// @vitest-environment jsdom
//
// The renderer half of the ghost-thumbnail fix (ThumbnailManager): when main
// reports that a cached thumbnail's source file is gone, the image row must go
// and its caches must be purged — otherwise the grid keeps painting a deleted
// image on every launch. The thumbnail manager is the only path from
// `get-thumbnail` to the store, so these tests drive it through
// `ensureThumbnail` with the cache manager mocked.
//
// `isElectron` and the persisted store both capture module state at import
// time, so the bridge/localStorage mocks must be hoisted.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as unknown as Storage;

  // Older jsdom builds lack object URLs; the success path stores one.
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock-thumbnail'),
    });
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn() });
  }
});

const cache = vi.hoisted(() => {
  const getCachedThumbnail = vi.fn<
    (imageId: string) => Promise<{ blob: Blob | null; sourceMissing: boolean }>
  >();
  const deleteImageCaches = vi.fn<
    (
      directoryPath: string,
      images: Array<{ id: string; lastModified?: number }>,
    ) => Promise<void>
  >();
  return {
    getCachedThumbnail,
    deleteImageCaches,
    cacheThumbnail: vi.fn(async () => undefined),
  };
});

vi.mock('../services/cacheManager', () => ({
  default: cache,
  cacheManager: cache,
}));

import { thumbnailManager } from '../services/thumbnailManager';
import { useImageStore } from '../store/useImageStore';
import type { IndexedImage } from '../types';

const makeImage = (overrides: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id: 'C:\\Images::ghost.png',
    name: 'ghost.png',
    handle: {} as IndexedImage['handle'],
    metadata: {},
    metadataString: '',
    lastModified: 111,
    models: [],
    loras: [],
    scheduler: '',
    directoryId: 'C:\\Images',
    ...overrides,
  }) as IndexedImage;

beforeEach(() => {
  thumbnailManager.flushCachePurges();
  cache.getCachedThumbnail.mockReset();
  cache.deleteImageCaches.mockReset().mockResolvedValue(undefined);
  thumbnailManager.clearAllUrls();
  useImageStore.setState({ images: [], filteredImages: [] });
});

describe('ThumbnailManager and missing source files', () => {
  it('drops the image and purges its caches when the source is gone', async () => {
    const image = makeImage();
    useImageStore.setState({ images: [image], filteredImages: [image] });
    cache.getCachedThumbnail.mockResolvedValue({
      blob: null,
      sourceMissing: true,
    });

    await thumbnailManager.ensureThumbnail(image);
    thumbnailManager.flushCachePurges();

    const state = useImageStore.getState();
    expect(state.images.some((entry) => entry.id === image.id)).toBe(false);
    expect(cache.deleteImageCaches).toHaveBeenCalledWith('C:\\Images', [
      { id: image.id, lastModified: 111 },
    ]);
  });

  it('coalesces the purge for several dropped images in one directory', async () => {
    const first = makeImage();
    const second = makeImage({
      id: 'C:\\Images::other-ghost.png',
      name: 'other-ghost.png',
      lastModified: 222,
    });
    useImageStore.setState({
      images: [first, second],
      filteredImages: [first, second],
    });
    cache.getCachedThumbnail.mockResolvedValue({
      blob: null,
      sourceMissing: true,
    });

    await thumbnailManager.ensureThumbnail(first);
    await thumbnailManager.ensureThumbnail(second);
    thumbnailManager.flushCachePurges();

    expect(cache.deleteImageCaches).toHaveBeenCalledTimes(1);
    expect(cache.deleteImageCaches).toHaveBeenCalledWith('C:\\Images', [
      { id: first.id, lastModified: 111 },
      { id: second.id, lastModified: 222 },
    ]);
    expect(useImageStore.getState().images).toHaveLength(0);
  });

  it('still renders a cached thumbnail whose source exists', async () => {
    const image = makeImage();
    useImageStore.setState({ images: [image], filteredImages: [image] });
    cache.getCachedThumbnail.mockResolvedValue({
      blob: new Blob(['thumb'], { type: 'image/webp' }),
      sourceMissing: false,
    });

    await thumbnailManager.ensureThumbnail(image);

    const state = useImageStore.getState();
    const entry = state.images.find((candidate) => candidate.id === image.id);
    expect(entry?.thumbnailStatus).toBe('ready');
    expect(entry?.thumbnailUrl).toMatch(/^blob:/);
    expect(cache.deleteImageCaches).not.toHaveBeenCalled();
  });

  it('does not drop the relocated successor of a re-keyed image', async () => {
    // An in-app move/rename re-keys the id while a thumbnail read is still in
    // flight; the late "missing" verdict belongs to the OLD path and must not
    // delete the row that now points at the new one.
    const image = makeImage();
    useImageStore.setState({ images: [image], filteredImages: [image] });

    let release: (value: { blob: null; sourceMissing: true }) => void = () => {};
    cache.getCachedThumbnail.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const pending = thumbnailManager.ensureThumbnail(image);
    thumbnailManager.renameEntry(image.id, 'C:\\Images::renamed.png');
    release({ blob: null, sourceMissing: true });
    await pending;
    thumbnailManager.flushCachePurges();

    expect(
      useImageStore.getState().images.some((entry) => entry.id === image.id),
    ).toBe(true);
    expect(cache.deleteImageCaches).not.toHaveBeenCalled();
  });
});
