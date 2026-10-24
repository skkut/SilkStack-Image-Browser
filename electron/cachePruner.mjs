/**
 * Per-image removal from the directory metadata cache.
 *
 * Deleting a file from the library has to delete what the index remembers about
 * it too. The metadata cache is one file per directory, not per image, so a
 * single delete cannot unlink anything — the record's chunk has to be rewritten
 * without it. Without this, the cache keeps a ghost entry until the directory is
 * next scanned, and every reader of that cache (search fields, counts, the
 * delete diff) reports a file that no longer exists.
 *
 * This module is pure orchestration over an injected IO port, exactly like
 * `cacheRelocation.mjs` (the unit tests drive it with an in-memory store;
 * main.mjs wires it to the real cache files):
 *
 *   readMain(cacheId)                   -> parsed main record | null
 *   readChunk(cacheId, index)           -> record[] | null
 *   writeMain(cacheId, record)          -> void
 *   writeChunk(cacheId, index, records) -> void
 *
 * Layout preservation is deliberate. Modern caches are chunked (`metadata`
 * lives in `json_cache/{safeCacheId}_{i}.json`, the main file carries
 * `chunkCount`), older ones keep `metadata` inline in the main file. A prune
 * must edit whichever shape is on disk and leave the other absent, or the
 * reader that prefers inline metadata would see records the chunk layout no
 * longer has.
 *
 * Every failure path returns `{ removed: 0, reason }` rather than throwing: a
 * cache that cannot be pruned only costs a stale entry until the next scan,
 * which rebuilds the directory from the file listing anyway.
 */

/** Case/separator-insensitive comparison key for ids. */
const toMatchKey = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase();

/**
 * The filesystem/cache port main.mjs implements with real files and the unit
 * tests implement with in-memory fakes.
 *
 * @typedef {object} CachePrunerIo
 * @property {(cacheId: string) => Promise<any>} readMain
 *   Parsed main cache record (may carry inline `metadata` + `chunkCount`), or
 *   null when the cache file is missing/unreadable.
 * @property {(cacheId: string, index: number) => Promise<any[]|null>} readChunk
 *   Parsed chunk record array, or null when the chunk file is missing.
 * @property {(cacheId: string, record: any) => Promise<void>} writeMain
 *   Persist a main cache record.
 * @property {(cacheId: string, index: number, records: any[]) => Promise<void>} writeChunk
 *   Persist one chunk file.
 */

/**
 * Remove every record whose `id` is in `imageIds` from one cache.
 *
 * Only chunks that actually contain a removed id are rewritten; a large cache
 * can have dozens of chunks and a delete usually touches one. Chunk indexes are
 * left untouched (an emptied chunk stays on disk) because `chunkCount` and
 * `getCachedData` address chunks positionally.
 *
 * @param {CachePrunerIo} io
 * @param {{ cacheId: string, imageIds: string[] }} params
 * @returns {Promise<{ removed: number, reason?: string }>}
 */
export async function pruneCacheEntries(io, { cacheId, imageIds }) {
  if (!cacheId) return { removed: 0, reason: 'no-cache-id' };

  const wanted = new Set(
    (Array.isArray(imageIds) ? imageIds : []).filter(
      (id) => typeof id === 'string' && id.length > 0,
    ),
  );
  if (wanted.size === 0) return { removed: 0, reason: 'no-image-ids' };

  const main = await io.readMain(cacheId);
  if (!main || typeof main !== 'object' || Array.isArray(main)) {
    return { removed: 0, reason: 'no-cache' };
  }

  // The id at delete time is the exact id the record was written with (both
  // are path-derived from the same scan). A normalized fallback costs almost
  // nothing and covers the Windows case/separator drift that would otherwise
  // leave a ghost entry.
  const wantedKeys = new Set(Array.from(wanted, toMatchKey));
  const isRemoved = (entry) => {
    if (!entry || typeof entry !== 'object') return false;
    if (typeof entry.id === 'string' && wanted.has(entry.id)) return true;
    return typeof entry.id === 'string' && wantedKeys.has(toMatchKey(entry.id));
  };

  let removed = 0;

  // Same layout decision every reader makes (see cacheRelocation.mjs): a
  // non-empty inline `metadata` is the cache; chunks only matter without it.
  if (Array.isArray(main.metadata) && main.metadata.length > 0) {
    const kept = main.metadata.filter((entry) => !isRemoved(entry));
    removed += main.metadata.length - kept.length;
    main.metadata = kept;
  } else {
    const chunkCount = Number.isInteger(main.chunkCount) ? main.chunkCount : 0;
    for (let index = 0; index < chunkCount; index++) {
      const chunk = await io.readChunk(cacheId, index);
      if (!Array.isArray(chunk)) continue; // missing/torn chunk — nothing to prune
      const kept = chunk.filter((entry) => !isRemoved(entry));
      if (kept.length === chunk.length) continue;
      removed += chunk.length - kept.length;
      await io.writeChunk(cacheId, index, kept);
    }
  }

  if (removed === 0) return { removed: 0 };

  // One main-record write at the end, so inline metadata and the image count
  // cannot disagree even when both layouts were present.
  const record = { ...main };
  if (typeof record.imageCount === 'number') {
    record.imageCount = Math.max(0, record.imageCount - removed);
  }
  await io.writeMain(cacheId, record);

  return { removed };
}
