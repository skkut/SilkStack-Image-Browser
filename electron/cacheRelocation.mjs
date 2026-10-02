/**
 * Metadata-cache record relocation for in-app moves/renames.
 *
 * The JSON metadata cache is owned by the main process. A moved file changes
 * its path-derived imageId (and its root-relative `name`), so without help the
 * source cache reports a deletion and the target cache re-parses the file from
 * scratch. This module moves the already-extracted record between caches
 * instead — the record's `id`/`name`/`lastModified` are rewritten in place, so
 * the target's next `validateCacheAndGetDiff` classifies the file as cached.
 *
 * The module is pure orchestration over an injected IO port (the unit tests
 * drive it with in-memory fakes; main.mjs wires it to the real cache files):
 *
 *   readMain(cacheId)          -> parsed main record | null
 *   readChunk(cacheId, index)  -> record[] | null
 *   writeMain(cacheId, record) -> void   (record includes `metadata` ONLY for
 *                                         the legacy inline layout)
 *   writeChunk(cacheId, index, records) -> void
 *
 * Layout preservation is deliberate: modern caches are chunked (`metadata`
 * lives in `json_cache/{safeCacheId}_{i}.json`, the main file carries
 * `chunkCount`), older ones keep `metadata` inline in the main file, and
 * `getCachedData` prefers inline when both exist. A relocation must never mix
 * the two or the moved record would be invisible to one of the readers.
 *
 * Every failure path returns `{ cacheMoved: false, reason }` rather than
 * throwing: a failed cache move only costs a re-parse (annotations, vectors
 * and thumbnails are preserved by the other relocation legs).
 */

/** Case/separator-insensitive comparison key for paths and ids. */
const toMatchKey = (value) => String(value ?? '').replace(/\\/g, '/').toLowerCase();

/**
 * The filesystem/cache port main.mjs implements with real files and the unit
 * tests implement with in-memory fakes.
 *
 * @typedef {object} CacheRelocationIo
 * @property {(cacheId: string) => Promise<any>} readMain
 *   Parsed main cache record (may carry inline `metadata` + `chunkCount`), or
 *   null when the cache file is missing/unreadable.
 * @property {(cacheId: string, index: number) => Promise<any[]|null>} readChunk
 *   Parsed chunk record array, or null when the chunk file is missing.
 * @property {(cacheId: string, record: any) => Promise<void>} writeMain
 *   Persist a main cache record (`metadata` present only for the legacy
 *   inline layout).
 * @property {(cacheId: string, index: number, records: any[]) => Promise<void>} writeChunk
 *   Persist one chunk file.
 */

/**
 * @typedef {object} CacheRelocationParams
 * @property {{ oldImageId: string, newImageId: string, oldName: string, newName: string, newLastModified?: number }} move
 *   Old → new identity of a single relocated file. `newLastModified`
 *   overwrites the cached record when present.
 * @property {number} parserVersion
 *   Current PARSER_VERSION; a cache written by another parser version is left
 *   alone (it is about to be invalidated anyway).
 * @property {number} [now]
 *   Timestamp written as `lastScan` (injectable for tests).
 * @property {string} sourceCacheId
 *   Cache the record is read from.
 * @property {string} [targetCacheId]
 *   Cache the record is written to; omitted/equal to the source means an
 *   in-place rewrite (rename, or a move within one root).
 * @property {string} [targetDirectoryPath]
 *   `directoryPath` used when the target cache must be created.
 * @property {string} [targetDirectoryName]
 *   `directoryName` used when the target cache must be created.
 */

function findRecordIndex(records, { id, name }) {
  // Exact id first (the common case), then normalized id, then name.
  for (let i = 0; i < records.length; i++) {
    if (records[i] && records[i].id === id) return i;
  }
  const idKey = toMatchKey(id);
  for (let i = 0; i < records.length; i++) {
    if (records[i] && toMatchKey(records[i].id) === idKey) return i;
  }
  const nameKey = toMatchKey(name);
  for (let i = 0; i < records.length; i++) {
    if (records[i] && toMatchKey(records[i].name) === nameKey) return i;
  }
  return -1;
}

/**
 * Read a cache's records into a normalized `{ kind, lists }` shape.
 * `lists[0]` is the inline metadata array for the legacy layout; for chunked
 * caches it is chunk 0 (an empty cache yields `lists: []`).
 */
async function readLists(io, cacheId, main) {
  if (Array.isArray(main.metadata) && main.metadata.length > 0) {
    return { kind: 'inline', lists: [main.metadata] };
  }
  const chunkCount = main.chunkCount ?? 0;
  const lists = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = await io.readChunk(cacheId, i);
    lists.push(Array.isArray(chunk) ? chunk : []);
  }
  return { kind: 'chunked', lists };
}

/**
 * Persist a cache after one of its lists changed.
 * `changedIndex` is the only chunk rewritten (large caches have many chunks).
 * `newList` (optional) appends a chunk that does not exist on disk yet.
 */
async function writeCache(io, cacheId, main, layout, { changedIndex, newList, imageCount, parserVersion, now }) {
  if (layout.kind === 'inline') {
    const metadata = layout.lists[0] ?? [];
    await io.writeMain(cacheId, {
      ...main,
      metadata,
      imageCount: imageCount ?? metadata.length,
      chunkCount: undefined,
      parserVersion,
      lastScan: now,
    });
    return;
  }

  let chunkCount = layout.lists.length;
  if (newList) {
    chunkCount = layout.lists.length; // the appended list's index is length-1
    await io.writeChunk(cacheId, chunkCount - 1, newList);
  } else if (changedIndex !== undefined && changedIndex !== null) {
    await io.writeChunk(cacheId, changedIndex, layout.lists[changedIndex]);
  }

  await io.writeMain(cacheId, {
    ...main,
    metadata: undefined,
    imageCount: imageCount ?? (main.imageCount ?? 0),
    chunkCount,
    parserVersion,
    lastScan: now,
  });
}

/**
 * Move one record between caches (or rewrite it in place when the source and
 * target cache ids match — the rename case, and subfolder→subfolder moves
 * within one root).
 *
 * `move` carries both identities: `{ oldImageId, newImageId, oldName, newName,
 * newLastModified }`.
 *
 * @param {CacheRelocationIo} io
 * @param {CacheRelocationParams} params
 * @returns {Promise<{ cacheMoved: boolean, reason?: string }>}
 */
export async function relocateCacheRecord(io, params) {
  const {
    move,
    parserVersion,
    now = Date.now(),
    sourceCacheId,
    targetCacheId,
    targetDirectoryPath,
    targetDirectoryName,
  } = params;

  if (!sourceCacheId) return { cacheMoved: false, reason: 'no-cache-id' };

  const sourceMain = await io.readMain(sourceCacheId);
  if (!sourceMain) return { cacheMoved: false, reason: 'no-source-cache' };
  if (sourceMain.parserVersion !== parserVersion) {
    return { cacheMoved: false, reason: 'parser-version-mismatch' };
  }

  const sameCache = !targetCacheId || toMatchKey(sourceCacheId) === toMatchKey(targetCacheId);

  const sourceLayout = await readLists(io, sourceCacheId, sourceMain);
  const sourceIndex = sourceLayout.lists.findIndex(
    (list) => findRecordIndex(list, { id: move.oldImageId, name: move.oldName }) !== -1,
  );
  if (sourceIndex === -1) return { cacheMoved: false, reason: 'record-not-found' };

  const recordIndex = findRecordIndex(sourceLayout.lists[sourceIndex], {
    id: move.oldImageId,
    name: move.oldName,
  });
  const record = sourceLayout.lists[sourceIndex][recordIndex];
  if (!record) return { cacheMoved: false, reason: 'record-not-found' };

  const rewritten = {
    ...record,
    id: move.newImageId,
    name: move.newName,
    ...(typeof move.newLastModified === 'number' ? { lastModified: move.newLastModified } : {}),
  };

  if (sameCache) {
    sourceLayout.lists[sourceIndex][recordIndex] = rewritten;
    await writeCache(io, sourceCacheId, sourceMain, sourceLayout, {
      changedIndex: sourceIndex,
      imageCount: sourceMain.imageCount,
      parserVersion,
      now,
    });
    return { cacheMoved: true };
  }

  // Cross-cache: remove from the source, then insert into the target.
  sourceLayout.lists[sourceIndex].splice(recordIndex, 1);
  await writeCache(io, sourceCacheId, sourceMain, sourceLayout, {
    changedIndex: sourceIndex,
    imageCount: Math.max(0, (sourceMain.imageCount ?? 1) - 1),
    parserVersion,
    now,
  });

  const targetCacheIdResolved = targetCacheId;
  let targetMain = await io.readMain(targetCacheIdResolved);

  if (!targetMain) {
    // No target cache yet — create the modern chunked shape, matching what
    // cache-data / appendToCache produce.
    const created = {
      id: targetCacheIdResolved,
      directoryPath: targetDirectoryPath,
      directoryName: targetDirectoryName,
      lastScan: now,
      imageCount: 1,
      chunkCount: 1,
      parserVersion,
    };
    await io.writeChunk(targetCacheIdResolved, 0, [rewritten]);
    await io.writeMain(targetCacheIdResolved, created);
    return { cacheMoved: true };
  }

  if (targetMain.parserVersion !== parserVersion) {
    // The target cache is already invalid (wholesale re-parse upcoming) — the
    // source removal already happened, which is all the diff needs to avoid a
    // stale ghost entry. The moved file just gets re-parsed.
    return { cacheMoved: false, reason: 'target-parser-version-mismatch' };
  }

  const targetLayout = await readLists(io, targetCacheIdResolved, targetMain);

  // If a record for the new identity already exists (stale leftover from an
  // earlier index of this path), replace it rather than duplicating.
  const existingIndex = targetLayout.lists.findIndex(
    (list) => findRecordIndex(list, { id: move.newImageId, name: move.newName }) !== -1,
  );

  if (existingIndex !== -1) {
    const idx = findRecordIndex(targetLayout.lists[existingIndex], {
      id: move.newImageId,
      name: move.newName,
    });
    targetLayout.lists[existingIndex][idx] = rewritten;
    await writeCache(io, targetCacheIdResolved, targetMain, targetLayout, {
      changedIndex: existingIndex,
      imageCount: targetMain.imageCount,
      parserVersion,
      now,
    });
    return { cacheMoved: true };
  }

  if (targetLayout.kind === 'inline') {
    targetLayout.lists[0] = [...(targetLayout.lists[0] ?? []), rewritten];
    await writeCache(io, targetCacheIdResolved, targetMain, targetLayout, {
      imageCount: targetLayout.lists[0].length,
      parserVersion,
      now,
    });
    return { cacheMoved: true };
  }

  // Chunked (or empty): append a fresh chunk.
  targetLayout.lists.push([rewritten]);
  await writeCache(io, targetCacheIdResolved, targetMain, targetLayout, {
    newList: [rewritten],
    imageCount: (targetMain.imageCount ?? 0) + 1,
    parserVersion,
    now,
  });
  return { cacheMoved: true };
}
