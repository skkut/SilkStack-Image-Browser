import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SemanticSearchCoordinator,
  type SemanticIndexProgress,
  type SemanticSearchStatus,
  type PromptVectorSearchHit,
} from '../services/semanticSearchEngine';
import { getAiLoadError, isAiAvailable, SIMILARITY_MATCH_THRESHOLD } from '../services/aiBridge';
import { extractRawMetadataFromFile } from '../services/fileIndexer';

/**
 * Dev tools page for prompt vector similarity (the stacking engine's vector
 * half). Reached via `?devtools=vector-similarity`. Uses the REAL coordinator
 * → worker → storage stack against the LIBRARY's production DB — the same
 * records the app's own pipeline (semantic indexing + vector grouping) writes:
 *
 *   1. Compare two prompts — embed both (non-persisting) and score their
 *      cosine similarity against the ACTIVE model's grouping threshold.
 *   2. Prompt grouping — the tuning vehicle moved here from the Semantic
 *      Search tab: scan the library, then cluster its distinct prompts into
 *      similarity groups. Runs LIVE on the library DB with the same union-only
 *      upserts the app pipeline performs per image round (vectors Δ-skip;
 *      group records are upserted, never deleted).
 *   3. Prompt-vector search — rank the stored per-image prompt vectors against
 *      a prompt-like query and show the matching images.
 *
 * Everything reads the library store; the only writes are the grouping card's
 * embed backfill + group upserts (the app's own semantics — this page has no
 * isolated test store by design at this stage).
 */

/** Sample pairs for the compare panel (fill both inputs on click). */
const COMPARE_PRESETS = [
  {
    label: 'Near-duplicates',
    a: 'a red fox sitting in a snowy forest, digital painting',
    b: 'a red fox sitting in a snowy forest, digital painting, high detail',
  },
  {
    label: 'Unrelated',
    a: 'a red fox in the snow',
    b: 'cyberpunk neon city at night',
  },
  {
    label: 'Cross-lingual pair',
    a: 'a cat sitting on a windowsill watching the rain',
    b: '一只猫坐在窗台上看雨',
  },
];

/**
 * The lexical engine merges prompts when hybridSimilarity
 * (0.6·jaccard + 0.4·Levenshtein) clears the shared bar. Reads
 * SIMILARITY_MATCH_THRESHOLD so this instrument can never judge a pair at a
 * different bar than the pipeline does — the two signals are OR-ed, and the
 * vector engine's own default is pinned to the same value. The lexical engine
 * has no cross-lingual relaxation, unlike the vector one.
 */
const LEXICAL_MATCH_THRESHOLD = SIMILARITY_MATCH_THRESHOLD;

/** Full-res file reads for previews are expensive — cap how many hits get one. */
const MAX_RESULT_PREVIEWS = 50;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

function mimeForPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

function dirname(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'));
  return idx === -1 ? '' : filePath.slice(0, idx);
}

/**
 * Recover the real filesystem path from a stored image id. The persisted
 * vector records use `{directoryPath}::{filename}` (verified in the app's
 * IndexedDB, e.g. `H:\Images::cat.webp`) while the current indexer builds
 * `{directoryId}::{absolute-path}` — and legacy records may carry a bare
 * path with no separator at all. Handle all three shapes.
 */
function filePathFromImageId(imageId: string): string {
  const sep = imageId.indexOf('::');
  if (sep === -1) return imageId;
  const left = imageId.slice(0, sep);
  const right = imageId.slice(sep + 2);
  // Right side is already a full path (has separators or a drive letter).
  if (/[\\/]/.test(right) || /^[A-Za-z]:/.test(right)) return right;
  // Legacy format: left is the directory path, right is the bare filename.
  return left.endsWith('\\') || left.endsWith('/') ? left + right : left + '\\' + right;
}

/** Compact failure label for the preview placeholder. */
function shortError(err?: string, fallback = 'unavailable'): string {
  if (!err) return fallback;
  const known = err.match(/PERMISSION_DENIED|FILE_NOT_FOUND|ENOENT|EACCES|EPERM/i);
  return known ? known[0].toUpperCase() : err.length > 24 ? `${err.slice(0, 24)}…` : err;
}

/**
 * Electron IPC delivers Node Buffers as an ArrayBuffer or a typed-array view
 * (possibly into a pooled buffer) — normalize to a standalone ArrayBuffer so
 * the bytes are safe to hand to Blob. Same conversion as fileIndexer.ts.
 */
function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const view = data as ArrayBufferView;
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

/** idle = mounted but the model has NOT been loaded (explicit button). */
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** Fallbacks for the module stash — only ever matter if an export is dropped. */
const FALLBACK_NORMALIZE = (p: string): string => p.trim().replace(/\s+/g, ' ');
const FALLBACK_HASH = (p: string): string => p;
const FALLBACK_RESOLVE_THRESHOLD = (): number => SIMILARITY_MATCH_THRESHOLD;
const FALLBACK_COSINE = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
};
/** Broad non-Latin block test — cross-lingual matches relax the threshold by the module delta. */
const FALLBACK_NON_LATIN_RE = /[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0E00-\u0E7F\u0900-\u097F\u0600-\u06FF\u0590-\u05FF]/;

/**
 * Module constants stashed from the ai-intelligence module via the same
 * guarded dynamic import the coordinator wrapper uses (absent in open-source
 * builds) — the displayed thresholds can never drift from the module's real
 * values. All names are barrel-exported.
 */
interface VectorModuleConsts {
  /** Default dot-product threshold for prompt-vector clustering. */
  PROMPT_GROUPING_VECTOR_THRESHOLD: number;
  /** Threshold relaxation when one side of a comparison is non-Latin. */
  PROMPT_GROUPING_CROSSLINGUAL_DELTA: number;
  /** Resolve the effective grouping threshold for a model id. */
  resolvePromptGroupingThreshold: (modelId?: string) => number;
  /** Non-Latin script probe (CJK etc.) — gates the cross-lingual delta. */
  NON_LATIN_SCRIPT_RE: RegExp;
  /** The same normalization stored prompt vectors embed + hash with. */
  normalizePrompt: (prompt: string) => string;
  /** Exact-prompt FNV-1a hash — the app's stackGroupId / store promptHash. */
  generatePromptHash: (prompt: string) => string;
  /** Dot product over L2-normalized vectors (the module's similarity). */
  cosineSimilarity: (a: Float32Array, b: Float32Array) => number;
  /**
   * The lexical engine's hybrid score (0.6·jaccard + 0.4·normalized
   * Levenshtein). The third argument only tunes the internal jaccard
   * prefilter — pass the bar the score will be compared against, or the
   * prefilter can skip a pair that would have cleared it. null only when the
   * export is absent; the UI hides the lexical line then rather than
   * reimplementing MPL-covered logic app-side.
   */
  hybridSimilarity: ((a: string, b: string, threshold?: number) => number) | null;
}

/** One file entry from listDirectoryFiles (recursive: name = subfolder-relative path). */
interface LibraryFile {
  name: string;
  lastModified: number;
  size: number;
  type: string;
  birthtimeMs?: number;
}

interface CompareResult {
  a: string;
  b: string;
  score: number;
  /** The model's grouping threshold actually applied (delta included). */
  effThreshold: number;
  /** True when the cross-lingual relaxation was applied. */
  crosslingual: boolean;
  /**
   * The alternate non-AI score: the pre-vector grouping engine's hybrid
   * (0.6·jaccard + 0.4·Levenshtein) over the same normalized text — judged
   * against the fixed LEXICAL_MATCH_THRESHOLD. null when the module export
   * is absent (line hidden, never reimplemented app-side).
   */
  lexicalScore: number | null;
  elapsed: number;
}

interface SearchResult {
  q: string;
  /**
   * Vector-ranked hits, each carrying the alternate non-AI (lexical hybrid)
   * score against the query — null when the corpus scan has not seen the
   * hit's prompt text (the line is hidden then).
   */
  hits: Array<PromptVectorSearchHit & { lexicalScore: number | null }>;
  elapsed: number;
}

interface PromptClusterReadout {
  distinctPrompts: number;
  /** Similarity groups already in the library DB when the run started. */
  existingGroups: number;
  clusterCount: number;
  mergeCount: number;
  /** Compact previews: merged prompt → the prompt of the group it joined. */
  merges: Array<{ prompt: string; mergedIntoDisplay: string }>;
  /** Distinct prompts whose rep vector was missing/mismatched (self-assigned). */
  noVectorCount: number;
  thresholdUsed: number;
  elapsed: number;
}

export default function DevVectorSimilarityTester() {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [status, setStatus] = useState<SemanticSearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SemanticIndexProgress | null>(null);
  const [comparing, setComparing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [searching, setSearching] = useState(false);
  const [promptClustering, setPromptClustering] = useState(false);

  // Compare panel.
  const [promptA, setPromptA] = useState(COMPARE_PRESETS[0].a);
  const [promptB, setPromptB] = useState(COMPARE_PRESETS[0].b);
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);

  // Prompt-grouping panel.
  /** null = module default (PROMPT_GROUPING_VECTOR_THRESHOLD / per-model override). */
  const [groupingThreshold, setGroupingThreshold] = useState<number | null>(null);
  const [promptClusterReadout, setPromptClusterReadout] = useState<PromptClusterReadout | null>(null);

  // Prompt-vector search panel.
  const [query, setQuery] = useState('');
  /** Blank = no floor; 0-1 otherwise. */
  const [minScore, setMinScore] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);

  // Library corpus scan (read-only).
  const [libraryProgress, setLibraryProgress] = useState<{ current: number; total: number } | null>(null);
  const [librarySummary, setLibrarySummary] = useState<{ folders: number; files: number } | null>(null);
  /**
   * Every scanned image that carries a prompt — the grouping corpus and the
   * source of the prompt text shown on search hits. A ref, not state: a
   * 100k-image library must not re-render the panel per entry.
   */
  const libraryImagesRef = useRef<Array<{ id: string; prompt: string }>>([]);
  /**
   * promptHash → prompt text. Keyed by the SAME hash the store persists
   * (generatePromptHash(normalizePrompt(prompt))), so search hits resolve to
   * readable text even when the scan's image ids don't match the stored
   * records' ids (id-shape independent).
   */
  const promptByHashRef = useRef<Map<string, string>>(new Map());
  /** imageId → prompt text — secondary fallback when the hash misses. */
  const promptByIdRef = useRef<Map<string, string>>(new Map());

  const [log, setLog] = useState<string[]>([]);
  /** imageId → preview info: blob URL when loaded, or a short failure reason. */
  const [previews, setPreviews] = useState<Map<string, { url?: string; reason?: string }>>(new Map());
  /** The currently displayed map — its object URLs are revoked on replace. */
  const previewsRef = useRef<Map<string, { url?: string; reason?: string }>>(new Map());
  /** Bumped per search — a superseded search's late previews are dropped. */
  const searchSeqRef = useRef(0);

  const coordinatorRef = useRef<SemanticSearchCoordinator | null>(null);
  /** Live module constants, filled by the guarded module import in init(). */
  const moduleRef = useRef<VectorModuleConsts | null>(null);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);
  }, []);

  const revokeThumbs = useCallback(
    (map: Map<string, { url?: string; reason?: string }>) => {
      for (const { url } of map.values()) if (url) URL.revokeObjectURL(url);
    },
    [],
  );

  /**
   * Best-effort previews, rendered like the app's grid: look up each hit's
   * cached webp thumbnail via the SAME key the app uses (`${imageId}-
   * ${lastModified}`, with lastModified = birthtime as in fileIndexer) and
   * the same get-thumbnail IPC — a cache miss falls back to a full-res
   * per-file readFile. Per-hit IPC calls are independent, so a stale/denied
   * path fails alone (id-shape mismatches are display-cosmetic only). Revokes
   * the previous result's URLs; a response for a superseded search is
   * dropped (seq guard).
   */
  const loadThumbnails = useCallback(
    async (hits: PromptVectorSearchHit[], seq: number) => {
      const targets = hits
        .slice(0, MAX_RESULT_PREVIEWS)
        .map((h) => ({ imageId: h.imageId, path: filePathFromImageId(h.imageId) }));
      if (targets.length === 0 || !window.electronAPI?.getThumbnail) return;

      const results = await Promise.allSettled(
        targets.map(
          async (
            { imageId, path: p },
          ): Promise<[string, { url?: string; reason?: string }] | null> => {
            try {
              // Match the app's cache key: `${id}-${lastModified}` where
              // lastModified is birthtimeMs with an mtime fallback (fileIndexer).
              let key = `${imageId}-0`;
              if (window.electronAPI.getFileStats) {
                const stats = await window.electronAPI.getFileStats(p);
                if (stats.success && stats.stats) {
                  const lm = stats.stats.birthtimeMs ?? stats.stats.mtimeMs;
                  if (typeof lm === 'number') key = `${imageId}-${lm}`;
                } else {
                  return [imageId, { reason: shortError(stats.error, 'unreadable') }];
                }
              }
              const cached = await window.electronAPI.getThumbnail(key);
              if (cached.success && cached.data) {
                return [
                  imageId,
                  {
                    url: URL.createObjectURL(
                      new Blob([toArrayBuffer(cached.data as ArrayBuffer | ArrayBufferView)], { type: 'image/webp' }),
                    ),
                  },
                ];
              }
              // Cache miss → full-res read (independent per-path failures).
              if (!window.electronAPI.readFile) {
                return [imageId, { reason: 'no readFile API' }];
              }
              const resp = await window.electronAPI.readFile(p);
              if (!resp.success || !resp.data) {
                return [imageId, { reason: shortError(resp.error, resp.errorType ?? 'read failed') }];
              }
              return [
                imageId,
                {
                  url: URL.createObjectURL(
                    new Blob([toArrayBuffer(resp.data as ArrayBuffer | ArrayBufferView)], { type: mimeForPath(p) }),
                  ),
                },
              ];
            } catch {
              return [imageId, { reason: 'ipc error' }];
            }
          },
        ),
      );

      const next = new Map<string, { url?: string; reason?: string }>();
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) next.set(r.value[0], r.value[1]);
      }

      if (seq !== searchSeqRef.current) {
        revokeThumbs(next);
        return; // superseded by a newer search
      }
      revokeThumbs(previewsRef.current);
      previewsRef.current = next;
      setPreviews(next);
    },
    [revokeThumbs],
  );

  /**
   * Double-click a real hit → open the image in the Electron Image Modal
   * (a separate viewer window). The devtools window has no access to the main
   * window's IndexedImage objects, so we serialize a minimal image list built
   * from the hits themselves: ImageModal falls back to joinPaths(dirPath,
   * name) + readFile when an image has no usable handle, so a path + name is
   * all it needs to render. Navigation arrows move through the hit list.
   */
  const openInViewer = useCallback((hits: PromptVectorSearchHit[], index: number) => {
    const hit = hits[index];
    if (!hit) return;
    if (!window.electronAPI?.openImageViewer) return;
    const imageList = hits.map((h) => {
      const p = filePathFromImageId(h.imageId);
      return {
        // Keep the full `directoryId::path` id: the main window's store
        // is keyed by it, so delete/rename/favorite actions still sync.
        id: h.imageId,
        name: basename(p),
        fileType: mimeForPath(p),
        directoryId: dirname(p),
        directoryPath: dirname(p),
        lastModified: 0,
      };
    });
    const realIndex = imageList.findIndex((img) => img.id === hit.imageId);
    void window.electronAPI
      .openImageViewer({
        imageId: hit.imageId,
        directoryPath: dirname(filePathFromImageId(hit.imageId)),
        currentIndex: realIndex,
        totalImages: imageList.length,
        imageList,
      })
      .catch(() => {
        // Opening a viewer is best-effort from the tester
      });
  }, []);

  // Apply theme on mount (same pattern as the other dev testers)
  useEffect(() => {
    const applyTheme = (systemShouldUseDark: boolean) => {
      if (systemShouldUseDark) {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme', 'light');
      }
    };

    if (window.electronAPI) {
      window.electronAPI.getTheme().then(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });
      const unsubscribe = window.electronAPI.onThemeUpdated(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });
      return () => {
        if (unsubscribe) unsubscribe();
      };
    } else {
      applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
  }, []);

  // Initialize the coordinator (worker + chunked restore) on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const available = await isAiAvailable();
      if (!available) {
        if (!cancelled) {
          const errMsg = await getAiLoadError();
          setLoadState('error');
          setError(
            'AI intelligence module is not available. ' +
              'The ai-intelligence package must be installed for vector similarity. ' +
              (errMsg ? `(${errMsg})` : ''),
          );
        }
        return;
      }

      // Stash live constants from the module (same guarded dynamic import as
      // the coordinator wrapper — dead-code-eliminated when the module is
      // absent at build time). Absence is already reported above.
      if (import.meta.env.VITE_AI_FEATURES_AVAILABLE) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = (await import('@ai-images-browser/ai-intelligence')) as any;
          if (!cancelled) {
            moduleRef.current = {
              // Fallbacks must stay in sync with the module's values — they
              // only ever matter if the export above is ever dropped.
              PROMPT_GROUPING_VECTOR_THRESHOLD: mod.PROMPT_GROUPING_VECTOR_THRESHOLD ?? 0.85,
              PROMPT_GROUPING_CROSSLINGUAL_DELTA: mod.PROMPT_GROUPING_CROSSLINGUAL_DELTA ?? 0.05,
              resolvePromptGroupingThreshold: mod.resolvePromptGroupingThreshold ?? FALLBACK_RESOLVE_THRESHOLD,
              NON_LATIN_SCRIPT_RE: mod.NON_LATIN_SCRIPT_RE ?? FALLBACK_NON_LATIN_RE,
              normalizePrompt: mod.normalizePrompt ?? FALLBACK_NORMALIZE,
              generatePromptHash: mod.generatePromptHash ?? FALLBACK_HASH,
              cosineSimilarity: mod.cosineSimilarity ?? FALLBACK_COSINE,
              hybridSimilarity: mod.hybridSimilarity ?? null,
            };
          }
        } catch {
          // module absence is already reported by isAiAvailable()
        }
      }

      // The coordinator is created but NOT initialized: constructing it is
      // inert (no worker, no WebGPU engine, no model download — the worker
      // and engine only start inside ensureInitialized). Opening the tester
      // must not trigger a multi-second model load; the user clicks
      // "Load models" (handleLoadModels) to run it explicitly.
      // storageDbName is OMITTED → the coordinator binds to the LIBRARY
      // production DB — this page has no isolated test store by design.
      const coordinator = new SemanticSearchCoordinator(
        (p) => {
          if (!cancelled) setProgress(p);
        },
        undefined, // onGpuInfo — not rendered by this tester
        undefined, // storageDbName → library DB (production)
        undefined, // onModelsStatus — the tester renders status from getStatus()
        // skipMasterCheck: this harness is premium-gated at its entry
        // (Ctrl+Y is license-only) and loads only on explicit click — the
        // master AI toggle governs the MAIN APP, not the dev tester.
        true,
      );
      coordinatorRef.current = coordinator;
    }

    init();

    return () => {
      cancelled = true;
      coordinatorRef.current?.dispose();
      revokeThumbs(previewsRef.current); // preview blob URLs must not leak
    };
  }, [appendLog, revokeThumbs]);

  const refreshStatus = useCallback((coordinator: SemanticSearchCoordinator) => {
    setStatus(coordinator.getStatus());
  }, []);

  /**
   * Explicit model load — nothing loads until this button is clicked.
   * ensureInitialized is lazy and idempotent: a failed init clears its
   * promise, so a retry re-attempts with a fresh worker.
   */
  const handleLoadModels = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || loadState === 'loading' || loadState === 'ready') return;
    setLoadState('loading');
    setError(null);
    try {
      await coordinator.ensureInitialized();
      setLoadState('ready');
      setStatus(coordinator.getStatus());
      appendLog('worker ready — persisted index restored (chunked)');
    } catch (err) {
      setLoadState('error');
      setError(
        `Vector similarity failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [loadState, appendLog]);

  /**
   * Compare two prompts: embed both through the public non-persisting route
   * and score the cosine of the normalized forms — the SAME text the store
   * embeds, so the score is directly comparable to the grouping threshold the
   * clustering engine applies (per-model override, relaxed by the module's
   * cross-lingual delta when either side is non-Latin).
   */
  const handleCompare = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || loadState !== 'ready' || comparing) return;
    if (!promptA.trim() || !promptB.trim()) {
      setError('Both prompts must be non-empty to compare.');
      return;
    }
    const stash = moduleRef.current;
    const normalize = stash?.normalizePrompt ?? FALLBACK_NORMALIZE;
    const a = normalize(promptA);
    const b = normalize(promptB);
    if (!a || !b) {
      setError('Both prompts must normalize to non-empty text to compare.');
      return;
    }
    setComparing(true);
    setError(null);
    try {
      const start = performance.now();
      const [va, vb] = await coordinator.embedTexts([a, b]);
      if (!va || !vb) {
        setError('Embedding returned no vectors — check the model state.');
        return;
      }
      const cosine = stash?.cosineSimilarity ?? FALLBACK_COSINE;
      const score = cosine(va, vb);
      // Alternate, non-AI score over the SAME normalized text: the lexical
      // engine's hybrid (jaccard + Levenshtein). It runs alongside the vector
      // signal in the pipeline and the two are OR-ed, so its verdict is
      // "would the lexical half of the OR have merged this?" — judged against
      // LEXICAL_MATCH_THRESHOLD (the shared bar), with no cross-lingual relief.
      const lexicalScore = stash?.hybridSimilarity
        ? stash.hybridSimilarity(a, b, LEXICAL_MATCH_THRESHOLD)
        : null;
      const resolve = stash?.resolvePromptGroupingThreshold ?? FALLBACK_RESOLVE_THRESHOLD;
      const thresholdUsed = resolve(status?.modelId);
      const nonLatinRe = stash?.NON_LATIN_SCRIPT_RE ?? FALLBACK_NON_LATIN_RE;
      const crosslingual = nonLatinRe.test(promptA) || nonLatinRe.test(promptB);
      const delta = crosslingual ? (stash?.PROMPT_GROUPING_CROSSLINGUAL_DELTA ?? 0.05) : 0;
      setCompareResult({
        a,
        b,
        score,
        effThreshold: Math.max(0, thresholdUsed - delta),
        crosslingual,
        lexicalScore,
        elapsed: Math.round(performance.now() - start),
      });
      appendLog(
        `compare: ${(score * 100).toFixed(1)}% similar (${crosslingual ? 'cross-lingual — ' : ''}threshold ${thresholdUsed.toFixed(2)}${crosslingual ? ` − ${delta} delta` : ''}${lexicalScore !== null ? ` · lexical ${(lexicalScore * 100).toFixed(1)}%` : ''})`,
      );
    } catch (err) {
      setError(`Compare failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setComparing(false);
    }
  }, [loadState, comparing, promptA, promptB, status?.modelId, appendLog]);

  /**
   * Scan the REAL library — every image in the app's configured folders —
   * collecting ONLY the prompts (read-only: nothing is indexed or written).
   * The scan has two jobs on this page: it feeds the prompt-grouping corpus
   * (one entry per prompted image) and it maps stored promptHash values back
   * to readable prompt text on search hits (keyed by the same normalize +
   * hash the store persists, so the correlation is id-shape independent).
   *
   * Replicates the main app's enumeration exactly:
   *
   *   folders:  localStorage 'image-metahub-directories' (shared session)
   *   files:    listDirectoryFiles({dirPath, recursive}) — `name` is the
   *             subfolder-relative path, forward slashes (app convention)
   *   paths:    joinPathsBatch — path.resolve(basePath, relativeName)
   *   metadata: extractRawMetadataFromFile — the SAME parser the app's
   *             indexer uses (prompt/models), via the readFile IPC
   *   ids:      `${dirPath}::${relativePath}` — the persisted convention
   *
   * Metadata extraction runs in small concurrent chunks per folder; a file
   * that fails to parse simply contributes no prompt.
   */
  const handleScanLibrary = useCallback(async () => {
    if (scanning) return;
    if (!window.electronAPI?.listDirectoryFiles) {
      setError('The library scan requires the Electron app (listDirectoryFiles IPC).');
      return;
    }
    setScanning(true);
    setLibraryProgress(null);
    setError(null);
    try {
      // 1. The app's configured folders (shared localStorage — the devtools
      // window sees the main window's persisted list).
      let folders: string[] = [];
      try {
        const raw = localStorage.getItem('image-metahub-directories');
        folders = raw ? JSON.parse(raw) : [];
      } catch {
        folders = [];
      }
      if (!Array.isArray(folders)) folders = [];
      if (folders.length === 0) {
        setError('No library folders configured (image-metahub-directories is empty).');
        return;
      }

      const stash = moduleRef.current;
      const normalize = stash?.normalizePrompt ?? FALLBACK_NORMALIZE;
      const hash = stash?.generatePromptHash ?? FALLBACK_HASH;

      // 2. Enumerate every folder, then extract metadata per file.
      const prompted: Array<{ id: string; prompt: string }> = [];
      const byId = new Map<string, string>();
      const byHash = new Map<string, string>();
      let total = 0;
      const folderFiles: { dirPath: string; files: LibraryFile[] }[] = [];
      for (const dirPath of folders) {
        const resp = await window.electronAPI.listDirectoryFiles({ dirPath, recursive: true });
        const files = resp.success && resp.files ? resp.files : [];
        folderFiles.push({ dirPath, files });
        total += files.length;
      }
      appendLog(`library scan: ${folders.length} folder(s), ${total} file(s)`);

      const CHUNK = 10; // concurrent metadata reads per folder
      let done = 0;
      for (const { dirPath, files } of folderFiles) {
        const joined = await window.electronAPI.joinPathsBatch({
          basePath: dirPath,
          fileNames: files.map((f) => f.name),
        });
        const paths = joined.success && joined.paths ? joined.paths : [];
        for (let c = 0; c < files.length; c += CHUNK) {
          const slice = files.slice(c, c + CHUNK);
          const pathSlice = paths.slice(c, c + CHUNK);
          const metas = await Promise.allSettled(
            slice.map((_, i) => extractRawMetadataFromFile(pathSlice[i])),
          );
          for (let i = 0; i < slice.length; i++) {
            const file = slice[i];
            const id = `${dirPath}::${file.name}`;
            const metaResult = metas[i];
            const meta = metaResult.status === 'fulfilled' ? metaResult.value : null;
            // Crash-proof like the module's normalizePrompt: these are RAW
            // metadata parsers, so a ComfyUI chunk's "prompt" can parse to a
            // node ARRAY, not a string. The app treats non-string prompts as
            // absent everywhere downstream (the module drops them at
            // normalize) — guard here so one exotic file cannot fail the
            // whole scan.
            const rawPrompt = typeof meta?.prompt === 'string' ? meta.prompt : null;
            if (rawPrompt && rawPrompt.trim().length > 0) {
              const prompt = rawPrompt.trim();
              prompted.push({ id, prompt });
              byId.set(id, prompt);
              const key = hash(normalize(prompt));
              if (!byHash.has(key)) byHash.set(key, prompt);
            }
          }
          done += slice.length;
          if (done % 25 === 0 || done === total) {
            setLibraryProgress({ current: done, total });
          }
        }
      }
      setLibraryProgress(null);
      libraryImagesRef.current = prompted;
      promptByIdRef.current = byId;
      promptByHashRef.current = byHash;
      setLibrarySummary({ folders: folders.length, files: prompted.length });
      setPromptClusterReadout(null); // a fresh corpus invalidates the readout
      appendLog(`library scan: ${prompted.length} prompted image(s) of ${total} file(s) — nothing written`);
      if (prompted.length === 0) {
        setError('No prompted images found — grouping has no corpus and search-hit text stays hashed.');
      }
    } catch (err) {
      setError(`Library scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setScanning(false);
      setLibraryProgress(null);
    }
  }, [scanning, appendLog]);

  /**
   * Prompt-grouping card: cluster the scanned library's DISTINCT prompts by
   * embedding similarity — the same vector pass the app runs for stack
   * formation (embed → one vector per exact-prompt group → dot-product
   * clustering). Runs LIVE on the library DB: embedPromptVectors backfills
   * only vectors the app never wrote (Δ-skip — steady state embeds nothing)
   * and clusterPromptGroups persists union-only centroid upserts, never
   * deletes — the exact semantics useImageStore.computeVectorSimilarityGroups
   * runs per image round. Sweeping the threshold is still cheap: re-runs
   * re-embed nothing and re-merge the same persisted vectors.
   */
  const handleClusterPrompts = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || loadState !== 'ready' || promptClustering) return;
    const scanned = libraryImagesRef.current;
    if (scanned.length === 0) {
      setError('Run the library scan first — its prompt corpus feeds this panel.');
      return;
    }
    setPromptClustering(true);
    setError(null);
    try {
      // 1. One group per distinct prompt (the app's dedupe key is the
      // exact-prompt hash = stackGroupId; identical prompts share a vector).
      const firstById = new Map<string, string>(); // prompt → representative imageId
      for (const { id, prompt } of scanned) {
        if (!firstById.has(prompt)) firstById.set(prompt, id);
      }
      const stash = moduleRef.current;
      const hash = stash?.generatePromptHash ?? FALLBACK_HASH;
      const newGroups = Array.from(firstById, ([prompt, representativeImageId]) => ({
        groupId: hash(prompt),
        prompt,
        representativeImageId,
      }));
      appendLog(
        `prompt grouping: ${newGroups.length} distinct prompt(s) from ${scanned.length} image(s)`,
      );

      // 2. Backfill missing prompt vectors (Δ-skipped on re-runs — a
      // threshold sweep re-embeds nothing).
      const embedStart = performance.now();
      const embedded = await coordinator.embedPromptVectors(
        newGroups.map((g) => ({ id: g.representativeImageId, prompt: g.prompt })),
      );
      appendLog(
        `prompt vectors: embedded ${embedded.embedded}, skipped ${embedded.skipped} in ${Math.round(performance.now() - embedStart)}ms`,
      );

      // 3. Groups from the library DB (the app's own pipeline maintains
      // these). Their representatives are persisted, so the coordinator never
      // needs member lists for them.
      const existing = await coordinator.getPromptSimilarityGroups();
      const existingGroups = existing.map((g) => ({ groupId: g.groupId, memberImageIds: [] }));

      // 4. Cluster (chunked at PROMPT_CLUSTER_CHUNK_SIZE inside the module).
      const clusterStart = performance.now();
      const result = await coordinator.clusterPromptGroups({
        newGroups,
        existingGroups,
        ...(groupingThreshold !== null ? { threshold: groupingThreshold } : {}),
        onProgress: (p) =>
          appendLog(`prompt clustering: ${p.current}/${p.total}${p.message ? ` — ${p.message}` : ''}`),
      });

      // 5. Readout: distinct prompts → clusters, with merged-cluster previews.
      // Groups without a usable vector are absent from the map — the app
      // self-assigns them; mirror that here.
      const promptById = new Map(newGroups.map((g) => [g.groupId, g.prompt]));
      const finalByGroup = new Map<string, string>();
      for (const g of newGroups) finalByGroup.set(g.groupId, result.groupIdToSimId.get(g.groupId) ?? g.groupId);
      const clusters = new Set(finalByGroup.values());
      const merges = newGroups
        .filter((g) => finalByGroup.get(g.groupId) !== g.groupId)
        .map((g) => ({
          prompt: g.prompt,
          mergedIntoDisplay: promptById.get(finalByGroup.get(g.groupId)!) ?? finalByGroup.get(g.groupId)!,
        }));
      const thresholdUsed =
        groupingThreshold ?? stash?.PROMPT_GROUPING_VECTOR_THRESHOLD ?? 0.85;
      setPromptClusterReadout({
        distinctPrompts: newGroups.length,
        existingGroups: existing.length,
        clusterCount: clusters.size,
        mergeCount: merges.length,
        merges: merges.slice(0, 12),
        noVectorCount: newGroups.length - result.groupIdToSimId.size,
        thresholdUsed,
        elapsed: Math.round(performance.now() - clusterStart),
      });
      appendLog(
        `prompt grouping: ${newGroups.length} prompt(s) → ${clusters.size} cluster(s), ${merges.length} merged (threshold ${thresholdUsed.toFixed(2)})`,
      );
    } catch (err) {
      setError(`Prompt clustering failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPromptClustering(false);
    }
  }, [loadState, promptClustering, groupingThreshold, appendLog]);

  /**
   * Rank the library DB's stored prompt vectors against a prompt-like query
   * and show the matching images — "what was this prompt-like text used
   * for?". The query is normalized and embedded exactly like the persisted
   * records, so scores are the same cosine the grouping thresholds use.
   * Read-only: nothing is written or re-embedded beyond the transient query.
   */
  const handleSearchPromptVectors = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    const q = query.trim();
    if (!coordinator || loadState !== 'ready' || searching || !q) return;
    setSearching(true);
    setError(null);
    const seq = ++searchSeqRef.current;
    const start = performance.now();
    try {
      const options: { limit: number; minScore?: number } = { limit: 50 };
      const floor = parseFloat(minScore);
      if (minScore.trim() !== '' && !Number.isNaN(floor)) {
        options.minScore = Math.min(1, Math.max(0, floor));
      }
      const hits = await coordinator.searchPromptVectors(q, options);
      // Non-AI alternate per hit: the pre-vector engine's hybrid between the
      // query and the hit's STORED prompt text, resolved through the corpus
      // scan's hash map (id-shape independent). A hit whose prompt the scan
      // has never seen gets null → the row shows no lexical line.
      const stash = moduleRef.current;
      const normalize = stash?.normalizePrompt ?? FALLBACK_NORMALIZE;
      const hybrid = stash?.hybridSimilarity;
      const qText = normalize(q);
      const hitsWithLexical = hits.map((h) => {
        const text = promptByHashRef.current.get(h.promptHash) ?? promptByIdRef.current.get(h.imageId);
        return { ...h, lexicalScore: hybrid && text ? hybrid(qText, normalize(text)) : null };
      });
      setResult({ q, hits: hitsWithLexical, elapsed: Math.round(performance.now() - start) });
      void loadThumbnails(hitsWithLexical, seq); // fire-and-forget; seq guard drops late responses
      appendLog(
        `prompt-vector search: ${hits.length} hit(s) in ${Math.round(performance.now() - start)}ms` +
          (options.minScore !== undefined ? ` (minScore ${options.minScore.toFixed(2)})` : ''),
      );
    } catch (err) {
      setError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSearching(false);
    }
  }, [loadState, query, minScore, searching, loadThumbnails, appendLog]);

  // Ctrl+Y closes this window
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key === 'y') {
        e.preventDefault();
        window.close();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleClose = () => window.close();

  // Shared class sets to keep things DRY
  const cardClass = 'bg-gray-900 rounded-xl border border-gray-800 p-5';
  const btnChipClass =
    'px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
  const btnPresetClass =
    'px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded-full text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors';
  const inputClass =
    'w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30';
  const labelClass = 'block text-sm font-medium text-gray-200 mb-2';

  // Effective grouping threshold for the current model (chips + verdicts).
  const modelThreshold =
    moduleRef.current?.resolvePromptGroupingThreshold(status?.modelId ?? undefined) ?? 0.85;
  const crosslingualDelta = moduleRef.current?.PROMPT_GROUPING_CROSSLINGUAL_DELTA ?? 0.05;
  const promptCount = libraryImagesRef.current.length;
  /**
   * Verdict agreement between the AI (vector) and non-AI (lexical) methods
   * on the last comparison — divergence is the signal this tool exists for,
   * so it is highlighted rather than buried.
   */
  const compareAgree =
    compareResult === null ||
    compareResult.lexicalScore === null ||
    (compareResult.score >= compareResult.effThreshold) ===
      (compareResult.lexicalScore >= LEXICAL_MATCH_THRESHOLD);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-950 text-gray-200 font-sans">
      {/* Header — draggable region (titleBarStyle: hidden needs explicit drag region) */}
      <div
        className="px-6 py-4 border-b border-gray-800 flex items-center gap-4 shrink-0"
        style={{ WebkitAppRegion: 'drag', paddingTop: '36px' } as React.CSSProperties}
      >
        <button
          onClick={handleClose}
          className={btnChipClass + ' shrink-0'}
          title="Ctrl+Y"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          &#8592; Close
        </button>
        <div>
          <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
            Vector Similarity Test
            <span className="px-2 py-0.5 text-xs font-mono bg-gray-800 text-gray-400 rounded-md border border-gray-700 font-normal">
              {status?.modelId ?? 'qwen3-embedding-4b'}
            </span>
            <span
              className="px-2 py-0.5 text-xs font-mono bg-gray-800 text-gray-300 rounded-md border border-gray-700 font-normal"
              title="This page reads and writes the library production DB — no isolated test store at this stage"
            >
              library store
            </span>
          </h1>
          <p className="text-sm text-gray-500">
            Prompt embeddings: compare, group, search — the vector half of stack formation
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {loadState === 'idle' || loadState === 'error' ? (
            <button
              onClick={handleLoadModels}
              className="px-4 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              {loadState === 'error' ? 'Retry: load models' : 'Load models'}
            </button>
          ) : (
            <div
              className={`w-2 h-2 rounded-full ${
                loadState === 'loading' ? 'bg-yellow-500' : loadState === 'ready' ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
          )}
          <span className="text-sm text-gray-400">
            {loadState === 'idle'
              ? 'model not loaded'
              : loadState === 'loading'
                ? 'Loading model...'
                : loadState === 'error'
                  ? 'load failed'
                  : `indexed: ${status?.indexed ?? 0}${status?.dimension ? ` · ${status.dimension} dims` : ''}`}
          </span>
          {progress && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{progress.message}</span>
              <div className="w-32 h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Column (Controls) */}
        <div className="w-full lg:w-3/5 flex flex-col overflow-y-auto scrollbar-adaptive p-6 space-y-6 border-b lg:border-b-0 lg:border-r border-gray-800">
          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg text-sm text-red-600 dark:text-red-400 shrink-0">
              {error}
            </div>
          )}

          {/* Compare two prompts card */}
          <div className={`${cardClass} shrink-0`}>
            <h3 className="text-sm font-medium text-gray-200 mb-3">Compare two prompts</h3>
            <p className="text-[11px] text-gray-500 mb-4">
              Embeds both (normalized exactly like the store&apos;s records, nothing persisted) and
              scores their cosine against the current model&apos;s grouping threshold{' '}
              <span className="font-mono text-gray-400">{modelThreshold.toFixed(2)}</span>
              {crosslingualDelta > 0 && (
                <>
                  {' '}
                  — relaxed by{' '}
                  <span className="font-mono text-gray-400">{crosslingualDelta.toFixed(2)}</span> when
                  either side is non-Latin
                </>
              )}
              . Scores ≥ the threshold are what the app would merge into one stack.
            </p>
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="compare-prompt-a">
                  Prompt A
                </label>
                <input
                  id="compare-prompt-a"
                  value={promptA}
                  onChange={(e) => setPromptA(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCompare();
                    }
                  }}
                  className={inputClass}
                  placeholder='e.g. "a red fox sitting in a snowy forest"'
                />
              </div>
              <div>
                <label className={labelClass} htmlFor="compare-prompt-b">
                  Prompt B
                </label>
                <input
                  id="compare-prompt-b"
                  value={promptB}
                  onChange={(e) => setPromptB(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleCompare();
                    }
                  }}
                  className={inputClass}
                  placeholder='e.g. "a red fox in the snow"'
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {COMPARE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => {
                      setPromptA(p.a);
                      setPromptB(p.b);
                    }}
                    className={btnPresetClass}
                    title="Fill both inputs with a sample pair (then hit Compare)"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-4 mt-4">
              <button
                onClick={handleCompare}
                disabled={loadState !== 'ready' || comparing || !promptA.trim() || !promptB.trim()}
                className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {comparing ? 'Embedding...' : 'Compare'}
              </button>
              {compareResult && (
                <span className="text-xs text-gray-400 ml-auto">
                  {(compareResult.score * 100).toFixed(1)}% similar in {compareResult.elapsed}ms
                </span>
              )}
            </div>
            {compareResult && (
              <div className="mt-4 p-3 rounded-lg bg-gray-950/70 border border-gray-800 text-xs space-y-1.5">
                {/* Row 1: the AI score vs the model's (possibly relaxed) threshold */}
                <div className="flex items-baseline gap-2">
                  <span className="text-gray-500 shrink-0 w-28">vector (AI)</span>
                  <span
                    className={`font-mono text-lg font-semibold ${
                      compareResult.score >= compareResult.effThreshold
                        ? 'text-green-400'
                        : 'text-gray-300'
                    }`}
                  >
                    {(compareResult.score * 100).toFixed(1)}%
                  </span>
                  <span className="text-gray-400">
                    {compareResult.score >= compareResult.effThreshold ? (
                      <>
                        ≥ threshold{' '}
                        <span className="font-mono text-gray-300">
                          {compareResult.effThreshold.toFixed(2)}
                        </span>{' '}
                        — <span className="text-green-400">would merge into one stack</span>
                      </>
                    ) : (
                      <>
                        &lt; threshold{' '}
                        <span className="font-mono text-gray-300">
                          {compareResult.effThreshold.toFixed(2)}
                        </span>{' '}
                        — distinct stacks
                      </>
                    )}
                    {compareResult.crosslingual && (
                      <span className="ml-2 text-blue-300">
                        cross-lingual (threshold relaxed by {crosslingualDelta.toFixed(2)})
                      </span>
                    )}
                  </span>
                </div>

                {/* Row 2: the alternate non-AI score — the lexical grouping
                    engine's metric (0.6·jaccard + 0.4·Levenshtein) over the
                    same normalized text, judged against the shared match bar.
                    Both signals run in the pipeline and are OR-ed, so either
                    row passing means the pair stacks. The lexical side has no
                    cross-lingual relaxation. */}
                {compareResult.lexicalScore !== null && (
                  <div className="flex items-baseline gap-2">
                    <span className="text-gray-500 shrink-0 w-28">lexical (non-AI)</span>
                    <span
                      className={`font-mono text-lg font-semibold ${
                        compareResult.lexicalScore >= LEXICAL_MATCH_THRESHOLD
                          ? 'text-green-400'
                          : 'text-gray-300'
                      }`}
                    >
                      {(compareResult.lexicalScore * 100).toFixed(1)}%
                    </span>
                    <span className="text-gray-400">
                      {compareResult.lexicalScore >= LEXICAL_MATCH_THRESHOLD ? (
                        <>
                          ≥{' '}
                          <span className="font-mono text-gray-300">
                            {LEXICAL_MATCH_THRESHOLD.toFixed(2)}
                          </span>{' '}
                          — <span className="text-green-400">would merge (pre-vector engine)</span>
                        </>
                      ) : (
                        <>
                          &lt;{' '}
                          <span className="font-mono text-gray-300">
                            {LEXICAL_MATCH_THRESHOLD.toFixed(2)}
                          </span>{' '}
                          — distinct stacks
                        </>
                      )}
                    </span>
                  </div>
                )}

                {/* Divergence between the two methods is what threshold tuning is about */}
                {!compareAgree && (
                  <div className="flex items-center gap-2 text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                    methods disagree — the vector and lexical engines reach opposite verdicts on this pair
                  </div>
                )}

                <div className="text-gray-500 font-mono truncate" title={compareResult.a}>
                  A: &ldquo;{compareResult.a}&rdquo;
                </div>
                <div className="text-gray-500 font-mono truncate" title={compareResult.b}>
                  B: &ldquo;{compareResult.b}&rdquo;
                </div>
              </div>
            )}
          </div>

          {/* Prompt grouping card — moved from the Semantic Search tab */}
          <div className={`${cardClass} shrink-0`}>
            <h3 className="text-sm font-medium text-gray-200 mb-3">Prompt grouping (vector similarity)</h3>
            <p className="text-[11px] text-gray-500 mb-4">
              Clusters the scanned library&apos;s distinct prompts by embedding dot-product — the same
              vector pass the app runs to form stacks. Group ids are the app&apos;s stackGroupIds.
              Runs LIVE against the library store with the app pipeline&apos;s union-only semantics
              (vectors Δ-skip on re-runs, group records are upserted — never deleted); sweep the
              threshold and re-cluster.
            </p>
            <label className={labelClass} htmlFor="grouping-threshold">
              Threshold (dot product; blank = model default{' '}
              {moduleRef.current?.PROMPT_GROUPING_VECTOR_THRESHOLD ?? 0.85})
            </label>
            <input
              id="grouping-threshold"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={groupingThreshold ?? ''}
              onChange={(e) => {
                const v = e.target.value.trim();
                setGroupingThreshold(v === '' ? null : Math.min(1, Math.max(0, Number(v))));
              }}
              placeholder={String(moduleRef.current?.PROMPT_GROUPING_VECTOR_THRESHOLD ?? 0.85)}
              className={inputClass}
            />
            <div className="flex items-center gap-4 mt-4">
              <button
                onClick={handleClusterPrompts}
                disabled={loadState !== 'ready' || promptClustering || scanning || promptCount === 0}
                className="px-5 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {promptClustering ? 'Clustering...' : 'Cluster library prompts'}
              </button>
              <span className="text-xs text-gray-400 ml-auto">
                {promptCount > 0
                  ? `${promptCount} prompted image(s) from the last scan`
                  : 'run the library scan first'}
              </span>
            </div>
            {promptClusterReadout && (
              <div className="mt-4 p-3 rounded-lg bg-gray-950/70 border border-gray-800 text-xs">
                <div className="font-mono text-gray-300">
                  {promptClusterReadout.distinctPrompts} distinct prompt(s) vs{' '}
                  {promptClusterReadout.existingGroups} existing group(s) →{' '}
                  {promptClusterReadout.clusterCount} cluster(s), {promptClusterReadout.mergeCount}{' '}
                  merged
                  {promptClusterReadout.noVectorCount > 0 && (
                    <>
                      {' '}
                      · <span className="text-amber-300">{promptClusterReadout.noVectorCount} no vector
                      (self-assigned)</span>
                    </>
                  )}{' '}
                  · threshold {promptClusterReadout.thresholdUsed.toFixed(2)} ·{' '}
                  {promptClusterReadout.elapsed}ms
                </div>
                {promptClusterReadout.merges.length > 0 && (
                  <ul className="mt-2 space-y-1 text-gray-400">
                    {promptClusterReadout.merges.map((m) => (
                      <li key={m.prompt} className="font-mono truncate">
                        &ldquo;{m.prompt}&rdquo; → &ldquo;{m.mergedIntoDisplay}&rdquo;
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* Prompt-vector search card */}
          <div className={`${cardClass} shrink-0`}>
            <h3 className="text-sm font-medium text-gray-200 mb-3">Prompt-vector search</h3>
            <p className="text-[11px] text-gray-500 mb-4">
              Ranks the library&apos;s stored per-image prompt vectors against your text — what was
              this prompt-like phrase used for? Searches vectors the MAIN app persisted during its
              own semantic indexing; a fresh library has none until that runs. Read-only.
            </p>
            <label className={labelClass} htmlFor="pv-query">
              Prompt-like query
            </label>
            <input
              id="pv-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearchPromptVectors();
              }}
              className={inputClass}
              placeholder='e.g. "a red fox sitting in a snowy forest"'
            />
            <label className={labelClass + ' mt-3'} htmlFor="pv-min-score">
              Min score (blank = no floor)
            </label>
            <input
              id="pv-min-score"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minScore}
              onChange={(e) => {
                const v = e.target.value.trim();
                setMinScore(v === '' || Number.isNaN(Number(v)) ? '' : String(Math.min(1, Math.max(0, Number(v)))));
              }}
              placeholder="no floor"
              className={inputClass}
            />
            <div className="flex items-center gap-4 mt-4">
              <button
                onClick={handleSearchPromptVectors}
                disabled={loadState !== 'ready' || searching || !query.trim()}
                className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {searching ? 'Searching...' : 'Search'}
              </button>
              <span className="text-xs text-gray-400 ml-auto">
                Top 50 hits · double-click a result to open it
              </span>
            </div>
          </div>

          {/* Library corpus card (read-only scan) */}
          <div className={`${cardClass} shrink-0`}>
            <h3 className="text-sm font-medium text-gray-200 mb-3">Library corpus</h3>
            <p className="text-[11px] text-gray-500 mb-4">
              Scans the app&apos;s configured folders and keeps every image&apos;s prompt — nothing
              is indexed or written. The corpus feeds the grouping panel, and its prompt text
              resolves search-hit hashes back to readable phrases.
            </p>
            <div className="flex items-center gap-4">
              <button
                onClick={handleScanLibrary}
                disabled={scanning || promptClustering}
                className="px-5 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {scanning ? 'Scanning...' : 'Scan library images'}
              </button>
              {libraryProgress && (
                <span className="text-xs text-gray-400">
                  reading {libraryProgress.current}/{libraryProgress.total} files...
                </span>
              )}
              <span className="text-xs text-gray-500 ml-auto">
                {librarySummary
                  ? `${librarySummary.folders} folder(s), ${librarySummary.files} prompted image(s)`
                  : "scans the app's configured folders"}
              </span>
            </div>
          </div>

          {/* Activity log */}
          <div className={`${cardClass} flex-1 flex flex-col min-h-[150px]`}>
            <h3 className="text-sm font-medium text-gray-400 mb-2 shrink-0">Activity log</h3>
            <pre className="flex-1 text-xs text-gray-400 bg-gray-950 rounded-lg p-3 overflow-auto scrollbar-adaptive whitespace-pre-wrap break-all font-mono">
              {log.length === 0 ? 'No activity yet.' : log.join('\n')}
            </pre>
          </div>
        </div>

        {/* Right Column (Results) */}
        <div className="w-full lg:w-2/5 flex flex-col overflow-y-auto scrollbar-adaptive p-6 space-y-6">
          <div className={`${cardClass} flex-1 flex flex-col`}>
            <div className="flex items-center justify-between mb-3 shrink-0">
              <h3 className="text-sm font-medium text-gray-200">Top hits</h3>
              {result && (
                <span className="text-xs text-gray-400">
                  {result.hits.length} hit(s) in {result.elapsed}ms
                </span>
              )}
            </div>
            {!result ? (
              <span className="text-sm text-gray-500">
                {searching
                  ? 'Searching...'
                  : 'Run a prompt-vector search to see matching images.'}
              </span>
            ) : result.hits.length === 0 ? (
              <span className="text-sm text-gray-500">
                No stored prompt vectors scored ≥ the floor for &ldquo;{result.q}&rdquo; — the
                library gets its vectors from the main app&apos;s semantic indexing.
              </span>
            ) : (
              <div className="space-y-2 overflow-y-auto scrollbar-adaptive">
                {result.hits.map((hit, i) => {
                  const realPath = filePathFromImageId(hit.imageId);
                  const pv = previews.get(hit.imageId);
                  const thumbUrl = pv?.url;
                  const promptText =
                    promptByHashRef.current.get(hit.promptHash) ??
                    promptByIdRef.current.get(hit.imageId);
                  return (
                    <div
                      key={hit.imageId}
                      onDoubleClick={() => openInViewer(result.hits, i)}
                      title="Double-click to open in Image Modal"
                      className="p-3 bg-gray-950 border border-gray-800 rounded-lg flex gap-3 cursor-pointer select-none"
                    >
                      <div className="w-24 h-24 shrink-0 rounded-md overflow-hidden bg-gray-900 border border-gray-800 flex items-center justify-center">
                        {thumbUrl ? (
                          <img
                            src={thumbUrl}
                            alt={basename(realPath)}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <span className="text-[10px] text-gray-600 px-1 text-center" title={pv?.reason}>
                            {pv?.reason ?? 'no preview'}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-gray-200 truncate" title={realPath}>
                            #{i + 1} {basename(realPath)}
                          </span>
                          <span
                            className="text-xs text-gray-500 shrink-0"
                            title="Vector score (AI) — cosine of this image's stored prompt vector vs the query"
                          >
                            AI <span className="font-mono text-green-400">{(hit.score * 100).toFixed(1)}%</span>
                          </span>
                        </div>
                        <p className="text-[11px] font-mono text-gray-500 mt-0.5 break-all" title={realPath}>
                          {realPath}
                        </p>
                        {promptText ? (
                          <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">
                            &ldquo;{promptText}&rdquo;
                          </p>
                        ) : (
                          <p className="text-[10px] font-mono text-gray-600 mt-0.5" title="Prompt text unknown — no scanned image carries this exact prompt hash">
                            prompt {hit.promptHash.slice(0, 8)}…
                          </p>
                        )}
                        {hit.lexicalScore !== null && (
                          <p
                            className="text-[10px] text-gray-500 mt-0.5"
                            title="Non-AI score: the pre-vector grouping engine's hybrid (jaccard+Levenshtein) between this image's stored prompt and the query — it merges at the fixed 0.85"
                          >
                            lexical vs query:{' '}
                            <span
                              className={`font-mono ${
                                hit.lexicalScore >= LEXICAL_MATCH_THRESHOLD
                                  ? 'text-green-400'
                                  : 'text-gray-400'
                              }`}
                            >
                              {(hit.lexicalScore * 100).toFixed(1)}%
                            </span>
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
