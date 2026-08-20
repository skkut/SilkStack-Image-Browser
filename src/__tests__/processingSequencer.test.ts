import { describe, expect, it, vi, beforeEach } from 'vitest';

// Persisted-store tests need a localStorage mock before ANY store import.
// This one is a real in-memory map (unlike the 'true'-always stub in the
// other files) so markReprocessPending round-trips can be asserted.
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
  isSemanticSearchEnabled: vi.fn(() => true),
  useSemanticSearchEnabled: vi.fn(() => true),
}));

const coordinatorMock = vi.hoisted(() => ({
  ensureInitialized: vi.fn(),
  indexImages: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0 }),
  search: vi.fn(),
  clearIndex: vi.fn().mockResolvedValue(undefined),
  cancelIndexing: vi.fn(),
  getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
  dispose: vi.fn(),
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
  // this version so a second auto-tag pass no-ops.
  SEARCH_ENRICHMENT_VERSION: 1,
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

// The AI worker factory lives in the closed-source ai-intelligence module;
// mock it so startAutoTagging constructs the fake worker directly.
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
import { processingQueue } from '../services/processingQueue';
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

// Already-enriched annotation — needsSearchEnrichment sees the current
// version and skips, so auto-tag no-ops for this image.
const enrichedAnnotation = (imageId: string): ImageAnnotations => ({
  imageId,
  isFavorite: false,
  tags: [],
  autoTags: ['already-tagged'],
  metadataTags: [],
  isAutoTagged: true,
  synonymTags: [],
  searchTagVersion: 1,
  addedAt: 1000,
  updatedAt: 1000,
});

const completeRun = (worker: FakeTaggingWorker, autoTags: Record<string, unknown> = {}) => {
  worker.onmessage?.({ data: { type: 'complete', payload: { autoTags } } } as MessageEvent);
};

beforeEach(() => {
  vi.clearAllMocks(); // call history only — implementations persist
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
    semanticIndexProgress: null,
    pipelinePhase: null,
    directories: [],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    error: null,
  });
});

describe('runPipelineRound — canonical sequential round', () => {
  it('runs one round in order: stacking → similarity → autoTag → semantic → idle', async () => {
    const phases: Array<string | null> = [];
    const unsub = useImageStore.subscribe((s) => phases.push(s.pipelinePhase));
    await useImageStore.getState().processPostIndexingPipeline();
    unsub();

    const iStacking = phases.indexOf('stacking');
    const iSimilarity = phases.indexOf('similarity');
    const iAutoTag = phases.indexOf('autoTag');
    const iSemantic = phases.indexOf('semantic');
    expect(iStacking).toBeGreaterThan(-1);
    expect(iSimilarity).toBeGreaterThan(iStacking);
    expect(iAutoTag).toBeGreaterThan(iSimilarity);
    expect(iSemantic).toBeGreaterThan(iAutoTag);
    expect(phases[phases.length - 1]).toBeNull(); // the round resets the phase
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
  });

  it('awaits the auto-tag run before the semantic phase starts', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      directories: [dir('dir1', 'C:/lib', true)],
    });

    const round = useImageStore.getState().processPostIndexingPipeline();
    await vi.waitFor(() => {
      expect(FakeTaggingWorker.lastInstance).toBeTruthy();
      expect(useImageStore.getState().pipelinePhase).toBe('autoTag');
    });
    const worker = FakeTaggingWorker.lastInstance!;
    expect(worker.posted.some((m) => m.type === 'start')).toBe(true);
    // Phase 3 is in flight — the semantic phase must NOT have started yet.
    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();

    completeRun(worker);
    await round;

    expect(useImageStore.getState().pipelinePhase).toBeNull();
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
  });

  it('auto-tag completion alone does NOT trigger semantic indexing', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      directories: [dir('dir1', 'C:/lib', true)],
    });

    const run = useImageStore.getState().startAutoTagging('', false, { scope: 'library' });
    await vi.waitFor(() => { expect(FakeTaggingWorker.lastInstance).toBeTruthy(); });
    completeRun(FakeTaggingWorker.lastInstance!);
    await run;

    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();
  });
});

describe('startAutoTagging scope (view vs library)', () => {
  const setupImages = () => {
    const imgA = createImage({ id: 'imgA', name: 'a.png', directoryId: 'dir1', prompt: 'one' });
    const imgB = createImage({ id: 'imgB', name: 'b.png', directoryId: 'dir2', prompt: 'two' });
    const imgC = createImage({ id: 'imgC', name: 'c.png', directoryId: 'dir3', prompt: 'three' });
    useImageStore.setState({
      images: [imgA, imgB, imgC],
      filteredImages: [imgB], // the view shows only the offline dir's image
      directories: [dir('dir1', 'C:/on1', true), dir('dir2', 'C:/off', false), dir('dir3', 'C:/on2', true)],
    });
  };

  it('library scope tags images from connected dirs only — offline dirs are excluded', async () => {
    setupImages();
    const run = useImageStore.getState().startAutoTagging('', false, { scope: 'library' });
    await vi.waitFor(() => { expect(FakeTaggingWorker.lastInstance).toBeTruthy(); });
    const start = FakeTaggingWorker.lastInstance!.posted.find((m) => m.type === 'start');
    const ids = (start!.payload.images as Array<{ id: string }>).map((i) => i.id).sort();
    expect(ids).toEqual(['imgA', 'imgC']);
    completeRun(FakeTaggingWorker.lastInstance!);
    await run;
  });

  it('the default scope is the current view (manual Auto-Tag button behavior)', async () => {
    setupImages();
    const run = useImageStore.getState().startAutoTagging('', false, {}); // no scope option
    await vi.waitFor(() => { expect(FakeTaggingWorker.lastInstance).toBeTruthy(); });
    const start = FakeTaggingWorker.lastInstance!.posted.find((m) => m.type === 'start');
    const ids = (start!.payload.images as Array<{ id: string }>).map((i) => i.id).sort();
    expect(ids).toEqual(['imgB']); // filteredImages only
    completeRun(FakeTaggingWorker.lastInstance!);
    await run;
  });
});

describe('startAutoTagging promise semantics', () => {
  it('resolves on complete / error / cancel, no-ops immediately, and coalesces in-flight calls', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      directories: [dir('dir1', 'C:/lib', true)],
    });

    // `isAutoTagging` flips true exactly when a run's body has committed its
    // worker + in-flight promise — a stronger wait than `lastInstance`, which
    // survives terminate() and would let the next segment fire into a stale
    // handler.
    const waitForRun = () => vi.waitFor(() => {
      expect(useImageStore.getState().isAutoTagging).toBe(true);
    });

    // Resolves when the worker reports 'complete'.
    const run1 = useImageStore.getState().startAutoTagging('', false, {});
    await waitForRun();
    completeRun(FakeTaggingWorker.lastInstance!);
    await expect(run1).resolves.toBeUndefined();

    // A second call while a run is in flight JOINS the running run instead
    // of clobbering the worker's onmessage: no new 'start' is posted, and
    // both callers settle on the same completion.
    const p1 = useImageStore.getState().startAutoTagging('', false, {});
    await waitForRun();
    const startsBefore = FakeTaggingWorker.lastInstance!.posted.filter((m) => m.type === 'start').length;
    const p2 = useImageStore.getState().startAutoTagging('', false, {});
    expect(FakeTaggingWorker.lastInstance!.posted.filter((m) => m.type === 'start').length).toBe(startsBefore);
    completeRun(FakeTaggingWorker.lastInstance!);
    await p1;
    await p2;

    // Resolves (never rejects) when the worker reports 'error'.
    const p3 = useImageStore.getState().startAutoTagging('', false, {});
    await waitForRun();
    FakeTaggingWorker.lastInstance!.onmessage?.({ data: { type: 'error', payload: { error: 'boom' } } } as MessageEvent);
    await expect(p3).resolves.toBeUndefined();
    expect(useImageStore.getState().error).toContain('boom');

    // Resolves when the user cancels (terminate() means 'complete' never fires).
    const p4 = useImageStore.getState().startAutoTagging('', false, {});
    await waitForRun();
    useImageStore.getState().cancelAutoTagging();
    await expect(p4).resolves.toBeUndefined();
    expect(useImageStore.getState().isAutoTagging).toBe(false);

    // No-op: nothing needs enrichment → settles immediately, no worker, no post.
    const workerBefore = FakeTaggingWorker.lastInstance;
    const startsBeforeNoOp = workerBefore?.posted.filter((m) => m.type === 'start').length ?? 0;
    useImageStore.setState({ annotations: new Map([['imgA', enrichedAnnotation('imgA')]]) });
    const noOp = await useImageStore.getState().startAutoTagging('', false, {});
    expect(noOp).toBeUndefined();
    expect(FakeTaggingWorker.lastInstance).toBe(workerBefore);
    expect(FakeTaggingWorker.lastInstance?.posted.filter((m) => m.type === 'start').length).toBe(startsBeforeNoOp);
  });
});

describe('semanticIndexImages — queue semantics', () => {
  it('appends a second run behind a RUNNING one (never coalesced away)', async () => {
    let resolveFirst!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

    const p1 = useImageStore.getState().semanticIndexImages();
    await vi.waitFor(() => { expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1); });

    const p2 = useImageStore.getState().semanticIndexImages(); // running → appended
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1); // still waiting its turn

    resolveFirst({ indexed: 1, skipped: 0 });
    await p1;
    await p2;
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(2);
  });

  it('cancelSemanticIndexing drops the queued job; the running one finishes normally', async () => {
    let resolveFirst!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

    const p1 = useImageStore.getState().semanticIndexImages();
    await vi.waitFor(() => { expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1); });
    const p2 = useImageStore.getState().semanticIndexImages(); // queued behind p1

    useImageStore.getState().cancelSemanticIndexing(); // drops the QUEUED job
    resolveFirst({ indexed: 1, skipped: 0 });
    await p1;
    await p2; // dropped jobs resolve as no-ops
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
  });
});

describe('processPostIndexingPipeline — enqueueOnce coalescing', () => {
  it('coalesces a 10-call burst into one round; a call during a RUNNING round appends one more', async () => {
    const phases: Array<string | null> = [];
    const unsub = useImageStore.subscribe((s) => phases.push(s.pipelinePhase));

    // 10 synchronous calls: the first job is PENDING, the other 9 coalesce
    // into it — exactly one round runs.
    const calls = Array.from({ length: 10 }, () => useImageStore.getState().processPostIndexingPipeline());
    await Promise.all(calls);
    expect(phases.filter((p) => p === 'stacking')).toHaveLength(1);

    // A call while a round is RUNNING is appended (running-not-swallowed)…
    phases.length = 0; // fresh counter for this scenario
    let resolveIndex!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((r) => { resolveIndex = r; }));
    const first = useImageStore.getState().processPostIndexingPipeline();
    await vi.waitFor(() => { expect(useImageStore.getState().pipelinePhase).toBe('semantic'); });
    const second = useImageStore.getState().processPostIndexingPipeline();

    // …so a burst plus one running-time call still tops out at 2 rounds.
    resolveIndex({ indexed: 0, skipped: 0 });
    await Promise.all([first, second]);
    expect(phases.filter((p) => p === 'stacking')).toHaveLength(2);
    unsub();
  });
});

describe('markReprocessPending (offline reprocess bookkeeping)', () => {
  it('marks a directory pending and persists the id list for a restart round-trip', () => {
    useImageStore.setState({
      directories: [dir('dir1', 'C:/a', false), dir('dir2', 'C:/b', true)],
    });

    useImageStore.getState().markReprocessPending('dir1', true);
    expect(useImageStore.getState().directories.find((d) => d.id === 'dir1')?.reprocessPending).toBe(true);
    expect(localStorage.getItem('image-metahub-reprocess-pending')).toBe('["dir1"]');

    // Simulate a restart: whatever was persisted is what startup re-marks.
    useImageStore.getState().markReprocessPending('dir1', true);
    expect(JSON.parse(localStorage.getItem('image-metahub-reprocess-pending')!)).toEqual(['dir1']);

    // Reconnect handled → pending cleared and persisted.
    useImageStore.getState().markReprocessPending('dir1', false);
    expect(useImageStore.getState().directories.find((d) => d.id === 'dir1')?.reprocessPending).toBe(false);
    expect(localStorage.getItem('image-metahub-reprocess-pending')).toBe('[]');
  });

  it('removeDirectory drops a pending entry so a re-added folder is not auto-reprocessed', () => {
    useImageStore.setState({
      directories: [dir('dir1', 'C:/a', false)],
    });
    useImageStore.getState().markReprocessPending('dir1', true);
    expect(localStorage.getItem('image-metahub-reprocess-pending')).toBe('["dir1"]');

    useImageStore.getState().removeDirectory('dir1');
    expect(localStorage.getItem('image-metahub-reprocess-pending')).toBe('[]');
  });
});

describe('clearDerivedImageData — queue guards (Reprocess Images)', () => {
  it('refuses to wipe while a pipeline round is RUNNING', async () => {
    let release!: () => void;
    const gated = new Promise<void>((r) => { release = r; });
    const job = processingQueue.enqueueOnce('pipeline', () => gated, { label: 'gated round' });
    await vi.waitFor(() => { expect(processingQueue.hasRunning('pipeline')).toBe(true); });

    await expect(useImageStore.getState().clearDerivedImageData())
      .rejects.toThrow(/Processing is in progress/);

    release();
    await job; // drain the queue so later tests start idle
  });

  it('drops queued pipeline/semantic jobs before wiping (they never run)', async () => {
    const pipelineSpy = vi.fn();
    const semanticSpy = vi.fn();
    const p = processingQueue.enqueueOnce('pipeline', pipelineSpy, {});
    const s = processingQueue.enqueueOnce('semantic', semanticSpy, {});
    // The guards + dropQueued run synchronously before the first await —
    // the queue pump (a microtask) has not started either job yet.
    await useImageStore.getState().clearDerivedImageData();
    await p;
    await s;
    expect(pipelineSpy).not.toHaveBeenCalled();
    expect(semanticSpy).not.toHaveBeenCalled();
  });
});
