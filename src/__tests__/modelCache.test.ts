import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyModelFile,
  deleteCachedModel,
  groupModelFiles,
  listCachedModels,
  RUNTIME_LABEL,
  SHARED_LIB_REPO,
} from '../services/modelCache';

// ── helpers ────────────────────────────────────────────────────────────────

const HF = (repo: string, fileName: string, revision = 'main') =>
  `https://huggingface.co/${repo}/resolve/${revision}/${fileName}`;

const EMBED_8B = 'skkut/qwen3-embedding-8b-q4f16_1-MLC';
const HERMES = 'mlc-ai/Hermes-3-Llama-3.2-3B-q4f16_1-MLC';
const SHARED_WASM = 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC-webgpu.wasm';

/** Tiny in-memory Cache stand-in: url → content-length (null = no header). */
function makeFakeCache(initial: Record<string, number | null>) {
  const store = new Map<string, number | null>(Object.entries(initial));
  return {
    keys: async () => [...store.keys()].map((url) => new Request(url)),
    match: async (request: Request) => {
      const size = store.get(request.url);
      if (size === undefined) return undefined;
      return {
        headers: {
          get: (name: string) =>
            name.toLowerCase() === 'content-length' && size != null ? String(size) : null,
        },
      } as unknown as Response;
    },
    delete: async (request: Request) => store.delete(request.url),
    entriesLeft: () => [...store.entries()],
  };
}

function stubCaches(cachesByName: Record<string, ReturnType<typeof makeFakeCache>>) {
  const names = Object.keys(cachesByName);
  vi.stubGlobal('caches', {
    keys: async () => names,
    open: async (name: string) => {
      const cache = cachesByName[name];
      if (!cache) throw new Error(`no cache '${name}'`);
      return cache;
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── classifyModelFile ──────────────────────────────────────────────────────

describe('classifyModelFile', () => {
  it('derives the model label from the repo segment before /resolve/', () => {
    expect(classifyModelFile(HF(EMBED_8B, 'params_shard_0.bin'))).toEqual({
      label: 'qwen3-embedding-8b-q4f16_1-MLC',
      kind: 'model',
    });
    expect(classifyModelFile(HF(HERMES, 'config.json'))).toEqual({
      label: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
      kind: 'model',
    });
  });

  it('accepts commit-hash revisions as well as main', () => {
    expect(classifyModelFile(HF('skkut/qwen3-embedding-4b-q4f16_1-MLC-b2', 'params_shard_1.bin', '1e1efd82'))).toEqual({
      label: 'qwen3-embedding-4b-q4f16_1-MLC-b2',
      kind: 'model',
    });
  });

  it('matches model dirs served from any host (local MLC dev servers too)', () => {
    expect(classifyModelFile(
      'http://localhost:8912/Qwen3-Embedding-WebLLM/dist/qwen3-embedding-8b-q4f16_1-MLC/resolve/main/params_shard_0.bin',
    )).toEqual({ label: 'qwen3-embedding-8b-q4f16_1-MLC', kind: 'model' });
  });

  it('attributes shared-repo wasm to the model named by the file', () => {
    expect(classifyModelFile(HF(SHARED_LIB_REPO, SHARED_WASM))).toEqual({
      label: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
      kind: 'model',
    });
  });

  it('buckets non-model files (CDN/wasm runtime) as the shared runtime row', () => {
    expect(classifyModelFile('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/lib/tvmjs.bundle.wasm')).toEqual({
      label: RUNTIME_LABEL,
      kind: 'other',
    });
    expect(classifyModelFile('https://huggingface.co/mlc-ai/binary-mlc-llm-libs/resolve/main/')).toEqual({
      label: RUNTIME_LABEL,
      kind: 'other',
    });
  });

  it('returns null for unparseable URLs', () => {
    expect(classifyModelFile('not a url')).toBeNull();
    expect(classifyModelFile('')).toBeNull();
  });
});

// ── groupModelFiles ────────────────────────────────────────────────────────

describe('groupModelFiles', () => {
  it('merges shards and shared-repo wasm of one model into a single group', () => {
    const groups = groupModelFiles([
      { url: HF(HERMES, 'params_shard_0.bin'), size: 7 },
      { url: HF(HERMES, 'params_shard_1.bin'), size: 8 },
      { url: HF(SHARED_LIB_REPO, SHARED_WASM), size: 3 },
      { url: HF(EMBED_8B, 'params_shard_0.bin'), size: 100 },
    ]);
    const hermes = groups.find((g) => g.label === 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC');
    expect(hermes).toMatchObject({ kind: 'model', fileCount: 3, bytes: 18 });
    expect(groups.find((g) => g.label === 'qwen3-embedding-8b-q4f16_1-MLC')).toMatchObject({
      kind: 'model',
      fileCount: 1,
      bytes: 100,
    });
  });

  it('keeps an orphaned shared lib as its own deletable model row', () => {
    const groups = groupModelFiles([
      { url: HF(SHARED_LIB_REPO, 'SomeModelId-webgpu.wasm'), size: 9 },
    ]);
    expect(groups).toEqual([
      expect.objectContaining({ label: 'SomeModelId', kind: 'model', fileCount: 1, bytes: 9 }),
    ]);
  });

  it('tracks unknown sizes without poisoning the known byte sums', () => {
    const groups = groupModelFiles([
      { url: HF(EMBED_8B, 'params_shard_0.bin'), size: 100 },
      { url: HF(EMBED_8B, 'params_shard_1.bin'), size: null }, // no content-length
      { url: HF(EMBED_8B, 'config.json'), size: null },
    ]);
    expect(groups[0]).toMatchObject({ fileCount: 3, bytes: 100, hasUnknownSize: true });
  });

  it('skips records that classify to nothing', () => {
    const groups = groupModelFiles([{ url: 'not a url', size: 5 }]);
    expect(groups).toEqual([]);
  });

  it('sorts by bytes desc then label asc, pinning the runtime bucket last', () => {
    const groups = groupModelFiles([
      { url: 'https://cdn.example/tvmjs.bundle.wasm', size: 999 }, // runtime — largest but last
      { url: HF(EMBED_8B, 'params_shard_0.bin'), size: 300 },
      { url: HF('mlc-ai/a-model', 'params_shard_0.bin'), size: 300 }, // ties — label asc
      { url: HF('mlc-ai/b-model', 'params_shard_0.bin'), size: 200 },
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'a-model',
      'qwen3-embedding-8b-q4f16_1-MLC',
      'b-model',
      RUNTIME_LABEL,
    ]);
  });
});

// ── listCachedModels ───────────────────────────────────────────────────────

describe('listCachedModels', () => {
  it('reports unsupported when the Cache API is absent (jsdom)', async () => {
    // No stub → global caches is undefined in the test environment.
    const result = await listCachedModels();
    expect(result).toMatchObject({ supported: false, reason: 'unavailable', groups: [], totalBytes: 0 });
  });

  it('sums sizes across every named cache, counting duplicate URLs once', async () => {
    const cacheA = makeFakeCache({
      [HF(EMBED_8B, 'params_shard_0.bin')]: 100,
      [HF(EMBED_8B, 'params_shard_1.bin')]: 90,
    });
    const cacheB = makeFakeCache({
      [HF(EMBED_8B, 'params_shard_0.bin')]: 100, // same file re-cached in scope B
    });
    stubCaches({ 'webllm/model': cacheA, tvmjs: cacheB });

    const result = await listCachedModels();
    expect(result.supported).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ fileCount: 2, bytes: 190 });
    expect(result.totalBytes).toBe(190);
  });

  it('dedupes query-string variants of the same file', async () => {
    const cacheA = makeFakeCache({ [HF(EMBED_8B, 'params_shard_0.bin')]: 10 });
    const cacheB = makeFakeCache({ [`${HF(EMBED_8B, 'params_shard_0.bin')}?download=1`]: 99 });
    stubCaches({ 'webllm/model': cacheA, tvmjs: cacheB });

    const result = await listCachedModels();
    expect(result.groups[0]).toMatchObject({ fileCount: 1, bytes: 10 });
    expect(result.totalBytes).toBe(10);
  });

  it('flags unknown sizes instead of producing NaN totals', async () => {
    const cacheA = makeFakeCache({
      [HF(EMBED_8B, 'params_shard_0.bin')]: null, // chunked response — no content-length
      [HF(EMBED_8B, 'config.json')]: 3,
    });
    stubCaches({ 'webllm/model': cacheA });

    const result = await listCachedModels();
    expect(result.groups[0]).toMatchObject({ fileCount: 2, bytes: 3, hasUnknownSize: true });
    expect(result.hasUnknownSize).toBe(true);
    expect(result.totalBytes).toBe(3);
    expect(Number.isNaN(result.totalBytes)).toBe(false);
  });

  it('handles empty caches', async () => {
    stubCaches({ 'webllm/model': makeFakeCache({}), tvmjs: makeFakeCache({}) });
    const result = await listCachedModels();
    expect(result).toMatchObject({ supported: true, reason: 'ok', groups: [], totalBytes: 0, hasUnknownSize: false });
  });

  it('reports an enumeration error instead of rejecting', async () => {
    const broken = makeFakeCache({});
    (broken as { keys: unknown }).keys = async () => { throw new Error('boom'); };
    stubCaches({ 'webllm/model': broken });

    const result = await listCachedModels();
    expect(result).toMatchObject({ supported: false, reason: 'error', message: 'boom', groups: [] });
  });

  it('never rejects when caches.open fails', async () => {
    vi.stubGlobal('caches', {
      keys: async () => ['missing'],
      open: async () => { throw new Error('no such cache'); },
    });
    const result = await listCachedModels();
    expect(result).toMatchObject({ supported: false, reason: 'error' });
  });
});

// ── deleteCachedModel ──────────────────────────────────────────────────────

describe('deleteCachedModel', () => {
  it('removes every file of one model across all caches, leaving others intact', async () => {
    const cacheA = makeFakeCache({
      [HF(HERMES, 'params_shard_0.bin')]: 7,
      [HF(HERMES, 'params_shard_1.bin')]: 8,
      [`${HF(EMBED_8B, 'params_shard_0.bin')}?download=1`]: 6,
    });
    const cacheB = makeFakeCache({
      [HF(SHARED_LIB_REPO, SHARED_WASM)]: 3,
      [HF(HERMES, 'config.json')]: 2,
      ['https://cdn.example/tvmjs.bundle.wasm']: 1,
    });
    stubCaches({ 'webllm/model': cacheA, tvmjs: cacheB });

    const { removed } = await deleteCachedModel('Hermes-3-Llama-3.2-3B-q4f16_1-MLC');
    expect(removed).toBe(4); // 2 shards in A; shared-repo wasm + config.json in B
    expect(Object.keys(Object.fromEntries(cacheA.entriesLeft()))).toEqual([
      `${HF(EMBED_8B, 'params_shard_0.bin')}?download=1`,
    ]);
    expect(Object.keys(Object.fromEntries(cacheB.entriesLeft()))).toEqual([
      'https://cdn.example/tvmjs.bundle.wasm',
    ]);
  });

  it('resolves with removed: 0 when the model is not cached', async () => {
    const cacheA = makeFakeCache({ [HF(EMBED_8B, 'params_shard_0.bin')]: 5 });
    stubCaches({ 'webllm/model': cacheA });
    const { removed } = await deleteCachedModel('not-cached-model');
    expect(removed).toBe(0);
  });
});
