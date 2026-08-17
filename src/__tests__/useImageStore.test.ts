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

import { useImageStore, loadDetectedGpuInfo, loadDetectedGpuDevices } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { type IndexedImage, type ImageAnnotations } from '../types';

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
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
}));

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
    });
    vi.stubGlobal('Worker', FakeTaggingWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the device preference read at send time ('low-power')", async () => {
    useSettingsStore.setState({ aiDevicePreference: 'low-power' });
    await useImageStore.getState().startAutoTagging('', false, {});

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.devicePreference).toBe('low-power');
  });

  it("defaults to 'auto' when the pref is unset", async () => {
    await useImageStore.getState().startAutoTagging('', false, {});

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.devicePreference).toBe('auto');
  });

  it("sends the selected tag model in the start payload when set", async () => {
    useSettingsStore.setState({ aiTagModel: 'Qwen3-4B-q4f16_1-MLC' });
    await useImageStore.getState().startAutoTagging('', false, {});

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.tagModelId).toBe('Qwen3-4B-q4f16_1-MLC');
  });

  it('omits tagModelId when the setting is unset (worker falls back to its default)', async () => {
    await useImageStore.getState().startAutoTagging('', false, {});

    const start = FakeTaggingWorker.lastInstance?.posted.find((m) => m.type === 'start');
    expect(start?.payload.tagModelId).toBeUndefined();
  });

  it('stores gpu-info from the worker into detectedGpuInfo and persists it', async () => {
    await useImageStore.getState().startAutoTagging('', false, {});
    const worker = FakeTaggingWorker.lastInstance!;

    worker.onmessage?.({
      data: { type: 'gpu-info', payload: { vendor: 'NVIDIA', device: 'RTX 4090', preference: 'auto' } },
    } as MessageEvent);

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
    await useImageStore.getState().startAutoTagging('', false, {});
    const worker = FakeTaggingWorker.lastInstance!;

    worker.onmessage?.({
      data: { type: 'gpu-info', payload: { vendor: '', device: '', preference: 'auto' } },
    } as MessageEvent);

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

  it('shows the chips when the auto-tag worker reports its models resident, clears on run end', async () => {
    await useImageStore.getState().startAutoTagging('', false, {});
    const worker = FakeTaggingWorker.lastInstance!;

    worker.onmessage?.({ data: { type: 'models-status', payload: LOADED } } as MessageEvent);
    expect(useImageStore.getState().aiModelsLoaded).toEqual(LOADED);

    // The run completes → the worker is terminated → its engine is gone →
    // this source of the chips clears (no semantic worker reporting).
    worker.onmessage?.({
      data: { type: 'complete', payload: { autoTags: { img1: [{ tag: 'dragon', sourceType: 'prompt' }] } } },
    } as MessageEvent);
    expect(useImageStore.getState().aiModelsLoaded).toEqual(EMPTY);
    expect(useImageStore.getState().autoTaggingWorker).toBeNull();
  });

  it('unloadAiModels terminates the auto-tag worker and clears its chips', async () => {
    await useImageStore.getState().startAutoTagging('', false, {});
    const worker = FakeTaggingWorker.lastInstance!;
    worker.onmessage?.({ data: { type: 'models-status', payload: LOADED } } as MessageEvent);
    expect(useImageStore.getState().aiModelsLoaded).toEqual(LOADED);

    await useImageStore.getState().unloadAiModels();

    expect(worker.terminate).toHaveBeenCalled();
    expect(useImageStore.getState().autoTaggingWorker).toBeNull();
    expect(useImageStore.getState().aiModelsLoaded).toEqual(EMPTY);
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
