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
  isAiMasterEnabled: vi.fn(() => true),
  isAiModelFeaturesEnabled: vi.fn(() => true),
  isSemanticSearchEnabled: vi.fn(() => true),
  useSemanticSearchEnabled: vi.fn(() => true),
}));

const coordinatorMock = vi.hoisted(() => ({
  ensureInitialized: vi.fn(),
  indexImages: vi.fn(),
  search: vi.fn(),
  clearIndex: vi.fn(),
  cancelIndexing: vi.fn(),
  unloadModels: vi.fn().mockResolvedValue(undefined),
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
import { type ImageAnnotations, type IndexedImage } from '../types';

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
  semantic: { hits: Hit[] | null; mode: 'semantic' | 'off' },
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
  // A stale mockReturnValueOnce (e.g. a test that failed before consuming
  // its held promise) would otherwise poison the next test's indexImages —
  // the once-queue survives clearAllMocks. The fresh implementation is
  // re-set right below.
  coordinatorMock.indexImages.mockReset();
  featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(true);
  coordinatorMock.ensureInitialized.mockResolvedValue(undefined);
  // Mirrors the module coordinator's Δ-first flow: indexImages initializes
  // on demand (the store no longer calls ensureInitialized directly), so
  // pipeline assertions still see init precede index.
  coordinatorMock.indexImages.mockImplementation(async () => {
    await coordinatorMock.ensureInitialized();
    return { indexed: 0, skipped: 0 };
  });
  coordinatorMock.clearIndex.mockResolvedValue(undefined);
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
    libraryStackContext: null,
    semanticMode: 'off',
    semanticHits: null,
    semanticSearchStatus: 'idle',
    semanticIndexProgress: null,
    semanticIndexedCount: 0,
    semanticLastError: null,
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
    expect(applySemanticMerge(results, [], results, 'semantic')).toBe(results);
  });

  it('drops hits that are not curation-visible', () => {
    const out = applySemanticMerge(
      [imgA],
      [
        { imageId: 'c', score: 0.99 },
        { imageId: 'a', score: 0.5 },
      ],
      [imgA], // imgC is not curation-visible
      'semantic',
    );
    expect(out.map((i) => i.id)).toEqual(['a']);
  });

  it('semantic mode: hits ∩ curation-visible in score order, keyword matches preserved', () => {
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
      'semantic',
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

  it('union: keyword-only textResults append after hits, deduped by id', () => {
    const out = applySemanticMerge(
      [imgA, imgC], // imgA is also a hit; imgC is keyword-only
      [
        { imageId: 'b', score: 0.9 },
        { imageId: 'a', score: 0.5 },
      ],
      [imgA, imgB, imgC],
      'semantic',
    );
    // imgA appears once (in the hit section); imgC — a keyword match the
    // semantic engine missed — appends below the hits.
    expect(out.map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('union with null hits returns textResults unchanged', () => {
    const results = [imgA];
    expect(applySemanticMerge(results, null, results, 'semantic')).toBe(results);
  });
});

describe('filterAndSort semantic overlay (store integration)', () => {
  const fox = () => createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
  const mountain = () => createImage({ id: 'imgB', name: 'snowy mountain.png', directoryId: 'dir1' });

  it('semantic mode: hits first (score order), keyword matches preserved', () => {
    setupLibrary(
      [fox(), mountain()],
      {
        hits: [
          { imageId: 'imgB', score: 0.8 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { searchQuery: 'fox', sortOrder: 'relevance' },
    );
    // 'relevance' = pure score order (the semantic default); imgA is both a
    // hit and a keyword match — it appears once, in the hit section.
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgB', 'imgA']);
  });

  it('union merge: hits first (score order), keyword-only results appended (deduped)', () => {
    const cub = createImage({ id: 'imgC', name: 'red fox cub.png', directoryId: 'dir1' });
    setupLibrary(
      [fox(), mountain(), cub],
      {
        hits: [
          { imageId: 'imgB', score: 0.8 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { searchQuery: 'fox', sortOrder: 'relevance' },
    );
    // imgA is both a hit and a keyword match (appears once, in the hit
    // section); imgC is a keyword match the semantic engine missed → it is
    // appended below the hits instead of vanishing.
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgB', 'imgA', 'imgC']);
  });

  it('semantic mode with empty hits still shows the keyword results', () => {
    setupLibrary(
      [fox(), mountain()],
      { hits: [], mode: 'semantic' },
      { searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('semantic mode with null hits still shows the keyword results', () => {
    setupLibrary(
      [fox(), mountain()],
      { hits: null, mode: 'semantic' },
      { searchQuery: 'fox' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('semantic mode + explicit sort orders the whole union by that sort', () => {
    const older = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1', lastModified: 1000 });
    const newer = createImage({ id: 'imgB', name: 'snowy mountain.png', directoryId: 'dir1', lastModified: 2000 });
    const cub = createImage({ id: 'imgC', name: 'red fox cub.png', directoryId: 'dir1', lastModified: 1500 });
    setupLibrary(
      [older, newer, cub],
      {
        hits: [
          { imageId: 'imgB', score: 0.8 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { searchQuery: 'fox', sortOrder: 'date-asc' },
    );
    // Score order would be [imgB, imgA, imgC]; the explicitly chosen sort
    // wins for the WHOLE union, so the sort box stays honest.
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA', 'imgC', 'imgB']);
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

  it('stack drill-down: the semantic overlay shows only images from the active stack', () => {
    const other = createImage({ id: 'imgC', name: 'outside stack.png', directoryId: 'dir1' });
    useImageStore.setState({
      images: [fox(), mountain(), other],
      directories: [
        { id: 'dir1', name: 'lib', path: 'C:/lib', handle: {} as FileSystemDirectoryHandle, visible: true },
      ],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      semanticHits: [
        { imageId: 'imgA', score: 0.9 },
        { imageId: 'imgB', score: 0.8 },
        { imageId: 'imgC', score: 0.7 },
      ],
      semanticMode: 'semantic',
      libraryStackContext: {
        stackId: 'stack-1',
        imageIds: ['imgA', 'imgB'],
        basePrompt: 'fox',
      },
      sortOrder: 'relevance',
    });
    useImageStore.getState().filterAndSortImages();
    // imgC is a valid hit but belongs to another stack — it must not leak
    // into the drill-down alongside the stack's own images.
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA', 'imgB']);
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

  it('clearing the search bar restores the previous sort order after relevance', () => {
    useSettingsStore.getState().setSortOrder('asc');
    useImageStore.setState({
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticSearchStatus: 'ready',
      sortOrder: 'relevance',
      searchQuery: 'fox',
    });
    useImageStore.getState().setSearchQuery('');
    const s = useImageStore.getState();
    expect(s.sortOrder).toBe('asc');
    expect(s.semanticHits).toBeNull();
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
        mode: 'semantic',
      },
      { searchQuery: 'fox', sortOrder: 'relevance' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgB', 'imgA']);
    useImageStore.getState().setSemanticMode('off');
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('semantic mode + explicit sort re-orders hits by that sort (box stays honest)', () => {
    const older = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1', lastModified: 1000 });
    const newer = createImage({ id: 'imgB', name: 'snowy mountain.png', directoryId: 'dir1', lastModified: 2000 });
    setupLibrary(
      [older, newer],
      {
        hits: [
          { imageId: 'imgB', score: 0.8 },
          { imageId: 'imgA', score: 0.6 },
        ],
        mode: 'semantic',
      },
      { searchQuery: 'fox', sortOrder: 'date-asc' },
    );
    // Score order would be ['imgB', 'imgA']; the chosen 'date-asc' sort wins.
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA', 'imgB']);
  });

  it("'relevance' without semantic hits falls back to newest-first", () => {
    const older = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1', lastModified: 1000 });
    const newer = createImage({ id: 'imgB', name: 'snowy mountain.png', directoryId: 'dir1', lastModified: 2000 });
    setupLibrary(
      [older, newer],
      { hits: null, mode: 'semantic' },
      { searchQuery: '', sortOrder: 'relevance' },
    );
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgB', 'imgA']);
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

  it('auto-selects "relevance" on success without persisting it to settings', async () => {
    vi.useFakeTimers();
    useImageStore.setState({
      images: [createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' })],
      directories: [
        { id: 'dir1', name: 'lib', path: 'C:/lib', handle: {} as FileSystemDirectoryHandle, visible: true },
      ],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      searchQuery: 'fox',
    });
    const durableBefore = useSettingsStore.getState().sortOrder;
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgA', score: 0.9 }]);

    const p = useImageStore.getState().runSemanticSearch('fox');
    await vi.advanceTimersByTimeAsync(400);
    await p;

    const s = useImageStore.getState();
    expect(s.sortOrder).toBe('relevance');
    // 'relevance' is semantic-only state — the durable settings sort is untouched.
    expect(useSettingsStore.getState().sortOrder).toBe(durableBefore);
  });

  it('clearSemanticSearch restores the durable settings sort after relevance', () => {
    useSettingsStore.getState().setSortOrder('asc');
    useImageStore.setState({
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticSearchStatus: 'ready',
      sortOrder: 'relevance',
    });
    useImageStore.getState().clearSemanticSearch();
    expect(useImageStore.getState().sortOrder).toBe('asc');
    expect(useImageStore.getState().semanticHits).toBeNull();
  });

  it('setSemanticMode("off") restores the durable settings sort after relevance', () => {
    useSettingsStore.getState().setSortOrder('asc');
    useImageStore.setState({
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticMode: 'semantic',
      sortOrder: 'relevance',
    });
    useImageStore.getState().setSemanticMode('off');
    expect(useImageStore.getState().sortOrder).toBe('asc');
  });

  it('full loop: search selects relevance, clearing the bar restores the previous sort', async () => {
    vi.useFakeTimers();
    useSettingsStore.getState().setSortOrder('asc');
    useImageStore.setState({
      images: [createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' })],
      directories: [
        { id: 'dir1', name: 'lib', path: 'C:/lib', handle: {} as FileSystemDirectoryHandle, visible: true },
      ],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      semanticMode: 'semantic',
    });
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgA', score: 0.9 }]);

    useImageStore.getState().setSearchQuery('fox');
    await vi.advanceTimersByTimeAsync(400);
    await flush();
    expect(useImageStore.getState().sortOrder).toBe('relevance');

    useImageStore.getState().setSearchQuery('');
    expect(useImageStore.getState().sortOrder).toBe('asc');
    expect(useImageStore.getState().semanticHits).toBeNull();
  });

  it('settings-store writes do not clobber the semantic relevance sort', () => {
    useImageStore.setState({
      sortOrder: 'relevance',
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticMode: 'semantic',
    });
    // The settings→image sort sync must skip 'relevance' (semantic-session
    // state); otherwise ANY settings write mid-search snaps the sort back.
    useSettingsStore.setState({ displayStarredFirst: false });
    expect(useImageStore.getState().sortOrder).toBe('relevance');
  });

  it('re-activating semantic mode after the chip-clear re-runs the query and restores hits', async () => {
    vi.useFakeTimers();
    useImageStore.setState({
      images: [createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' })],
      directories: [
        { id: 'dir1', name: 'lib', path: 'C:/lib', handle: {} as FileSystemDirectoryHandle, visible: true },
      ],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      searchQuery: 'fox',
      semanticMode: 'semantic',
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
    });
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgA', score: 0.9 }]);

    // The footer chip: hits go away AND the sparkle turns off.
    useImageStore.getState().clearSemanticSearch();
    useImageStore.getState().setSemanticMode('off');
    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(useImageStore.getState().semanticMode).toBe('off');

    // Re-activating the sparkle re-runs the surviving query.
    useImageStore.getState().setSemanticMode('semantic');
    await vi.advanceTimersByTimeAsync(400);
    await flush();

    expect(coordinatorMock.search).toHaveBeenCalledWith('fox');
    expect(useImageStore.getState().semanticHits).toEqual([{ imageId: 'imgA', score: 0.9 }]);
    expect(useImageStore.getState().sortOrder).toBe('relevance');
  });
});

describe('semanticIndexImages + pipeline Phase 3', () => {
  it('runs the post-indexing pipeline phases in order, ending with semantic indexing', async () => {
    // One enriched + fully-analyzed but UNSTAMPED image: phases 1-3 no-op
    // for it (no stacking/similarity/AI work), yet phase 4's Δ-run genuinely
    // reaches the coordinator. An empty library short-circuits phase 4
    // before any coordinator call (isSemanticIndexed gate).
    const img = createImage({ id: 'imgA', name: 'fox.png', directoryId: 'dir1', prompt: 'a red fox' });
    useImageStore.setState({
      images: [img],
      filteredImages: [img],
      annotations: new Map([['imgA', {
        imageId: 'imgA',
        isFavorite: false,
        tags: ['manual'],
        autoTags: ['concept'],
        metadataTags: ['meta'],
        isAutoTagged: true,
        searchTagVersion: 2,
        stackGroupId: 'sg-imgA',
        isStackAnalyzed: true,
        similarityGroupId: 'sim-imgA',
        isSimilarityAnalyzed: true,
        addedAt: 1,
        updatedAt: 1,
      }]]),
    });

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
    // One unstamped image so the run reaches the coordinator — an empty
    // payload short-circuits before indexImages, and the mockReturnValueOnce
    // held promise would leak into the next test (it never resolves).
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });

    let resolveIndex!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((r) => { resolveIndex = r; }));

    const store = useImageStore.getState();
    const p1 = store.semanticIndexImages();
    await flush(); // let p1 become the RUNNING queue job (dynamic import + init)
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);

    // A running job does NOT swallow a new enqueue — it is appended.
    const p2 = store.semanticIndexImages();
    await flush();
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1); // still waiting its turn

    resolveIndex({ indexed: 1, skipped: 0 });
    await p1;
    await p2;
    await flush();
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(2);
  });
});

describe('settings subscription — kick-in when the feature becomes usable', () => {
  it('starts Δ-indexing when the toggle is enabled mid-session', async () => {
    // One unstamped image so the kick-in Δ-run reaches the coordinator —
    // with an empty library the isSemanticIndexed gate short-circuits first.
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });
    useSettingsStore.getState().setSemanticSearchEnabled(true);
    await flush();
    expect(coordinatorMock.ensureInitialized).toHaveBeenCalled();
    expect(coordinatorMock.indexImages).toHaveBeenCalled();
    // Restore — the feature stays off for the remaining tests.
    useSettingsStore.getState().setSemanticSearchEnabled(false);
  });

  it('starts Δ-indexing when premium arrives while the toggle is already on', async () => {
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });
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

// ── Master AI-features toggle — runtime flip (Phase 8) ────────────────
// The store's settings subscribe fires on the pref flip: OFF cancels
// in-flight runs, unloads resident models, and drops semantic hits; ON
// resumes Δ-indexing (idempotent). The latch is pre-initialized to the
// current pref, so only REAL flips fire — this test must be the last to
// touch the pref in the file (a restore would fire the ON branch).
describe('master AI-features toggle — runtime flip', () => {
  it('flip OFF cancels + unloads + clears; flip ON resumes Δ-indexing', async () => {
    // One unstamped image so the resumed run reaches the coordinator.
    useImageStore.setState({
      images: [{ id: 'a', name: 'a.png', prompt: 'red fox' } as unknown as IndexedImage],
    });

    // ON → OFF: hits drop and resident models unload (the coordinator
    // singleton exists from earlier describes — the mock records it).
    useImageStore.setState({ semanticHits: [{ imageId: 'a', score: 0.9 }] });
    useSettingsStore.setState({ aiFeaturesEnabled: false });
    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(coordinatorMock.unloadModels).toHaveBeenCalledTimes(1);

    // OFF → ON: the Δ-index resumes — the semantic gate mock is open, so
    // the run reaches the coordinator and re-embeds the unstamped image.
    useSettingsStore.setState({ aiFeaturesEnabled: true });
    await flush();
    expect(coordinatorMock.ensureInitialized).toHaveBeenCalled();
  });
});

describe('setSearchQuery → semantic search wiring (Phase 6)', () => {
  it('fires runSemanticSearch for a non-empty query when mode is semantic', async () => {
    vi.useFakeTimers();
    useImageStore.setState({ searchQuery: '', semanticMode: 'semantic' });
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgA', score: 0.9 }]);

    useImageStore.getState().setSearchQuery('red fox');
    await vi.advanceTimersByTimeAsync(400);

    expect(coordinatorMock.search).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.search).toHaveBeenCalledWith('red fox');
    expect(useImageStore.getState().semanticSearchStatus).toBe('ready');
    expect(useImageStore.getState().semanticHits).toEqual([{ imageId: 'imgA', score: 0.9 }]);
  });

  it('coalesces rapid keystrokes into a single search (debounce)', async () => {
    vi.useFakeTimers();
    useImageStore.setState({ searchQuery: '', semanticMode: 'semantic' });

    useImageStore.getState().setSearchQuery('red');
    useImageStore.getState().setSearchQuery('red fox');
    useImageStore.getState().setSearchQuery('red fox in snow');
    await vi.advanceTimersByTimeAsync(400);

    expect(coordinatorMock.search).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.search).toHaveBeenCalledWith('red fox in snow');
  });

  it('does not fire runSemanticSearch when mode is off', async () => {
    vi.useFakeTimers();
    useImageStore.setState({ searchQuery: '', semanticMode: 'off' });

    useImageStore.getState().setSearchQuery('fox');
    await vi.advanceTimersByTimeAsync(400);

    expect(coordinatorMock.search).not.toHaveBeenCalled();
    expect(useImageStore.getState().semanticSearchStatus).toBe('idle');
  });

  it('empty query still clears without touching the worker (regression)', async () => {
    useImageStore.setState({
      searchQuery: 'fox',
      semanticMode: 'semantic',
      semanticHits: [{ imageId: 'a', score: 0.9 }],
      semanticSearchStatus: 'ready',
    });

    useImageStore.getState().setSearchQuery('');

    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(useImageStore.getState().semanticSearchStatus).toBe('idle');
    expect(coordinatorMock.search).not.toHaveBeenCalled();
  });
});

describe('setSemanticMode re-search (Phase 6)', () => {
  it('re-runs the current query when switching to semantic mode', async () => {
    vi.useFakeTimers();
    useImageStore.setState({ searchQuery: 'fox', semanticMode: 'off' });
    vi.clearAllMocks(); // forget the wiring-era calls (implementations persist)

    useImageStore.getState().setSemanticMode('semantic');
    await vi.advanceTimersByTimeAsync(400);

    expect(coordinatorMock.search).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.search).toHaveBeenCalledWith('fox');
    expect(useImageStore.getState().semanticMode).toBe('semantic');
  });

  it('does not fire a search when switching to off or with an empty query', async () => {
    vi.useFakeTimers();
    useImageStore.setState({ searchQuery: 'fox', semanticMode: 'semantic' });
    useImageStore.getState().setSemanticMode('off');
    await vi.advanceTimersByTimeAsync(400);
    expect(coordinatorMock.search).not.toHaveBeenCalled();

    useImageStore.setState({ searchQuery: '', semanticMode: 'off' });
    vi.clearAllMocks();
    useImageStore.getState().setSemanticMode('semantic');
    await vi.advanceTimersByTimeAsync(400);
    expect(coordinatorMock.search).not.toHaveBeenCalled();
  });
});

describe('setSemanticMode toggle-off invalidation (reversal regression)', () => {
  it('toggle-off cancels a pending debounced search (no stale landing after OFF)', async () => {
    vi.useFakeTimers();
    useImageStore.setState({ searchQuery: 'fox', semanticMode: 'semantic' });
    vi.clearAllMocks(); // forget the wiring-era calls (implementations persist)
    coordinatorMock.search.mockResolvedValue([{ imageId: 'imgA', score: 0.9 }]);

    // Search fired while ON, then toggled OFF before the 300 ms debounce
    // fires. The timer must be cancelled — otherwise the search runs and
    // lands after the toggle, resurrecting hits under a gray sparkle.
    useImageStore.getState().runSemanticSearch('fox');
    useImageStore.getState().setSemanticMode('off');
    await vi.advanceTimersByTimeAsync(1000);

    expect(coordinatorMock.search).not.toHaveBeenCalled();
    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(useImageStore.getState().semanticSearchStatus).toBe('idle');
    expect(useImageStore.getState().semanticMode).toBe('off');
  });

  it('toggle-off while inference is in flight discards the landing (seq bump)', async () => {
    vi.useFakeTimers();
    let resolveSearch!: (v: Hit[]) => void;
    coordinatorMock.search.mockReturnValueOnce(new Promise((resolve) => { resolveSearch = resolve; }));
    useImageStore.setState({ searchQuery: 'fox', semanticMode: 'semantic', sortOrder: 'date-desc' });

    const p = useImageStore.getState().runSemanticSearch('fox');
    await vi.advanceTimersByTimeAsync(400); // debounce elapsed — inference running

    useImageStore.getState().setSemanticMode('off');
    resolveSearch([{ imageId: 'imgA', score: 0.9 }]);
    await p;

    // The landing must be discarded: no hits, no 'ready', no relevance sort
    // under a gray sparkle.
    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(useImageStore.getState().semanticSearchStatus).toBe('idle');
    expect(useImageStore.getState().sortOrder).toBe('date-desc');
    expect(useImageStore.getState().semanticMode).toBe('off');
  });

  it('toggle-off drops existing hits and the relevance sort (chip + sort box stay honest)', () => {
    useSettingsStore.getState().setSortOrder('date-asc');
    useImageStore.setState({
      semanticHits: [{ imageId: 'imgA', score: 0.9 }],
      semanticMode: 'semantic',
      semanticSearchStatus: 'ready',
      sortOrder: 'relevance',
      searchQuery: 'fox',
    });

    useImageStore.getState().setSemanticMode('off');

    const s = useImageStore.getState();
    expect(s.semanticHits).toBeNull();
    expect(s.semanticMode).toBe('off');
    expect(s.semanticSearchStatus).toBe('idle');
    expect(s.sortOrder).toBe('date-asc');
  });
});

describe('semanticIndexImages force + status (Phase 6)', () => {
  it('{force:true} clears the index then re-indexes', async () => {
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });

    await useImageStore.getState().semanticIndexImages({ force: true });
    await flush();

    expect(coordinatorMock.clearIndex).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.clearIndex.mock.invocationCallOrder[0])
      .toBeLessThan(coordinatorMock.indexImages.mock.invocationCallOrder[0]);
  });

  it('records the persisted count into semanticIndexedCount', async () => {
    coordinatorMock.getStatus.mockReturnValue({ ready: true, indexed: 7, modelId: 'm', dimension: 768, error: null });
    // One unstamped image so the Δ-run reaches the coordinator (an empty
    // library short-circuits before getStatus is ever read).
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });

    await useImageStore.getState().semanticIndexImages();
    await flush();

    expect(useImageStore.getState().semanticIndexedCount).toBe(7);
    expect(useImageStore.getState().semanticLastError).toBeNull();
  });

  it('records the error message on indexing failure', async () => {
    coordinatorMock.indexImages.mockRejectedValueOnce(new Error('embedding failed'));
    // Unstamped image so the run reaches indexImages and the rejection lands.
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });

    await useImageStore.getState().semanticIndexImages();
    await flush();

    expect(useImageStore.getState().semanticLastError).toBe('embedding failed');
    expect(useImageStore.getState().semanticIndexedCount).toBe(0);
  });

  it('records the error message on search failure', async () => {
    vi.useFakeTimers();
    coordinatorMock.search.mockRejectedValueOnce(new Error('search exploded'));
    useImageStore.setState({ searchQuery: '', semanticMode: 'semantic' });

    useImageStore.getState().runSemanticSearch('fox');
    await vi.advanceTimersByTimeAsync(400);

    expect(useImageStore.getState().semanticSearchStatus).toBe('error');
    expect(useImageStore.getState().semanticLastError).toBe('search exploded');
  });

  it('replays a queued force request (clear still happens before the second run)', async () => {
    // Unstamped image so the first run genuinely reaches indexImages and
    // hangs on the held promise (an empty payload would short-circuit and
    // leak the never-resolved once-promise into the next test).
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });

    let resolveFirst!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));

    // First run hangs mid-embed…
    const first = useImageStore.getState().semanticIndexImages();
    await flush(); // let it become the RUNNING queue job
    // …a force arrives while it is in flight → appended with the force flag.
    const second = useImageStore.getState().semanticIndexImages({ force: true });
    await flush();
    expect(coordinatorMock.clearIndex).not.toHaveBeenCalled(); // force is deferred

    resolveFirst({ indexed: 1, skipped: 0 });
    await first;
    await second;
    await flush();

    expect(coordinatorMock.clearIndex).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(2);
    expect(coordinatorMock.clearIndex.mock.invocationCallOrder[0])
      .toBeLessThan(coordinatorMock.indexImages.mock.invocationCallOrder[1]);
  });

  it('clears the progress bar when the run completes (regression: it stuck at 100/100 forever)', async () => {
    useImageStore.setState({
      images: [createImage({ id: 'a', prompt: 'red fox' })],
      semanticIndexProgress: { current: 1, total: 4, message: 'embedding' },
    });

    await useImageStore.getState().semanticIndexImages();

    expect(useImageStore.getState().semanticIndexProgress).toBeNull();
  });

  it('clears the progress bar when the run fails', async () => {
    coordinatorMock.indexImages.mockRejectedValueOnce(new Error('embedding failed'));
    useImageStore.setState({
      images: [createImage({ id: 'a', prompt: 'red fox' })],
      semanticIndexProgress: { current: 1, total: 4, message: 'embedding' },
    });

    await useImageStore.getState().semanticIndexImages();

    expect(useImageStore.getState().semanticIndexProgress).toBeNull();
    expect(useImageStore.getState().semanticLastError).toBe('embedding failed');
  });

  it('a user cancel clears the bar without surfacing an error', async () => {
    coordinatorMock.indexImages.mockRejectedValueOnce(
      new Error('Semantic indexing cancelled by user'),
    );
    useImageStore.setState({
      images: [createImage({ id: 'a', prompt: 'red fox' })],
      semanticIndexProgress: { current: 3, total: 4, message: 'embedding' },
    });

    await useImageStore.getState().semanticIndexImages();

    expect(useImageStore.getState().semanticIndexProgress).toBeNull();
    expect(useImageStore.getState().semanticLastError).toBeNull();
  });

  it('cancelSemanticIndexing clears the bar, drops a queued replay, and aborts the coordinator', async () => {
    // Unstamped image so the run reaches indexImages and hangs on the held
    // promise (an empty payload would short-circuit and leak it forward).
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });

    let resolveIndex!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((r) => { resolveIndex = r; }));

    // A run hangs mid-embed…
    const run = useImageStore.getState().semanticIndexImages();
    await flush();
    // …a second invocation is queued behind it…
    const queued = useImageStore.getState().semanticIndexImages();
    useImageStore.setState({ semanticIndexProgress: { current: 1, total: 4, message: 'embedding' } });

    // …then the user cancels: bar clears, queue drops, coordinator aborts.
    useImageStore.getState().cancelSemanticIndexing();
    expect(useImageStore.getState().semanticIndexProgress).toBeNull();
    expect(coordinatorMock.cancelIndexing).toHaveBeenCalledTimes(1);

    resolveIndex({ indexed: 1, skipped: 0 });
    await run;
    await queued; // dropped jobs resolve as no-ops
    await flush();
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
  });
});

describe('applySemanticEmbeddingModel (Settings model switch)', () => {
  it('persists the model, cancels in-flight work, disposes the worker, then force re-indexes', async () => {
    // A live coordinator exists from a prior Δ-run…
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });
    await useImageStore.getState().semanticIndexImages();
    await flush();
    vi.clearAllMocks(); // forget the setup run (implementations persist)

    await useImageStore.getState().applySemanticEmbeddingModel('embed-b32');
    await flush();

    expect(useSettingsStore.getState().aiEmbeddingModel).toBe('embed-b32');
    // Cancel BEFORE dispose: cancel rejects with the swallowed cancel path,
    // dispose rejects with a plain error that would surface as semanticLastError.
    expect(coordinatorMock.cancelIndexing).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.dispose).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.cancelIndexing.mock.invocationCallOrder[0])
      .toBeLessThan(coordinatorMock.dispose.mock.invocationCallOrder[0]);
    // Force path on a freshly-created coordinator: clear, then re-index.
    expect(coordinatorMock.clearIndex).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.clearIndex.mock.invocationCallOrder[0])
      .toBeLessThan(coordinatorMock.indexImages.mock.invocationCallOrder[0]);
  });

  it('cancels a hanging run before disposing; the deferred force replay still re-indexes', async () => {
    useImageStore.setState({ images: [createImage({ id: 'a', prompt: 'red fox' })] });
    let resolveFirst!: (v: { indexed: number; skipped: number }) => void;
    coordinatorMock.indexImages.mockReturnValueOnce(new Promise((r) => { resolveFirst = r; }));

    const first = useImageStore.getState().semanticIndexImages();
    await flush(); // run reaches the coordinator
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);

    // The switch lands while a run is in flight: cancel + dispose immediately…
    const apply = useImageStore.getState().applySemanticEmbeddingModel('embed-b32');
    expect(coordinatorMock.cancelIndexing).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.dispose).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.cancelIndexing.mock.invocationCallOrder[0])
      .toBeLessThan(coordinatorMock.dispose.mock.invocationCallOrder[0]);
    expect(coordinatorMock.clearIndex).not.toHaveBeenCalled(); // force is deferred

    // …the queued force run still clears + re-indexes once the hang settles.
    resolveFirst({ indexed: 1, skipped: 0 });
    await first;
    await apply;
    await flush();

    expect(coordinatorMock.clearIndex).toHaveBeenCalledTimes(1);
    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().aiEmbeddingModel).toBe('embed-b32');
  });
});

describe('semanticIndexImages split payload + tag-mutation re-index', () => {
  const annotationFor = (imageId: string, extra: Partial<ImageAnnotations> = {}): ImageAnnotations => ({
    imageId,
    isFavorite: false,
    tags: [],
    autoTags: [],
    metadataTags: [],
    isAutoTagged: false,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  });

  const lastPayload = () => coordinatorMock.indexImages.mock.calls[0][0] as Array<Record<string, unknown>>;

  it('sends the split payload — auto-tags in their own segment, manual + metadata in tags', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1', prompt: 'a red fox' });
    useImageStore.setState({
      // The merged IndexedImage.tags (annotation echo) must NOT leak through.
      images: [{ ...img, tags: ['merged-echo'] }],
      annotations: new Map([
        ['imgA', annotationFor('imgA', { tags: ['manual'], autoTags: ['concept'], metadataTags: ['meta'] })],
      ]),
    });

    await useImageStore.getState().semanticIndexImages();
    await flush();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toEqual([
      expect.objectContaining({
        id: 'imgA',
        prompt: 'a red fox',
        tags: ['manual', 'meta'],
        autoTags: ['concept'],
        synonyms: [],
      }),
    ]);
  });

  it('falls back to the image fields for never-annotated images', async () => {
    const img = createImage({
      id: 'imgA',
      name: 'red fox.png',
      directoryId: 'dir1',
      tags: ['legacy-tag'],
      autoTags: ['legacy-concept'],
      synonymTags: ['legacy-syn'],
    });
    useImageStore.setState({ images: [img], annotations: new Map() });

    await useImageStore.getState().semanticIndexImages();
    await flush();

    expect(lastPayload()).toEqual([
      expect.objectContaining({ tags: ['legacy-tag'], autoTags: ['legacy-concept'], synonyms: ['legacy-syn'] }),
    ]);
  });

  it('addTagToImage Δ-re-indexes so a manual tag is searchable immediately', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
    useImageStore.setState({ images: [img], annotations: new Map([['imgA', annotationFor('imgA')]]) });

    await useImageStore.getState().addTagToImage('imgA', 'furry');
    await flush();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toEqual([
      expect.objectContaining({ id: 'imgA', tags: ['furry'], autoTags: [] }),
    ]);
  });

  it('removeTagFromImage Δ-re-indexes the removal', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
    useImageStore.setState({
      images: [img],
      annotations: new Map([['imgA', annotationFor('imgA', { tags: ['furry'] })]]),
    });

    await useImageStore.getState().removeTagFromImage('imgA', 'furry');
    await flush();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toEqual([
      expect.objectContaining({ id: 'imgA', tags: [], autoTags: [] }),
    ]);
  });

  it('bulkAddTag Δ-re-indexes the bulk edit', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
    useImageStore.setState({ images: [img], annotations: new Map([['imgA', annotationFor('imgA')]]) });

    await useImageStore.getState().bulkAddTag(['imgA'], 'furry');
    await flush();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toEqual([
      expect.objectContaining({ id: 'imgA', tags: ['furry'], autoTags: [] }),
    ]);
  });

  it('bulkRemoveTag Δ-re-indexes the bulk removal', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
    useImageStore.setState({
      images: [img],
      annotations: new Map([['imgA', annotationFor('imgA', { tags: ['furry'] })]]),
    });

    await useImageStore.getState().bulkRemoveTag(['imgA'], 'furry');
    await flush();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toEqual([
      expect.objectContaining({ id: 'imgA', tags: [], autoTags: [] }),
    ]);
  });

  it('importMetadataTags Δ-re-indexes imported metadata tags', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
    useImageStore.setState({ images: [img], annotations: new Map([['imgA', annotationFor('imgA')]]) });

    const withMeta = {
      ...img,
      metadata: { normalizedMetadata: { tags: ['style-x'] } },
    } as unknown as IndexedImage;
    await useImageStore.getState().importMetadataTags([withMeta]);
    await flush();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    // Metadata tags ride the same 0.8 segment as manual tags (split from autoTags).
    expect(lastPayload()).toEqual([
      expect.objectContaining({ id: 'imgA', tags: ['style-x'], autoTags: [] }),
    ]);
  });

  it('clearAutoTags Δ-re-indexes so cleared concepts drop out of the index', async () => {
    const img = createImage({ id: 'imgA', name: 'red fox.png', directoryId: 'dir1' });
    useImageStore.setState({
      images: [img],
      annotations: new Map([
        ['imgA', annotationFor('imgA', { autoTags: ['concept'], isAutoTagged: true })],
      ]),
    });

    await useImageStore.getState().clearAutoTags();
    await flush();

    expect(coordinatorMock.indexImages).toHaveBeenCalledTimes(1);
    expect(lastPayload()).toEqual([
      expect.objectContaining({ id: 'imgA', tags: [], autoTags: [] }),
    ]);
  });
});

describe('keyword catalog text — models coverage', () => {
  it('matches model family names in the search box (mode off / keyword path)', () => {
    const img = createImage({ id: 'imgA', name: 'render.png', directoryId: 'dir1', models: ['sdxl', 'flux1-dev'] });
    setupLibrary([img], { hits: null, mode: 'off' }, { searchQuery: 'sdxl' });
    expect(useImageStore.getState().filteredImages.map((i) => i.id)).toEqual(['imgA']);
  });

  it('does not match a model name that is absent (no false positives)', () => {
    const img = createImage({ id: 'imgA', name: 'render.png', directoryId: 'dir1', models: ['flux1-dev'] });
    setupLibrary([img], { hits: null, mode: 'off' }, { searchQuery: 'sdxl' });
    expect(useImageStore.getState().filteredImages).toEqual([]);
  });
});
