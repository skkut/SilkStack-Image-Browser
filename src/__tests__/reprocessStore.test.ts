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
  isSemanticSearchEnabled: vi.fn(() => true),
  useSemanticSearchEnabled: vi.fn(() => true),
}));

const coordinatorMock = vi.hoisted(() => ({
  ensureInitialized: vi.fn(),
  indexImages: vi.fn(),
  search: vi.fn(),
  clearIndex: vi.fn().mockResolvedValue(undefined),
  cancelIndexing: vi.fn(),
  getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
  dispose: vi.fn(),
}));

const clearSemanticVectorsStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const clearDirectoryCacheMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const bulkSaveAnnotationsMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);

// The store lazy-loads the coordinator via dynamic import — every `new
// SemanticSearchCoordinator(...)` returns the same mock instance (mirrors the
// module-level singleton in useImageStore). Constructable via `function`.
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
  bulkSaveAnnotations: bulkSaveAnnotationsMock,
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

// Spread the real modules and override only what clearDerivedImageData uses —
// the store (and thumbnailManager, which imports cacheManager) keep the real
// implementations for everything else.
vi.mock('../services/cacheManager', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/cacheManager')>();
  return { ...mod, default: { ...mod.default, clearDirectoryCache: clearDirectoryCacheMock } };
});

vi.mock('../services/indexedDb', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../services/indexedDb')>();
  return { ...mod, clearSemanticVectorsStore: clearSemanticVectorsStoreMock };
});

import { useImageStore } from '../store/useImageStore';
import { thumbnailManager } from '../services/thumbnailManager';
import { type ImageAnnotations, type IndexedImage } from '../types';

const createImage = (id: string, prompt = ''): IndexedImage => ({
  id,
  name: `${id}.png`,
  handle: {} as FileSystemFileHandle,
  metadata: {
    normalizedMetadata: { prompt, negativePrompt: '' },
  } as any,
  metadataString: '',
  lastModified: Date.now(),
  models: [],
  loras: [],
  scheduler: '',
  thumbnailStatus: 'pending',
  tags: [],
  autoTags: [],
  directoryId: 'dir1',
});

const createAnnotation = (imageId: string, overrides: Partial<ImageAnnotations> = {}): ImageAnnotations => ({
  imageId,
  isFavorite: false,
  tags: [],
  autoTags: [],
  metadataTags: [],
  addedAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const dirtyAnnotation = (imageId: string): ImageAnnotations => createAnnotation(imageId, {
  isFavorite: true,
  tags: ['manual-tag'],
  autoTags: ['sunset', 'landscape'],
  isAutoTagged: true,
  synonymTags: ['sunset sunset landscape scenery'],
  searchTagVersion: 2,
  metadataTags: ['Canon EOS R5', 'f/2.8'],
  stackGroupId: 'hash-prompt-a',
  isStackAnalyzed: true,
  similarityGroupId: 'sim-1',
  isSimilarityAnalyzed: true,
});

const cleanAnnotation = (imageId: string): ImageAnnotations => createAnnotation(imageId, {
  isFavorite: true,
  tags: ['kept-manual'],
});

beforeEach(() => {
  vi.clearAllMocks();
  // Electron API — the disk-cache branch of clearDerivedImageData needs it.
  (global.window as any).electronAPI = {
    clearThumbnailCache: vi.fn().mockResolvedValue({ success: true }),
  };
  // Default store state: idle, two directories, two images (one dirty, one
  // already-clean annotation).
  useImageStore.setState({
    images: [createImage('img-a', 'prompt a'), createImage('img-b', 'prompt b')],
    directories: [
      { id: 'dir1', path: 'C:/library/a', name: 'a', handle: {} as any, autoWatch: true, isConnected: true },
      { id: 'dir2', path: 'C:/library/b', name: 'b', handle: {} as any, autoWatch: false, isConnected: true },
    ],
    annotations: new Map([
      ['img-a', dirtyAnnotation('img-a')],
      ['img-b', cleanAnnotation('img-b')],
    ]),
    indexingState: 'idle',
    isAutoTagging: false,
  });
});

describe('clearDerivedImageData (Reprocess Images)', () => {
  it('preserves favorites/manual tags/addedAt and zeroes all derived fields', async () => {
    await useImageStore.getState().clearDerivedImageData();

    const imgA = useImageStore.getState().annotations.get('img-a')!;
    expect(imgA.isFavorite).toBe(true);                    // KEEP
    expect(imgA.tags).toEqual(['manual-tag']);             // KEEP
    expect(imgA.addedAt).toBe(1000);                       // KEEP
    expect(imgA.updatedAt).toBeGreaterThan(1000);          // bump

    expect(imgA.autoTags).toEqual([]);                     // CLEAR
    expect(imgA.isAutoTagged).toBe(false);                 // CLEAR
    expect(imgA.synonymTags).toEqual([]);                  // CLEAR
    expect(imgA.searchTagVersion).toBeUndefined();         // CLEAR — enrichment gate
    expect(imgA.metadataTags).toEqual([]);                 // CLEAR
    expect(imgA.stackGroupId).toBeUndefined();             // CLEAR
    expect(imgA.isStackAnalyzed).toBe(false);              // CLEAR
    expect(imgA.similarityGroupId).toBeUndefined();        // CLEAR
    expect(imgA.isSimilarityAnalyzed).toBe(false);         // CLEAR

    // The already-clean record is untouched and was NOT rewritten.
    const imgB = useImageStore.getState().annotations.get('img-b')!;
    expect(imgB.isFavorite).toBe(true);
    expect(imgB.tags).toEqual(['kept-manual']);
    expect(imgB.updatedAt).toBe(1000);
  });

  it('persists only the changed records via bulkSaveAnnotations', async () => {
    await useImageStore.getState().clearDerivedImageData();

    expect(bulkSaveAnnotationsMock).toHaveBeenCalledTimes(1);
    const written = bulkSaveAnnotationsMock.mock.calls[0][0] as ImageAnnotations[];
    expect(written).toHaveLength(1);                       // img-a only
    expect(written[0].imageId).toBe('img-a');
  });

  it('clears the disk metadata cache for BOTH scan variants of every directory, plus thumbnails', async () => {
    await useImageStore.getState().clearDerivedImageData();

    expect(clearDirectoryCacheMock).toHaveBeenCalledTimes(4); // 2 dirs × (recursive + flat)
    expect(clearDirectoryCacheMock).toHaveBeenCalledWith('C:/library/a', true);
    expect(clearDirectoryCacheMock).toHaveBeenCalledWith('C:/library/a', false);
    expect(clearDirectoryCacheMock).toHaveBeenCalledWith('C:/library/b', true);
    expect(clearDirectoryCacheMock).toHaveBeenCalledWith('C:/library/b', false);

    expect((global.window as any).electronAPI.clearThumbnailCache).toHaveBeenCalled();
  });

  it('revokes in-memory thumbnail URLs', async () => {
    const clearAllUrlsSpy = vi.spyOn(thumbnailManager, 'clearAllUrls');
    await useImageStore.getState().clearDerivedImageData();
    expect(clearAllUrlsSpy).toHaveBeenCalled();
    clearAllUrlsSpy.mockRestore();
  });

  it('wipes the semantic index via the coordinator when search is enabled', async () => {
    await useImageStore.getState().clearDerivedImageData();

    expect(coordinatorMock.clearIndex).toHaveBeenCalled();
    expect(clearSemanticVectorsStoreMock).not.toHaveBeenCalled();
    expect(useImageStore.getState().semanticIndexedCount).toBe(0);
  });

  it('falls back to a direct semanticVectors store clear when search is disabled and no coordinator exists', async () => {
    // Fresh module state → __semanticCoordinator is null; disabled → the
    // coordinator is not obtainable, so the direct store clear must run.
    vi.resetModules();
    featureAccessMocks.isSemanticSearchEnabled.mockReturnValue(false);
    const { useImageStore: freshStore } = await import('../store/useImageStore');

    freshStore.setState({
      images: [createImage('img-a', 'prompt a')],
      directories: [],
      annotations: new Map([['img-a', dirtyAnnotation('img-a')]]),
    });

    await freshStore.getState().clearDerivedImageData();

    expect(clearSemanticVectorsStoreMock).toHaveBeenCalled();
  });

  it('rejects while an indexing operation is in flight', async () => {
    useImageStore.setState({ indexingState: 'indexing' });

    await expect(useImageStore.getState().clearDerivedImageData())
      .rejects.toThrow(/indexing operation is in progress/);
  });
});
