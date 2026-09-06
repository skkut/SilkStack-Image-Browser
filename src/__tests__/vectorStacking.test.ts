import { describe, expect, it, vi, beforeEach } from 'vitest';

// Persisted-store tests need a localStorage mock before ANY store import.
// This one is a real in-memory map so the similarityGroupVersion bump can be
// seeded and round-tripped (the version reset reads it during loadAnnotations).
vi.hoisted(() => {
  const storage = new Map<string, string>();
  global.localStorage = {
    getItem: vi.fn((k: string) => storage.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { storage.set(k, String(v)); }),
    removeItem: vi.fn((k: string) => { storage.delete(k); }),
    clear: vi.fn(() => { storage.clear(); }),
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
  ensureInitialized: vi.fn().mockResolvedValue(undefined),
  indexImages: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0 }),
  search: vi.fn().mockResolvedValue([]),
  clearIndex: vi.fn().mockResolvedValue(undefined),
  cancelIndexing: vi.fn(),
  unloadModels: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
  dispose: vi.fn(),
  embedPromptVectors: vi.fn().mockResolvedValue({ embedded: 0, skipped: 0 }),
  getPromptVectors: vi.fn().mockResolvedValue([]),
  getPromptSimilarityGroups: vi.fn().mockResolvedValue([]),
  clusterPromptGroups: vi.fn().mockResolvedValue({ groupIdToSimId: new Map(), updatedRepresentatives: [] }),
  removeImages: vi.fn().mockResolvedValue(undefined),
  switchStorageDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);

// The store lazy-loads the coordinator via dynamic import — every `new
// SemanticSearchCoordinator(...)` returns the same mock instance, mirroring
// the module-level singleton in useImageStore. Constructable via `function`.
vi.mock('../services/semanticSearchEngine', () => ({
  SemanticSearchCoordinator: vi.fn(function SemanticSearchCoordinator() {
    return coordinatorMock;
  }),
}));

vi.mock('../services/aiBridge', () => ({
  createStackingEngine: vi.fn().mockResolvedValue({
    generatePromptHash: (prompt: string) => `hash-${prompt}`,
    computeSimilarityGroupIds: vi.fn().mockResolvedValue({
      groupIdToSimId: new Map(),
    }),
    computePromptSimilarity: vi.fn().mockResolvedValue(0.9),
  }),
  // Mirrored by the store's enrichment gate — keep in sync with the real
  // constant (src/services/aiBridge.ts). Pre-enriched test annotations carry
  // this version so the auto-tag phase no-ops (no worker spawn, no block).
  SEARCH_ENRICHMENT_VERSION: 2,
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
  deleteAnnotation: vi.fn().mockResolvedValue(true),
}));

// Defensive: the auto-tag phase dynamically imports the closed module's
// worker factory. All seeds below are pre-enriched so it never fires, but a
// missing mock would turn an accidental spawn into a cryptic import error.
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
import { loadAllAnnotations } from '../services/imageAnnotationsStorage';
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

// Pre-enriched + stamped annotation: the auto-tag and semantic phases no-op,
// so the round exercises exactly the similarity phase under test.
const enrichedAnnotation = (imageId: string, prompt: string, overrides: Partial<ImageAnnotations> = {}): ImageAnnotations => ({
  imageId,
  isFavorite: false,
  tags: [],
  autoTags: ['already-tagged'],
  metadataTags: [],
  isAutoTagged: true,
  synonymTags: [],
  searchTagVersion: 2,
  // stackGroupId must match the mock engine hash (reconcilePromptHashes
  // invariant — a fake id would be rewritten mid-round).
  stackGroupId: `hash-${prompt}`,
  isStackAnalyzed: true,
  isSemanticIndexed: true,
  addedAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const lastClusterCall = () =>
  coordinatorMock.clusterPromptGroups.mock.calls[coordinatorMock.clusterPromptGroups.mock.calls.length - 1][0] as {
    newGroups: Array<{ groupId: string; prompt: string; representativeImageId: string }>;
    existingGroups: Array<{ groupId: string; memberImageIds: string[]; nonLatin?: boolean }>;
  };

beforeEach(() => {
  vi.clearAllMocks(); // call history only — implementations persist
  FakeTaggingWorker.lastInstance = null;
  useSettingsStore.setState({ aiTagModel: '' });
  featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(true);
  // Defensive reset against a stale mockReturnValueOnce from a failed test
  // (see vitest-stale-mockreturnvalueonce memory): fresh defaults for the
  // vector methods, then per-test once-values override the first call only.
  coordinatorMock.clusterPromptGroups.mockReset();
  coordinatorMock.clusterPromptGroups.mockResolvedValue({ groupIdToSimId: new Map(), updatedRepresentatives: [] });
  coordinatorMock.embedPromptVectors.mockReset();
  coordinatorMock.embedPromptVectors.mockResolvedValue({ embedded: 0, skipped: 0 });
  coordinatorMock.removeImages.mockReset();
  coordinatorMock.removeImages.mockResolvedValue(undefined);
  vi.mocked(loadAllAnnotations).mockReset();
  vi.mocked(loadAllAnnotations).mockResolvedValue(new Map());
  (global.localStorage as any).clear();
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
    semanticIndexProgress: null,
    pipelinePhase: null,
    directories: [],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    error: null,
  });
});

describe('vector stacking — pipeline round integration', () => {
  it('embeds + clusters new prompt groups and self-assigns unmerged ones (semantic gate untouched)', async () => {
    const fox = createImage({ id: 'imgA', name: 'fox.png', prompt: 'a red fox' });
    const whale = createImage({ id: 'imgB', name: 'whale.png', prompt: 'a blue whale' });
    useImageStore.setState({
      images: [fox, whale],
      filteredImages: [fox, whale],
      annotations: new Map([
        ['imgA', enrichedAnnotation('imgA', 'a red fox', { similarityGroupId: undefined, isSimilarityAnalyzed: false })],
        ['imgB', enrichedAnnotation('imgB', 'a blue whale', { similarityGroupId: undefined, isSimilarityAnalyzed: false })],
      ]),
    });

    const phases: Array<string | null> = [];
    const unsub = useImageStore.subscribe((s) => phases.push(s.pipelinePhase));
    await useImageStore.getState().processPostIndexingPipeline();
    unsub();

    // Vector branch: similarity is LAST (prompt vectors only exist after the
    // semantic pass).
    const iSemantic = phases.indexOf('semantic');
    const iSimilarity = phases.indexOf('similarity');
    expect(iSemantic).toBeGreaterThan(-1);
    expect(iSimilarity).toBeGreaterThan(iSemantic);

    // The backfill embeds one entry per distinct new prompt group.
    expect(coordinatorMock.embedPromptVectors).toHaveBeenCalledTimes(1);
    const embedEntries = coordinatorMock.embedPromptVectors.mock.calls[0][0] as Array<{ id: string; prompt: string }>;
    expect(embedEntries).toEqual([
      { id: 'imgA', prompt: 'a red fox' },
      { id: 'imgB', prompt: 'a blue whale' },
    ]);

    expect(coordinatorMock.clusterPromptGroups).toHaveBeenCalledTimes(1);
    const call = lastClusterCall();
    expect(call.newGroups).toEqual([
      { groupId: 'hash-a red fox', prompt: 'a red fox', representativeImageId: 'imgA' },
      { groupId: 'hash-a blue whale', prompt: 'a blue whale', representativeImageId: 'imgB' },
    ]);
    expect(call.existingGroups).toEqual([]);

    // Both images were stamped → the semantic phase sent nothing.
    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();

    // Unmerged groups self-assign; the semantic stamp survives clustering.
    const annA = useImageStore.getState().annotations.get('imgA')!;
    const annB = useImageStore.getState().annotations.get('imgB')!;
    expect(annA.similarityGroupId).toBe('hash-a red fox');
    expect(annA.isSimilarityAnalyzed).toBe(true);
    expect(annA.isSemanticIndexed).toBe(true);
    expect(annB.similarityGroupId).toBe('hash-a blue whale');
    expect(annB.isSimilarityAnalyzed).toBe(true);
  });

  it('passes existing groups with members + nonLatin flag and merges new groups into them', async () => {
    // Existing similarity group 'sim-1' whose member prompt is non-Latin
    // ('赤い狐' — CJK range of NON_LATIN_SCRIPT_RE) → cross-lingual
    // relaxation applies; a new Latin group merges into it.
    const member = createImage({ id: 'imgA', name: 'fox.png', prompt: '赤い狐' });
    const newcomer = createImage({ id: 'imgB', name: 'fox2.png', prompt: 'a red fox' });
    useImageStore.setState({
      images: [member, newcomer],
      filteredImages: [member, newcomer],
      annotations: new Map([
        ['imgA', enrichedAnnotation('imgA', '赤い狐', { similarityGroupId: 'sim-1', isSimilarityAnalyzed: true })],
        ['imgB', enrichedAnnotation('imgB', 'a red fox', { similarityGroupId: undefined, isSimilarityAnalyzed: false })],
      ]),
    });

    coordinatorMock.clusterPromptGroups.mockResolvedValueOnce({
      groupIdToSimId: new Map([['hash-a red fox', 'sim-1']]),
      updatedRepresentatives: [],
    });

    await useImageStore.getState().processPostIndexingPipeline();

    const call = lastClusterCall();
    expect(call.newGroups).toEqual([
      { groupId: 'hash-a red fox', prompt: 'a red fox', representativeImageId: 'imgB' },
    ]);
    expect(call.existingGroups).toEqual([
      { groupId: 'sim-1', memberImageIds: ['imgA'], nonLatin: true },
    ]);

    const annB = useImageStore.getState().annotations.get('imgB')!;
    expect(annB.similarityGroupId).toBe('sim-1');
    expect(annB.isSimilarityAnalyzed).toBe(true);
  });

  it('manual merged-* groups are never re-assigned (union-only) but still absorb new groups', async () => {
    const merged = createImage({ id: 'imgA', name: 'fox.png', prompt: 'a red fox' });
    const newcomer = createImage({ id: 'imgB', name: 'whale.png', prompt: 'a blue whale' });
    useImageStore.setState({
      images: [merged, newcomer],
      filteredImages: [merged, newcomer],
      annotations: new Map([
        ['imgA', enrichedAnnotation('imgA', 'a red fox', { similarityGroupId: 'merged-123', isSimilarityAnalyzed: true })],
        ['imgB', enrichedAnnotation('imgB', 'a blue whale', { similarityGroupId: undefined, isSimilarityAnalyzed: false })],
      ]),
    });

    await useImageStore.getState().processPostIndexingPipeline();

    // The manually merged image is analyzed → excluded from newGroups; its
    // group appears as an existing group (absorb-only).
    const call = lastClusterCall();
    expect(call.newGroups.map((g) => g.groupId)).toEqual(['hash-a blue whale']);
    expect(call.existingGroups).toEqual([
      { groupId: 'merged-123', memberImageIds: ['imgA'], nonLatin: false },
    ]);

    const annA = useImageStore.getState().annotations.get('imgA')!;
    expect(annA.similarityGroupId).toBe('merged-123'); // never re-assigned
    expect(annA.isSimilarityAnalyzed).toBe(true);
  });

  it('semantic-off falls back to the lexical branch — the coordinator is never consulted', async () => {
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false);
    const img = createImage({ id: 'imgA', name: 'fox.png', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      annotations: new Map([
        ['imgA', enrichedAnnotation('imgA', 'a red fox', { similarityGroupId: undefined, isSimilarityAnalyzed: false })],
      ]),
    });

    await useImageStore.getState().processPostIndexingPipeline();

    expect(coordinatorMock.embedPromptVectors).not.toHaveBeenCalled();
    expect(coordinatorMock.clusterPromptGroups).not.toHaveBeenCalled();

    // The lexical matcher ran: a single new group self-assigns.
    const ann = useImageStore.getState().annotations.get('imgA')!;
    expect(ann.isSimilarityAnalyzed).toBe(true);
    expect(ann.similarityGroupId).toBe('hash-a red fox');
  });

  it('a vector-cluster failure falls back to lexical clustering so stacks still form', async () => {
    const img = createImage({ id: 'imgA', name: 'fox.png', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      annotations: new Map([
        ['imgA', enrichedAnnotation('imgA', 'a red fox', { similarityGroupId: undefined, isSimilarityAnalyzed: false })],
      ]),
    });

    coordinatorMock.clusterPromptGroups.mockRejectedValueOnce(new Error('boom'));

    await useImageStore.getState().processPostIndexingPipeline();

    expect(coordinatorMock.clusterPromptGroups).toHaveBeenCalledTimes(1);
    const ann = useImageStore.getState().annotations.get('imgA')!;
    expect(ann.isSimilarityAnalyzed).toBe(true);      // lexical fallback completed
    expect(ann.similarityGroupId).toBe('hash-a red fox');
  });
});

describe('vector stacking — similarity version bump (2 → 3)', () => {
  it('loadAnnotations resets similarity groups on the version bump; the next round backfills vectors', async () => {
    // Pre-upgrade persisted state: version 2, one merged group.
    (global.localStorage as any).setItem('similarityGroupVersion', '2');
    const persisted: ImageAnnotations = enrichedAnnotation('imgA', 'a red fox', {
      similarityGroupId: 'sim-1',
      isSimilarityAnalyzed: true,
    });
    vi.mocked(loadAllAnnotations).mockResolvedValue(new Map([['imgA', persisted]]));

    const img = createImage({ id: 'imgA', name: 'fox.png', prompt: 'a red fox' });
    useImageStore.setState({ images: [img], filteredImages: [img] });

    await useImageStore.getState().loadAnnotations();

    // The bump cleared the old grouping (all groups become "new" → the
    // vector backfill re-embeds every distinct prompt once) and re-persisted
    // the current version. Enrichment/semantic stamps survive.
    const ann = useImageStore.getState().annotations.get('imgA')!;
    expect(ann.similarityGroupId).toBeUndefined();
    expect(ann.isSimilarityAnalyzed).toBe(false);
    expect(ann.isSemanticIndexed).toBe(true);
    expect(ann.searchTagVersion).toBe(2);
    expect((global.localStorage as any).getItem('similarityGroupVersion')).toBe('3');

    // The post-upgrade round backfills the prompt vector…
    await useImageStore.getState().processPostIndexingPipeline();
    expect(coordinatorMock.embedPromptVectors).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.embedPromptVectors.mock.calls[0][0]).toEqual([
      { id: 'imgA', prompt: 'a red fox' },
    ]);

    // …and re-clusters it (self-assign: no existing groups left).
    const reann = useImageStore.getState().annotations.get('imgA')!;
    expect(reann.similarityGroupId).toBe('hash-a red fox');
    expect(reann.isSimilarityAnalyzed).toBe(true);
  });
});

describe('vector stacking — deletion hook', () => {
  it('removeImages deletes the annotation and removes its vectors from the coordinator', async () => {
    const img = createImage({ id: 'imgA', name: 'fox.png', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      annotations: new Map([
        ['imgA', enrichedAnnotation('imgA', 'a red fox', { similarityGroupId: 'sim-1', isSimilarityAnalyzed: true })],
      ]),
    });

    useImageStore.getState().removeImages(['imgA']);
    await flush();

    expect(useImageStore.getState().annotations.has('imgA')).toBe(false);
    expect(coordinatorMock.removeImages).toHaveBeenCalledWith(['imgA']);
  });

  it('a vector-cleanup failure is swallowed — removal still completes', async () => {
    coordinatorMock.removeImages.mockRejectedValueOnce(new Error('db locked'));
    const img = createImage({ id: 'imgA', name: 'fox.png', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      annotations: new Map([
        ['imgA', enrichedAnnotation('imgA', 'a red fox', { similarityGroupId: 'sim-1', isSimilarityAnalyzed: true })],
      ]),
    });

    expect(() => useImageStore.getState().removeImages(['imgA'])).not.toThrow();
    await flush();

    expect(useImageStore.getState().annotations.has('imgA')).toBe(false);
    expect(coordinatorMock.removeImages).toHaveBeenCalledWith(['imgA']);
  });
});
