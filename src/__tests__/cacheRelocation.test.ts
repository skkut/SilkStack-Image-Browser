// @vitest-environment node
//
// Covers the main-process metadata-cache record relocation
// (electron/cacheRelocation.mjs). The module is pure orchestration over an
// injected IO port, so these tests drive it with an in-memory cache store:
// chunked and legacy-inline layouts, the same-cache (rename) case, cache
// creation, and every skip path. A skip here only costs a re-parse, but a
// WRONG write could corrupt a cache — the layout assertions are the point.
import { describe, it, expect, beforeEach } from 'vitest';

import { relocateCacheRecord } from '../../electron/cacheRelocation.mjs';

const PARSER_VERSION = 4;
const NOW = 1_700_000_000_000;

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

describe('relocateCacheRecord', () => {
  let store: Map<string, FakeCacheEntry>;

  /** In-memory implementation of the CacheRelocationIo port. */
  const io = {
    readMain: async (cacheId: string) => clone(store.get(cacheId)?.main ?? null),
    readChunk: async (cacheId: string, index: number) =>
      clone(store.get(cacheId)?.chunks.get(index) ?? null),
    writeMain: async (cacheId: string, record: FakeMain) => {
      const entry = store.get(cacheId) ?? { main: null, chunks: new Map() };
      entry.main = clone(record);
      store.set(cacheId, entry);
    },
    writeChunk: async (cacheId: string, index: number, records: FakeRecord[]) => {
      const entry = store.get(cacheId) ?? { main: null, chunks: new Map() };
      entry.chunks.set(index, clone(records));
      store.set(cacheId, entry);
    },
  };

  beforeEach(() => {
    store = new Map();
  });

  const seedChunked = (
    cacheId: string,
    chunks: FakeRecord[][],
    overrides: Partial<FakeMain> = {},
  ) => {
    const entry: FakeCacheEntry = { main: null, chunks: new Map() };
    chunks.forEach((chunk, i) => entry.chunks.set(i, chunk));
    entry.main = {
      id: cacheId,
      directoryPath: `C:\\libs\\${cacheId}`,
      directoryName: cacheId,
      lastScan: 1,
      imageCount: chunks.reduce((n, c) => n + c.length, 0),
      chunkCount: chunks.length,
      parserVersion: PARSER_VERSION,
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
        lastScan: 1,
        imageCount: metadata.length,
        metadata,
        parserVersion: PARSER_VERSION,
      },
      chunks: new Map(),
    };
    store.set(cacheId, entry);
    return entry;
  };

  const move = {
    oldImageId: 'C:\\libs\\a::old/pic.png',
    newImageId: 'C:\\libs\\b::new/pic.png',
    oldName: 'old/pic.png',
    newName: 'new/pic.png',
    newLastModified: 999,
  };

  const rec = (id: string, name: string, extra: Partial<FakeRecord> = {}): FakeRecord => ({
    id,
    name,
    lastModified: 111,
    prompt: 'a test prompt',
    ...extra,
  });

  it('rewrites the record in place when source and target cache ids match (rename)', async () => {
    seedChunked('root-recursive', [
      [rec('other-1', 'x.png')],
      [rec(move.oldImageId, move.oldName)],
    ]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'root-recursive',
      targetCacheId: 'root-recursive',
    });

    expect(result).toEqual({ cacheMoved: true });
    const entry = store.get('root-recursive')!;
    expect(entry.main!.imageCount).toBe(2); // unchanged
    expect(entry.main!.chunkCount).toBe(2); // unchanged
    expect(entry.main!.lastScan).toBe(NOW);
    expect(entry.main!.parserVersion).toBe(PARSER_VERSION);
    expect(entry.main!.metadata).toBeUndefined();
    // Unrelated chunk untouched
    expect(entry.chunks.get(0)).toEqual([rec('other-1', 'x.png')]);
    // Record rewritten where it was, old id gone
    expect(entry.chunks.get(1)).toHaveLength(1);
    expect(entry.chunks.get(1)![0]).toMatchObject({
      id: move.newImageId,
      name: move.newName,
      lastModified: 999,
      prompt: 'a test prompt', // unrelated fields preserved
    });
  });

  it('moves a record between chunked caches by appending a new chunk', async () => {
    const source = seedChunked('a-recursive', [
      [rec(move.oldImageId, move.oldName), rec('keep', 'keep.png')],
    ]);
    const target = seedChunked('b-recursive', [[rec('other', 'other.png')]]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
    });

    expect(result).toEqual({ cacheMoved: true });

    // Source: record removed, count decremented, chosen chunk rewritten in place.
    expect(source.main!.imageCount).toBe(1);
    expect(source.main!.chunkCount).toBe(1);
    expect(source.chunks.get(0)).toEqual([rec('keep', 'keep.png')]);

    // Target: appended as chunk index 1, count incremented.
    expect(target.main!.imageCount).toBe(2);
    expect(target.main!.chunkCount).toBe(2);
    expect(target.chunks.get(0)).toEqual([rec('other', 'other.png')]);
    expect(target.chunks.get(1)).toEqual([
      { ...rec(move.oldImageId, move.oldName), id: move.newImageId, name: move.newName, lastModified: 999 },
    ]);
  });

  it('leaves the source chunked record out of every other chunk file', async () => {
    const source = seedChunked('a-recursive', [
      [rec('z', 'z.png')],
      [rec('y', 'y.png')],
      [rec(move.oldImageId, move.oldName)],
    ]);
    seedChunked('b-recursive', [[rec('o', 'o.png')]]);

    await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
    });

    // Only the chunk that held the record changed; the others are byte-identical.
    expect(source.chunks.get(0)).toEqual([rec('z', 'z.png')]);
    expect(source.chunks.get(1)).toEqual([rec('y', 'y.png')]);
    expect(source.chunks.get(2)).toEqual([]);
  });

  it('creates the target cache (chunked, matching cache-data) when it does not exist', async () => {
    seedChunked('a-recursive', [[rec(move.oldImageId, move.oldName)]]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
      targetDirectoryPath: 'C:\\libs\\B',
      targetDirectoryName: 'B',
    });

    expect(result).toEqual({ cacheMoved: true });
    const created = store.get('b-recursive')!;
    expect(created.main).toMatchObject({
      id: 'b-recursive',
      directoryPath: 'C:\\libs\\B',
      directoryName: 'B',
      lastScan: NOW,
      imageCount: 1,
      chunkCount: 1,
      parserVersion: PARSER_VERSION,
    });
    expect(created.main.metadata).toBeUndefined();
    expect(created.chunks.get(0)![0]).toMatchObject({
      id: move.newImageId,
      name: move.newName,
      lastModified: 999,
    });
    // Source record was removed even though the target had to be created.
    expect(store.get('a-recursive')!.main!.imageCount).toBe(0);
    expect(store.get('a-recursive')!.chunks.get(0)).toEqual([]);
  });

  it('preserves the legacy inline layout on both source and target', async () => {
    const source = seedInline('a-flat', [
      rec(move.oldImageId, move.oldName),
      rec('keep', 'keep.png'),
    ]);
    const target = seedInline('b-flat', [rec('other', 'other.png')]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-flat',
      targetCacheId: 'b-flat',
    });

    expect(result).toEqual({ cacheMoved: true });
    expect(source.main!.metadata).toEqual([rec('keep', 'keep.png')]);
    expect(source.main!.imageCount).toBe(1);
    expect(target.main!.metadata).toEqual([
      rec('other', 'other.png'),
      { ...rec(move.oldImageId, move.oldName), id: move.newImageId, name: move.newName, lastModified: 999 },
    ]);
    expect(target.main!.imageCount).toBe(2);
    // Inline caches never grow chunk files.
    expect(target.chunks.size).toBe(0);
    expect(source.chunks.size).toBe(0);
  });

  it('replaces an existing record for the new identity instead of duplicating it', async () => {
    seedChunked('a-recursive', [[rec(move.oldImageId, move.oldName)]]);
    const target = seedChunked('b-recursive', [
      [rec('other', 'other.png')],
      [{ ...rec(move.newImageId, move.newName), prompt: 'stale prompt' }],
    ]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
    });

    expect(result).toEqual({ cacheMoved: true });
    expect(target.main!.imageCount).toBe(2); // unchanged — replaced, not added
    expect(target.main!.chunkCount).toBe(2);
    expect(target.chunks.get(1)).toEqual([
      { ...rec(move.oldImageId, move.oldName), id: move.newImageId, name: move.newName, lastModified: 999 },
    ]);
  });

  it('omits the lastModified rewrite when the move carries no number', async () => {
    seedChunked('a-recursive', [[rec(move.oldImageId, move.oldName)]]);
    seedChunked('b-recursive', [[rec('other', 'other.png')]]);

    await relocateCacheRecord(io, {
      move: { ...move, newLastModified: undefined },
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
    });

    expect(store.get('b-recursive')!.chunks.get(1)![0]).toMatchObject({
      id: move.newImageId,
      name: move.newName,
      lastModified: 111, // the record's own value, untouched
    });
  });

  it.each([
    ['missing source cache', { sourceCacheId: 'nope' }, 'no-source-cache'],
    ['no cache id at all', { sourceCacheId: '' }, 'no-cache-id'],
  ])('skips with reason %s', async (_label, override, reason) => {
    seedChunked('a-recursive', [[rec(move.oldImageId, move.oldName)]]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
      ...override,
    });

    expect(result).toEqual({ cacheMoved: false, reason });
  });

  it('skips when the source cache was written by another parser version', async () => {
    seedChunked('a-recursive', [[rec(move.oldImageId, move.oldName)]], {
      parserVersion: PARSER_VERSION - 1,
    });

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
    });

    expect(result).toEqual({ cacheMoved: false, reason: 'parser-version-mismatch' });
    // The stale cache is left for the normal invalidation path to purge.
    expect(store.get('a-recursive')!.chunks.get(0)).toEqual([rec(move.oldImageId, move.oldName)]);
  });

  it('skips when the record is not in the source cache', async () => {
    seedChunked('a-recursive', [[rec('someone-else', 'other.png')]]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
    });

    expect(result).toEqual({ cacheMoved: false, reason: 'record-not-found' });
    expect(store.get('a-recursive')!.chunks.get(0)).toEqual([rec('someone-else', 'other.png')]);
  });

  it('removes the source record but does not write into an invalid target cache', async () => {
    seedChunked('a-recursive', [[rec(move.oldImageId, move.oldName)]]);
    seedChunked('b-recursive', [[rec('other', 'other.png')]], {
      parserVersion: PARSER_VERSION - 1,
    });

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'a-recursive',
      targetCacheId: 'b-recursive',
    });

    expect(result).toEqual({ cacheMoved: false, reason: 'target-parser-version-mismatch' });
    // Source removal still happened — prevents a ghost entry in the diff.
    expect(store.get('a-recursive')!.chunks.get(0)).toEqual([]);
    // Target left exactly as it was.
    expect(store.get('b-recursive')!.chunks.get(0)).toEqual([rec('other', 'other.png')]);
  });

  it('treats a cache id match case-insensitively (Windows paths)', async () => {
    seedChunked('A-Recursive', [[rec(move.oldImageId, move.oldName)]]);

    const result = await relocateCacheRecord(io, {
      move,
      parserVersion: PARSER_VERSION,
      now: NOW,
      sourceCacheId: 'A-Recursive',
      targetCacheId: 'a-recursive',
    });

    expect(result).toEqual({ cacheMoved: true });
    expect(store.get('A-Recursive')!.chunks.get(0)![0]).toMatchObject({ id: move.newImageId });
    // Never created a second cache keyed by the lowercase spelling.
    expect(store.has('a-recursive')).toBe(false);
  });
});
