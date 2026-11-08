/**
 * alwaysShowFilenames persistence tests — default, round-trip, factory reset,
 * and the rehydration backfill for settings persisted before the switch
 * existed.
 *
 * Same shape as the autoplayVideoPreviews suite: the store is imported
 * DYNAMICALLY after vi.resetModules() for the rehydration cases (the persist
 * middleware hydrates once at module load), with a seeded localStorage mock.
 */
import { describe, it, expect, vi } from 'vitest';

const localStorageMock = vi.hoisted(() => {
  let seed: string | null = null;
  const mock = {
    setSeed: (value: string | null) => {
      seed = value;
    },
    getItem: vi.fn(() => seed),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  };
  global.localStorage = mock as unknown as Storage;
  return mock;
});

/** Drain microtasks so persist hydration settles after the dynamic import. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('useSettingsStore alwaysShowFilenames', () => {
  it('defaults to OFF (hover-only, the established behavior)', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    expect(useSettingsStore.getState().alwaysShowFilenames).toBe(false);
  });

  it('round-trips through the setter and persists to storage', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setAlwaysShowFilenames(true);
    expect(useSettingsStore.getState().alwaysShowFilenames).toBe(true);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'image-metahub-settings',
      expect.stringContaining('"alwaysShowFilenames":true'),
    );
  });

  it('restores the default on resetState', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setAlwaysShowFilenames(true);
    useSettingsStore.getState().resetState();
    expect(useSettingsStore.getState().alwaysShowFilenames).toBe(false);
  });

  it('rehydration backfills OFF for settings persisted before the switch existed', async () => {
    vi.resetModules();
    localStorageMock.setSeed(JSON.stringify({ state: { displayStarredFirst: true } }));
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    expect(useSettingsStore.getState().alwaysShowFilenames).toBe(false);
  });

  it('rehydration preserves an explicit ON choice', async () => {
    // The `typeof` guard exists for exactly this: a truthiness check on a
    // missing field would also work here, but any future default change must
    // not override a stored choice.
    vi.resetModules();
    localStorageMock.setSeed(
      JSON.stringify({ state: { alwaysShowFilenames: true } }),
    );
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    expect(useSettingsStore.getState().alwaysShowFilenames).toBe(true);
  });
});
