import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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

import { useImageStore, loadDetectedGpuInfo, loadDetectedGpuDevices, needsSearchEnrichment, needsSemanticIndexing } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { type IndexedImage, type ImageAnnotations } from '../types';
import { saveAnnotation } from '../services/imageAnnotationsStorage';

const createImage = (overrides: Partial<IndexedImage>): IndexedImage => ({
  id: overrides.id || 'id',
  name: overrides.name || 'name',
  handle: {} as FileSystemFileHandle,
  metadata: {
    normalizedMetadata: {
      prompt: overrides.prompt || '',
      negativePrompt: overrides.negativePrompt || '',
    }
  } as any,
  metadataString: '',
  lastModified: overrides.lastModified || Date.now(),
  models: [],
  loras: [],
  scheduler: '',
  prompt: overrides.prompt,
  negativePrompt: overrides.negativePrompt,
  isFavorite: overrides.isFavorite,
  stackGroupId: overrides.stackGroupId,
  isStackAnalyzed: overrides.isStackAnalyzed,
  similarityGroupId: overrides.similarityGroupId,
  ...overrides,
});

// The AI worker factory lives in the closed-source ai-intelligence module;
// mock it so startAutoTagging constructs the fake worker directly (the real
// module's dist is a build artifact — tests must not depend on it being
// built). The factory is lazy: it runs on the first dynamic import() inside
// startAutoTagging, long after this top-level class has been evaluated.
class FakeTaggingWorker {
  static lastInstance: FakeTaggingWorker | null = null;
  posted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage(message: { type: string; payload: Record<string, unknown> }): void {
    this.posted.push(message);
  }
  constructor() {
    FakeTaggingWorker.lastInstance = this;
  }
}

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  createAiWorker: () => new FakeTaggingWorker(),
}));

// Mock dependencies
vi.mock('../services/aiBridge', () => ({
  createStackingEngine: vi.fn().mockResolvedValue({
    generatePromptHash: (prompt: string) => `hash-${prompt}`,
    computeSimilarityGroupIds: vi.fn().mockResolvedValue({
      groupIdToSimId: new Map([['hash-test', 'sim-hash-test']]),
    }),
    computePromptSimilarity: vi.fn().mockResolvedValue(0.9),
  }),
  // Mirrored by the store's enrichment gate — keep in sync with the real
  // constant (src/services/aiBridge.ts).
  SEARCH_ENRICHMENT_VERSION: 2,
  // Mirrored default tag model — the store resolves '' (fresh install) to
  // this id for worker-reuse comparison.
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
}));

// Auto-tag is premium-gated inside the store — tests exercise the tagging
// path, so the gate must be open.
vi.mock('../services/aiFeatureAccess', () => ({
  isAiFeaturesEnabled: vi.fn(() => true),
}));

const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * startAutoTagging now resolves on the worker's terminal 'complete' message
 * (the round awaits it before semantic indexing). Fire that message after the
 * store has created the worker + posted 'start', then await the run.
 */
const completeAutoTagRun = async () => {
  const run = useImageStore.getState().startAutoTagging('', false, {});
  await flush();
  FakeTaggingWorker.lastInstance?.onmessage?.({
    data: { type: 'complete', payload: { autoTags: {} } },
  } as MessageEvent);
  await run;
};

describe('useImageStore Stacking Preservations', () => {
  beforeEach(() => {
    // Reset global module-level vars if possible, or just reset state
    useImageStore.setState({
      images: [],
      filteredImages: [],
      annotations: new Map(),
      isAnnotationsLoaded: true,
      indexingState: 'idle',
      directories: [],
      selectedFolders: new Set(),
      excludedFolders: new Set()
    });
  });

  it('mergeImages preserves similarityGroupId and stackGroupId', () => {
    const img1 = createImage({
      id: 'img1',
      prompt: 'test',
      stackGroupId: 'group1',
      similarityGroupId: 'sim1',
      isStackAnalyzed: true
    });
    
    // Set initial state
    useImageStore.setState({ images: [img1], filteredImages: [img1] });

    // Merge update with no annotations
    const update = createImage({ id: 'img1', prompt: 'test updated' });
    useImageStore.getState().mergeImages([update]);

    const updatedImg = useImageStore.getState().images.find(i => i.id === 'img1');
    expect(updatedImg?.prompt).toBe('test updated');
    expect(updatedImg?.stackGroupId).toBe('group1');
    expect(updatedImg?.similarityGroupId).toBe('sim1');
    expect(updatedImg?.isStackAnalyzed).toBe(true);
  });

  it('syncNewImagesToStacks preserves similarityGroupId', async () => {
    const img1 = createImage({ id: 'img1', prompt: 'test' });
    const existingAnnotation: ImageAnnotations = {
        imageId: 'img1',
        isFavorite: false,
        tags: [],
        autoTags: [],
        metadataTags: [],
        isAutoTagged: false,
        stackGroupId: 'group1',
        similarityGroupId: 'sim1',
        isStackAnalyzed: false,
        addedAt: Date.now(),
        updatedAt: Date.now()
    };
    useImageStore.setState({
        images: [img1],
        filteredImages: [img1],
        annotations: new Map([['img1', existingAnnotation]])
    });

    await useImageStore.getState().syncNewImagesToStacks();

    const annotations = useImageStore.getState().annotations;
    const ann = annotations.get('img1');
    expect(ann?.similarityGroupId).toBe('sim1'); // Should be preserved
    expect(ann?.stackGroupId).toBe('hash-test'); // Updated by the mock
  });

  it('computeSimilarityGroups preserves similarityGroupId for images that are not unstacked', async () => {
    const img1 = createImage({ id: 'img1', prompt: 'test' });
    const existingAnnotation: ImageAnnotations = {
        imageId: 'img1',
        isFavorite: false,
        tags: [],
        autoTags: [],
        metadataTags: [],
        isAutoTagged: false,
        stackGroupId: undefined,
        similarityGroupId: 'sim-manual', // Manually assigned
        isStackAnalyzed: false,
        addedAt: Date.now(),
        updatedAt: Date.now()
    };
    useImageStore.setState({
        images: [img1],
        filteredImages: [img1],
        annotations: new Map([['img1', existingAnnotation]])
    });

    await useImageStore.getState().computeSimilarityGroups();

    const annotations = useImageStore.getState().annotations;
    const ann = annotations.get('img1');
    expect(ann?.similarityGroupId).toBe('sim-manual'); // Should be preserved
    expect(ann?.stackGroupId).toBe('hash-test');
  });

  // ── Enrichment-stamp preservation (auto-tag idempotency regression) ──
  // syncNewImagesToStacks and computeSimilarityGroups used to REBUILD the
  // annotation from a hardcoded field list, silently dropping
  // searchTagVersion/synonymTags. The rebuilt record is then bulk-saved over
  // the enriched one, so the next pipeline round's auto-tag phase sees a
  // version-less annotation and re-tags an already-tagged image. Same bug
  // class as the toggleFavorite/addTagToImage rebuilds fixed earlier — these
  // two pipeline writers were missed.

  it('syncNewImagesToStacks preserves searchTagVersion/synonymTags on enriched images', async () => {
    const img1 = createImage({ id: 'img1', prompt: 'test' });
    const enriched: ImageAnnotations = {
      imageId: 'img1',
      isFavorite: false,
      tags: ['manual'],
      autoTags: ['dragon'],
      metadataTags: [],
      isAutoTagged: true,
      stackGroupId: undefined,
      similarityGroupId: undefined,
      isStackAnalyzed: false, // not yet stack-analyzed → the writer fires
      synonymTags: ['wyvern', 'serpent'],
      searchTagVersion: 2, // v2 stamp — auto-tag must skip this image
      isSemanticIndexed: true, // indexed stamp — semantic must skip it too
      addedAt: 1000,
      updatedAt: 1000,
    };
    useImageStore.setState({
      images: [img1],
      filteredImages: [img1],
      annotations: new Map([['img1', enriched]])
    });

    await useImageStore.getState().syncNewImagesToStacks();

    const ann = useImageStore.getState().annotations.get('img1')!;
    expect(ann.searchTagVersion).toBe(2);          // stamp survives the rewrite
    expect(ann.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(ann.isAutoTagged).toBe(true);
    expect(ann.isSemanticIndexed).toBe(true);      // semantic stamp survives too
    expect(ann.isStackAnalyzed).toBe(true);        // the writer's own job still done
    expect(ann.stackGroupId).toBe('hash-test');
  });

  it('computeSimilarityGroups preserves searchTagVersion/synonymTags on enriched images (missing-stack path)', async () => {
    const img1 = createImage({ id: 'img1', prompt: 'test' });
    const enriched: ImageAnnotations = {
      imageId: 'img1',
      isFavorite: false,
      tags: ['manual'],
      autoTags: ['dragon'],
      metadataTags: [],
      isAutoTagged: true,
      stackGroupId: undefined, // missing → the rebuild path fires
      similarityGroupId: undefined,
      isStackAnalyzed: false,
      synonymTags: ['wyvern', 'serpent'],
      searchTagVersion: 2,
      isSemanticIndexed: true, // indexed stamp — semantic must skip it too
      addedAt: 1000,
      updatedAt: 1000,
    };
    useImageStore.setState({
      images: [img1],
      filteredImages: [img1],
      annotations: new Map([['img1', enriched]])
    });

    await useImageStore.getState().computeSimilarityGroups();

    const ann = useImageStore.getState().annotations.get('img1')!;
    expect(ann.searchTagVersion).toBe(2);          // stamp survives the rewrite
    expect(ann.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(ann.isAutoTagged).toBe(true);
    expect(ann.isSemanticIndexed).toBe(true);      // semantic stamp survives too
    expect(ann.isSimilarityAnalyzed).toBe(true);
    expect(ann.stackGroupId).toBe('hash-test');
  });
});

// ── Enrichment gate semantics (pure function) ─────────────────────────

describe('needsSearchEnrichment', () => {
  const base: ImageAnnotations = {
    imageId: 'img1',
    isFavorite: false,
    tags: [],
    autoTags: [],
    metadataTags: [],
    addedAt: 0,
    updatedAt: 0,
  };

  it('returns true when there is no annotation at all (never tagged)', () => {
    expect(needsSearchEnrichment(undefined)).toBe(true);
  });

  it('returns true when the version is missing (legacy isAutoTagged-only records re-tag once)', () => {
    expect(needsSearchEnrichment({ ...base, isAutoTagged: true })).toBe(true);
  });

  it('returns true when the stored version is stale (a future version bump re-tags the library once)', () => {
    expect(needsSearchEnrichment({ ...base, searchTagVersion: 1 })).toBe(true);
  });

  it('returns false when the stored version matches SEARCH_ENRICHMENT_VERSION (skip — already tagged)', () => {
    expect(needsSearchEnrichment({ ...base, searchTagVersion: 2 })).toBe(false);
  });
});

// ── Semantic-index gate semantics (pure function) ─────────────────────

describe('needsSemanticIndexing', () => {
  const base: ImageAnnotations = {
    imageId: 'img1',
    isFavorite: false,
    tags: [],
    autoTags: [],
    metadataTags: [],
    addedAt: 0,
    updatedAt: 0,
  };

  it('returns true when there is no annotation at all (never indexed)', () => {
    expect(needsSemanticIndexing(undefined)).toBe(true);
  });

  it('returns true when the stamp is missing (records written before the stamp existed re-index once)', () => {
    expect(needsSemanticIndexing(base)).toBe(true);
  });

  it('returns true when the stamp is explicitly false (index text changed — writer cleared it)', () => {
    expect(needsSemanticIndexing({ ...base, isSemanticIndexed: false })).toBe(true);
  });

  it('returns false when the stamp is true (skip — already embedded)', () => {
    expect(needsSemanticIndexing({ ...base, isSemanticIndexed: true })).toBe(false);
  });
});

// ── Auto-tagging GPU preference (start payload + gpu-info) ────────────

describe('useImageStore auto-tagging GPU preference', () => {
  beforeEach(() => {
    FakeTaggingWorker.lastInstance = null;
    useSettingsStore.setState({ aiDevicePreference: 'auto', aiTagModel: '' });
    useImageStore.setState({
      images: [],
      filteredImages: [createImage({ id: 'img1', prompt: 'a dragon' })],
      annotations: new Map(),
      isAnnotationsLoaded: true,
      detectedGpuInfo: null,
      // Worker reuse means a finished worker STAYS in state — each test must
      // start from a clean worker so `posted` arrays are per-run.
      autoTaggingWorker: null,
      autoTagWorkerModelId: null,
      isAutoTagging: false,
      autoTaggingProgress: null,
    });
    vi.stubGlobal('Worker', FakeTaggingWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the device preference read at send time ('low-power')", async () => {
    useSettingsStore.setState({ aiDevicePreference: 'low-power' });
    await completeAutoTagRun();

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.devicePreference).toBe('low-power');
  });

  it("defaults to 'auto' when the pref is unset", async () => {
    await completeAutoTagRun();

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.devicePreference).toBe('auto');
  });

  it("sends the selected tag model in the start payload when set", async () => {
    useSettingsStore.setState({ aiTagModel: 'Qwen3-4B-q4f16_1-MLC' });
    await completeAutoTagRun();

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.tagModelId).toBe('Qwen3-4B-q4f16_1-MLC');
  });

  it('omits tagModelId when the setting is unset (worker falls back to its default)', async () => {
    await completeAutoTagRun();

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.tagModelId).toBeUndefined();
  });

  it('stores gpu-info from the worker into detectedGpuInfo and persists it', async () => {
    const run = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    const worker = FakeTaggingWorker.lastInstance!;

    worker.onmessage?.({
      data: { type: 'gpu-info', payload: { vendor: 'NVIDIA', device: 'RTX 4090', preference: 'auto' } },
    } as MessageEvent);
    // Finish the run so the resolve-on-complete promise settles.
    worker.onmessage?.({
      data: { type: 'complete', payload: { autoTags: {} } },
    } as MessageEvent);
    await run;

    expect(useImageStore.getState().detectedGpuInfo).toEqual({
      vendor: 'NVIDIA',
      device: 'RTX 4090',
      preference: 'auto',
    });
    // Persisted so Settings shows the GPU without waiting for another load.
    expect(global.localStorage.setItem).toHaveBeenCalledWith(
      'image-metahub-detected-gpu',
      JSON.stringify({ vendor: 'NVIDIA', device: 'RTX 4090', preference: 'auto' }),
    );
  });

  it('loadDetectedGpuInfo restores a saved value and rejects corrupt data', () => {
    const storage = global.localStorage as any;
    storage.getItem.mockReturnValueOnce(
      JSON.stringify({ vendor: 'NVIDIA', device: 'RTX 4090', preference: 'low-power' }),
    );
    expect(loadDetectedGpuInfo()).toEqual({
      vendor: 'NVIDIA',
      device: 'RTX 4090',
      preference: 'low-power',
    });

    storage.getItem.mockReturnValueOnce('not json');
    expect(loadDetectedGpuInfo()).toBeNull();

    storage.getItem.mockReturnValueOnce('true'); // valid JSON, wrong shape
    expect(loadDetectedGpuInfo()).toBeNull();

    storage.getItem.mockReturnValueOnce(null);
    expect(loadDetectedGpuInfo()).toBeNull();
  });

  it('setDetectedGpuInfo(null) clears the persisted detection', () => {
    useImageStore.getState().setDetectedGpuInfo({ vendor: 'NVIDIA', device: 'RTX 4090', preference: 'auto' });
    useImageStore.getState().setDetectedGpuInfo(null);
    expect(global.localStorage.removeItem).toHaveBeenCalledWith('image-metahub-detected-gpu');
    expect(useImageStore.getState().detectedGpuInfo).toBeNull();
  });

  it('resetState clears the persisted detection', () => {
    useImageStore.getState().setDetectedGpuInfo({ vendor: 'NVIDIA', device: 'RTX 4090', preference: 'auto' });
    useImageStore.getState().resetState();
    expect(global.localStorage.removeItem).toHaveBeenCalledWith('image-metahub-detected-gpu');
    expect(useImageStore.getState().detectedGpuInfo).toBeNull();
  });

  it('ignores a blank worker gpu-info report (opaque WebGPU ids) — keeps the previous value', async () => {
    useImageStore.setState({
      detectedGpuInfo: { vendor: 'AMD', device: 'Radeon(TM) Graphics', preference: 'auto' },
    });
    const run = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    const worker = FakeTaggingWorker.lastInstance!;

    worker.onmessage?.({
      data: { type: 'gpu-info', payload: { vendor: '', device: '', preference: 'auto' } },
    } as MessageEvent);
    worker.onmessage?.({
      data: { type: 'complete', payload: { autoTags: {} } },
    } as MessageEvent);
    await run;

    // A blank report must not flip the readout to "not reported yet".
    expect(useImageStore.getState().detectedGpuInfo).toEqual({
      vendor: 'AMD',
      device: 'Radeon(TM) Graphics',
      preference: 'auto',
    });
  });

  it('setDetectedGpuDevices stores the list, persists it, and resetState clears it', () => {
    const devices = [
      { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
      { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
    ];
    useImageStore.getState().setDetectedGpuDevices(devices);
    expect(useImageStore.getState().detectedGpuDevices).toEqual(devices);
    // Persisted so the dropdown shows the cards on the next launch before the
    // async main-process re-fetch resolves.
    expect(global.localStorage.setItem).toHaveBeenCalledWith(
      'image-metahub-detected-gpus',
      JSON.stringify(devices),
    );

    useImageStore.getState().resetState();
    expect(useImageStore.getState().detectedGpuDevices).toEqual([]);
    expect(global.localStorage.removeItem).toHaveBeenCalledWith('image-metahub-detected-gpus');
  });

  it('setDetectedGpuDevices skips the write when the list is unchanged (startup re-fetch)', () => {
    const devices = [
      { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
      { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
    ];
    useImageStore.getState().setDetectedGpuDevices(devices);
    const writes = (global.localStorage.setItem as any).mock.calls.length;

    // A byte-identical list (every launch re-queries the main process) must
    // not re-persist or re-render pointlessly.
    useImageStore.getState().setDetectedGpuDevices([...devices]);
    expect(global.localStorage.setItem).toHaveBeenCalledTimes(writes);
    expect(useImageStore.getState().detectedGpuDevices).toEqual(devices);

    // A genuinely changed list (e.g. a GPU was unplugged) still writes.
    useImageStore.getState().setDetectedGpuDevices([devices[1]]);
    expect(global.localStorage.setItem).toHaveBeenCalledTimes(writes + 1);
    expect(useImageStore.getState().detectedGpuDevices).toEqual([devices[1]]);
  });

  it('loadDetectedGpuDevices restores a saved list and rejects corrupt data', () => {
    const storage = global.localStorage as any;
    storage.getItem.mockReturnValueOnce(
      JSON.stringify([
        { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
        { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
      ]),
    );
    expect(loadDetectedGpuDevices()).toEqual([
      { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
      { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
    ]);

    // Corrupt / wrong-shape payloads → empty list, never a crash.
    storage.getItem.mockReturnValueOnce('not json');
    expect(loadDetectedGpuDevices()).toEqual([]);

    storage.getItem.mockReturnValueOnce('true'); // valid JSON, wrong shape
    expect(loadDetectedGpuDevices()).toEqual([]);

    storage.getItem.mockReturnValueOnce(JSON.stringify([{ vendor: 'AMD' }])); // entry missing device
    expect(loadDetectedGpuDevices()).toEqual([]);

    storage.getItem.mockReturnValueOnce(null);
    expect(loadDetectedGpuDevices()).toEqual([]);
  });
});

// ── Footer AI-model chips (models-status + eject) ──────────────────────
// The auto-tag worker's engine carries both records (CreateMLCEngine
// ([chatId, embedId])); its models-status push feeds the footer chips and
// every worker-death path clears this source of the union.

describe('useImageStore AI model chips (models-status + eject)', () => {
  beforeEach(() => {
    FakeTaggingWorker.lastInstance = null;
    useSettingsStore.setState({ aiDevicePreference: 'auto', aiTagModel: '' });
    useImageStore.setState({
      images: [],
      filteredImages: [createImage({ id: 'img1', prompt: 'a dragon' })],
      annotations: new Map(),
      isAnnotationsLoaded: true,
      aiModelsLoaded: {
        chatLoaded: false,
        embedLoaded: false,
        chatModelId: null,
        embedModelId: null,
        chatVramMb: null,
        embedVramMb: null,
      },
      // Worker reuse means a finished worker STAYS in state — each test must
      // start from a clean worker so `posted` arrays are per-run.
      autoTaggingWorker: null,
      autoTagWorkerModelId: null,
      isAutoTagging: false,
      autoTaggingProgress: null,
    });
    vi.stubGlobal('Worker', FakeTaggingWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Realistic declared VRAM (record vram_required_MB): Hermes 3B ~2.3 GB, Qwen3-8B 6.9 GB.
  const LOADED = {
    chatLoaded: true,
    embedLoaded: true,
    chatModelId: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
    embedModelId: 'Qwen3-Embedding-8B-q4f16_1-MLC',
    chatVramMb: 2262,
    embedVramMb: 6900,
  };
  const EMPTY = {
    chatLoaded: false,
    embedLoaded: false,
    chatModelId: null,
    embedModelId: null,
    chatVramMb: null,
    embedVramMb: null,
  };

  it('keeps the chips and the worker after a run completes (worker reuse)', async () => {
    const run = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    const worker = FakeTaggingWorker.lastInstance!;

    worker.onmessage?.({ data: { type: 'models-status', payload: LOADED } } as MessageEvent);
    expect(useImageStore.getState().aiModelsLoaded).toEqual(LOADED);

    // The run completes → the worker STAYS resident (engine reuse across
    // runs is the point) → its chips source stays in the union.
    worker.onmessage?.({
      data: { type: 'complete', payload: { autoTags: { img1: [{ tag: 'dragon', sourceType: 'prompt' }] } } },
    } as MessageEvent);
    await run;
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(useImageStore.getState().autoTaggingWorker).toBe(worker);
    expect(useImageStore.getState().autoTagWorkerModelId).toBe('Hermes-3-Llama-3.2-3B-q4f16_1-MLC');
    expect(useImageStore.getState().aiModelsLoaded).toEqual(LOADED);
  });

  it('reuses the resident worker when the model is unchanged', async () => {
    const run1 = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    const first = FakeTaggingWorker.lastInstance!;
    expect(first.terminate).not.toHaveBeenCalled();
    first.onmessage?.({ data: { type: 'complete', payload: { autoTags: {} } } } as MessageEvent);
    await run1;

    // Second run, same resolved model ('' → TAG_GENERATION_MODEL_ID) — the
    // existing worker is reused; no terminate, no new construction.
    const run2 = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    expect(FakeTaggingWorker.lastInstance).toBe(first);
    expect(first.terminate).not.toHaveBeenCalled();
    expect(useImageStore.getState().autoTaggingWorker).toBe(first);
    // Both runs' starts went to the same worker.
    const starts = first.posted.filter((m) => m.type === 'start');
    expect(starts).toHaveLength(2);
    first.onmessage?.({ data: { type: 'complete', payload: { autoTags: {} } } } as MessageEvent);
    await run2;
  });

  it('spawns a fresh worker when the tag model changes', async () => {
    const run1 = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    const first = FakeTaggingWorker.lastInstance!;
    first.onmessage?.({ data: { type: 'complete', payload: { autoTags: {} } } } as MessageEvent);
    await run1;

    useSettingsStore.setState({ aiTagModel: 'Qwen3-4B-q4f16_1-MLC' });
    const run2 = useImageStore.getState().startAutoTagging('', false, {});
    await flush();

    const second = FakeTaggingWorker.lastInstance!;
    expect(second).not.toBe(first);
    expect(first.terminate).toHaveBeenCalled();
    expect(useImageStore.getState().autoTagWorkerModelId).toBe('Qwen3-4B-q4f16_1-MLC');
    const start = second.posted.find((m) => m.type === 'start');
    expect(start?.payload.tagModelId).toBe('Qwen3-4B-q4f16_1-MLC');
    second.onmessage?.({ data: { type: 'complete', payload: { autoTags: {} } } } as MessageEvent);
    await run2;
  });

  it('unloadAiModels terminates the auto-tag worker and clears its chips', async () => {
    const run = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    const worker = FakeTaggingWorker.lastInstance!;
    worker.onmessage?.({ data: { type: 'models-status', payload: LOADED } } as MessageEvent);
    expect(useImageStore.getState().aiModelsLoaded).toEqual(LOADED);
    worker.onmessage?.({ data: { type: 'complete', payload: { autoTags: {} } } } as MessageEvent);
    await run;

    await useImageStore.getState().unloadAiModels();

    expect(worker.terminate).toHaveBeenCalled();
    expect(useImageStore.getState().autoTaggingWorker).toBeNull();
    expect(useImageStore.getState().autoTagWorkerModelId).toBeNull();
    expect(useImageStore.getState().aiModelsLoaded).toEqual(EMPTY);
  });
});

// ── Incremental per-image persistence (image-tagged) ───────────────────
// The worker streams each finished image as { type: 'image-tagged' }; the
// store must commit that image (tags + isAutoTagged + the enrichment stamp)
// to the DB and to the in-memory lists IMMEDIATELY — before the run ends —
// so an interrupted run resumes instead of restarting. The trailing
// 'complete' map must not double-write ids already persisted.
describe('useImageStore auto-tagging incremental persistence (image-tagged)', () => {
  beforeEach(() => {
    FakeTaggingWorker.lastInstance = null;
    useSettingsStore.setState({ aiDevicePreference: 'auto', aiTagModel: '' });
    const img1 = createImage({ id: 'img1', prompt: 'a dragon' });
    const img2 = createImage({ id: 'img2', prompt: 'a castle' });
    useImageStore.setState({
      images: [img1, img2],
      filteredImages: [img1, img2],
      annotations: new Map(),
      isAnnotationsLoaded: true,
      autoTaggingWorker: null,
      autoTagWorkerModelId: null,
      isAutoTagging: false,
      autoTaggingProgress: null,
    });
    vi.stubGlobal('Worker', FakeTaggingWorker);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('commits each image the moment its image-tagged message arrives, and complete does not double-write', async () => {
    const run = useImageStore.getState().startAutoTagging('', false, {});
    await flush();
    const worker = FakeTaggingWorker.lastInstance!;

    // img1 finishes in the worker FIRST — it must be committed (tags +
    // isAutoTagged + enrichment stamp) while the run is still in flight.
    worker.onmessage?.({
      data: {
        type: 'image-tagged',
        payload: {
          id: 'img1',
          tags: [{ tag: 'dragon', sourceType: 'prompt' }, { tag: 'fire', sourceType: 'prompt' }],
        },
      },
    } as MessageEvent);

    const midRun = useImageStore.getState();
    expect(midRun.isAutoTagging).toBe(true); // run still active
    // In-memory image patched immediately...
    expect(midRun.images.find(i => i.id === 'img1')?.autoTags).toEqual(['dragon', 'fire']);
    expect(midRun.images.find(i => i.id === 'img1')?.isAutoTagged).toBe(true);
    // ...annotation carries the enrichment stamp...
    const ann = midRun.annotations.get('img1');
    expect(ann?.autoTags).toEqual(['dragon', 'fire']);
    expect(ann?.isAutoTagged).toBe(true);
    expect(ann?.searchTagVersion).toBe(2);
    expect(ann?.isSemanticIndexed).toBe(false);
    // ...and img2 is untouched — it hasn't finished yet.
    expect(midRun.images.find(i => i.id === 'img2')?.autoTags).toBeUndefined();
    expect(midRun.images.find(i => i.id === 'img2')?.isAutoTagged).toBeUndefined();

    // Persisted to IndexedDB via the single-annotation save — the store's
    // dynamic import resolves to the mocked module.
    await flush();
    expect(saveAnnotation).toHaveBeenCalledWith(expect.objectContaining({
      imageId: 'img1',
      autoTags: ['dragon', 'fire'],
      isAutoTagged: true,
      searchTagVersion: 2,
    }));

    // img2 finishes, then the run completes with BOTH ids in the map —
    // img1 must NOT be re-persisted (deduped), img2 goes through the
    // backward-compat leftover path.
    const saveAnnotationMock = vi.mocked(saveAnnotation);
    const savesBefore = saveAnnotationMock.mock.calls.length;
    worker.onmessage?.({
      data: { type: 'image-tagged', payload: { id: 'img2', tags: [{ tag: 'castle', sourceType: 'prompt' }] } },
    } as MessageEvent);
    worker.onmessage?.({
      data: {
        type: 'complete',
        payload: {
          autoTags: {
            img1: [{ tag: 'dragon', sourceType: 'prompt' }],
            img2: [{ tag: 'castle', sourceType: 'prompt' }],
          },
        },
      },
    } as MessageEvent);
    await run;
    await flush();

    expect(saveAnnotationMock.mock.calls).toHaveLength(savesBefore + 1); // only img2 was written
    expect(saveAnnotationMock).toHaveBeenLastCalledWith(expect.objectContaining({
      imageId: 'img2',
      autoTags: ['castle'],
      isAutoTagged: true,
    }));

    // Final state: both images tagged, the run settled.
    expect(useImageStore.getState().isAutoTagging).toBe(false);
    expect(useImageStore.getState().autoTaggingProgress).toBeNull();
    expect(useImageStore.getState().images.find(i => i.id === 'img1')?.autoTags).toEqual(['dragon', 'fire']);
    expect(useImageStore.getState().images.find(i => i.id === 'img2')?.autoTags).toEqual(['castle']);
    expect(useImageStore.getState().images.find(i => i.id === 'img2')?.isAutoTagged).toBe(true);
  });
});

// ── Annotation enrichment preservation (version-wipe regression) ───────
// toggleFavorite / addTagToImage / bulkToggleFavorite / bulkAddTag used to
// rebuild ImageAnnotations from hardcoded field lists, dropping
// synonymTags/searchTagVersion (re-queueing enriched images on EVERY
// auto-tag run) and the stack/similarity fields. They must spread the
// current annotation instead — regression-tested here.
//
// isSemanticIndexed behaves differently by design: writers that CHANGE the
// index text (tag add/remove/import, auto-tag completion, clear auto-tags)
// deliberately clear it so the next semantic Δ-run re-embeds exactly those
// images; writers that leave the index text alone (favorites, stacking,
// merging) must preserve it.

describe('useImageStore annotation enrichment preservation', () => {
  const ENRICHED: ImageAnnotations = {
    imageId: 'img1',
    isFavorite: false,
    tags: ['manual'],
    autoTags: ['dragon'],
    isAutoTagged: true,
    metadataTags: [],
    addedAt: 1000,
    updatedAt: 1000,
    synonymTags: ['wyvern', 'serpent'],
    searchTagVersion: 2,
    isSemanticIndexed: true,
    stackGroupId: 'stack-1',
    isStackAnalyzed: true,
  };

  beforeEach(() => {
    useImageStore.setState({
      images: [createImage({ id: 'img1', prompt: 'a dragon' })],
      filteredImages: [createImage({ id: 'img1', prompt: 'a dragon' })],
      annotations: new Map([['img1', { ...ENRICHED }]]),
      isAnnotationsLoaded: true,
      directories: [],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      autoTaggingWorker: null,
      autoTagWorkerModelId: null,
    });
  });

  it('toggleFavorite preserves synonymTags/searchTagVersion and stack fields', async () => {
    await useImageStore.getState().toggleFavorite('img1');
    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(true); // index text unchanged → preserved
    expect(a.stackGroupId).toBe('stack-1');
    expect(a.isStackAnalyzed).toBe(true);
    expect(a.isFavorite).toBe(true);
  });

  it('addTagToImage preserves enrichment stamps but clears isSemanticIndexed', async () => {
    await useImageStore.getState().addTagToImage('img1', 'newtag');
    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(false); // new tag feeds the index → Δ-run re-embeds
    expect(a.tags).toContain('newtag');
  });

  it('removeTagFromImage preserves enrichment stamps but clears isSemanticIndexed', async () => {
    await useImageStore.getState().removeTagFromImage('img1', 'manual');
    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(false); // tag text changed → Δ-run re-embeds
    expect(a.tags).not.toContain('manual');
  });

  it('bulkToggleFavorite preserves synonymTags/searchTagVersion and stack fields', async () => {
    await useImageStore.getState().bulkToggleFavorite(['img1'], true);
    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(true); // index text unchanged → preserved
    expect(a.stackGroupId).toBe('stack-1');
    expect(a.isFavorite).toBe(true);
  });

  it('bulkAddTag preserves enrichment stamps but clears isSemanticIndexed', async () => {
    await useImageStore.getState().bulkAddTag(['img1'], 'newtag');
    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(false); // new tag feeds the index → Δ-run re-embeds
    expect(a.tags).toContain('newtag');
  });

  it('bulkRemoveTag preserves enrichment stamps but clears isSemanticIndexed', async () => {
    await useImageStore.getState().bulkRemoveTag(['img1'], 'manual');
    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(false); // tag text changed → Δ-run re-embeds
    expect(a.tags).not.toContain('manual');
  });

  it('importMetadataTags preserves enrichment stamps but clears isSemanticIndexed', async () => {
    const img = createImage({
      id: 'img1',
      prompt: 'a dragon',
      metadata: { normalizedMetadata: { tags: ['from-file'] } } as any,
    });
    useImageStore.setState({ images: [img], filteredImages: [img] });

    await useImageStore.getState().importMetadataTags([img]);

    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(false); // metadata tags feed the index → Δ-run re-embeds
    expect(a.metadataTags).toContain('from-file');
  });

  it('mergeSelectedToStack preserves synonymTags/searchTagVersion', async () => {
    const img1 = createImage({ id: 'img1', prompt: 'a dragon', stackGroupId: 'sg-1' });
    const img2 = createImage({ id: 'img2', prompt: 'another dragon', stackGroupId: 'sg-1' });
    useImageStore.setState({
      images: [img1, img2],
      filteredImages: [img1, img2],
      selectedImages: new Set(['img1', 'img2']),
      annotations: new Map([
        ['img1', { ...ENRICHED }],
        ['img2', { ...ENRICHED, imageId: 'img2' }],
      ]),
    });

    await useImageStore.getState().mergeSelectedToStack();

    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(a.searchTagVersion).toBe(2);
    expect(a.isSemanticIndexed).toBe(true); // index text unchanged → preserved
    expect(a.similarityGroupId).toBe('sg-1'); // the merge's own job still done
  });

  it('clearAutoTags re-opens BOTH gates (searchTagVersion AND isSemanticIndexed)', async () => {
    await useImageStore.getState().clearAutoTags();
    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.autoTags).toEqual([]);
    expect(a.isAutoTagged).toBe(false);
    expect(a.searchTagVersion).toBeUndefined(); // re-open the enrichment gate
    expect(a.isSemanticIndexed).toBe(false);    // re-open the semantic gate (cleared text must drop out of the index)
  });

  it('clearDerivedImageData (Reprocess) re-opens the semantic gate even when ONLY the stamp is set', async () => {
    // An image whose ONLY derived state is the semantic stamp — the
    // hasDerived check must still include it, or the wipe would skip it and
    // leave the stamp in place while the vectors are cleared.
    useImageStore.setState({
      annotations: new Map([['img1', { ...ENRICHED, isFavorite: true, autoTags: [], isAutoTagged: false, synonymTags: [], searchTagVersion: undefined, metadataTags: [], stackGroupId: undefined, isStackAnalyzed: false, similarityGroupId: undefined, isSimilarityAnalyzed: false, isSemanticIndexed: true }]]),
    });

    await useImageStore.getState().clearDerivedImageData();

    const a = useImageStore.getState().annotations.get('img1')!;
    expect(a.isSemanticIndexed).toBe(false); // gate re-opened for the post-rescan round
    expect(a.isFavorite).toBe(true);         // user data still kept
    expect(a.tags).toEqual(['manual']);
  });
});

// ── Main-process GPU reporting (startup source, no model load) ─────────
// The worker-side adapter.info detection only fires after a model load and
// can silently fail; Electron's main process (app.getGPUInfo) knows every
// GPU Chromium detected at startup. fetchMainProcessGpuInfo feeds that
// report through the same persisted setter.

describe('fetchMainProcessGpuInfo (main-process startup report)', () => {
  beforeEach(() => {
    delete (global.window as any).electronAPI;
    useImageStore.setState({ detectedGpuInfo: null, detectedGpuDevices: [] });
  });

  it('stores every detected GPU and seeds the single report from the active one', async () => {
    (global.window as any).electronAPI = {
      getGpuInfo: vi.fn().mockResolvedValue({
        devices: [
          { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
          { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
        ],
        preference: 'high-performance',
      }),
    };
    const { fetchMainProcessGpuInfo } = await import('../services/mainProcessGpu');

    await fetchMainProcessGpuInfo();

    expect(useImageStore.getState().detectedGpuDevices).toEqual([
      { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
      { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
    ]);
    expect(useImageStore.getState().detectedGpuInfo).toEqual({
      vendor: 'AMD',
      device: 'Radeon(TM) Graphics',
      preference: 'high-performance',
    });
    // Persisted so Settings shows the GPU without waiting for another load.
    expect(global.localStorage.setItem).toHaveBeenCalledWith(
      'image-metahub-detected-gpu',
      JSON.stringify({ vendor: 'AMD', device: 'Radeon(TM) Graphics', preference: 'high-performance' }),
    );
    // …and the full device list, which feeds the dropdown options.
    expect(global.localStorage.setItem).toHaveBeenCalledWith(
      'image-metahub-detected-gpus',
      JSON.stringify([
        { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
        { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
      ]),
    );
  });

  it('leaves the store untouched when the main process reports nothing', async () => {
    (global.window as any).electronAPI = { getGpuInfo: vi.fn().mockResolvedValue(null) };
    const { fetchMainProcessGpuInfo } = await import('../services/mainProcessGpu');

    await fetchMainProcessGpuInfo();
    expect(useImageStore.getState().detectedGpuInfo).toBeNull();
    expect(useImageStore.getState().detectedGpuDevices).toEqual([]);

    (global.window as any).electronAPI = {
      getGpuInfo: vi.fn().mockResolvedValue({ devices: [], preference: 'auto' }),
    };
    await fetchMainProcessGpuInfo();
    expect(useImageStore.getState().detectedGpuDevices).toEqual([]);
  });

  it('is a no-op without electronAPI (browser preview) and swallows IPC failures', async () => {
    const { fetchMainProcessGpuInfo } = await import('../services/mainProcessGpu');

    await fetchMainProcessGpuInfo(); // no window.electronAPI → no-op
    expect(useImageStore.getState().detectedGpuInfo).toBeNull();

    (global.window as any).electronAPI = {
      getGpuInfo: vi.fn().mockRejectedValue(new Error('no GPU process')),
    };
    await expect(fetchMainProcessGpuInfo()).resolves.toBeUndefined();
    expect(useImageStore.getState().detectedGpuInfo).toBeNull();
  });
});
