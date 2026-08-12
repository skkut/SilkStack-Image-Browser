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

const featureAccessMocks = vi.hoisted(() => ({
  isAiFeaturesEnabled: vi.fn(() => true),
  isSemanticSearchEnabled: vi.fn(() => true),
  useSemanticSearchEnabled: vi.fn(() => true),
}));

const coordinatorMock = vi.hoisted(() => ({
  ensureInitialized: vi.fn(),
  indexImages: vi.fn(),
  search: vi.fn(),
  clearIndex: vi.fn(),
  getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
  dispose: vi.fn(),
}));

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);

// The store lazy-loads the coordinator via dynamic import — every `new
// SemanticSearchCoordinator(...)` returns the same mock instance, mirroring
// the module-level singleton in useImageStore. The implementation must be a
// `function` (not an arrow) so the mock is constructable with `new`.
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
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

import { useImageStore, applySemanticMerge } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { normalizePath } from '../utils/pathUtils';
import { type IndexedImage } from '../types';

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

type Hit = { imageId: string; score: number };

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Seed images + directories + semantic state, then re-run the filter. */
const setupLibrary = (
  images: IndexedImage[],
  semantic: { hits: Hit[] | null; mode: 'auto' | 'semantic' | 'off' },
  extra: Record<string, unknown> = {},
) => {
  useImageStore.setState({
    images,
    directories: [
      {
        id: 'dir1',
        name: 'lib',
        path: 'C:/lib',
        handle: {} as FileSystemDirectoryHandle,
        visible: true,
      },
    ],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    semanticHits: semantic.hits,
    semanticMode: semantic.mode,
    ...extra,
  });
  useImageStore.getState().filterAndSortImages();
};

beforeEach(() => {
  vi.clearAllMocks();
  featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(true);
  coordinatorMock.ensureInitialized.mockResolvedValue(undefined);
  coordinatorMock.indexImages.mockResolvedValue({ indexed: 0, skipped: 0 });
  coordinatorMock.search.mockResolvedValue([]);

  // Reset in-flight search/index state (module-level vars survive between tests).
  useImageStore.getState().clearSemanticSearch();

  useImageStore.setState({
    images: [],
    filteredImages: [],
    annotations: new Map(),
    isAnnotationsLoaded: true,
    indexingState: 'idle',
    directories: [],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    searchQuery: '',
    semanticMode: 'auto',
    semanticHits: null,
    semanticSearchStatus: 'idle',
    semanticIndexProgress: null,
    showFavoritesOnly: false,
    selectedTags: [],
  });

  useSettingsStore.setState({
    enableSafeMode: true,
    blurSensitiveImages: true,
    sensitiveTags: ['nsfw', 'private', 'hidden'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('applySemanticMerge (pure §8.2 algorithm)', () => {
  const imgA = createImage({ id: 'a', name: 'red fox.png' });
  const imgB = createImage({ id: 'b', name: 'snowy mountain.png' });
  const imgC = createImage({ id: 'c', name: 'not visible.png' });

  it('returns textResults unchanged when the mode is off', () => {
    const results = [imgA, imgB];
    const out = applySemanticMerge(results, [{ imageId: 'a', score: 0.9 }], results, 'off');
    expect(out).toBe(results);
  });

  it('returns textResults unchanged when there are no hits', () => {
    const results = [imgA];
    expect(applySemanticMerge(results, [], results, 'auto')).toBe(results);
    expect(applySemanticMerge(results, [], results, 'semantic')).toBe(results);
  });

  it('auto mode: keyword matches first (score order), relatives appended (score order)', () => {
    const visible = [imgA, imgB];
    const out = applySemanticMerge(
      [imgA], // only imgA matches the keyword
      [
        { imageId: 'b', score: 0.9 },
        { imageId: 'a', score: 0.5 },
      ],
      visible,
      'auto',
    );
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('auto mode: drops hits that are not curation-visible', () => {
    const out = applySemanticMerge(
      [imgA],
      [
        { imageId: 'c', score: 0.99 },
        { imageId: 'a', score: 0.5 },
      ],
      [imgA], // imgC is not curation-visible
      'auto',
    );
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('semantic mode: all hits ∩ curation-visible, pure score order (keyword filter replaced)', () => {
    const visible = [imgA, imgB];
    const out = applySemanticMerge(
      [imgA], // imgA is the only keyword match — irrelevant in semantic mode
      [
        { imageId: 'b', score: 0.9 },
        { imageId: 'a', score: 0.5 },
      ],
      visible,
      'semantic',
    );
    expect(out.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('deduplicates repeated hit imageIds', () => {
    const visible = [imgA, imgB];
    const out = applySemanticMerge(
      [imgA],
      [
        { imageId: 'a', score: 0.9 },
        { imageId: 'a', score: 0.8 },
        { imageId: 'b', score: 0.7 },
      ],
      visible,
      'auto',
    );
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('sorts defensively even when hits arrive out of order', () => {
    const visible = [imgA, imgB];
    const out = applySemanticMerge(
      [imgA],
      [
        { imageId: 'b', score: 0.4 },
        { imageId: 'a', score: 0.9 },
      ],
      visible,
      'semantic',
    );
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('filterAndSort semantic overlay (store integration)', () => {
  const fox = () => createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
  const mountain = () => createImage({ id: 'imgB', name: 'snowy mountain.png', directoryId: 'dir1' });

  it('auto mode: keyword matches first, semantic relatives appended', () => {
    setupLibrary(
      [fox(), mountain()],
      {
        hits: [
          { imageId: 'imgB', score: 0.8 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'auto',
      },
      { searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA', 'imgB']);
  });

  it('semantic mode: replaces keyword filtering entirely (score order)', () => {
    setupLibrary(
      [fox(), mountain()],
      {
        hits: [
          { imageId: 'imgB', score: 0.8 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgB', 'imgA']);
  });

  it('off mode: falls back to keyword results, semantic state ignored', () => {
    setupLibrary(
      [fox(), mountain()],
      {
        hits: [
          { imageId: 'imgB', score: 0.99 },
          { imageId: 'imgA', score: 0.5 },
        ],
        mode: 'off',
      },
      { searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('favorites filter drops semantic hits for non-favorites', () => {
    setupLibrary(
      [{ ...fox(), isFavorite: true }, mountain()],
      {
        hits: [
          { imageId: 'imgB', score: 0.9 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { showFavoritesOnly: true, searchQuery: 'fox' },
    );
    // imgA is a favorite; imgB is not → only imgA survives the curation filters.
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('safe mode drops sensitive-tagged semantic hits when filtering is on', () => {
    useSettingsStore.getState().setBlurSensitiveImages(false);
    useSettingsStore.getState().setSensitiveTags(['nsfw']);
    setupLibrary(
      [fox(), { ...mountain(), tags: ['nsfw'] }],
      {
        hits: [
          { imageId: 'imgB', score: 0.9 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('folder exclusion drops semantic hits from excluded subfolders', () => {
    const subImage = createImage({ id: 'dir1::sub/mountain.png', name: 'snowy mountain.png' });
    setupLibrary(
      [fox(), subImage],
      {
        hits: [
          { imageId: 'dir1::sub/mountain.png', score: 0.9 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { excludedFolders: new Set([normalizePath('C:/lib/sub')]), searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('directory visibility drops semantic hits from hidden directories', () => {
    const hidden = createImage({ id: 'imgC', name: 'hidden dir.png', directoryId: 'dir2' });
    useImageStore.setState({
      images: [fox(), mountain(), hidden],
      directories: [
        { id: 'dir1', name: 'lib', path: 'C:/lib', handle: {} as FileSystemDirectoryHandle, visible: true },
        { id: 'dir2', name: 'off', path: 'C:/off', handle: {} as FileSystemDirectoryHandle, visible: false },
      ],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      semanticHits: [
        { imageId: 'imgC', score: 0.99 },
        { imageId: 'imgA', score: 0.6 },
      ],
      semanticMode: 'semantic',
      searchQuery: 'fox',
    });
    useImageStore.getState().filterAndSortImages();
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('clearing the search bar clears semantic hits and restores the idle status', () => {
    useImageStore.setState({
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticSearchStatus: 'ready',
      searchQuery: 'fox',
    });
    useImageStore.getState().setSearchQuery('');
    const s = useImageStore.getState();
    expect(s.semanticHits).toBeNull();
    expect(s.semanticSearchStatus).toBe('idle');
    expect(s.searchQuery).toBe('');
  });

  it('setSemanticMode re-runs the merge with the new mode', () => {
    setupLibrary(
      [fox(), mountain()],
      {
        hits: [
          { imageId: 'imgB', score: 0.8 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'auto',
      },
      { searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA', 'imgB']);
    useImageStore.getState().setSemanticMode('off');
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });
});

describe('runSemanticSearch', () => {
  it('debounces keystrokes and searches only with the settled query', async () => {
    vi.useFakeTimers();
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgA', score: 0.9 }]);

    const store = useImageStore.getState();
    const p1 = store.runSemanticSearch('red');
    const p2 = store.runSemanticSearch('red fox');
    expect(useImageStore.getState().semanticSearchStatus).toBe('loading');

    await vi.advanceTimersByTimeAsync(400);
    await p1;
    await p2;

    expect(coordinatorMock.search).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.search).toHaveBeenCalledWith('red fox');
    const s = useImageStore.getState();
    expect(s.semanticSearchStatus).toBe('ready');
    expect(s.semanticHits).toEqual([{ imageId: 'imgA', score: 0.9 }]);
  });

  it('applies hits through filterAndSort (auto overlay active)', async () => {
    vi.useFakeTimers();
    useImageStore.setState({
      images: [createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' })],
      directories: [
        { id: 'dir1', name: 'lib', path: 'C:/lib', handle: {} as FileSystemDirectoryHandle, visible: true },
      ],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
    });
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgA', score: 0.9 }]);

    const store = useImageStore.getState();
    const p = store.runSemanticSearch('fox');
    await vi.advanceTimersByTimeAsync(400);
    await p;

    const s = useImageStore.getState();
    expect(s.semanticHits).toEqual([{ imageId: 'imgA', score: 0.9 }]);
    expect(s.filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('discards results from a superseded search (latest query wins)', async () => {
    vi.useFakeTimers();
    let resolveA!: (v: Hit[]) => void;
    coordinatorMock.search.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgB', score: 0.8 }]);

    const store = useImageStore.getState();
    const p1 = store.runSemanticSearch('query a');
    await vi.advanceTimersByTimeAsync(320); // search a goes in flight
    const p2 = store.runSemanticSearch('query b');
    await vi.advanceTimersByTimeAsync(320); // search b resolves with imgB

    resolveA([{ imageId: 'imgA', score: 0.99 }]); // a resolves LATE
    await p1;
    await p2;
    await flush();

    const s = useImageStore.getState();
    expect(s.semanticHits).toEqual([{ imageId: 'imgB', score: 0.8 }]);
    expect(s.semanticSearchStatus).toBe('ready');
  });

  it('empty query clears semantic state without touching the worker', async () => {
    useImageStore.setState({
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticSearchStatus: 'ready',
    });
    await useImageStore.getState().runSemanticSearch('   ');
    expect(coordinatorMock.search).not.toHaveBeenCalled();
    const s = useImageStore.getState();
    expect(s.semanticHits).toBeNull();
    expect(s.semanticSearchStatus).toBe('idle');
  });

  it('marks the search unavailable when the feature is disabled', async () => {
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false);
    await useImageStore.getState().runSemanticSearch('fox');
    expect(coordinatorMock.search).not.toHaveBeenCalled();
    const s = useImageStore.getState();
    expect(s.semanticSearchStatus).toBe('unavailable');
    expect(s.semanticHits).toBeNull();
  });

  it('reports an error when the search fails', async () => {
    vi.useFakeTimers();
    coordinatorMock.search.mockRejectedValue(new Error('worker crashed'));
    const p = useImageStore.getState().runSemanticSearch('fox');
    await vi.advanceTimersByTimeAsync(400);
    await p;
    const s = useImageStore.getState();
    expect(s.semanticSearchStatus).toBe('error');
    expect(s.semanticHits).toBeNull();
  });

  it('settings toggle off clears semantic state (rehydration sync)', () => {
    useSettingsStore.getState().setSemanticSearchEnabled(true);
    useImageStore.setState({
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticSearchStatus: 'ready',
    });
    useSettingsStore.getState().setSemanticSearchEnabled(false);
    const s = useImageStore.getState();
    expect(s.semanticHits).toBeNull();
    expect(s.semanticSearchStatus).toBe('idle');
  });
});

describe('semanticIndexImages + pipeline Phase 3', () => {
  it('runs the post-indexing pipeline phases in order, ending with semantic indexing', async () => {
    const phases: Array<string | null> = [];
    const unsub = useImageStore.subscribe((s) => phases.push(s.pipelinePhase));
    await useImageStore.getState().processPostIndexingPipeline();
    unsub();

    const iStacking = phases.indexOf('stacking');
    const iSimilarity = phases.indexOf('similarity');
    const iSemantic = phases.indexOf('semantic');
    expect(iStacking).toBeGreaterThan(-1);
    expect(iSimilarity).toBeGreaterThan(iStacking);
    expect(iSemantic).toBeGreaterThan(iSimilarity);
    expect(coordinatorMock.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
  });

  it('skips semantic indexing silently when the feature is disabled', async () => {
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false);
    const phases: Array<string | null> = [];
    const unsub = useImageStore.subscribe((s) => phases.push(s.pipelinePhase));
    await useImageStore.getState().processPostIndexingPipeline();
    unsub();

    expect(coordinatorMock.ensureInitialized).not.toHaveBeenCalled();
    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();
    // Pipeline still completes and resets the phase.
    expect(phases[phases.length - 1]).toBeNull();
  });

  it('does no premium scanning when the premium gate is closed (dev, no license)', async () => {
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false);
    const { createStackingEngine } = await import('../services/aiBridge');
    // Real no-license behavior: the bridge factories return null, so the
    // stacking + similarity phases skip (covered per-factory in
    // aiBridge.license.gating.test.ts). This proves the pipeline as a whole
    // performs no premium work and still completes.
    vi.mocked(createStackingEngine).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const phases: Array<string | null> = [];
    const unsub = useImageStore.subscribe((s) => phases.push(s.pipelinePhase));
    await useImageStore.getState().processPostIndexingPipeline();
    unsub();

    expect(coordinatorMock.ensureInitialized).not.toHaveBeenCalled();
    expect(coordinatorMock.indexImages).not.toHaveBeenCalled();
    expect(phases[phases.length - 1]).toBeNull();
  });

  it('queues a second indexImages run while one is in progress', async () => {
    vi.useFakeTimers();
    let resolveIndex!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((r) => { resolveIndex = r; }));

    const store = useImageStore.getState();
    const p1 = store.semanticIndexImages();
    const p2 = store.semanticIndexImages(); // in-progress guard → queued
    await flush(); // let p1 reach the coordinator (dynamic import + init)
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);

    resolveIndex({ indexed: 1, skipped: 0 });
    await p1;
    await p2;

    await vi.advanceTimersByTimeAsync(600); // queued re-run (500ms)
    await flush();
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(2);
  });
});

describe('settings subscription — kick-in when the feature becomes usable', () => {
  it('starts Δ-indexing when the toggle is enabled mid-session', async () => {
    useSettingsStore.getState().setSemanticSearchEnabled(true);
    await flush();
    expect(coordinatorMock.ensureInitialized).toHaveBeenCalled();
    expect(coordinatorMock.indexImages).toHaveBeenCalled();
    // Restore — the feature stays off for the remaining tests.
    useSettingsStore.getState().setSemanticSearchEnabled(false);
  });

  it('starts Δ-indexing when premium arrives while the toggle is already on', async () => {
    useSettingsStore.getState().setSemanticSearchEnabled(true);
    await flush();
    vi.clearAllMocks(); // forget the toggle-on run (implementations persist)

    // Premium gate closed → open: e.g. a license activated mid-session.
    featureAccessMocks.isAiFeaturesEnabled.mockReturnValue(false);
    useSettingsStore.getState().setSortOrder('asc');
    featureAccessMocks.isAiFeaturesEnabled.mockReturnValue(true);
    useSettingsStore.getState().setSortOrder('desc');

    await flush();
    expect(coordinatorMock.ensureInitialized).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);

    useSettingsStore.getState().setSemanticSearchEnabled(false);
  });
});
