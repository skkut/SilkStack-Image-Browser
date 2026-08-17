/**
 * getModuleNamespace concurrent-load regression test.
 *
 * The Settings modal fires getEmbeddingModelOptions() and
 * getTagModelOptions() back-to-back (Promise.all). The old loader cached a
 * "started" flag, so the SECOND caller observed the namespace before the
 * import settled — `null` → the auto-tagging list rendered "No models
 * available" on the deployed build while the embedding list (first caller)
 * populated fine. The loader must cache the in-flight PROMISE so every
 * concurrent caller awaits the same import.
 *
 * The module package is mocked with tiny catalogs; the service itself is
 * imported for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const localStorageMock = vi.hoisted(() => {
  const mock = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  };
  global.localStorage = mock as unknown as Storage;
  return mock;
});

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  EMBEDDING_MODEL_OPTIONS: [
    { modelId: 'embed-a', dimension: 768, label: 'Embed A', vram: '1 GB', description: 'a' },
    { modelId: 'embed-b', dimension: 1536, label: 'Embed B', vram: '2 GB', description: 'b' },
  ],
  TAG_MODEL_OPTIONS: [
    { modelId: 'tag-a', label: 'Tag A', vram: '1 GB', tier: 'low', description: 'a' },
    { modelId: 'tag-b', label: 'Tag B', vram: '2 GB', tier: 'mid', description: 'b' },
    { modelId: 'tag-c', label: 'Tag C', vram: '3 GB', tier: 'high', description: 'c' },
  ],
  SemanticSearchCoordinator: class {},
}));

describe('SemanticSearch engine module load', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AI_FEATURES_AVAILABLE', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('back-to-back option fetches both resolve the full catalogs', async () => {
    const { getEmbeddingModelOptions, getTagModelOptions } = await import(
      '../services/semanticSearchEngine'
    );

    // Fired without awaiting between calls — exactly what the Settings modal
    // effect does (Promise.all([getEmbeddingModelOptions(), getTagModelOptions()])).
    const embedP = getEmbeddingModelOptions();
    const tagP = getTagModelOptions();
    const [embed, tag] = await Promise.all([embedP, tagP]);

    expect(embed.map((o) => o.modelId)).toEqual(['embed-a', 'embed-b']);
    expect(tag.map((o) => o.modelId)).toEqual(['tag-a', 'tag-b', 'tag-c']);
  });

  it('later fetches reuse the cached namespace (single import)', async () => {
    const { getEmbeddingModelOptions, getTagModelOptions } = await import(
      '../services/semanticSearchEngine'
    );
    // Warm the cache, then fetch again — must still see the full catalog.
    await getEmbeddingModelOptions();
    const tag = await getTagModelOptions();
    expect(tag).toHaveLength(3);
  });
});
