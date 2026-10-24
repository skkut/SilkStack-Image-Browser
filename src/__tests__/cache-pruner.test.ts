// @vitest-environment node
//
// Covers per-image pruning of the main-process metadata cache
// (electron/cachePruner.mjs). The module is pure orchestration over an
// injected IO port, so these tests drive it with an in-memory cache store.
//
// The invariants that matter are layout ones: a prune must edit the layout it
// found (legacy inline metadata OR chunked), rewrite only chunks it changed,
// and leave `chunkCount`/`parserVersion`/`lastScan` alone. A wrong write here
// corrupts the cache rather than merely costing a re-parse.
import { beforeEach, describe, expect, it } from 'vitest';

import { pruneCacheEntries } from '../../electron/cachePruner.mjs';

interface FakeRecord {
  id: string;
  name: string;
  lastModified?: number;
  prompt?: string;
  [key: string]: unknown;
}

interface FakeMain {
  id?: string;
  directoryPath?: string;
  directoryName?: string;
  lastScan?: number;
  imageCount?: number;
  chunkCount?: number;
  parserVersion?: number;
  metadata?: FakeRecord[];
  [key: string]: unknown;
}

interface FakeCacheEntry {
  main: FakeMain | null;
  chunks: Map<number, FakeRecord[]>;
}

/** Deep copy through JSON, mirroring what serialize/reparse does to `undefined`. */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe('pruneCacheEntries', () => {
  let store: Map<string, FakeCacheEntry>;
  let chunkWrites: Array<{ cacheId: string; index: number }>;
  let mainWrites: number;

  /** In-memory implementation of the CachePrunerIo port. */
  const io = {
    readMain: async (cacheId: string) => clone(store.get(cacheId)?.main ?? null),
    readChunk: async (cacheId: string, index: number) =>
      clone(store.get(cacheId)?.chunks.get(index) ?? null),
    writeMain: async (cacheId: string, record: FakeMain) => {
      mainWrites += 1;
      const entry = store.get(cacheId) ?? { main: null, chunks: new Map() };
      entry.main = clone(record);
      store.set(cacheId, entry);
    },
    writeChunk: async (cacheId: string, index: number, records: FakeRecord[]) => {
      chunkWrites.push({ cacheId, index });
      const entry = store.get(cacheId) ?? { main: null, chunks: new Map() };
      entry.chunks.set(index, clone(records));
      store.set(cacheId, entry);
    },
  };

  beforeEach(() => {
    store = new Map();
    chunkWrites = [];
    mainWrites = 0;
  });

  const rec = (id: string, name: string, extra: Partial<FakeRecord> = {}): FakeRecord => ({
    id,
    name,
    lastModified: 111,
    prompt: 'a test prompt',
    ...extra,
  });

  const seedChunked = (cacheId: string, chunks: FakeRecord[][], overrides: Partial<FakeMain> = {}) => {
    const entry: FakeCacheEntry = { main: null, chunks: new Map() };
    chunks.forEach((chunk, i) => entry.chunks.set(i, chunk));
    entry.main = {
      id: cacheId,
      directoryPath: `C:\\libs\\${cacheId}`,
      directoryName: cacheId,
      lastScan: 12345,
      imageCount: chunks.reduce((n, chunk) => n + chunk.length, 0),
      chunkCount: chunks.length,
      parserVersion: 4,
      ...overrides,
    };
    store.set(cacheId, entry);
    return entry;
  };

  const seedInline = (cacheId: string, metadata: FakeRecord[]) => {
    const entry: FakeCacheEntry = {
      main: {
        id: cacheId,
        directoryPath: `C:\\libs\\${cacheId}`,
        directoryName: cacheId,
        lastScan: 12345,
        imageCount: metadata.length,
        metadata,
        parserVersion: 4,
      },
      chunks: new Map(),
    };
    store.set(cacheId, entry);
    return entry;
  };

  it('removes entries from the chunks that hold them, and only those chunks', async () => {
    const cacheId = 'C:\\libs\\a-recursive';
    seedChunked(cacheId, [
      [rec('a::keep.png', 'keep.png'), rec('a::gone-1.png', 'gone-1.png')],
      [rec('a::gone-2.png', 'gone-2.png'), rec('a::also-keep.png', 'also-keep.png')],
      [rec('a::untouched.png', 'untouched.png')],
    ]);

    const outcome = await pruneCacheEntries(io, {
      cacheId,
      imageIds: ['a::gone-1.png', 'a::gone-2.png'],
    });

    expect(outcome).toEqual({ removed: 2 });
    expect(store.get(cacheId)!.chunks.get(0)!.map((r) => r.id)).toEqual(['a::keep.png']);
    expect(store.get(cacheId)!.chunks.get(1)!.map((r) => r.id)).toEqual(['a::also-keep.png']);
    expect(store.get(cacheId)!.chunks.get(2)!.map((r) => r.id)).toEqual(['a::untouched.png']);
    // Chunk 2 had nothing to remove — rewriting it would be wasted IO.
    expect(chunkWrites).toEqual([
      { cacheId, index: 0 },
      { cacheId, index: 1 },
    ]);
  });

  it('updates imageCount but preserves the rest of the main record', async () => {
    const cacheId = 'C:\\libs\\a-recursive';
    seedChunked(cacheId, [
      [rec('a::keep.png', 'keep.png'), rec('a::gone.png', 'gone.png')],
    ]);

    await pruneCacheEntries(io, { cacheId, imageIds: ['a::gone.png'] });

    const main = store.get(cacheId)!.main!;
    expect(main.imageCount).toBe(1);
    expect(main.chunkCount).toBe(1);
    expect(main.parserVersion).toBe(4);
    expect(main.lastScan).toBe(12345);
    expect(main.metadata).toBeUndefined();
    expect(mainWrites).toBe(1);
  });

  it('prunes the legacy inline layout without inventing chunk files', async () => {
    const cacheId = 'C:\\libs\\legacy-flat';
    seedInline(cacheId, [
      rec('a::keep.png', 'keep.png'),
      rec('a::gone.png', 'gone.png'),
    ]);

    const outcome = await pruneCacheEntries(io, { cacheId, imageIds: ['a::gone.png'] });

    expect(outcome).toEqual({ removed: 1 });
    expect(store.get(cacheId)!.main!.metadata!.map((r) => r.id)).toEqual(['a::keep.png']);
    expect(store.get(cacheId)!.main!.imageCount).toBe(1);
    expect(store.get(cacheId)!.chunks.size).toBe(0);
    expect(chunkWrites).toEqual([]);
  });

  it('matches ids case- and separator-insensitively', async () => {
    const cacheId = 'C:\\libs\\a-recursive';
    seedChunked(cacheId, [[rec('C:\\Libs\\a::Sub\\Pic.PNG', 'Sub/Pic.PNG')]]);

    const outcome = await pruneCacheEntries(io, {
      cacheId,
      imageIds: ['c:/libs/a::sub/pic.png'],
    });

    expect(outcome).toEqual({ removed: 1 });
    expect(store.get(cacheId)!.chunks.get(0)).toEqual([]);
  });

  it('skips a missing chunk but still prunes the others', async () => {
    const cacheId = 'C:\\libs\\a-recursive';
    const entry = seedChunked(cacheId, [
      [rec('a::gone.png', 'gone.png')],
      [rec('a::also-gone.png', 'also-gone.png')],
    ]);
    entry.chunks.delete(0); // torn/never-written chunk

    const outcome = await pruneCacheEntries(io, {
      cacheId,
      imageIds: ['a::gone.png', 'a::also-gone.png'],
    });

    expect(outcome).toEqual({ removed: 1 });
    expect(store.get(cacheId)!.chunks.get(1)).toEqual([]);
  });

  it('does nothing when the cache does not exist', async () => {
    const outcome = await pruneCacheEntries(io, {
      cacheId: 'C:\\libs\\missing-flat',
      imageIds: ['a::gone.png'],
    });

    expect(outcome).toEqual({ removed: 0, reason: 'no-cache' });
    expect(mainWrites).toBe(0);
    expect(chunkWrites).toEqual([]);
  });

  it('does nothing when no ids were supplied', async () => {
    const cacheId = 'C:\\libs\\a-recursive';
    seedChunked(cacheId, [[rec('a::keep.png', 'keep.png')]]);

    const outcome = await pruneCacheEntries(io, { cacheId, imageIds: [] });

    expect(outcome).toEqual({ removed: 0, reason: 'no-image-ids' });
    expect(mainWrites).toBe(0);
    expect(chunkWrites).toEqual([]);
  });

  it('leaves the cache untouched when no record matches', async () => {
    const cacheId = 'C:\\libs\\a-recursive';
    seedChunked(cacheId, [[rec('a::keep.png', 'keep.png')]]);

    const outcome = await pruneCacheEntries(io, {
      cacheId,
      imageIds: ['a::somebody-else.png'],
    });

    expect(outcome).toEqual({ removed: 0 });
    expect(mainWrites).toBe(0);
    expect(chunkWrites).toEqual([]);
  });

  it('never drives imageCount below zero', async () => {
    const cacheId = 'C:\\libs\\a-recursive';
    seedChunked(cacheId, [[rec('a::gone.png', 'gone.png')]], { imageCount: 0 });

    const outcome = await pruneCacheEntries(io, { cacheId, imageIds: ['a::gone.png'] });

    expect(outcome).toEqual({ removed: 1 });
    expect(store.get(cacheId)!.main!.imageCount).toBe(0);
  });
});
