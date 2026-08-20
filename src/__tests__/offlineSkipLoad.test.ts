import { describe, expect, it, vi } from 'vitest';

// Persisted-store tests need a localStorage mock before ANY store import —
// useImageLoader pulls in useImageStore transitively.
vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import { shouldSkipLoadDueToOffline } from '../hooks/useImageLoader';

/**
 * Decision table for the empty-scan safeguard (useImageLoader loadDirectory):
 * an empty directory listing is either "offline — preserve images" or
 * "genuinely empty — proceed (and clear)". Purely a pure-function test.
 */
describe('shouldSkipLoadDueToOffline', () => {
  it('does not skip when files were found (normal path)', () => {
    expect(shouldSkipLoadDueToOffline({ fileCount: 3, cachedImageCount: 0, probeConnected: true })).toBe(false);
  });

  it('skips when the probe says the directory is unreachable (preserve images)', () => {
    expect(shouldSkipLoadDueToOffline({ fileCount: 0, cachedImageCount: 100, probeConnected: false })).toBe(true);
  });

  it('skips when the dir is reachable but the cache still holds images (transient listing failure)', () => {
    expect(shouldSkipLoadDueToOffline({ fileCount: 0, cachedImageCount: 5, probeConnected: true })).toBe(true);
  });

  it('does NOT skip when reachable with no cache — the folder is genuinely empty', () => {
    expect(shouldSkipLoadDueToOffline({ fileCount: 0, cachedImageCount: 0, probeConnected: true })).toBe(false);
  });
});
