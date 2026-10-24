// The renderer-side purge for deleted images (cacheManager.deleteImageCaches)
// spans two main-process APIs: `delete-thumbnails-batch` (keyed
// `${id}-${lastModified}`) and `delete-cache-entries` (keyed by id, sent for
// both directory cache variants). `isElectron` is captured in the
// CacheManager constructor, so the bridge must exist before the module is
// imported — hence vi.hoisted.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => {
  const deleteThumbnailsBatch = vi.fn(async () => ({
    success: true,
    deletedCount: 0,
  }));
  const deleteCacheEntries = vi.fn(async () => ({
    success: true,
    deletedCount: 0,
  }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    deleteThumbnailsBatch,
    deleteCacheEntries,
  };
  return { deleteThumbnailsBatch, deleteCacheEntries };
});

import { cacheManager } from '../services/cacheManager';

beforeEach(() => {
  api.deleteThumbnailsBatch.mockClear();
  api.deleteCacheEntries.mockClear();
});

describe('cacheManager.deleteImageCaches', () => {
  it('deletes thumbnails by id+lastModified and prunes both cache variants', async () => {
    await cacheManager.deleteImageCaches('C:\\Images', [
      { id: 'C:\\Images::a.png', lastModified: 111 },
      { id: 'C:\\Images::b.png', lastModified: 222 },
    ]);

    expect(api.deleteThumbnailsBatch).toHaveBeenCalledTimes(1);
    expect(api.deleteThumbnailsBatch).toHaveBeenCalledWith([
      'C:\\Images::a.png-111',
      'C:\\Images::b.png-222',
    ]);
    expect(api.deleteCacheEntries).toHaveBeenCalledTimes(1);
    expect(api.deleteCacheEntries).toHaveBeenCalledWith({
      cacheIds: ['C:\\Images-recursive', 'C:\\Images-flat'],
      imageIds: ['C:\\Images::a.png', 'C:\\Images::b.png'],
    });
  });

  it('still prunes the metadata entry when lastModified is unknown', async () => {
    // An image whose timestamp was unavailable cannot name a thumbnail file,
    // but its cache record is id-keyed and must still go.
    await cacheManager.deleteImageCaches('C:\\Images', [
      { id: 'C:\\Images::a.png' },
    ]);

    expect(api.deleteThumbnailsBatch).not.toHaveBeenCalled();
    expect(api.deleteCacheEntries).toHaveBeenCalledWith({
      cacheIds: ['C:\\Images-recursive', 'C:\\Images-flat'],
      imageIds: ['C:\\Images::a.png'],
    });
  });

  it('does nothing for an empty batch', async () => {
    await cacheManager.deleteImageCaches('C:\\Images', []);

    expect(api.deleteThumbnailsBatch).not.toHaveBeenCalled();
    expect(api.deleteCacheEntries).not.toHaveBeenCalled();
  });

  it('swallows IPC failures', async () => {
    api.deleteThumbnailsBatch.mockRejectedValueOnce(new Error('ipc gone'));

    await expect(
      cacheManager.deleteImageCaches('C:\\Images', [
        { id: 'C:\\Images::a.png', lastModified: 111 },
      ]),
    ).resolves.toBeUndefined();
  });
});
