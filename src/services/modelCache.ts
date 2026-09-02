/**
 * modelCache.ts — enumerate and delete the model files web-llm keeps in the
 * browser Cache API (CacheStorage) on this app's origin.
 *
 * web-llm fetches every model artifact (weight shards, tokenizer/config JSON,
 * per-model wasm libraries) through `caches.open(...)` keyed by the request
 * URL. Unlike the HTTP disk cache, Cache API entries are never auto-evicted,
 * so superseded and orphaned models accumulate until something removes them.
 *
 * Sizes come from each cached Response's Content-Length header only —
 * response bodies are never materialised (a single 8B-model shard is
 * ~0.3 GB; pulling bodies into memory just to count them would defeat the
 * purpose of freeing disk space).
 */

export interface CachedModelGroup {
  /** Canonical key — equals `label` for models (repo's last path segment). */
  id: string;
  /** Display name: model id (e.g. `qwen3-embedding-8b-q4f16_1-MLC`) or the
   *  shared-runtime bucket label for non-model files. */
  label: string;
  /** 'model' = deletable per-model group; 'other' = shared runtime files
   *  (read-only in the UI — no X button). */
  kind: 'model' | 'other';
  /** Sum of known Content-Lengths over unique files (0 when none known). */
  bytes: number;
  /** Unique cached files in the group (known size or not). */
  fileCount: number;
  /** true when ≥1 file had no usable Content-Length (size is a floor). */
  hasUnknownSize: boolean;
}

export interface CachedModelSummary {
  supported: boolean;
  reason: 'ok' | 'unavailable' | 'error';
  /** Set when reason === 'error'; surfaced verbatim in the UI. */
  message?: string;
  groups: CachedModelGroup[];
  /** Sum of known sizes across all groups. */
  totalBytes: number;
  hasUnknownSize: boolean;
}

/** HF repo that holds the per-model wasm libraries for web-llm's prebuilt
 *  records (weights live in `<owner>/<model-id>`, libs in this one repo). */
export const SHARED_LIB_REPO = 'mlc-ai/binary-mlc-llm-libs';

/** Single read-only bucket for cached files with no model attribution
 *  (tvm/wasm CDN fetches etc.). */
export const RUNTIME_LABEL = 'Shared runtime files';

/** web-llm stores tens to hundreds of shard keys per model; batch Cache API
 *  calls so a big store doesn't stampede the disk. */
const BATCH_SIZE = 8;

interface Classification {
  label: string;
  kind: 'model' | 'other';
}

/** Map a cached request URL to the model group it belongs to.
 *
 *  Model URLs follow the layout `<host>/…/<model>/resolve/<rev>/<file>`
 *  (huggingface.co for first-party and mlc-ai repos, but any host serving a
 *  compiled model dir — e.g. the localhost dev servers used for MLC builds —
 *  matches too). The group label is the path segment right before `resolve`,
 *  which equals the web-llm model id for every record the catalog ships.
 *
 *  Files in the shared-library repo are attributed to the model named by the
 *  file itself (`Hermes-…-MLC-webgpu.wasm` → `Hermes-…-MLC`), so the wasm
 *  merges into the same row as that model's weight shards. Anything that
 *  does not look like a model download lands in the read-only runtime
 *  bucket. Returns null for URLs with no usable signal.
 */
export function classifyModelFile(urlRaw: string): Classification | null {
  let url: URL;
  try {
    url = new URL(urlRaw);
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  // …/resolve/<revision>/<file…> — the segment before `resolve` must be a
  // model dir, the revision a plain token, and at least one file must follow.
  const resolveIdx = segments.indexOf('resolve');
  const revision = segments[resolveIdx + 1];
  const fileName = segments[segments.length - 1] ?? '';
  const hasFile = segments.length > resolveIdx + 2;
  if (
    resolveIdx < 1
    || !revision
    || !/^[A-Za-z0-9._-]{1,64}$/.test(revision)
    || !hasFile
    || fileName === ''
  ) {
    return { label: RUNTIME_LABEL, kind: 'other' };
  }
  const repo = segments.slice(0, resolveIdx).join('/');
  if (repo === SHARED_LIB_REPO) {
    // Shared lib: `…/binary-mlc-llm-libs/resolve/main/<model-id>-webgpu.wasm`
    const modelId = fileName
      .replace(/-(webgpu|tvmjs|mlc)\.wasm$/, '')
      .replace(/\.wasm$/, '');
    return modelId === '' ? null : { label: modelId, kind: 'model' };
  }
  return { label: segments[resolveIdx - 1]!, kind: 'model' };
}

/** Pure grouping core over (url, known-size) records — exported for tests.
 *  URLs that classify to nothing are skipped. Groups sort by size desc,
 *  label asc, with the runtime bucket pinned last. */
export function groupModelFiles(
  records: Array<{ url: string; size: number | null }>,
): CachedModelGroup[] {
  const buckets = new Map<string, { label: string; kind: 'model' | 'other'; bytes: number; fileCount: number; hasUnknownSize: boolean }>();
  for (const { url, size } of records) {
    const classified = classifyModelFile(url);
    if (!classified) continue;
    const existing = buckets.get(classified.label);
    const bucket = existing ?? {
      label: classified.label,
      kind: classified.kind,
      bytes: 0,
      fileCount: 0,
      hasUnknownSize: false,
    };
    bucket.fileCount += 1;
    if (size != null && size >= 0) {
      bucket.bytes += size;
    } else {
      bucket.hasUnknownSize = true;
    }
    buckets.set(classified.label, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'other' ? 1 : -1;
      if (b.bytes !== a.bytes) return b.bytes - a.bytes;
      return a.label.localeCompare(b.label);
    })
    .map((bucket) => ({ id: bucket.label, ...bucket }));
}

/** Enumerate every cached model (or runtime file) with its on-disk size.
 *  Never rejects: environments without the Cache API (jsdom, opaque
 *  `file://` origins) report `supported:false` instead. */
export async function listCachedModels(): Promise<CachedModelSummary> {
  const empty = (reason: 'unavailable' | 'error', message?: string): CachedModelSummary => ({
    supported: false,
    reason,
    message,
    groups: [],
    totalBytes: 0,
    hasUnknownSize: false,
  });
  if (typeof caches === 'undefined' || typeof caches.keys !== 'function') {
    return empty('unavailable');
  }
  try {
    const cacheNames = await caches.keys();
    // Dedupe by host + pathname: the same file can sit in several named
    // caches (web-llm uses scopes like `webllm/model` and `tvmjs`) or under
    // query-string variants — size it once, from the first cache that holds it.
    const seen = new Map<string, { url: string; size: number | null }>();
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      const requests = await cache.keys();
      const fresh: Array<{ key: string; request: Request }> = [];
      for (const request of requests) {
        let url: URL;
        try {
          url = new URL(request.url);
        } catch {
          continue;
        }
        const key = url.host + url.pathname;
        if (!seen.has(key)) {
          seen.set(key, { url: request.url, size: null });
          fresh.push({ key, request });
        }
      }
      for (let i = 0; i < fresh.length; i += BATCH_SIZE) {
        await Promise.all(
          fresh.slice(i, i + BATCH_SIZE).map(async ({ key, request }) => {
            const response = await cache.match(request);
            const header = response?.headers.get('content-length');
            const parsed = header != null && header.trim() !== '' ? Number(header) : NaN;
            const size = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
            const record = seen.get(key);
            if (record) record.size = size;
          }),
        );
      }
    }
    const groups = groupModelFiles([...seen.values()]);
    return {
      supported: true,
      reason: 'ok',
      groups,
      totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0),
      hasUnknownSize: groups.some((group) => group.hasUnknownSize),
    };
  } catch (err) {
    // Opaque origins (sandboxed/file contexts) throw SecurityError on access.
    if ((err as { name?: string })?.name === 'SecurityError') return empty('unavailable');
    return empty('error', err instanceof Error ? err.message : String(err));
  }
}

/** Delete every cached file that belongs to one model (weight shards,
 *  config/tokenizer, and its shared-repo wasm). Rejects on failure; the
 *  caller confirms first and re-lists afterwards. */
export async function deleteCachedModel(modelId: string): Promise<{ removed: number }> {
  if (typeof caches === 'undefined') {
    throw new Error('Cache API is not available in this environment.');
  }
  const cacheNames = await caches.keys();
  let removed = 0;
  for (const cacheName of cacheNames) {
    const cache = await caches.open(cacheName);
    const requests = await cache.keys();
    // Delete the stored Request instances themselves — never URLs we
    // reconstruct — so query-string variants are matched exactly.
    const toDelete = requests.filter((request) => {
      const classified = classifyModelFile(request.url);
      return classified !== null && classified.kind === 'model' && classified.label === modelId;
    });
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      await Promise.all(
        toDelete.slice(i, i + BATCH_SIZE).map(async (request) => {
          if (await cache.delete(request)) removed += 1;
        }),
      );
    }
  }
  return { removed };
}
