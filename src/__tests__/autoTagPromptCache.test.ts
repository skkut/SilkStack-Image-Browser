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

const promptCacheMocks = vi.hoisted(() => {
  type CacheRecord = {
    modelId: string;
    enrichmentVersion: number;
    prompt: string;
    concepts: string[];
    synonyms: string[];
    source: 'llm';
    createdAt: number;
    updatedAt: number;
  };
  const store = new Map<string, CacheRecord>();
  const keyOf = (key: { modelId: string; enrichmentVersion: number; prompt: string }): string =>
    `${key.modelId}\u0000${key.enrichmentVersion}\u0000${key.prompt}`;
  return {
    store,
    keyOf,
    getPromptEnrichments: vi.fn(async (keys: Array<{ modelId: string; enrichmentVersion: number; prompt: string }>) => {
      const found = new Map<string, CacheRecord>();
      for (const key of keys) {
        const record = store.get(keyOf(key));
        if (record) found.set(keyOf(key), record);
      }
      return found;
    }),
    savePromptEnrichments: vi.fn(async (records: CacheRecord[]) => {
      for (const record of records) store.set(keyOf(record), record);
    }),
    deletePromptEnrichmentsForPrompts: vi.fn(async (prompts: string[]) => {
      for (const [key, record] of store) {
        if (prompts.includes(record.prompt)) store.delete(key);
      }
    }),
    promptEnrichmentMapKey: keyOf,
    getPromptCacheStats: vi.fn(async () => ({ enrichments: 0, promptEmbeddings: 0, textEmbeddings: 0 })),
    clearPromptCache: vi.fn(async () => store.clear()),
    // Pretend the one-time backfill already ran so the background pipeline's
    // warm-up is a no-op in this harness.
    PROMPT_CACHE_WARMUP_VERSION: 1,
    getPromptCacheWarmup: vi.fn(async () => ({
      key: 'warmup',
      version: 1,
      completedAt: 1,
      enrichmentCount: 0,
      textPromoted: 0,
      promptPromoted: 0,
    })),
    markPromptCacheWarmupComplete: vi.fn(async () => {}),
  };
});

const bulkSaveAnnotationsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);
vi.mock('../services/promptCache', () => promptCacheMocks);
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
      warmEmbeddingCache: vi.fn(async () => ({ textPromoted: 0, promptPromoted: 0 })),
    };
  }),
}));
vi.mock('../services/aiBridge', () => ({
  // Also stubs the background pipeline's stacking engine — it can run
  // concurrently with a direct startAutoTagging() call in this harness.
  createStackingEngine: vi.fn(async () => ({
    generatePromptHash: (prompt: string) => `hash-${prompt}`,
    normalizePrompt: (prompt: string) => prompt,
    computePromptSimilarity: vi.fn(async () => 0.9),
    computeSimilarityGroupIds: vi.fn(async () => ({ groupIdToSimId: new Map() })),
  })),
  SEARCH_ENRICHMENT_VERSION: 4,
  TAG_GENERATION_MODEL_ID: 'default-tag-model',
  SIMILARITY_MATCH_THRESHOLD: 0.8,
  MAX_TAGS_PER_IMAGE: 15,
  MAX_SYNONYMS_PER_IMAGE: 6,
  MAX_CATEGORIES_PER_IMAGE: 4,
}));
vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: bulkSaveAnnotationsMock,
  saveAnnotation: vi.fn().mockResolvedValue(undefined),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  rekeyAnnotations: vi.fn().mockResolvedValue(undefined),
}));

class FakeTaggingWorker {
  static instances: FakeTaggingWorker[] = [];
  posted: Array<{ type: string; payload: any }> = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage(message: { type: string; payload: any }): void {
    this.posted.push(message);
  }
  emit(type: string, payload: any): void {
    this.onmessage?.({ data: { type, payload } } as MessageEvent);
  }
  constructor() {
    FakeTaggingWorker.instances.push(this);
  }
}

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  createAiWorker: () => new FakeTaggingWorker(),
}));

import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type { IndexedImage, ImageAnnotations } from '../types';

const createImage = (overrides: Partial<IndexedImage>): IndexedImage => ({
  id: overrides.id || 'id',
  name: overrides.name || 'name',
  handle: {} as FileSystemFileHandle,
  metadata: {
    normalizedMetadata: {
      prompt: overrides.prompt || '',
      negativePrompt: overrides.negativePrompt || '',
    },
  } as any,
  metadataString: '',
  lastModified: overrides.lastModified || Date.now(),
  directoryId: overrides.directoryId || 'dir-1',
  models: [],
  loras: [],
  scheduler: '',
  prompt: overrides.prompt,
  negativePrompt: overrides.negativePrompt,
  ...overrides,
});

const directory = {
  id: 'dir-1',
  name: 'Library',
  path: 'C:/Library',
  handle: {} as any,
  visible: true,
  autoWatch: false,
  isConnected: true,
};

const noAnnotation = (): Map<string, ImageAnnotations> => new Map();

/** Macrotask-based wait — the run crosses dynamic imports and cache reads. */
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  promptCacheMocks.store.clear();
  FakeTaggingWorker.instances = [];
  featureAccessMocks.isAiModelFeaturesEnabled.mockReturnValue(true);
  useSettingsStore.setState({ aiTagModel: '', disableAiFallback: true, aiDevicePreference: 'auto' });
  useImageStore.setState({
    images: [],
    filteredImages: [],
    annotations: noAnnotation(),
    directories: [directory as any],
    isAnnotationsLoaded: true,
    isAutoTagging: false,
    autoTaggingWorker: null,
    autoTagWorkerModelId: null,
    autoTaggingProgress: null,
    error: null,
  });
});

describe('auto-tag prompt cache', () => {
  it('sends ONE representative for images sharing a prompt and fans the result out', async () => {
    const images = [
      createImage({ id: 'a', name: 'a.png', prompt: 'a red fox in snow' }),
      createImage({ id: 'b', name: 'b.png', prompt: 'a red fox in snow' }),
      createImage({ id: 'c', name: 'c.png', prompt: 'a blue owl at dusk' }),
    ];
    useImageStore.setState({ images, filteredImages: images });

    const run = useImageStore.getState().startAutoTagging('', false, { scope: 'library' });
    await waitFor(() => FakeTaggingWorker.instances.length > 0, 'the tag worker');

    // Only two representatives (one per distinct prompt).
    const worker = FakeTaggingWorker.instances[0];
    expect(worker).toBeTruthy();
    const start = worker.posted.find((message) => message.type === 'start');
    expect(start?.payload.images.map((image: { id: string }) => image.id)).toEqual(['a', 'c']);
    expect(start?.payload.topN).toBe(15);

    // The worker finishes the first prompt — both images must receive it.
    worker.emit('image-tagged', {
      id: 'a',
      tags: [{ tag: 'red fox' }, { tag: 'snow' }],
      synonyms: ['vulpes', 'animal'],
    });

    const annotations = useImageStore.getState().annotations;
    expect(annotations.get('a')).toMatchObject({
      autoTags: ['red fox', 'snow'],
      synonymTags: ['vulpes', 'animal'],
      searchTagVersion: 4,
      isAutoTagged: true,
      isSemanticIndexed: false,
    });
    expect(annotations.get('b')).toMatchObject({
      autoTags: ['red fox', 'snow'],
      synonymTags: ['vulpes', 'animal'],
      searchTagVersion: 4,
      isSemanticIndexed: false,
    });
    expect(annotations.has('c')).toBe(false);

    // Stored once, keyed by the RESOLVED model id (not the empty setting).
    expect(promptCacheMocks.savePromptEnrichments).toHaveBeenCalledTimes(1);
    const saved = promptCacheMocks.savePromptEnrichments.mock.calls[0][0][0];
    expect(saved).toMatchObject({
      modelId: 'resolved-tag-model',
      enrichmentVersion: 4,
      prompt: 'a red fox in snow',
      concepts: ['red fox', 'snow'],
      synonyms: ['vulpes', 'animal'],
      source: 'llm',
    });

    worker.emit('complete', { autoTags: { a: [{ tag: 'red fox' }], c: [] } });
    await run;
  });

  it('hydrates every sibling from the cache without creating a worker', async () => {
    promptCacheMocks.store.set(
      promptCacheMocks.keyOf({
        modelId: 'resolved-tag-model',
        enrichmentVersion: 4,
        prompt: 'a red fox in snow',
      }),
      {
        modelId: 'resolved-tag-model',
        enrichmentVersion: 4,
        prompt: 'a red fox in snow',
        concepts: ['red fox', 'snowy forest'],
        synonyms: ['vulpes'],
        source: 'llm',
        createdAt: 1,
        updatedAt: 1,
      },
    );
    const images = [
      createImage({ id: 'a', name: 'a.png', prompt: 'a red fox in snow' }),
      createImage({ id: 'b', name: 'b.png', prompt: 'a red fox in snow' }),
    ];
    useImageStore.setState({ images, filteredImages: images });

    await useImageStore.getState().startAutoTagging('', false, { scope: 'library' });

    expect(FakeTaggingWorker.instances).toHaveLength(0);
    const annotations = useImageStore.getState().annotations;
    expect(annotations.get('a')?.autoTags).toEqual(['red fox', 'snowy forest']);
    expect(annotations.get('b')?.autoTags).toEqual(['red fox', 'snowy forest']);
    expect(annotations.get('a')?.synonymTags).toEqual(['vulpes']);
    expect(bulkSaveAnnotationsMock).toHaveBeenCalled();
  });

  it('stamps prompt-less images without a model run', async () => {
    const images = [
      createImage({ id: 'a', name: 'a.png', prompt: '' }),
      createImage({ id: 'b', name: 'b.png', prompt: '   ' }),
    ];
    useImageStore.setState({ images, filteredImages: images });

    await useImageStore.getState().startAutoTagging('', false, { scope: 'library' });

    expect(FakeTaggingWorker.instances).toHaveLength(0);
    const annotations = useImageStore.getState().annotations;
    expect(annotations.get('a')).toMatchObject({ autoTags: [], isAutoTagged: true, searchTagVersion: 4 });
    expect(annotations.get('b')).toMatchObject({ autoTags: [], isAutoTagged: true, searchTagVersion: 4 });
  });

  it('reuses an already-enriched sibling annotation and warms the cache', async () => {
    // Upgrade bridge: no cache row yet, but the library already holds the
    // result in an annotation for the same prompt.
    const images = [
      createImage({ id: 'a', name: 'a.png', prompt: 'a red fox in snow' }),
      createImage({ id: 'b', name: 'b.png', prompt: 'a red fox in snow' }),
    ];
    const annotations = new Map<string, ImageAnnotations>([
      ['a', {
        imageId: 'a',
        isFavorite: false,
        tags: [],
        autoTags: ['red fox'],
        isAutoTagged: true,
        metadataTags: [],
        synonymTags: ['vulpes'],
        searchTagVersion: 4,
        addedAt: 1,
        updatedAt: 1,
      }],
    ]);
    useImageStore.setState({ images, filteredImages: images, annotations });

    await useImageStore.getState().startAutoTagging('', false, { scope: 'library' });

    expect(FakeTaggingWorker.instances).toHaveLength(0);
    expect(useImageStore.getState().annotations.get('b')?.autoTags).toEqual(['red fox']);
    expect(useImageStore.getState().annotations.get('b')?.synonymTags).toEqual(['vulpes']);
    expect(promptCacheMocks.savePromptEnrichments).toHaveBeenCalled();
  });
});
