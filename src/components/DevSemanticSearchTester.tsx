import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SemanticSearchCoordinator,
  type SemanticIndexProgress,
  type SemanticSearchStatus,
  type SemanticIndexOptions,
} from '../services/semanticSearchEngine';
import { getAiLoadError, isAiAvailable } from '../services/aiBridge';
import { extractRawMetadataFromFile } from '../services/fileIndexer';
import { loadAllAnnotations } from '../services/imageAnnotationsStorage';
import type { IndexedImage } from '../types';

/**
 * Dev tools page for the semantic search feature (plan §14, Phase 4 verify).
 * Reached via `?devtools=semantic-search`. Uses the REAL coordinator →
 * worker → storage → module stack against a small fixture library so the
 * feature can be exercised end-to-end:
 *
 *   1. Index the fixture library (Δ by textHash — re-indexing is a no-op).
 *   2. Natural-language queries — hits must rank by meaning, not word match.
 *   3. "Index + query" — the query must resolve while the index batch is
 *      still running (worker preemption, §5.1).
 *   4. Clear index → storage + worker index wiped, then re-index.
 */

interface FixtureImage {
  id: string;
  prompt: string;
  tags: string[];
  models: string[];
}

const FIXTURES: FixtureImage[] = [
  { id: 'fixture-fox-snow', prompt: 'a red fox sitting in a snowy forest, digital painting', tags: ['red fox', 'snowy forest', 'digital painting'], models: ['sd-1.5'] },
  { id: 'fixture-cyberpunk', prompt: '1girl, solo, cyberpunk city, neon lights, night rain', tags: ['cyberpunk city', 'neon lights', '1girl'], models: ['sd-1.5'] },
  { id: 'fixture-dragon-castle', prompt: 'a dragon flying over a medieval castle at sunset, fantasy art', tags: ['dragon', 'medieval castle', 'fantasy art'], models: ['sd-1.5'] },
  { id: 'fixture-fisherman', prompt: 'close-up portrait of an old fisherman, weathered skin, dramatic lighting, black and white', tags: ['portrait', 'old fisherman', 'black and white'], models: ['sd-1.5'] },
  { id: 'fixture-cottage', prompt: 'a cozy cottage in a magical forest, soft ambient lighting, fairycore', tags: ['cozy cottage', 'magical forest', 'fairycore'], models: ['sd-1.5'] },
  { id: 'fixture-lion', prompt: 'a majestic lion with a flowing mane, african savanna, golden hour', tags: ['lion', 'african savanna', 'golden hour'], models: ['sd-1.5'] },
  { id: 'fixture-robot', prompt: 'a small cute robot in a garden full of flowers, soft light, studio ghibli style', tags: ['robot', 'garden', 'flowers', 'studio ghibli'], models: ['sd-1.5'] },
  { id: 'fixture-ocean', prompt: 'underwater scene, colorful coral reef, tropical fish, sun rays', tags: ['underwater', 'coral reef', 'tropical fish'], models: ['sd-1.5'] },
  { id: 'fixture-coffee', prompt: 'a cup of coffee on a rustic wooden table, morning light, cozy cafe', tags: ['coffee', 'wooden table', 'cozy cafe'], models: ['sd-1.5'] },
  { id: 'fixture-mountain', prompt: 'a lone hiker on a mountain ridge above the clouds, epic landscape', tags: ['hiker', 'mountain ridge', 'epic landscape'], models: ['sd-1.5'] },
  { id: 'fixture-cat-window', prompt: 'a cat sitting on a windowsill watching the rain, melancholic mood', tags: ['cat', 'windowsill', 'rain'], models: ['sd-1.5'] },
  { id: 'fixture-astronaut', prompt: 'an astronaut floating in space above a glowing earth, stars', tags: ['astronaut', 'space', 'earth'], models: ['sd-1.5'] },
  { id: 'fixture-forest-path', prompt: 'sunlight through pine trees on a forest path, morning mist', tags: ['pine forest', 'sunlight', 'morning mist'], models: ['sd-1.5'] },
  { id: 'fixture-market', prompt: 'a bustling street market with colorful fruit stalls, warm afternoon light', tags: ['street market', 'fruit stalls', 'warm light'], models: ['sd-1.5'] },
  { id: 'fixture-owl', prompt: 'a wise owl perched on a mossy branch at night, full moon', tags: ['owl', 'mossy branch', 'full moon'], models: ['sd-1.5'] },
  { id: 'fixture-train', prompt: 'a steam locomotive crossing a viaduct bridge, autumn landscape', tags: ['steam locomotive', 'viaduct', 'autumn'], models: ['sd-1.5'] },
];

const QUERY_PRESETS = [
  { label: 'Fox in snow', value: 'a red fox in the snow' },
  { label: 'Cyberpunk city', value: 'cyberpunk neon city at night' },
  { label: 'Old portrait', value: 'portrait of an old man with a beard' },
  { label: 'Dragon fantasy', value: 'a dragon above a castle' },
  { label: 'Cozy', value: 'warm cozy place to relax' },
  { label: 'Lion', value: 'lion on the savanna' },
  { label: 'Underwater', value: 'underwater ocean life' },
  { label: 'Cat', value: 'a cat' },
  // Cross-lingual probes: Qwen3-Embedding is multilingual; the CJK entries
  // in the module's QUERY_EXPANSIONS realign these to English doc vocabulary.
  { label: '猫 (cat)', value: '猫' },
  { label: '狗 (dog)', value: '狗' },
  { label: '花 (flower)', value: '花' },
];

const fixtureById = new Map(FIXTURES.map((f) => [f.id, f]));

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

interface QueryResult {
  q: string;
  hits: Array<{ imageId: string; score: number }>;
  elapsed: number;
}

/**
 * Live-tuning helpers stashed from the ai-intelligence module via the same
 * guarded dynamic import the coordinator wrapper uses (absent in
 * open-source builds) — the displayed defaults can never drift from the
 * module's real constants.
 */
interface TuningModuleConsts {
  LEXICAL_BLEND_WEIGHT: number;
  SEMANTIC_SEARCH_TOP_N: number;
  SEMANTIC_PROMPT_WEIGHT: number;
  SEMANTIC_TAG_WEIGHT: number;
  SEMANTIC_MODEL_WEIGHT: number;
  SEMANTIC_TEXT_MAX_CHARS: number;
  /** The isolated test-store DB name (tester↔module contract, exported from index.ts). */
  SEMANTIC_TEST_STORE_DB: string;
  queryContentTokens: (text: string) => string[];
  resolveEmbeddingModel: (modelId?: string) => { searchThreshold: number };
}

/**
 * Per-query tuning overrides. null = leave the engine's default in place
 * (the model's catalog searchThreshold / the module's LEXICAL_BLEND_WEIGHT /
 * SEMANTIC_SEARCH_TOP_N). See ai-intelligence/docs/SEARCH-QUALITY-TUNING.md.
 */
interface TuningState {
  threshold: number | null;
  blend: number | null;
  topN: number | null;
  expand: boolean;
  instruct: boolean;
}

const DEFAULT_TUNING: TuningState = { threshold: null, blend: null, topN: null, expand: true, instruct: true };

/**
 * Index-time text building overrides — the "Indexing parameters" panel.
 * null = the module's default weight/cap (same "default until dragged"
 * pattern as TuningState). These are INDEX-time knobs: they reshape the text
 * that gets embedded, so a run with overrides re-embeds (textHash changes →
 * coordinator Δ). See ai-intelligence/docs/SEARCH-QUALITY-TUNING.md §2.
 */
interface IndexTuningState {
  promptWeight: number | null;
  tagWeight: number | null;
  modelWeight: number | null;
  maxChars: number | null;
}

const DEFAULT_INDEX_TUNING: IndexTuningState = {
  promptWeight: null,
  tagWeight: null,
  modelWeight: null,
  maxChars: null,
};

/** One file entry from listDirectoryFiles (recursive: name = subfolder-relative path). */
interface LibraryFile {
  name: string;
  lastModified: number;
  size: number;
  type: string;
  birthtimeMs?: number;
}

/** Weight → repetition readout for the panel (0 drops the segment). */
function repsLabel(weight: number): string {
  return weight <= 0 ? 'dropped' : `×${Math.max(1, Math.round(weight * 10))}`;
}

/** Slider that shows the engine default until the user drags it. */
function TuningSlider({
  label,
  min,
  max,
  step,
  value,
  defaultValue,
  display,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number | null;
  defaultValue: number;
  display: (v: number) => string;
  onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">{label}</span>
        <span className={`text-xs font-mono ${value === null ? 'text-gray-500' : 'text-blue-300'}`}>
          {value === null ? `default ${display(defaultValue)}` : display(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value ?? defaultValue}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500"
      />
    </div>
  );
}

export default function DevSemanticSearchTester() {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [status, setStatus] = useState<SemanticSearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SemanticIndexProgress | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [preempting, setPreempting] = useState(false);
  const [query, setQuery] = useState(QUERY_PRESETS[0].value);
  const [tuning, setTuning] = useState<TuningState>(DEFAULT_TUNING);
  const [indexTuning, setIndexTuning] = useState<IndexTuningState>(DEFAULT_INDEX_TUNING);
  const [libraryIndexing, setLibraryIndexing] = useState(false);
  const [libraryProgress, setLibraryProgress] = useState<{ current: number; total: number } | null>(null);
  /** Result of the last library scan (shown under the Index button). */
  const [librarySummary, setLibrarySummary] = useState<{ folders: number; files: number } | null>(null);
  /**
   * Search target store. true = the isolated test DB (all test indexing
   * writes here, never the library's); false = the library's production
   * store, read-only from the tester (index actions are disabled).
   */
  const [useTestStore, setUseTestStore] = useState(true);
  /** True while switchStorageDb is re-restoring the worker index. */
  const [storeSwitching, setStoreSwitching] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [log, setLog] = useState<string[]>([]);
  /** imageId → preview info: blob URL when loaded, or a short failure reason. */
  const [previews, setPreviews] = useState<Map<string, { url?: string; reason?: string }>>(new Map());
  /** The currently displayed map — its object URLs are revoked on replace. */
  const previewsRef = useRef<Map<string, { url?: string; reason?: string }>>(new Map());
  /** Bumped per search — a superseded search's late previews are dropped. */
  const searchSeqRef = useRef(0);

  const coordinatorRef = useRef<SemanticSearchCoordinator | null>(null);
  /** Live-tuning constants, filled by the guarded module import in init(). */
  const moduleRef = useRef<TuningModuleConsts | null>(null);

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
   * path fails alone. Revokes the previous result's URLs; a response for a
   * superseded search is dropped (seq guard).
   */
  const loadThumbnails = useCallback(
    async (hits: QueryResult['hits'], seq: number) => {
      const targets = hits
        .slice(0, MAX_RESULT_PREVIEWS)
        .filter((h) => !fixtureById.has(h.imageId))
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
  const openInViewer = useCallback(
    (hits: QueryResult['hits'], index: number) => {
      const hit = hits[index];
      if (!hit || fixtureById.has(hit.imageId)) return; // no file on disk
      if (!window.electronAPI?.openImageViewer) return;
      const imageList = hits
        .filter((h) => !fixtureById.has(h.imageId))
        .map((h) => {
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
    },
    [],
  );

  // Apply theme on mount (same pattern as DevAutoTaggingTester)
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
              'The ai-intelligence package must be installed for semantic search. ' +
              (errMsg ? `(${errMsg})` : ''),
          );
        }
        return;
      }

      // Stash live-tuning constants from the module (same guarded dynamic
      // import as the coordinator wrapper — dead-code-eliminated when the
      // module is absent at build time). Absence is already reported above.
      if (import.meta.env.VITE_AI_FEATURES_AVAILABLE) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mod = (await import('@ai-images-browser/ai-intelligence')) as any;
          if (!cancelled) {
            moduleRef.current = {
              LEXICAL_BLEND_WEIGHT: mod.LEXICAL_BLEND_WEIGHT,
              SEMANTIC_SEARCH_TOP_N: mod.SEMANTIC_SEARCH_TOP_N,
              SEMANTIC_PROMPT_WEIGHT: mod.SEMANTIC_PROMPT_WEIGHT,
              SEMANTIC_TAG_WEIGHT: mod.SEMANTIC_TAG_WEIGHT,
              SEMANTIC_MODEL_WEIGHT: mod.SEMANTIC_MODEL_WEIGHT,
              SEMANTIC_TEXT_MAX_CHARS: mod.SEMANTIC_TEXT_MAX_CHARS,
              // Fallback must stay in sync with the module's constant — it
              // only ever matters if the export above is ever dropped.
              SEMANTIC_TEST_STORE_DB: mod.SEMANTIC_TEST_STORE_DB ?? 'image-metahub-semantic-test',
              queryContentTokens: mod.queryContentTokens,
              resolveEmbeddingModel: mod.resolveEmbeddingModel,
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
      // Third positional arg = the isolated test DB — test indexing never
      // touches the library's production store from day one. Switching to
      // the library store is the Retrieval-tuning checkbox (handleToggleStore).
      const coordinator = new SemanticSearchCoordinator(
        (p) => {
          if (!cancelled) setProgress(p);
        },
        undefined,
        moduleRef.current?.SEMANTIC_TEST_STORE_DB,
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

  const handleIndexFixtures = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    // Index actions are test-store-only: they must never write to the
    // library's production store.
    if (!coordinator || loadState !== 'ready' || indexing || !useTestStore) return;
    setIndexing(true);
    setError(null);
    try {
      const images = FIXTURES.map((f) => ({ ...f })) as unknown as IndexedImage[];
      const start = performance.now();
      const result = await coordinator.indexImages(images);
      refreshStatus(coordinator);
      appendLog(
        `indexed ${result.indexed} fixture(s) (+${result.skipped} unchanged) in ${Math.round(performance.now() - start)}ms`,
      );
    } catch (err) {
      setError(`Indexing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIndexing(false);
      setProgress(null);
    }
  }, [loadState, indexing, useTestStore, appendLog, refreshStatus]);

  const handleSearch = useCallback(
    async (text?: string) => {
      const coordinator = coordinatorRef.current;
      const q = (text ?? query).trim();
      if (!coordinator || loadState !== 'ready' || !q) return;
      setSearching(true);
      setError(null);
      const seq = ++searchSeqRef.current;
      const start = performance.now();

      // Live-tuning overrides — only send what differs from the engine
      // defaults (null = engine default, resolved worker-side).
      const options: {
        threshold?: number;
        limit?: number;
        blendWeight?: number;
        expandQuery?: boolean;
        applyInstruction?: boolean;
      } = {};
      if (tuning.threshold !== null) options.threshold = tuning.threshold;
      if (tuning.topN !== null) options.limit = tuning.topN;
      if (tuning.blend !== null) options.blendWeight = tuning.blend;
      if (!tuning.expand) options.expandQuery = false;
      if (!tuning.instruct) options.applyInstruction = false;
      const hasOverrides = Object.keys(options).length > 0;
      if (hasOverrides) appendLog(`search overrides: ${JSON.stringify(options)}`);

      try {
        const hits = await coordinator.search(q, hasOverrides ? options : undefined);
        setResult({ q, hits, elapsed: Math.round(performance.now() - start) });
        void loadThumbnails(hits, seq); // fire-and-forget; seq guard drops late responses
      } catch (err) {
        setError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSearching(false);
      }
    },
    [loadState, query, tuning, loadThumbnails, appendLog],
  );

  const handleResetTuning = useCallback(() => {
    setTuning(DEFAULT_TUNING);
    appendLog('retrieval tuning reset to engine defaults');
  }, [appendLog]);

  const handleResetIndexTuning = useCallback(() => {
    setIndexTuning(DEFAULT_INDEX_TUNING);
    appendLog('indexing tuning reset to engine defaults');
  }, [appendLog]);

  /**
   * Index the REAL library — every image in the app's configured folders —
   * into the shared persisted store, using the selected indexing parameters.
   * Replicates the main app's pipeline exactly (same enumeration, same
   * parser, same id convention), so the tester's store overlays the app's:
   *
   *   folders:  localStorage 'image-metahub-directories' (shared session)
   *   files:    listDirectoryFiles({dirPath, recursive}) — `name` is the
   *             subfolder-relative path, forward slashes (app convention)
   *   paths:    joinPathsBatch — path.resolve(basePath, relativeName)
   *   metadata: extractRawMetadataFromFile — the SAME parser the app's
   *             indexer uses (prompt/models), via the readFile IPC
   *   tags:     loadAllAnnotations() from the shared IndexedDB, merged the
   *             way the app does (dedupe union of tags + autoTags + metadataTags)
   *   ids:      `${dirPath}::${relativePath}` — the persisted convention
   *
   * Metadata extraction runs in small concurrent chunks per folder; a file
   * that fails to parse still indexes with whatever tags it has.
   */
  const handleIndexLibrary = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || loadState !== 'ready' || libraryIndexing || indexing || preempting) return;
    if (!useTestStore) return; // index actions are test-store-only
    if (!window.electronAPI?.listDirectoryFiles) {
      setError('Library indexing requires the Electron app (listDirectoryFiles IPC).');
      return;
    }
    setLibraryIndexing(true);
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

      // 2. Annotations once — tag merging needs them for every image.
      const annotations = await loadAllAnnotations();

      // 3. Enumerate every folder, then extract metadata per file.
      const images: Array<{ id: string; prompt?: string; tags: string[]; models?: string[] }> = [];
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
            const annotation = annotations.get(id);
            const tags = annotation
              ? [
                  ...new Set([
                    ...(annotation.tags ?? []),
                    ...(annotation.autoTags ?? []),
                    ...(annotation.metadataTags ?? []),
                  ]),
                ]
              : [];
            const metaResult = metas[i];
            const meta = metaResult.status === 'fulfilled' ? metaResult.value : null;
            images.push({
              id,
              prompt: meta?.prompt,
              tags,
              models: meta?.models ?? (meta?.model ? [meta.model] : undefined),
            });
          }
          done += slice.length;
          if (done % 25 === 0 || done === total) {
            setLibraryProgress({ current: done, total });
          }
        }
      }
      setLibraryProgress(null);
      setLibrarySummary({ folders: folders.length, files: images.length });
      if (images.length === 0) {
        appendLog('library scan found no image/video files');
        return;
      }

      // 4. Index with the selected parameters (only non-default overrides).
      const options: SemanticIndexOptions = {};
      if (indexTuning.promptWeight !== null) options.promptWeight = indexTuning.promptWeight;
      if (indexTuning.tagWeight !== null) options.tagWeight = indexTuning.tagWeight;
      if (indexTuning.modelWeight !== null) options.modelWeight = indexTuning.modelWeight;
      if (indexTuning.maxChars !== null) options.maxChars = indexTuning.maxChars;
      const hasOverrides = Object.keys(options).length > 0;
      if (hasOverrides) appendLog(`index overrides: ${JSON.stringify(options)}`);

      const start = performance.now();
      const result = await coordinator.indexImages(
        images as unknown as IndexedImage[],
        hasOverrides ? options : undefined,
      );
      refreshStatus(coordinator);
      appendLog(
        `library: ${images.length} image(s) → indexed ${result.indexed}, skipped ${result.skipped} in ${Math.round(performance.now() - start)}ms`,
      );
    } catch (err) {
      setError(`Library indexing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLibraryIndexing(false);
      setLibraryProgress(null);
    }
  }, [loadState, libraryIndexing, indexing, preempting, indexTuning, useTestStore, appendLog, refreshStatus]);

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
        `Semantic search failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [loadState, appendLog]);

  /** §5.1 preemption check: a query fired mid-index must resolve first. */
  const handlePreemptDemo = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || loadState !== 'ready' || preempting || !useTestStore) return;
    setPreempting(true);
    setError(null);
    try {
      const many = Array.from({ length: 60 }, (_, i) => ({ ...FIXTURES[i % FIXTURES.length] }));
      appendLog('preemption demo: starting 60-image index...');
      const indexPromise = coordinator.indexImages(many as unknown as IndexedImage[]);
      // Fire the query while the first embed batch is in flight.
      setTimeout(() => {
        void coordinator.search('a red fox in the snow').then((hits) => {
          appendLog(`query resolved with ${hits.length} hit(s) WHILE indexing — preemption OK`);
        });
      }, 100);
      const result = await indexPromise;
      refreshStatus(coordinator);
      appendLog(`index finished: ${result.indexed} embedded, ${result.skipped} skipped`);
    } catch (err) {
      setError(`Preemption demo failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreempting(false);
      setProgress(null);
    }
  }, [loadState, preempting, useTestStore, appendLog, refreshStatus]);

  const handleClearIndex = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    // Test-store-only: clearing the library store is Settings → Re-index in
    // the main app — the tester must never wipe production vectors.
    if (!coordinator || !useTestStore) return;
    setError(null);
    try {
      await coordinator.clearIndex();
      refreshStatus(coordinator);
      appendLog('test index cleared (store + worker heap)');
    } catch (err) {
      setError(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [appendLog, refreshStatus, useTestStore]);

  /**
   * Toggle the search store (Retrieval tuning checkbox): isolated test DB
   * ↔ the library's production DB. switchStorageDb settles pending work
   * and re-restores the worker index from the target DB chunked, so
   * subsequent searches hit the new store. On failure the state is left
   * untouched → the checkbox stays on the old value (automatic revert).
   * In library mode the tester is read-only: search (and previews) only.
   */
  const handleToggleStore = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || storeSwitching) return;
    const target = !useTestStore; // the value we're switching TO
    setStoreSwitching(true);
    setError(null);
    const testStoreName = moduleRef.current?.SEMANTIC_TEST_STORE_DB ?? 'image-metahub-semantic-test';
    try {
      await coordinator.switchStorageDb(target ? testStoreName : undefined);
      setUseTestStore(target);
      refreshStatus(coordinator);
      // Hits from the previous store would be presented as current — clear.
      setResult(null);
      appendLog(
        target
          ? 'search store → TEST (isolated DB — test indexing only lands here)'
          : 'search store → LIBRARY (production DB — read-only from the tester)',
      );
    } catch (err) {
      setError(`Store switch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStoreSwitching(false);
    }
  }, [useTestStore, storeSwitching, appendLog, refreshStatus]);

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

  // Effective values for the tuning panel: engine/model defaults until the
  // user drags a slider (module constants come from the guarded import).
  const effBlend = tuning.blend ?? moduleRef.current?.LEXICAL_BLEND_WEIGHT ?? 0.15;
  const effTopN = tuning.topN ?? moduleRef.current?.SEMANTIC_SEARCH_TOP_N ?? 200;
  const modelThreshold =
    moduleRef.current?.resolveEmbeddingModel(status?.modelId ?? undefined).searchThreshold ?? 0.45;
  const nQ = moduleRef.current ? moduleRef.current.queryContentTokens(query).length : 0;
  const blendScale = nQ > 0 ? effBlend / nQ : 0;

  // Effective index-time defaults: module constants until the user drags.
  const effPromptW = indexTuning.promptWeight ?? moduleRef.current?.SEMANTIC_PROMPT_WEIGHT ?? 1.0;
  const effTagW = indexTuning.tagWeight ?? moduleRef.current?.SEMANTIC_TAG_WEIGHT ?? 0.8;
  const effModelW = indexTuning.modelWeight ?? moduleRef.current?.SEMANTIC_MODEL_WEIGHT ?? 0.5;
  const effMaxChars = indexTuning.maxChars ?? moduleRef.current?.SEMANTIC_TEXT_MAX_CHARS ?? 1600;

  // The isolated test DB name (module contract; fallback stays in sync).
  const testStoreName = moduleRef.current?.SEMANTIC_TEST_STORE_DB ?? 'image-metahub-semantic-test';
  /** Index actions are test-store-only — the checkbox in Retrieval tuning gates them. */
  const storeBusy = storeSwitching || indexing || libraryIndexing || preempting;

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
            Semantic Search Test
            <span className="px-2 py-0.5 text-xs font-mono bg-gray-800 text-gray-400 rounded-md border border-gray-700 font-normal">
              {status?.modelId ?? 'qwen3-embedding-4b'}
            </span>
            <span
              className={`px-2 py-0.5 text-xs font-mono rounded-md border font-normal ${
                useTestStore
                  ? 'bg-blue-900/40 text-blue-300 border-blue-800'
                  : 'bg-gray-800 text-gray-300 border-gray-700'
              }`}
              title={useTestStore ? 'Searching the isolated test DB' : 'Searching the library production DB (read-only)'}
            >
              {useTestStore ? 'test store' : 'library store'}
            </span>
          </h1>
          <p className="text-sm text-gray-500">Natural-language search over prompts/tags — local via WebLLM</p>
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

          {/* Indexing card */}
          <div className={`${cardClass} shrink-0`}>
            <div className="flex items-center gap-4">
              <button
                onClick={handleIndexFixtures}
                disabled={loadState !== 'ready' || indexing || preempting || !useTestStore}
                className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {indexing ? 'Indexing...' : 'Index fixture library'}
              </button>
              <button
                onClick={handlePreemptDemo}
                disabled={loadState !== 'ready' || indexing || preempting || !useTestStore}
                className="px-5 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {preempting ? 'Running...' : 'Index 60 + query mid-run'}
              </button>
              <button
                onClick={handleClearIndex}
                disabled={loadState === 'loading' || indexing || preempting || !useTestStore}
                className={btnChipClass}
              >
                Clear index
              </button>
              <span className="text-xs text-gray-500 ml-auto">{FIXTURES.length} fixture images</span>
            </div>
            <p className={labelClass + ' mt-4 mb-0'}>
              Indexing is Δ by textHash — re-running is a no-op unless fixture text changes. Index
              actions write to the isolated test store only (see the store toggle in Retrieval
              tuning) — the library store is never written by the tester.
            </p>
          </div>

          {/* Indexing parameters card */}
          <div className={`${cardClass} shrink-0`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-200">Indexing parameters</h3>
              <button onClick={handleResetIndexTuning} className={btnChipClass}>
                Reset to defaults
              </button>
            </div>
            <div className="space-y-4">
              <TuningSlider
                label="Prompt weight (segment repetition)"
                min={0}
                max={2}
                step={0.05}
                value={indexTuning.promptWeight}
                defaultValue={effPromptW}
                display={(v) => `${v.toFixed(2)} → ${repsLabel(v)}`}
                onChange={(v) => setIndexTuning({ ...indexTuning, promptWeight: v })}
              />
              <TuningSlider
                label="Tags weight (segment repetition)"
                min={0}
                max={2}
                step={0.05}
                value={indexTuning.tagWeight}
                defaultValue={effTagW}
                display={(v) => `${v.toFixed(2)} → ${repsLabel(v)}`}
                onChange={(v) => setIndexTuning({ ...indexTuning, tagWeight: v })}
              />
              <TuningSlider
                label="Models weight (segment repetition)"
                min={0}
                max={2}
                step={0.05}
                value={indexTuning.modelWeight}
                defaultValue={effModelW}
                display={(v) => `${v.toFixed(2)} → ${repsLabel(v)}`}
                onChange={(v) => setIndexTuning({ ...indexTuning, modelWeight: v })}
              />
              <TuningSlider
                label="Max chars (global cap on built text)"
                min={100}
                max={3000}
                step={50}
                value={indexTuning.maxChars}
                defaultValue={effMaxChars}
                display={(v) => `${Math.round(v)} chars`}
                onChange={(v) => setIndexTuning({ ...indexTuning, maxChars: v })}
              />
            </div>
            <p className="text-[11px] text-gray-500 mt-3">
              effective:{' '}
              <span className="font-mono text-gray-400">
                prompt {repsLabel(effPromptW)} · tags {repsLabel(effTagW)} · models {repsLabel(effModelW)}
              </span>{' '}
              · cap <span className="font-mono text-gray-400">{effMaxChars}</span>
            </p>
            <div className="flex items-center gap-4 mt-4">
              <button
                onClick={handleIndexLibrary}
                disabled={loadState !== 'ready' || libraryIndexing || indexing || preempting || !useTestStore}
                className="px-5 py-2 bg-amber-600 text-white text-sm font-medium rounded-lg hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {libraryIndexing ? 'Indexing library...' : 'Index all library images'}
              </button>
              {libraryProgress && (
                <span className="text-xs text-gray-400">
                  reading {libraryProgress.current}/{libraryProgress.total} files...
                </span>
              )}
              <span className="text-xs text-gray-500 ml-auto">
                {librarySummary
                  ? `${librarySummary.folders} folder(s), ${librarySummary.files} image(s) found`
                  : "scans the app's configured folders"}
              </span>
            </div>
            <p className="text-[11px] text-gray-600 mt-3">
              Index-time only — rebuilds the searchable text with these weights and re-indexes the
              REAL library into the isolated TEST store ({testStoreName}); the library store is
              never written by the tester. Changing a weight re-embeds (textHash changes). Custom
              weights persist in the test DB — the app's startup Δ only self-heals the library
              store. See ai-intelligence/docs/SEARCH-QUALITY-TUNING.md §2 and §5.1.
            </p>
          </div>

          {/* Query card */}
          <div className={`${cardClass} shrink-0`}>
            <label className={labelClass}>Natural-language query</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              className={inputClass}
              placeholder='e.g. "a red fox in the snow"'
            />
            <div className="flex flex-wrap gap-2 mt-3">
              {QUERY_PRESETS.map((p) => (
                <button key={p.label} onClick={() => handleSearch(p.value)} className={btnPresetClass}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-4">
              <button
                onClick={() => handleSearch()}
                disabled={loadState !== 'ready' || searching || !query.trim()}
                className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {searching ? 'Searching...' : 'Search'}
              </button>
              <span className="text-xs text-gray-400 ml-auto">
                Queries preempt a running index batch (worker §5.1)
              </span>
            </div>
          </div>

          {/* Retrieval tuning card */}
          <div className={`${cardClass} shrink-0`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-200">Retrieval tuning</h3>
              <button onClick={handleResetTuning} className={btnChipClass}>
                Reset to defaults
              </button>
            </div>
            <div className="mb-4 pb-4 border-b border-gray-800">
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useTestStore}
                  disabled={storeBusy}
                  onChange={handleToggleStore}
                  className="accent-blue-500"
                />
                Search from isolated test store
              </label>
              <p className="text-[11px] text-gray-500 mt-1">
                {useTestStore
                  ? `Test indexing lives in its own DB (${testStoreName}) — the library's production store is untouched.`
                  : 'Searching the library production DB — read-only: index actions and clear are disabled.'}
                {storeSwitching && <span className="text-blue-300"> Switching… (re-restoring worker index)</span>}
              </p>
            </div>
            <div className="space-y-4">
              <TuningSlider
                label="Threshold (min cosine for a hit)"
                min={0.3}
                max={0.8}
                step={0.005}
                value={tuning.threshold}
                defaultValue={modelThreshold}
                display={(v) => v.toFixed(3)}
                onChange={(v) => setTuning({ ...tuning, threshold: v })}
              />
              <TuningSlider
                label="Lexical blend weight (exact-word boost)"
                min={0}
                max={0.5}
                step={0.005}
                value={tuning.blend}
                defaultValue={effBlend}
                display={(v) => v.toFixed(3)}
                onChange={(v) => setTuning({ ...tuning, blend: v })}
              />
              <TuningSlider
                label="Top-N (max hits returned)"
                min={1}
                max={500}
                step={5}
                value={tuning.topN}
                defaultValue={effTopN}
                display={(v) => String(Math.round(v))}
                onChange={(v) => setTuning({ ...tuning, topN: v })}
              />
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tuning.expand}
                    onChange={(e) => setTuning({ ...tuning, expand: e.target.checked })}
                    className="accent-blue-500"
                  />
                  Query expansion (hypernym / CJK)
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={tuning.instruct}
                    onChange={(e) => setTuning({ ...tuning, instruct: e.target.checked })}
                    className="accent-blue-500"
                  />
                  Qwen3 instruction prefix
                </label>
              </div>
              <p className="text-[11px] text-gray-500">
                lexical tokens: <span className="font-mono text-gray-400">{nQ}</span>
                {nQ > 0 ? (
                  <>
                    {' '}
                    → blend scale{' '}
                    <span className="font-mono text-gray-400">{blendScale.toFixed(3)}</span> per matched
                    token
                  </>
                ) : (
                  <> → lexical blend off (non-Latin query)</>
                )}
              </p>
            </div>
            <p className="text-[11px] text-gray-600 mt-3">
              Query-time only — applies to the next search, no re-index. See
              ai-intelligence/docs/SEARCH-QUALITY-TUNING.md §1.
            </p>
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
                {searching ? 'Searching...' : 'Run a query to see ranked hits.'}
              </span>
            ) : result.hits.length === 0 ? (
              <span className="text-sm text-gray-500">
                No hits above the model's search threshold for “{result.q}”.
              </span>
            ) : (
              <div className="space-y-2 overflow-y-auto scrollbar-adaptive">
                {result.hits.map((hit, i) => {
                  const fixture = fixtureById.get(hit.imageId);
                  const isReal = !fixture;
                  const realPath = isReal ? filePathFromImageId(hit.imageId) : '';
                  const pv = previews.get(hit.imageId);
                  const thumbUrl = pv?.url;
                  return (
                    <div
                      key={hit.imageId}
                      onDoubleClick={() => openInViewer(result.hits, i)}
                      title={isReal ? 'Double-click to open in Image Modal' : 'Fixture — no file on disk'}
                      className="p-3 bg-gray-950 border border-gray-800 rounded-lg flex gap-3 cursor-pointer select-none"
                    >
                      {/* Preview: real library images render from IPC-read blob
                          URLs; fixtures have no file on disk — honest label. */}
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
                            {isReal ? (pv?.reason ?? 'no preview') : 'fixture'}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium text-gray-200 truncate" title={isReal ? realPath : undefined}>
                            #{i + 1} {isReal ? basename(realPath) : (fixture?.id ?? hit.imageId)}
                          </span>
                          <span className="text-xs font-mono text-green-400 shrink-0">
                            {(hit.score * 100).toFixed(1)}%
                          </span>
                        </div>
                        {isReal && (
                          <p className="text-[11px] font-mono text-gray-500 mt-0.5 break-all" title={realPath}>
                            {realPath}
                          </p>
                        )}
                        {fixture?.prompt && (
                          <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{fixture.prompt}</p>
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
