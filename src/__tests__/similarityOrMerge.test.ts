/**
 * OR-merge contract for similarity stacking.
 *
 * THE BUG THIS FILE PINS: before the v4 fix, `runPipelineRound()` chose exactly
 * ONE similarity engine per round — on any semantic-enabled machine it called
 * `computeVectorSimilarityGroups()` and never `computeSimilarityGroups()`. The
 * lexical signal (jaccard×0.6 + levenshtein×0.4, which predates embeddings and
 * performed better) was switched OFF, not superseded, and stacks regressed.
 *
 * The contract now: a pair of prompt groups shares a stack when the lexical
 * score clears `SIMILARITY_MATCH_THRESHOLD` (0.80, the app's lexical bar) **OR**
 * the vector score clears the MODULE's own bar (now 0.90 on the mean-centered
 * cosine scale — the two are different metrics, so the numbers are
 * deliberately independent and the vector pass is passed no threshold at all).
 * The vector pass may only ADD members — the lexical partition is the floor, and
 * `computeVectorSimilarityGroups` is handed the lexical candidate set to make
 * that structural rather than aspirational.
 *
 * `computePromptSimilarity` is mocked SYNCHRONOUSLY and returns 0 by default:
 * the lexical incremental path compares `score >= threshold`, so a
 * promise-returning mock is always falsy and reads as "lexical agrees" when it
 * means nothing. Each test opts into the lexical signal it needs.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Persisted-store tests need a localStorage mock before ANY store import — the
// similarity version bump reads it during loadAnnotations.
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

// Hoisted so tests can drive the two signals independently: the lexical pass
// goes through `computeSimilarityGroupIds` (batch) / `computePromptSimilarity`
// (incremental), the vector pass through the coordinator's cluster call.
const stackingEngineMock = vi.hoisted(() => ({
  generatePromptHash: (prompt: string) => `hash-${prompt}`,
  computeSimilarityGroupIds: vi.fn(),
  computePromptSimilarity: vi.fn(),
}));

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);

vi.mock('../services/semanticSearchEngine', () => ({
  SemanticSearchCoordinator: vi.fn(function SemanticSearchCoordinator() {
    return coordinatorMock;
  }),
}));

vi.mock('../services/aiBridge', () => ({
  createStackingEngine: vi.fn().mockResolvedValue(stackingEngineMock),
  // Mirrored constants — keep in sync with the real module
  // (src/services/aiBridge.ts). A full-replacement mock must export every
  // constant the store reads at runtime, or the round throws mid-phase.
  SEARCH_ENRICHMENT_VERSION: 2,
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
  SIMILARITY_MATCH_THRESHOLD: 0.8,
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
  deleteAnnotation: vi.fn().mockResolvedValue(true),
}));

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
  ...overrides,
});

// Pre-enriched + stamped: the auto-tag and semantic phases no-op, so a round
// exercises exactly the similarity phase under test. stackGroupId must match
// the engine mock's hash, or reconcilePromptHashes rewrites it mid-round.
const enrichedAnnotation = (
  imageId: string,
  prompt: string,
  overrides: Partial<ImageAnnotations> = {},
): ImageAnnotations => ({
  imageId,
  isFavorite: false,
  tags: [],
  autoTags: ['already-tagged'],
  metadataTags: [],
  isAutoTagged: true,
  synonymTags: [],
  searchTagVersion: 2,
  stackGroupId: `hash-${prompt}`,
  isStackAnalyzed: true,
  isSemanticIndexed: true,
  addedAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const seed = (entries: Array<[IndexedImage, ImageAnnotations]>) => {
  useImageStore.setState({
    images: entries.map(([img]) => img),
    filteredImages: entries.map(([img]) => img),
    annotations: new Map(entries.map(([img, ann]) => [img.id, ann])),
  });
};

const annotations = () => useImageStore.getState().annotations;
const simIdOf = (id: string) => annotations().get(id)!.similarityGroupId;

const lastClusterCall = () =>
  coordinatorMock.clusterPromptGroups.mock.calls[
    coordinatorMock.clusterPromptGroups.mock.calls.length - 1
  ][0] as {
    newGroups: Array<{ groupId: string; prompt: string; representativeImageId: string }>;
    existingGroups: Array<{ groupId: string; memberImageIds: string[]; nonLatin?: boolean }>;
    threshold?: number;
  };

beforeEach(() => {
  vi.clearAllMocks(); // call history only — implementations persist
  FakeTaggingWorker.lastInstance = null;
  useSettingsStore.setState({ aiTagModel: '' });
  featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(true);

  // Defensive reset: a stale once-queue from a failed test poisons the next
  // one (see vitest-stale-mockreturnvalueonce memory).
  stackingEngineMock.computeSimilarityGroupIds.mockReset();
  stackingEngineMock.computeSimilarityGroupIds.mockResolvedValue({ groupIdToSimId: new Map() });
  stackingEngineMock.computePromptSimilarity.mockReset();
  stackingEngineMock.computePromptSimilarity.mockReturnValue(0);

  coordinatorMock.clusterPromptGroups.mockReset();
  coordinatorMock.clusterPromptGroups.mockResolvedValue({
    groupIdToSimId: new Map(),
    updatedRepresentatives: [],
  });
  coordinatorMock.embedPromptVectors.mockReset();
  coordinatorMock.embedPromptVectors.mockResolvedValue({ embedded: 0, skipped: 0 });

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

describe('similarity OR-merge — the lexical floor survives a vector miss', () => {
  it('keeps a lexical merge intact when the vector signal finds nothing (the reported regression)', async () => {
    // A near-duplicate pair — the kind the pre-vector engine stacked correctly
    // and the vector-only branch lost. The two prompts differ by one token, so
    // they hash to DIFFERENT stackGroupIds and only a similarity signal can
    // join them.
    const trees = 'a serene mountain lake at sunrise with pine trees';
    const tree = 'a serene mountain lake at sunrise with pine tree';
    const whale = 'a blue whale breaching at dawn';

    const imgA = createImage({ id: 'imgA', name: 'trees.png', prompt: trees });
    const imgB = createImage({ id: 'imgB', name: 'tree.png', prompt: tree });
    const imgC = createImage({ id: 'imgC', name: 'whale.png', prompt: whale });

    seed([
      [imgA, enrichedAnnotation('imgA', trees, { isSimilarityAnalyzed: false })],
      [imgB, enrichedAnnotation('imgB', tree, { isSimilarityAnalyzed: false })],
      // An untouched fourth-prompt group: it keeps the vector pass alive, so
      // this test proves the merge SURVIVED a real clustering round rather
      // than a round that early-returned before touching anything.
      [imgC, enrichedAnnotation('imgC', whale, { isSimilarityAnalyzed: false })],
    ]);

    // Lexical signal: A and B are near-duplicates under the same bar the real
    // engine applies. (The module's own clustering is covered in
    // ai-intelligence/src/modules/stacking-engine.test.ts.)
    stackingEngineMock.computeSimilarityGroupIds.mockResolvedValueOnce({
      groupIdToSimId: new Map([
        [`hash-${trees}`, `hash-${trees}`],
        [`hash-${tree}`, `hash-${trees}`],
        [`hash-${whale}`, `hash-${whale}`],
      ]),
    });
    // Vector signal: a total miss — it merges nobody.
    coordinatorMock.clusterPromptGroups.mockResolvedValueOnce({
      groupIdToSimId: new Map([
        [`hash-${trees}`, `hash-${trees}`],
        [`hash-${tree}`, `hash-${tree}`],
        [`hash-${whale}`, `hash-${whale}`],
      ]),
      updatedRepresentatives: [],
    });

    await useImageStore.getState().processPostIndexingPipeline();

    // ① The lexical pass RAN on a semantic-enabled machine. Under the old
    //    exclusive branch this call never happened and this assertion fails.
    expect(stackingEngineMock.computeSimilarityGroupIds).toHaveBeenCalledTimes(1);
    expect(stackingEngineMock.computeSimilarityGroupIds.mock.calls[0][0]).toMatchObject({
      threshold: 0.8,
    });

    // ② The lexical merge survived — the vector map self-assigned B and was
    //    not allowed to act on it, because B was already clustered.
    expect(simIdOf('imgA')).toBe(`hash-${trees}`);
    expect(simIdOf('imgB')).toBe(`hash-${trees}`);
    expect(simIdOf('imgC')).toBe(`hash-${whale}`);

    // ③ The vector pass did run, and was offered ONLY the still-standalone
    //    group — never the merged pair.
    expect(coordinatorMock.clusterPromptGroups).toHaveBeenCalledTimes(1);
    const call = lastClusterCall();
    expect(call.newGroups.map((g) => g.groupId)).toEqual([`hash-${whale}`]);
    expect(call.existingGroups).toEqual([
      {
        groupId: `hash-${trees}`,
        memberImageIds: ['imgA', 'imgB'],
        nonLatin: false,
      },
    ]);
    // ④ No threshold is passed. The vector bar is the MODULE's own constant
    //    (0.90 on the CENTERED scale), deliberately not this app's lexical
    //    SIMILARITY_MATCH_THRESHOLD (0.80) — the two are different metrics on
    //    different scales, and sharing the number was part of the over-merging.
    //    Passing 0.8 here again would be a silent regression, so assert the
    //    key is ABSENT rather than merely not-0.8.
    expect('threshold' in call).toBe(false);
  });
});

describe('similarity OR-merge — vector adds on top of the lexical partition', () => {
  it('merges two groups the lexical signal left apart, and leaves the rest alone', async () => {
    const fox = 'a red fox';
    const foxSnow = 'a red fox in snow';
    const whale = 'a blue whale';

    seed([
      [createImage({ id: 'imgA', name: 'fox.png', prompt: fox }),
        enrichedAnnotation('imgA', fox, { isSimilarityAnalyzed: false })],
      [createImage({ id: 'imgB', name: 'fox2.png', prompt: foxSnow }),
        enrichedAnnotation('imgB', foxSnow, { isSimilarityAnalyzed: false })],
      [createImage({ id: 'imgC', name: 'whale.png', prompt: whale }),
        enrichedAnnotation('imgC', whale, { isSimilarityAnalyzed: false })],
    ]);

    // Lexical: nobody merges (each group self-assigns) — the OR's left arm
    // misses. computePromptSimilarity stays at its default 0 for the
    // incremental path.
    // Vector: B joins A. C is omitted from the map entirely.
    coordinatorMock.clusterPromptGroups.mockResolvedValueOnce({
      groupIdToSimId: new Map([
        [`hash-${fox}`, `hash-${fox}`],
        [`hash-${foxSnow}`, `hash-${fox}`],
      ]),
      updatedRepresentatives: [],
    });

    await useImageStore.getState().processPostIndexingPipeline();

    // All three were standalone after lexical → all three were candidates.
    expect(lastClusterCall().newGroups.map((g) => g.groupId).sort()).toEqual(
      [`hash-${fox}`, `hash-${foxSnow}`, `hash-${whale}`].sort(),
    );

    // The OR's right arm carried the merge.
    expect(simIdOf('imgA')).toBe(`hash-${fox}`);
    expect(simIdOf('imgB')).toBe(`hash-${fox}`);
    // …and it did not invent one for the group the module omitted.
    expect(simIdOf('imgC')).toBe(`hash-${whale}`);
    expect(annotations().get('imgC')!.isSimilarityAnalyzed).toBe(true);
  });

  it('never lets a vector target repoint an already-clustered group out of its stack', async () => {
    // A+B are an existing lexical cluster. C is new and standalone. A naive
    // implementation that fed A back as a candidate would hand the module's
    // single best-match target the power to pull A OUT of its cluster — a
    // silent split. The candidate rule makes A a merge TARGET only.
    const fox = 'a red fox';
    const foxSnow = 'a red fox in snow';
    const whale = 'a blue whale';

    seed([
      [createImage({ id: 'imgA', name: 'fox.png', prompt: fox }),
        enrichedAnnotation('imgA', fox, { similarityGroupId: 'sim-AB' })],
      [createImage({ id: 'imgB', name: 'fox2.png', prompt: foxSnow }),
        enrichedAnnotation('imgB', foxSnow, { similarityGroupId: 'sim-AB' })],
      [createImage({ id: 'imgC', name: 'whale.png', prompt: whale }),
        enrichedAnnotation('imgC', whale, { isSimilarityAnalyzed: false })],
    ]);

    // A hostile vector result: it tries to repoint A onto C's group AND merge
    // C into sim-AB. Only the second half is legitimate.
    coordinatorMock.clusterPromptGroups.mockResolvedValueOnce({
      groupIdToSimId: new Map([
        [`hash-${whale}`, 'sim-AB'],
        [`hash-${fox}`, `hash-${whale}`],
      ]),
      updatedRepresentatives: [],
    });

    await useImageStore.getState().processPostIndexingPipeline();

    const call = lastClusterCall();
    // A is NOT offered — it is already clustered, so it is a target.
    expect(call.newGroups.map((g) => g.groupId)).toEqual([`hash-${whale}`]);
    expect(call.existingGroups).toEqual([
      { groupId: 'sim-AB', memberImageIds: ['imgA', 'imgB'], nonLatin: false },
    ]);

    // Monotone: the cluster GREW by one and lost nobody.
    expect(simIdOf('imgA')).toBe('sim-AB');
    expect(simIdOf('imgB')).toBe('sim-AB');
    expect(simIdOf('imgC')).toBe('sim-AB');
  });
});

describe('similarity OR-merge — pipeline shape', () => {
  it('keeps the observed phase sequence unchanged (similarity stays last)', async () => {
    const fox = 'a red fox';
    const whale = 'a blue whale';

    seed([
      [createImage({ id: 'imgA', name: 'fox.png', prompt: fox }),
        enrichedAnnotation('imgA', fox, { isSimilarityAnalyzed: false })],
      [createImage({ id: 'imgB', name: 'whale.png', prompt: whale }),
        enrichedAnnotation('imgB', whale, { isSimilarityAnalyzed: false })],
    ]);

    const phases: Array<string | null> = [];
    const unsub = useImageStore.subscribe((s) => phases.push(s.pipelinePhase));
    await useImageStore.getState().processPostIndexingPipeline();
    unsub();

    // `subscribe` without a selector fires on EVERY state change, so a phase
    // repeats once per progress update while it is active. Collapse runs of
    // the same label to read the actual sequence.
    const observed = phases
      .filter((p): p is string => p !== null)
      .filter((p, i, all) => p !== all[i - 1]);
    expect(observed).toEqual(['stacking', 'autoTag', 'semantic', 'similarity']);

    // Both signals ran INSIDE that single phase. If a future refactor splits
    // them into two phases, the Footer's "Phase N/4" counter and the
    // processingSequencer assertions need updating too.
    expect(stackingEngineMock.computeSimilarityGroupIds).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.clusterPromptGroups).toHaveBeenCalledTimes(1);
  });
});
