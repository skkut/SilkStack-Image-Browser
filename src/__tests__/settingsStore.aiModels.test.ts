/**
 * aiEmbeddingModel / aiTagModel persistence tests — default, round-trip,
 * reset, and rehydration (Settings → AI Intelligence model selection).
 *
 * Unlike aiDevicePreference there is NO rehydration validation: '' means "the
 * module's default model" and an unknown persisted id resolves to the catalog
 * default at runtime (resolveEmbeddingModel/resolveTagModel), so anything
 * that survives JSON round-trips is preserved as-is.
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

describe('useSettingsStore AI model selection', () => {
  it("defaults both model ids to '' (the module's defaults)", async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    expect(useSettingsStore.getState().aiEmbeddingModel).toBe('');
    expect(useSettingsStore.getState().aiTagModel).toBe('');
  });

  it('round-trips through the setters and persists to storage', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setAiEmbeddingModel('embed-b32');
    useSettingsStore.getState().setAiTagModel('tag-qwen');
    expect(useSettingsStore.getState().aiEmbeddingModel).toBe('embed-b32');
    expect(useSettingsStore.getState().aiTagModel).toBe('tag-qwen');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'image-metahub-settings',
      expect.stringContaining('"aiEmbeddingModel":"embed-b32"'),
    );
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'image-metahub-settings',
      expect.stringContaining('"aiTagModel":"tag-qwen"'),
    );
  });

  it('resetState restores the defaults', async () => {
    const { useSettingsStore } = await import('../store/useSettingsStore');
    useSettingsStore.getState().setAiEmbeddingModel('embed-b32');
    useSettingsStore.getState().setAiTagModel('tag-qwen');
    useSettingsStore.getState().resetState();
    expect(useSettingsStore.getState().aiEmbeddingModel).toBe('');
    expect(useSettingsStore.getState().aiTagModel).toBe('');
  });

  it('rehydration preserves persisted model ids (unknown ids resolve at runtime)', async () => {
    vi.resetModules();
    localStorageMock.setSeed(
      JSON.stringify({ state: { aiEmbeddingModel: 'embed-b32', aiTagModel: 'tag-qwen' } }),
    );
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    expect(useSettingsStore.getState().aiEmbeddingModel).toBe('embed-b32');
    expect(useSettingsStore.getState().aiTagModel).toBe('tag-qwen');
  });
});
