// @vitest-environment jsdom
//
// Covers the pure pieces of the relocation service (src/services/imageRelocation.ts):
// the move builder that turns a `move-files` result set into old→new identities,
// source resolution from the drag payload, and the relocation registry the
// rescan/watcher paths consult. These are the inputs every derived-data re-key
// (annotations, vectors, thumbnails, metadata cache) is keyed by, so an error
// here silently moves the wrong record — the id/name/cache assertions are the point.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildCacheId,
  relativePathPreservingCase,
  buildDragPayload,
  collectRelocationSources,
  buildRelocationMoves,
  beginRelocation,
  endRelocation,
  isRelocatedPath,
  isRelocatedTargetId,
  filterRelocatedTargetIds,
  resetRelocationRegistryForTests,
} from '../services/imageRelocation';
import type { Directory, ImageRelocationMove, IndexedImage } from '../types';

const ROOT_A = 'C:\\libs\\A';
const ROOT_B = 'C:\\libs\\B';

const makeImage = (
  id: string,
  name: string,
  extra: Partial<IndexedImage> = {},
): IndexedImage => {
  const directoryId = extra.directoryId ?? ROOT_A;
  return {
    id,
    name,
    directoryId,
    directoryName: 'A',
    handle: {
      _filePath: `${directoryId}\\${name.split('/').join('\\')}`,
      name: name.split('/').pop(),
      kind: 'file',
    } as unknown as FileSystemFileHandle,
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 111,
    models: [],
    loras: [],
    scheduler: '',
    ...extra,
  } as IndexedImage;
};

const makeDirectory = (id: string, name: string): Directory => ({
  id,
  path: id,
  name,
  handle: {} as FileSystemDirectoryHandle,
});

const makeMove = (extra: Partial<ImageRelocationMove> = {}): ImageRelocationMove => ({
  oldImageId: `${ROOT_A}::old/pic.png`,
  newImageId: `${ROOT_B}::new/pic.png`,
  oldName: 'old/pic.png',
  newName: 'new/pic.png',
  oldAbsolutePath: `${ROOT_A}\\old\\pic.png`,
  newAbsolutePath: `${ROOT_B}\\new\\pic.png`,
  oldLastModified: 111,
  newLastModified: 111,
  targetRootId: ROOT_B,
  ...extra,
});

describe('buildCacheId / relativePathPreservingCase', () => {
  it('builds the cache id shape every cache writer uses', () => {
    expect(buildCacheId(ROOT_A, true)).toBe(`${ROOT_A}-recursive`);
    expect(buildCacheId(ROOT_A, false)).toBe(`${ROOT_A}-flat`);
  });

  it('keeps the original casing of the path under the root', () => {
    expect(relativePathPreservingCase(ROOT_A, 'C:\\libs\\A\\Sub\\Pic.PNG')).toBe('Sub/Pic.PNG');
  });

  it('falls back to the basename when the file is not under the root', () => {
    expect(relativePathPreservingCase(ROOT_A, 'D:\\elsewhere\\pic.png')).toBe('pic.png');
  });
});

describe('buildDragPayload', () => {
  // Every draggable surface (grid card, table row, stack expanded view) drags
  // through this builder: the payload it produces is what the native OS drag
  // hands to ComfyUI/Explorer AND what the sidebar folder drop moves.
  const lone = makeImage(`${ROOT_A}::pic.png`, 'pic.png');
  const nested = makeImage(`${ROOT_A}::sub/pic.png`, 'sub/pic.png');

  it('drags just the image when it is not part of the selection', () => {
    const payload = buildDragPayload(lone, [lone, nested], new Set());

    expect(payload).toHaveLength(1);
    expect(payload[0]).toEqual({
      id: `${ROOT_A}::pic.png`,
      directoryId: ROOT_A,
      sourcePath: `${ROOT_A}\\pic.png`,
      name: 'pic.png',
    });
  });

  it('drags the whole selection when the dragged image is selected', () => {
    const payload = buildDragPayload(
      lone,
      [lone, nested],
      new Set([lone.id, nested.id]),
    );

    expect(payload.map((item) => item.id)).toEqual([lone.id, nested.id]);
    // The relative tail survives into a real path — a recursive-scan image
    // lives in a subfolder, and the drag must name that subfolder.
    expect(payload[1].sourcePath).toBe(`${ROOT_A}\\sub\\pic.png`);
  });

  it('falls back to the lone image when no selected id is in the loaded list', () => {
    // Selection can outlive a filter change; an empty payload would start a
    // drag that drops nothing at all.
    const payload = buildDragPayload(lone, [lone], new Set(['gone::elsewhere.png']));

    expect(payload.map((item) => item.id)).toEqual([lone.id]);
  });

  it('joins with the root\'s own separator so non-Windows roots stay valid', () => {
    const posix = makeImage('/home/me/libs::sub/pic.png', 'sub/pic.png', {
      directoryId: '/home/me/libs',
    });
    const trailing = makeImage(`${ROOT_A}\\::pic.png`, 'pic.png', {
      directoryId: `${ROOT_A}\\`,
    });

    expect(buildDragPayload(posix, [posix], new Set())[0].sourcePath)
      .toBe('/home/me/libs/sub/pic.png');
    // A root stored with a trailing separator must not double it up.
    expect(buildDragPayload(trailing, [trailing], new Set())[0].sourcePath)
      .toBe(`${ROOT_A}\\pic.png`);
  });

  it('round-trips through collectRelocationSources (the drop-side consumer)', () => {
    const payload = buildDragPayload(lone, [lone, nested], new Set([lone.id, nested.id]));

    const sources = collectRelocationSources(
      payload,
      [lone, nested],
      [makeDirectory(ROOT_A, 'A')],
    );

    expect(sources.map((source) => source.id)).toEqual([lone.id, nested.id]);
    expect(sources[0].absolutePath).toBe(`${ROOT_A}\\pic.png`);
  });
});

describe('collectRelocationSources', () => {
  const image = makeImage(`${ROOT_A}::old/pic.png`, 'old/pic.png');

  it('resolves a dragged item to its store image by id', () => {
    const sources = collectRelocationSources(
      [{ sourcePath: 'C:\\libs\\A\\old\\pic.png', name: 'pic.png', id: image.id, directoryId: ROOT_A }],
      [image],
      [makeDirectory(ROOT_A, 'A')],
    );

    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      id: image.id,
      directoryId: ROOT_A,
      name: 'old/pic.png',
      absolutePath: 'C:\\libs\\A\\old\\pic.png',
      lastModified: 111,
    });
  });

  it('falls back to matching by normalized path when the payload carries no id', () => {
    const sources = collectRelocationSources(
      // Forward slashes + different case — the id must still resolve.
      [{ sourcePath: 'c:/libs/a/old/pic.png', name: 'pic.png' }],
      [image],
      [makeDirectory(ROOT_A, 'A')],
    );

    expect(sources.map((source) => source.id)).toEqual([image.id]);
  });

  it('skips external drops (no store image) and dedupes repeated items', () => {
    const sources = collectRelocationSources(
      [
        { sourcePath: 'D:\\external\\other.png', name: 'other.png' },
        { sourcePath: 'C:\\libs\\A\\old\\pic.png', name: 'pic.png', id: image.id },
        { sourcePath: 'C:\\libs\\A\\old\\pic.png', name: 'pic.png', id: image.id },
      ],
      [image],
      [makeDirectory(ROOT_A, 'A')],
    );

    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(image.id);
  });
});

describe('buildRelocationMoves', () => {
  const source = {
    id: `${ROOT_A}::old/pic.png`,
    directoryId: ROOT_A,
    name: 'old/pic.png',
    absolutePath: 'C:\\libs\\A\\old\\pic.png',
    lastModified: 111,
  };

  it('pairs each successful result with its source and both cache ids', () => {
    const moves = buildRelocationMoves({
      results: [
        { sourcePath: 'C:\\libs\\A\\old\\pic.png', targetPath: 'C:\\libs\\B\\sub\\Pic.png', success: true },
      ],
      targetRootId: ROOT_B,
      targetRootName: 'B',
      sources: [source],
      scanSubfoldersByRoot: new Map([
        ['c:/libs/a', false],
        ['c:/libs/b', true],
      ]),
    });

    expect(moves).toEqual([
      {
        oldImageId: `${ROOT_A}::old/pic.png`,
        newImageId: `${ROOT_B}::sub/Pic.png`,
        oldName: 'old/pic.png',
        newName: 'sub/Pic.png',
        oldAbsolutePath: 'C:\\libs\\A\\old\\pic.png',
        newAbsolutePath: 'C:\\libs\\B\\sub\\Pic.png',
        oldLastModified: 111,
        newLastModified: 111,
        targetRootId: ROOT_B,
        targetRootName: 'B',
        sourceCacheId: `${ROOT_A}-flat`,
        targetCacheId: `${ROOT_B}-recursive`,
      },
    ]);
  });

  it('leaves the cache ids undefined when a root has no known scan setting', () => {
    const moves = buildRelocationMoves({
      results: [{ sourcePath: source.absolutePath, targetPath: 'C:\\libs\\B\\pic.png', success: true }],
      targetRootId: ROOT_B,
      sources: [source],
      scanSubfoldersByRoot: new Map(),
    });

    // Undefined cache ids make the cache leg a no-op (the file just re-parses)
    // rather than guessing a cache that may not be the one the loader built.
    expect(moves[0].sourceCacheId).toBeUndefined();
    expect(moves[0].targetCacheId).toBeUndefined();
  });

  it('skips failed moves, external files and no-op paths', () => {
    const moves = buildRelocationMoves({
      results: [
        { sourcePath: source.absolutePath, success: false },
        { sourcePath: 'D:\\external\\other.png', targetPath: 'C:\\libs\\B\\other.png', success: true },
        // Same file, different case + separators → no-op, skipped.
        { sourcePath: source.absolutePath, targetPath: 'C:\\LIBS\\A\\OLD\\PIC.PNG', success: true },
      ],
      targetRootId: ROOT_B,
      sources: [source],
      scanSubfoldersByRoot: new Map(),
    });

    expect(moves).toEqual([]);
  });
});

describe('relocation registry', () => {
  beforeEach(() => {
    resetRelocationRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRelocationRegistryForTests();
  });

  it('tracks both ends of a move and filters its new id out of removals', () => {
    const move = makeMove();
    beginRelocation([move]);

    expect(isRelocatedPath(move.oldAbsolutePath)).toBe(true);
    expect(isRelocatedPath(move.newAbsolutePath)).toBe(true);
    expect(isRelocatedPath('C:\\libs\\A\\unrelated.png')).toBe(false);
    expect(isRelocatedTargetId(move.newImageId)).toBe(true);
    expect(isRelocatedTargetId(move.newImageId.toUpperCase())).toBe(true);
    expect(filterRelocatedTargetIds([move.newImageId, 'other-id'])).toEqual(['other-id']);

    endRelocation([move]);
    // Recently-relocated entries keep protecting the re-key for the watcher's
    // debounce window.
    expect(isRelocatedTargetId(move.newImageId)).toBe(true);
  });

  it('expires entries after the TTL so stale guards never outlive the move', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const move = makeMove();
    beginRelocation([move]);

    expect(isRelocatedTargetId(move.newImageId)).toBe(true);
    vi.setSystemTime(1_000_000 + 61_000);
    expect(isRelocatedTargetId(move.newImageId)).toBe(false);
    expect(isRelocatedPath(move.oldAbsolutePath)).toBe(false);
    expect(filterRelocatedTargetIds([move.newImageId])).toEqual([move.newImageId]);
  });
});
