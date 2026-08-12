/**
 * aiDevicePreference persistence tests — default, round-trip, reset, and the
 * rehydration backfill for settings persisted before the pref existed.
 *
 * The store is imported DYNAMICALLY after vi.resetModules() for the
 * rehydration cases (the persist middleware hydrates once at module load),
 * with a seeded localStorage mock. The static import is deliberately absent.
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

describe('useSettingsStore aiDevicePreference', () => {
  it('defaults to auto', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    expect(useSettingsStore.getState().aiDevicePreference).toBe('auto');
  });

  it('round-trips through the setter and persists to storage', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setAiDevicePreference('low-power');
    expect(useSettingsStore.getState().aiDevicePreference).toBe('low-power');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'image-metahub-settings',
      expect.stringContaining('"aiDevicePreference":"low-power"'),
    );
  });

  it('resetState restores the default', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setAiDevicePreference('software');
    useSettingsStore.getState().resetState();
    expect(useSettingsStore.getState().aiDevicePreference).toBe('auto');
  });

  it('rehydration backfills an unknown persisted value to auto', async () => {
    vi.resetModules();
    localStorageMock.setSeed(JSON.stringify({ state: { aiDevicePreference: 'bogus' } }));
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    expect(useSettingsStore.getState().aiDevicePreference).toBe('auto');
  });

  it('rehydration preserves a valid persisted preference', async () => {
    vi.resetModules();
    localStorageMock.setSeed(JSON.stringify({ state: { aiDevicePreference: 'low-power' } }));
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    expect(useSettingsStore.getState().aiDevicePreference).toBe('low-power');
  });
});
