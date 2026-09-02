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
  isSemanticSearchEnabled: vi.fn(() => true),
  useSemanticSearchEnabled: vi.fn(() => true),
}));

const coordinatorMock = vi.hoisted(() => ({
  ensureInitialized: vi.fn(),
  indexImages: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0 }),
  search: vi.fn(),
  clearIndex: vi.fn().mockResolvedValue(undefined),
  cancelIndexing: vi.fn(),
  unloadModels: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
  dispose: vi.fn(),
}));

const createStackingEngineMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  generatePromptHash: (prompt: string) => `hash-${prompt}`,
  computeSimilarityGroupIds: vi.fn().mockResolvedValue({
    groupIdToSimId: new Map(),
  }),
  computePromptSimilarity: vi.fn().mockResolvedValue(0.9),
}));

const bulkSaveAnnotationsMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);

vi.mock('../services/semanticSearchEngine', () => ({
  SemanticSearchCoordinator: vi.fn(function SemanticSearchCoordinator() {
    return coordinatorMock;
  }),
}));

vi.mock('../services/aiBridge', () => ({
  createStackingEngine: createStackingEngineMock,
  // Mirrored constants — keep in sync with the real module.
  SEARCH_ENRICHMENT_VERSION: 2,
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: bulkSaveAnnotationsMock,
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

// The AI worker factory lives in the closed-source ai-intelligence module;
// mock it so a worker construction is observable (must NEVER happen without
// a license).
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
    },
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

const dir = (id: string, path: string, isConnected: boolean): any => ({
  id,
  name: id,
  path,
  handle: {} as any,
  visible: true,
  autoWatch: true,
  isConnected,
});

beforeEach(() => {
  vi.clearAllMocks(); // call history only — implementations persist
  // …but mockReturnValue overrides DO persist across tests — restore the
  // default open-gate so each test starts premium-on unless it opts out.
  featureAccessMocks.isAiFeaturesEnabled.mockReturnValue(true);
  featureAccessMocks.isAiModelFeaturesEnabled.mockReturnValue(true);
  featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(true);
  FakeTaggingWorker.lastInstance = null;
  useSettingsStore.setState({ aiTagModel: '' });
  useImageStore.setState({
    images: [],
    filteredImages: [],
    annotations: new Map(),
    isAnnotationsLoaded: true,
    indexingState: 'idle',
    isAutoTagging: false,
    autoTaggingWorker: null,
    autoTagWorkerModelId: null,
    autoTaggingProgress: null,
    similarityGroupProgress: null,
    semanticIndexProgress: null,
    pipelinePhase: null,
    directories: [],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    error: null,
  });
});

const twoImages = () => {
  const imgA = createImage({ id: 'imgA', name: 'a.png', directoryId: 'dir1', prompt: 'red fox' });
  const imgB = createImage({ id: 'imgB', name: 'b.png', directoryId: 'dir1', prompt: 'blue cat' });
  useImageStore.setState({
    images: [imgA, imgB],
    filteredImages: [imgA, imgB],
    directories: [dir('dir1', 'C:/lib', true)],
  });
};

// License off → the composition the real isSemanticSearchEnabled would give:
// premium false AND the derived semantic gate false.
const premiumOff = () => {
  featureAccessMocks.isAiFeaturesEnabled.mockReturnValue(false);
  featureAccessMocks.isAiModelFeaturesEnabled.mockReturnValue(false);
  featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false);
};

describe('premium gating — license off', () => {
  it('stacking skips entirely: no engine, no annotation writes, images untouched', async () => {
    twoImages();
    premiumOff();

    await useImageStore.getState().syncNewImagesToStacks();

    expect(createStackingEngineMock).not.toHaveBeenCalled();
    expect(bulkSaveAnnotationsMock).not.toHaveBeenCalled();
    expect(useImageStore.getState().images.every((img) => !img.stackGroupId)).toBe(true);
  });

  it('similarity grouping skips without a license and never flashes progress', async () => {
    twoImages();
    premiumOff();

    await useImageStore.getState().computeSimilarityGroups();

    expect(createStackingEngineMock).not.toHaveBeenCalled();
    expect(bulkSaveAnnotationsMock).not.toHaveBeenCalled();
    expect(useImageStore.getState().similarityGroupProgress).toBeNull();
  });

  it('a full pipeline round performs zero premium work and still completes', async () => {
    twoImages();
    premiumOff();

    await useImageStore.getState().processPostIndexingPipeline();

    expect(createStackingEngineMock).not.toHaveBeenCalled();       // stacking + similarity
    expect(FakeTaggingWorker.lastInstance).toBeNull();             // auto-tag
    expect(coordinatorMock.ensureInitialized).not.toHaveBeenCalled(); // semantic
    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();
    expect(useImageStore.getState().pipelinePhase).toBeNull();     // round completed
  });

  it('auto-tagging is a silent no-op without a license (no worker created)', async () => {
    twoImages();
    premiumOff();

    const result = await useImageStore.getState().startAutoTagging('', false, {});

    expect(result).toBeUndefined();
    expect(FakeTaggingWorker.lastInstance).toBeNull();
    expect(useImageStore.getState().isAutoTagging).toBe(false);
  });

  it('semantic indexing is a silent no-op without a license', async () => {
    twoImages();
    premiumOff();

    await useImageStore.getState().semanticIndexImages();

    expect(coordinatorMock.ensureInitialized).not.toHaveBeenCalled();
    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();
  });
});

describe('premium gating — license on', () => {
  it('semantic indexing still respects the user toggle when premium is on', async () => {
    twoImages();
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false); // toggle off

    await useImageStore.getState().semanticIndexImages();

    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();
  });

  it('stacking runs with a license (sanity — the gate must not over-block)', async () => {
    twoImages();

    await useImageStore.getState().syncNewImagesToStacks();

    expect(createStackingEngineMock).toHaveBeenCalledTimes(1);
    expect(bulkSaveAnnotationsMock).toHaveBeenCalledTimes(1);
    const written = bulkSaveAnnotationsMock.mock.calls[0][0] as ImageAnnotations[];
    expect(written).toHaveLength(2);
    expect(written.every((a) => Boolean(a.stackGroupId))).toBe(true);
  });

  it('semantic indexing runs with a license and the toggle on (sanity)', async () => {
    twoImages();

    await useImageStore.getState().semanticIndexImages();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
  });
});

// ── Master AI-features toggle — model features off, stacking survives ──
// The store's gates call the (mocked) featureAccess functions, so master-off
// is emulated through the mocks; the REAL settings pref is flipped too,
// exercising the store's subscribe path (cancel → unload → clear) without
// coordinator contact while the semantic gate mock stays false.
describe('master AI toggle — model features off, stacking survives', () => {
  // Restore the pref + open the gates so later describes run master-on.
  // The flip-back fires the subscribe's ON branch (Δ-index attempt) — it
  // must run while the semantic gate mock is still false so it short-circuits
  // at runSemanticIndexNow's gate (line ~210) BEFORE any coordinator contact.
  const masterOn = async () => {
    useSettingsStore.setState({ aiFeaturesEnabled: true });
    await new Promise((r) => setTimeout(r, 0));
    featureAccessMocks.isAiModelFeaturesEnabled.mockReturnValue(true);
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(true);
  };

  it('auto-tagging never creates a worker when the master toggle is off', async () => {
    twoImages();
    useSettingsStore.setState({ aiFeaturesEnabled: false });
    featureAccessMocks.isAiModelFeaturesEnabled.mockReturnValue(false);

    const result = await useImageStore.getState().startAutoTagging('', false, {});

    expect(result).toBeUndefined();
    expect(FakeTaggingWorker.lastInstance).toBeNull();
    expect(useImageStore.getState().isAutoTagging).toBe(false);
    await masterOn();
  });

  it('semantic indexing is a silent no-op when the master toggle is off', async () => {
    twoImages();
    useSettingsStore.setState({ aiFeaturesEnabled: false });
    featureAccessMocks.isAiModelFeaturesEnabled.mockReturnValue(false);
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false);

    await useImageStore.getState().semanticIndexImages();

    expect(coordinatorMock.ensureInitialized).not.toHaveBeenCalled();
    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();
    await masterOn();
  });

  it('stacking STILL runs when the master toggle is off (rule-based, no model load)', async () => {
    twoImages();
    useSettingsStore.setState({ aiFeaturesEnabled: false });
    featureAccessMocks.isAiModelFeaturesEnabled.mockReturnValue(false);

    await useImageStore.getState().syncNewImagesToStacks();

    expect(createStackingEngineMock).toHaveBeenCalledTimes(1);
    expect(bulkSaveAnnotationsMock).toHaveBeenCalledTimes(1);
    const written = bulkSaveAnnotationsMock.mock.calls[0][0] as ImageAnnotations[];
    expect(written).toHaveLength(2);
    expect(written.every((a) => Boolean(a.stackGroupId))).toBe(true);
    await masterOn();
  });
});
