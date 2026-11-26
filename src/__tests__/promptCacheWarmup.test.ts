import 'fake-indexeddb/auto';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Persisted-store tests need a localStorage mock before ANY store import.
vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue('true'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

const featureAccessMocks = vi.hoisted(() => ({
  isAiFeaturesEnabled: vi.fn(() => true),
  isAiMasterEnabled: vi.fn(() => true),
  isAiModelFeaturesEnabled: vi.fn(() => true),
  isSemanticSearchEnabled: vi.fn(() => false),
  useSemanticSearchEnabled: vi.fn(() => false),
}));

const warmEmbeddingCacheMock = vi.hoisted(() => vi.fn(async () => ({
  textPromoted: 2,
  promptPromoted: 3,
})));

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);
vi.mock('../services/semanticSearchEngine', () => ({
  getTagModelOptions: vi.fn(async () => [
    {
      modelId: 'resolved-tag-model',
      label: 'Resolved model',
      vram: '~1 GB',
      tier: 'low',
      description: '',
    },
  ]),
  SemanticSearchCoordinator: vi.fn(function SemanticSearchCoordinator() {
    return {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      indexImages: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0 }),
      getStatus: vi.fn(() => ({ ready: false, indexed: 0, modelId: null, dimension: null, error: null })),
      warmEmbeddingCache: warmEmbeddingCacheMock,
    };
  }),
}));
vi.mock('../services/aiBridge', () => ({
  SEARCH_ENRICHMENT_VERSION: 4,
  TAG_GENERATION_MODEL_ID: 'default-tag-model',
  SIMILARITY_MATCH_THRESHOLD: 0.8,
  MAX_TAGS_PER_IMAGE: 15,
  MAX_SYNONYMS_PER_IMAGE: 6,
  MAX_CATEGORIES_PER_IMAGE: 4,
  createStackingEngine: vi.fn(async () => ({
    generatePromptHash: (prompt: string) => `hash-${prompt}`,
    normalizePrompt: (prompt: string) => prompt,
    computePromptSimilarity: vi.fn(async () => 0.9),
    computeSimilarityGroupIds: vi.fn(async () => ({ groupIdToSimId: new Map() })),
  })),
}));
vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(undefined),
  saveAnnotation: vi.fn().mockResolvedValue(undefined),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  rekeyAnnotations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@ai-images-browser/ai-intelligence', () => ({
  createAiWorker: () => ({
    postMessage: vi.fn(),
    terminate: vi.fn(),
    onmessage: null,
    onerror: null,
  }),
}));

import {
  PROMPT_CACHE_DB_NAME,
  getPromptCacheWarmup,
  getPromptEnrichments,
  promptEnrichmentMapKey,
} from '../services/promptCache';
import { useImageStore, warmPromptCacheFromLibrary } from '../store/useImageStore';
import type { ImageAnnotations, IndexedImage } from '../types';

async function resetCacheDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(PROMPT_CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

const createImage = (id: string, prompt: string): IndexedImage => ({
  id,
  name: `${id}.png`,
  handle: {} as FileSystemFileHandle,
  metadata: { normalizedMetadata: { prompt, negativePrompt: '' } } as any,
  metadataString: '',
  lastModified: 1,
  directoryId: 'dir-1',
  models: [],
  loras: [],
  scheduler: '',
  prompt,
  negativePrompt: '',
});

const annotation = (imageId: string, overrides: Partial<ImageAnnotations> = {}): ImageAnnotations => ({
  imageId,
  isFavorite: false,
  tags: [],
  autoTags: ['red fox', 'snowy forest'],
  isAutoTagged: true,
  metadataTags: [],
  synonymTags: ['vulpes', 'animal'],
  searchTagVersion: 4,
  addedAt: 1,
  updatedAt: 1,
  ...overrides,
});

beforeEach(async () => {
  await resetCacheDatabase();
  vi.clearAllMocks();
  warmEmbeddingCacheMock.mockResolvedValue({ textPromoted: 2, promptPromoted: 3 });
  const images = [
    createImage('a', 'a red fox in snow'),
    createImage('b', 'a red fox in snow'), // same prompt — one cache row
    createImage('c', 'a blue owl at dusk'), // old enrichment version — skipped
  ];
  useImageStore.setState({
    images,
    filteredImages: images,
    annotations: new Map([
      ['a', annotation('a')],
      ['c', annotation('c', {
        autoTags: ['blue owl'],
        synonymTags: [],
        searchTagVersion: 2,
      })],
    ]),
    isAnnotationsLoaded: true,
    directories: [{ id: 'dir-1', name: 'Library', path: 'C:/Library', handle: {} as any, visible: true, autoWatch: false, isConnected: true }],
  });
});

describe('one-time prompt-cache warm-up', () => {
  it('seeds enrichments + vectors from the existing library and records the marker', async () => {
    await warmPromptCacheFromLibrary();

    const found = await getPromptEnrichments([
      { modelId: 'resolved-tag-model', enrichmentVersion: 4, prompt: 'a red fox in snow' },
      { modelId: 'resolved-tag-model', enrichmentVersion: 4, prompt: 'a blue owl at dusk' },
    ]);
    expect(found.size).toBe(1);
    expect(found.get(promptEnrichmentMapKey({
      modelId: 'resolved-tag-model',
      enrichmentVersion: 4,
      prompt: 'a red fox in snow',
    }))).toMatchObject({
      concepts: ['red fox', 'snowy forest'],
      synonyms: ['vulpes', 'animal'],
      source: 'llm',
    });

    // The module-side backfill ran (its own promotion is covered there), and
    // its counts are recorded on the marker.
    expect(warmEmbeddingCacheMock).toHaveBeenCalledTimes(1);
    await expect(getPromptCacheWarmup()).resolves.toMatchObject({
      version: 1,
      enrichmentCount: 1,
      textPromoted: 2,
      promptPromoted: 3,
    });

    // Idempotent: another pipeline round in the same session does nothing.
    await warmPromptCacheFromLibrary();
    expect(warmEmbeddingCacheMock).toHaveBeenCalledTimes(1);
  });
});
