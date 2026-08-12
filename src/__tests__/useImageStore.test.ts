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

import { useImageStore } from '../store/useImageStore';
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

  beforeEach(() => {
    FakeTaggingWorker.lastInstance = null;
    useSettingsStore.setState({ aiDevicePreference: 'auto' });
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

  it('stores gpu-info from the worker into detectedGpuInfo', async () => {
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
  });
});
