/**
 * stackHighlightPromptVariations persistence tests — default, round-trip, and
 * the rehydration backfill for settings persisted before the switch existed.
 *
 * The store is imported DYNAMICALLY after vi.resetModules() for the
 * rehydration cases (the persist middleware hydrates once at module load),
 * with a seeded localStorage mock.
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

describe('useSettingsStore stackHighlightPromptVariations', () => {
  it('defaults to ON', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    expect(useSettingsStore.getState().stackHighlightPromptVariations).toBe(true);
  });

  it('round-trips through the setter and persists to storage', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setStackHighlightPromptVariations(false);
    expect(useSettingsStore.getState().stackHighlightPromptVariations).toBe(false);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'image-metahub-settings',
      expect.stringContaining('"stackHighlightPromptVariations":false'),
    );
  });

  it('does not have its default restored by resetState', async () => {
    // Deliberate, and consistent with stackGroupByDimensions, which resetState
    // also leaves alone. Pinned so changing it is a conscious decision.
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setStackHighlightPromptVariations(false);
    useSettingsStore.getState().resetState();
    expect(useSettingsStore.getState().stackHighlightPromptVariations).toBe(false);
  });

  it('rehydration backfills ON for settings persisted before the switch existed', async () => {
    vi.resetModules();
    localStorageMock.setSeed(JSON.stringify({ state: { stackGroupByDimensions: ['model'] } }));
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    expect(useSettingsStore.getState().stackHighlightPromptVariations).toBe(true);
  });

  it('rehydration preserves an explicit OFF choice', async () => {
    // The `typeof` guard exists for exactly this: a truthiness check would
    // silently turn the switch back on for every user who disabled it.
    vi.resetModules();
    localStorageMock.setSeed(
      JSON.stringify({ state: { stackHighlightPromptVariations: false } }),
    );
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    expect(useSettingsStore.getState().stackHighlightPromptVariations).toBe(false);
  });
});
