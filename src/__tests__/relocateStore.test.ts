// @vitest-environment jsdom
//
// Store-level relocation invariants (relocateImages in useImageStore).
//
// This is an integration test on purpose: it uses the REAL annotation storage
// on fake-indexeddb and the REAL relocation service, stubbing only the
// main-process IPC. What it pins down:
//
//   - every derived record re-keys old-id → new-id (annotations in the store
//     map AND the DB, semantic vectors, thumbnail bookkeeping),
//   - the image object is rebased (id/name/directoryId/handle/lastModified),
//     and its handle reads the NEW path — the Electron mock handle closes over
//     its creation path, so a carried-over handle would silently read the old
//     file,
//   - the pipeline gates (searchTagVersion / isSemanticIndexed) are still
//     closed afterwards — that is what stops the re-tag/re-embed work,
//   - filteredImages reflects the new ids (the _updateState early-out trap),
//   - with a semantic round in flight, the moved image is un-stamped (in the
//     store AND persisted) and a follow-up round is enqueued.
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

class FakeTaggingWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage(): void { /* no-op */ }
}

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  createAiWorker: () => new FakeTaggingWorker(),
}));

vi.mock('../services/aiBridge', () => ({
  createStackingEngine: vi.fn().mockResolvedValue({
    generatePromptHash: (prompt: string) => `hash-${prompt}`,
    computeSimilarityGroupIds: vi.fn().mockResolvedValue({ groupIdToSimId: new Map() }),
    computePromptSimilarity: vi.fn().mockResolvedValue(0.9),
  }),
  SEARCH_ENRICHMENT_VERSION: 2,
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
  SIMILARITY_MATCH_THRESHOLD: 0.8,
}));

// Semantic search stays disabled: the follow-up round enqueued by
// relocateImages must short-circuit in runSemanticIndexNow's gate, so the test
// exercises the queue ordering without loading the ai-intelligence module.
vi.mock('../services/aiFeatureAccess', () => ({
  isAiFeaturesEnabled: vi.fn(() => true),
  isAiMasterEnabled: vi.fn(() => true),
  isAiModelFeaturesEnabled: vi.fn(() => true),
  isSemanticSearchEnabled: vi.fn(() => false),
}));

import {
  useImageStore,
  needsSearchEnrichment,
  needsSemanticIndexing,
} from '../store/useImageStore';
import { thumbnailManager } from '../services/thumbnailManager';
import { processingQueue } from '../services/processingQueue';
import {
  saveAnnotation,
  loadAllAnnotations,
  clearAllAnnotations,
} from '../services/imageAnnotationsStorage';
import { openDatabase, clearSemanticVectorsStore } from '../services/indexedDb';
import {
  resetRelocationRegistryForTests,
  isRelocatedPath,
} from '../services/imageRelocation';
import type { Directory, ImageAnnotations, ImageRelocationMove, IndexedImage } from '../types';

/** Shape of a `semanticVectors` record (keyPath imageId, owned by the AI module). */
interface VectorRecord {
  imageId: string;
  vector: number[];
  updatedAt?: number;
}

const ROOT_A = 'C:\\libs\\A';
const ROOT_B = 'C:\\libs\\B';
const OLD_ID = `${ROOT_A}::old/pic.png`;
const NEW_ID = `${ROOT_B}::sub/pic.png`;
const OLD_ABS = 'C:\\libs\\A\\old\\pic.png';
const NEW_ABS = 'C:\\libs\\B\\sub\\pic.png';
/** What the stubbed main-process IPC reports as the moved file's fresh mtime. */
const FRESH_MTIME = 4242;

const MOVE: ImageRelocationMove = {
  oldImageId: OLD_ID,
  newImageId: NEW_ID,
  oldName: 'old/pic.png',
  newName: 'sub/pic.png',
  oldAbsolutePath: OLD_ABS,
  newAbsolutePath: NEW_ABS,
  oldLastModified: 111,
  newLastModified: 111, // pre-IPC placeholder, overwritten by the stat
  targetRootId: ROOT_B,
  targetRootName: 'B',
  sourceCacheId: `${ROOT_A}-flat`,
  targetCacheId: `${ROOT_B}-recursive`,
};

const relocateDerivedFilesMock = vi.fn();
const electronReadFileMock = vi.fn();

// Installed before any test runs; imageRelocation.ts reads window.electronAPI
// lazily on each call, so per-test mockReset/re-implementation is enough.
(window as unknown as { electronAPI: unknown }).electronAPI = {
  relocateDerivedFiles: relocateDerivedFilesMock,
  readFile: electronReadFileMock,
};

const makeImage = (
  id: string,
  name: string,
  directoryId: string,
  extra: Partial<IndexedImage> = {},
): IndexedImage => ({
  id,
  name,
  directoryId,
  directoryName: directoryId === ROOT_A ? 'A' : 'B',
  handle: {
    _filePath: `${directoryId}\\${name.split('/').join('\\')}`,
    name: name.split('/').pop(),
    kind: 'file',
  } as unknown as FileSystemFileHandle,
  metadata: {
    normalizedMetadata: { prompt: 'dragon', negativePrompt: '' },
  } as unknown as IndexedImage['metadata'],
  metadataString: '',
  lastModified: 111,
  models: [],
  loras: [],
  scheduler: '',
  ...extra,
});

const makeDirectory = (id: string, name: string): Directory => ({
  id,
  path: id,
  name,
  handle: {} as FileSystemDirectoryHandle,
  visible: true,
  isConnected: true,
});

const makeAnnotation = (imageId: string): ImageAnnotations => ({
  imageId,
  isFavorite: true,
  tags: ['keeper'],
  autoTags: ['dragon'],
  metadataTags: [],
  isAutoTagged: true,
  synonymTags: ['wyvern'],
  searchTagVersion: 2,
  isSemanticIndexed: true,
  stackGroupId: 'hash-dragon',
  isStackAnalyzed: true,
  similarityGroupId: 'sim-1',
  addedAt: 1000,
  updatedAt: 1000,
});

const putVector = async (imageId: string, vector: number[]): Promise<void> => {
  const db = await openDatabase();
  expect(db).not.toBeNull();
  await new Promise<void>((resolve) => {
    const tx = db!.transaction('semanticVectors', 'readwrite');
    tx.oncomplete = tx.onabort = tx.onerror = () => resolve();
    tx.objectStore('semanticVectors').put({ imageId, vector, updatedAt: 1 });
  });
  db!.close();
};

const getVector = async (imageId: string): Promise<VectorRecord | undefined> => {
  const db = await openDatabase();
  expect(db).not.toBeNull();
  const record = await new Promise<VectorRecord | undefined>((resolve) => {
    const request = db!
      .transaction('semanticVectors', 'readonly')
      .objectStore('semanticVectors')
      .get(imageId);
    request.onsuccess = () => resolve(request.result as VectorRecord | undefined);
    request.onerror = () => resolve(undefined);
  });
  db!.close();
  return record;
};

const getAnnotationFromDb = async (imageId: string): Promise<ImageAnnotations | undefined> => {
  const db = await openDatabase();
  expect(db).not.toBeNull();
  const record = await new Promise<ImageAnnotations | undefined>((resolve) => {
    const request = db!
      .transaction('imageAnnotations', 'readonly')
      .objectStore('imageAnnotations')
      .get(imageId);
    request.onsuccess = () => resolve(request.result as ImageAnnotations | undefined);
    request.onerror = () => resolve(undefined);
  });
  db!.close();
  return record;
};

describe('relocateImages — store-level invariants', () => {
  beforeEach(async () => {
    await clearAllAnnotations();
    await clearSemanticVectorsStore();
    resetRelocationRegistryForTests();
    relocateDerivedFilesMock.mockReset();
    relocateDerivedFilesMock.mockImplementation(async ({ moves }: { moves: ImageRelocationMove[] }) => ({
      success: true,
      results: moves.map((move) => ({
        oldImageId: move.oldImageId,
        newImageId: move.newImageId,
        newLastModified: FRESH_MTIME,
        thumbnailMoved: true,
        cacheMoved: true,
      })),
    }));
    electronReadFileMock.mockReset();
    electronReadFileMock.mockResolvedValue({ success: true, data: new Uint8Array([1, 2, 3]) });

    useImageStore.setState({
      images: [],
      filteredImages: [],
      annotations: new Map(),
      isAnnotationsLoaded: true,
      indexingState: 'idle',
      // filterAndSort drops images whose directoryId is not a visible,
      // connected directory — seed both roots (source and target).
      directories: [makeDirectory(ROOT_A, 'A'), makeDirectory(ROOT_B, 'B')],
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      selectedImages: new Set(),
      selectedImage: null,
      selectionAnchorId: null,
      semanticHits: null,
      libraryStackContext: null,
      draggedItems: [],
    });
  });

  it('re-keys annotations + vectors, rebases the image, and keeps the pipeline gates closed', async () => {
    const annotation = makeAnnotation(OLD_ID);
    await saveAnnotation(annotation);
    await putVector(OLD_ID, [0.1, 0.2, 0.3]);

    const image = makeImage(OLD_ID, 'old/pic.png', ROOT_A);
    useImageStore.setState({
      images: [image],
      filteredImages: [image],
      annotations: new Map([[OLD_ID, annotation]]),
      selectedImages: new Set([OLD_ID]),
      selectedImage: image,
      selectionAnchorId: OLD_ID,
      draggedItems: [
        { sourcePath: OLD_ABS, name: 'pic.png', id: OLD_ID, directoryId: ROOT_A },
      ],
    });

    const renameSpy = vi.spyOn(thumbnailManager, 'renameEntry');
    await useImageStore.getState().relocateImages([MOVE]);

    const state = useImageStore.getState();
    expect(state.images).toHaveLength(1);
    const relocated = state.images[0];
    expect(relocated.id).toBe(NEW_ID);
    expect(relocated.name).toBe('sub/pic.png');
    expect(relocated.directoryId).toBe(ROOT_B);
    expect(relocated.directoryName).toBe('B');
    // Fresh stat from the IPC folds into the same write (EXDEV copy+delete
    // resets birthtime; the thumbnail key + cache diff both read this).
    expect(relocated.lastModified).toBe(FRESH_MTIME);
    // Bytes never changed — the parsed metadata is carried over untouched.
    expect(relocated.metadata.normalizedMetadata.prompt).toBe('dragon');

    // The rebuilt handle must read the NEW path, or copy-to-clipboard and the
    // modal's full-size load would fetch the file that no longer exists.
    expect((relocated.handle as unknown as { _filePath: string })._filePath).toBe(NEW_ABS);
    const file = await relocated.handle.getFile();
    expect(electronReadFileMock).toHaveBeenCalledWith(NEW_ABS);
    expect(file.name).toBe('pic.png');

    // filteredImages was rebuilt (the _updateState early-out would have left
    // the old ids there).
    expect(state.filteredImages.map((img) => img.id)).toEqual([NEW_ID]);

    // Annotation map re-keyed with every field intact.
    expect(state.annotations.has(OLD_ID)).toBe(false);
    const ann = state.annotations.get(NEW_ID);
    expect(ann).toBeDefined();
    expect(ann!.imageId).toBe(NEW_ID);
    expect(ann!.isFavorite).toBe(true);
    expect(ann!.tags).toEqual(['keeper']);
    expect(ann!.autoTags).toEqual(['dragon']);
    expect(ann!.synonymTags).toEqual(['wyvern']);
    expect(ann!.stackGroupId).toBe('hash-dragon');

    // THE point of the whole exercise: both pipeline gates stay closed.
    expect(needsSearchEnrichment(ann)).toBe(false);
    expect(needsSemanticIndexing(ann)).toBe(false);

    // Persisted re-key — raw DB read, not the module's memory cache.
    expect(await getAnnotationFromDb(OLD_ID)).toBeUndefined();
    const persisted = await getAnnotationFromDb(NEW_ID);
    expect(persisted?.isFavorite).toBe(true);
    expect(persisted?.searchTagVersion).toBe(2);
    expect(persisted?.isSemanticIndexed).toBe(true);
    // …and the module's in-memory cache agrees.
    const memory = await loadAllAnnotations();
    expect(memory.has(OLD_ID)).toBe(false);
    expect(memory.get(NEW_ID)?.isFavorite).toBe(true);

    // Semantic vector moved with the id.
    expect(await getVector(NEW_ID)).toEqual(
      expect.objectContaining({ imageId: NEW_ID, vector: [0.1, 0.2, 0.3] }),
    );
    expect(await getVector(OLD_ID)).toBeUndefined();

    // Selection / modal / drag state all follow the image.
    expect(state.selectedImages.has(NEW_ID)).toBe(true);
    expect(state.selectedImages.has(OLD_ID)).toBe(false);
    expect(state.selectedImage?.id).toBe(NEW_ID);
    expect(state.selectionAnchorId).toBe(NEW_ID);
    expect(state.draggedItems[0]).toMatchObject({
      id: NEW_ID,
      name: 'sub/pic.png',
      directoryId: ROOT_B,
      sourcePath: NEW_ABS,
    });

    // Thumbnail bookkeeping re-keyed; main process asked to move cache + webp.
    expect(renameSpy).toHaveBeenCalledWith(OLD_ID, NEW_ID);
    renameSpy.mockRestore();
    expect(relocateDerivedFilesMock).toHaveBeenCalledTimes(1);
    expect(relocateDerivedFilesMock.mock.calls[0][0].moves[0].oldImageId).toBe(OLD_ID);

    // Both ends armed in the registry so the watcher's unlink+add compound is
    // treated as a relocation, not a delete + new file.
    expect(isRelocatedPath(OLD_ABS)).toBe(true);
    expect(isRelocatedPath(NEW_ABS)).toBe(true);
  });

  it('replaces a stale entry already sitting under the new identity', async () => {
    const stale = makeImage(NEW_ID, 'sub/pic.png', ROOT_B, { lastModified: 999 });
    const moving = makeImage(OLD_ID, 'old/pic.png', ROOT_A);
    useImageStore.setState({ images: [stale, moving], filteredImages: [stale, moving] });

    await useImageStore.getState().relocateImages([MOVE]);

    const state = useImageStore.getState();
    // One entry survives: the rebased image, not the stale leftover.
    expect(state.images).toHaveLength(1);
    expect(state.images[0].id).toBe(NEW_ID);
    expect(state.images[0].lastModified).toBe(FRESH_MTIME);
    expect(state.filteredImages).toHaveLength(1);
  });

  it('is a no-op for an empty move list', async () => {
    const image = makeImage(OLD_ID, 'old/pic.png', ROOT_A);
    useImageStore.setState({ images: [image], filteredImages: [image] });

    await useImageStore.getState().relocateImages([]);

    expect(useImageStore.getState().images[0].id).toBe(OLD_ID);
    expect(relocateDerivedFilesMock).not.toHaveBeenCalled();
  });

  it('keeps real deletion intact: an unlink of the OLD path destroys nothing, a delete of the NEW path clears', async () => {
    await saveAnnotation(makeAnnotation(OLD_ID));
    const image = makeImage(OLD_ID, 'old/pic.png', ROOT_A);
    useImageStore.setState({
      images: [image],
      filteredImages: [image],
      annotations: new Map([[OLD_ID, makeAnnotation(OLD_ID)]]),
    });

    await useImageStore.getState().relocateImages([MOVE]);

    // The watcher's rename compound still reports `unlink(old)` after the
    // move — by then the re-keyed annotation lives under the new id and the
    // old-id removal has nothing to destroy.
    useImageStore.getState().removeImages([OLD_ID]);
    expect(useImageStore.getState().annotations.get(NEW_ID)).toBeDefined();
    expect(useImageStore.getState().images.map((img) => img.id)).toEqual([NEW_ID]);

    // A genuine delete of the moved file still wipes the annotation — the
    // clearAnnotationsForRemovedImages path is untouched by the relocation
    // feature (its persistence is fire-and-forget, hence waitFor).
    useImageStore.getState().removeImages([NEW_ID]);
    expect(useImageStore.getState().annotations.has(NEW_ID)).toBe(false);
    await vi.waitFor(async () => {
      expect(await getAnnotationFromDb(NEW_ID)).toBeUndefined();
    });
  });

  it('un-stamps semantic indexing and enqueues a follow-up when a semantic round is in flight', async () => {
    const annotation = makeAnnotation(OLD_ID);
    await saveAnnotation(annotation);
    const image = makeImage(OLD_ID, 'old/pic.png', ROOT_A);
    useImageStore.setState({
      images: [image],
      filteredImages: [image],
      annotations: new Map([[OLD_ID, annotation]]),
    });

    // Occupy the 'semantic' queue key with a job we control: the in-flight
    // round captured its payload (old ids) BEFORE the move.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = processingQueue.enqueueOnce('semantic', async () => { await gate; });
    expect(processingQueue.hasPendingOrRunning('semantic')).toBe(true);

    try {
      await useImageStore.getState().relocateImages([MOVE]);

      // The stamp is dropped in memory AND persisted: the in-flight round's
      // vectors land under the old ids, so the new id must re-embed — and if
      // the app closes first, the surviving DB record must still carry the
      // open gate.
      const ann = useImageStore.getState().annotations.get(NEW_ID);
      expect(ann?.isSemanticIndexed).toBe(false);
      expect(needsSemanticIndexing(ann)).toBe(true);
      expect((await getAnnotationFromDb(NEW_ID))?.isSemanticIndexed).toBe(false);

      // A follow-up round is queued behind the running job (enqueueOnce
      // appends to a RUNNING key), so the moved image is re-embedded under
      // its new id once the current round finishes.
      expect(processingQueue.hasPendingOrRunning('semantic')).toBe(true);
    } finally {
      release();
      await running;
      await processingQueue.waitForIdle(5000);
    }
  });
});
