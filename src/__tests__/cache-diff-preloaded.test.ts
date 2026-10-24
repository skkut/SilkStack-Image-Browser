import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `validateCacheAndGetDiff` reads the cache itself — a summary plus one chunk
 * per 1024 images — and a cold-start loader has to read the same record to
 * decide whether it can skip the diff entirely. The optional `preloadedCache`
 * argument is how that read is shared instead of repeated.
 *
 * The tri-state is the part worth pinning: `undefined` means "read it
 * yourself", `null` means "there is none". Collapsing the two would silently
 * turn every caller that passed a null into a full re-index on the next load,
 * and the symptom (cold-start behaviour on a warm library) is invisible in any
 * assertion that does not count IPC calls.
 */

// `isElectron` is captured in the CacheManager constructor, so the bridge has
// to exist before the module is imported — hence vi.hoisted.
const api = vi.hoisted(() => {
  const getCacheSummary = vi.fn(async () => ({ success: true, data: null }));
  const getCacheChunk = vi.fn(async () => ({ success: true, data: [] }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    getCacheSummary,
    getCacheChunk,
    getCachedData: vi.fn(async () => ({ success: true, data: null })),
  };
  return { getCacheSummary, getCacheChunk };
});

import { cacheManager, type CacheEntry } from "../services/cacheManager";

function makeEntry(names: string[]): CacheEntry {
  return {
    id: "C:/Images-recursive",
    directoryPath: "C:/Images",
    directoryName: "Images",
    lastScan: 1,
    imageCount: names.length,
    chunkCount: 1,
    metadata: names.map((name) => ({
      id: `dir::${name}`,
      name,
      metadataString: "",
      metadata: {},
      lastModified: 100,
      models: [],
      loras: [],
      scheduler: "",
      enrichmentState: "enriched" as const,
    })),
  };
}

const current = (name: string, lastModified = 100) => ({
  name,
  lastModified,
  size: 10,
  type: "image/png",
});

beforeEach(() => {
  api.getCacheSummary.mockClear();
  api.getCacheChunk.mockClear();
});

describe("validateCacheAndGetDiff with an injected cache", () => {
  it("uses the injected record without reading the cache again", async () => {
    const entry = makeEntry(["a.png"]);

    const diff = await cacheManager.validateCacheAndGetDiff(
      "C:/Images",
      "Images",
      [current("a.png")],
      true,
      undefined,
      entry,
    );

    expect(diff.needsFullRefresh).toBe(false);
    expect(diff.cachedImages.map((i) => i.name)).toEqual(["a.png"]);
    expect(api.getCacheSummary).not.toHaveBeenCalled();
    expect(api.getCacheChunk).not.toHaveBeenCalled();
  });

  it("treats an injected null as 'no cache' without asking again", async () => {
    const files = [current("a.png"), current("b.png")];

    const diff = await cacheManager.validateCacheAndGetDiff(
      "C:/Images",
      "Images",
      files,
      true,
      undefined,
      null,
    );

    expect(diff.needsFullRefresh).toBe(true);
    expect(diff.newAndModifiedFiles.map((f) => f.name)).toEqual(["a.png", "b.png"]);
    expect(diff.cachedImages).toEqual([]);
    expect(api.getCacheSummary).not.toHaveBeenCalled();
  });

  it("still reads the cache itself when nothing is injected", async () => {
    await cacheManager.validateCacheAndGetDiff(
      "C:/Images",
      "Images",
      [current("a.png")],
      true,
    );

    expect(api.getCacheSummary).toHaveBeenCalledTimes(1);
  });

  it("classifies new, modified, catalog-state and deleted files in one pass", async () => {
    const entry = makeEntry(["same.png", "touched.png", "half.png", "gone.png"]);
    entry.metadata[2].enrichmentState = "catalog";

    const diff = await cacheManager.validateCacheAndGetDiff(
      "C:/Images",
      "Images",
      [current("same.png"), current("touched.png", 500), current("half.png"), current("new.png")],
      true,
      undefined,
      entry,
    );

    // Unchanged content is hydrated from the cache...
    expect(diff.cachedImages.map((i) => i.name)).toEqual(["same.png"]);
    // ...everything else has to be read from disk: never seen, newer on disk,
    // or left as a half-built catalog stub by an interrupted run.
    expect(diff.newAndModifiedFiles.map((f) => f.name).sort()).toEqual([
      "half.png",
      "new.png",
      "touched.png",
    ]);
    expect(diff.deletedFileIds).toEqual(["dir::gone.png"]);
    // The same deletions with the timestamp thumbnails are keyed by.
    expect(diff.deletedImages).toEqual([
      { id: "dir::gone.png", lastModified: 100 },
    ]);
    expect(diff.needsFullRefresh).toBe(false);
  });

  it("keeps deletions inside the scanned subfolder", async () => {
    // A refresh of one subfolder must not delete the rest of the library —
    // those files are simply not in the listing it compared against.
    const entry = makeEntry(["sub/a.png", "sub/gone.png", "other/b.png"]);

    const diff = await cacheManager.validateCacheAndGetDiff(
      "C:/Images",
      "Images",
      [current("sub/a.png")],
      true,
      "sub",
      entry,
    );

    expect(diff.deletedFileIds).toEqual(["dir::sub/gone.png"]);
  });
});
