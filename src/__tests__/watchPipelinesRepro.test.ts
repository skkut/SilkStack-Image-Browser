import { describe, expect, it, vi, beforeEach } from 'vitest';

// Persisted-store tests need a localStorage mock before ANY store import.
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

  // A real 1x1 PNG so the parsers run without crashing.
  const PNG_1x1 = Uint8Array.from(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  );
  globalThis.__PNG_1x1 = PNG_1x1;

  // electronAPI must exist at MODULE LOAD: fileIndexer computes
  // `isElectron = typeof window !== 'undefined' && window.electronAPI` once
  // at import time, and the optimized head-read path keys off it. Setting it
  // in beforeEach is too late — the import already ran.
  if (typeof window !== 'undefined') {
    (window as any).electronAPI = {
      readFilesHeadBatch: async ({ filePaths }: { filePaths: string[] }) => ({
        success: true,
        files: filePaths.map((p: string) => ({ path: p, success: true, data: PNG_1x1.buffer.slice(0) as ArrayBuffer })),
      }),
      readFilesBatch: async ({ filePaths }: { filePaths: string[] }) => ({
        success: true,
        files: filePaths.map((p: string) => ({ path: p, success: true, data: PNG_1x1.buffer.slice(0) as ArrayBuffer })),
      }),
      readFilesTailBatch: async ({ filePaths }: { filePaths: string[] }) => ({
        success: true,
        files: filePaths.map((p: string) => ({ path: p, success: true, data: PNG_1x1.buffer.slice(0) as ArrayBuffer })),
      }),
      readVideoMetadata: async () => ({}),
      joinPaths: async (a: string, b: string) => ({ success: true, path: `${a}/${b}` }),
      // zustand persist in useSettingsStore calls saveSettings when setState
      // runs after a persist()-bound store touched state.
      saveSettings: async () => ({}),
    };
  }
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

vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);

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
  SEARCH_ENRICHMENT_VERSION: 2,
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
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

// jsdom's Worker is inert: constructing the real MetadataWorkerPool creates
// workers whose onerror rejects every pending parse() — processSingleFile-
// Optimized swallows that into null and Phase B delivers nothing. In the real
// app the pool parses fine; mock it to behave like production.
vi.mock('../services/metadataWorkerPool', () => ({
  MetadataWorkerPool: vi.fn(function () {
    return {
      parse: vi.fn(async () => ({ metadata: null, dimensions: null })),
      terminate: vi.fn(),
      size: 1,
      pendingCount: 0,
    };
  }),
}));

import { useImageStore } from '../store/useImageStore';
import { processingQueue } from '../services/processingQueue';
import { useSettingsStore } from '../store/useSettingsStore';
import { processFiles } from '../services/fileIndexer';

const PNG_1x1 = (globalThis as any).__PNG_1x1 as Uint8Array;

const dir = { id: 'D:/images', name: 'images', path: 'D:/images', handle: {} as any, visible: true, autoWatch: true, isConnected: true };

beforeEach(() => {
  vi.clearAllMocks();
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
    directories: [dir],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    error: null,
  });
});

const IMAGE_ID = 'D:/images::new-image.png';

/** Run the watch round exactly as processNewWatchedFiles does (inside a
 *  queued watcher job), completing the auto-tag run after 100 ms. */
async function runWatchRound(fileName: string): Promise<void> {
  const fileEntries = [
    {
      handle: {
        name: fileName,
        kind: 'file',
        _filePath: `D:/images/${fileName}`,
        // jsdom's File lacks arrayBuffer(); hand-build the minimal shape the
        // fallback `iterator` path uses.
        getFile: async () => ({
          name: fileName,
          type: 'image/png',
          arrayBuffer: async () => PNG_1x1.buffer.slice(0) as ArrayBuffer,
        }),
      } as any,
      path: fileName,
      lastModified: Date.now(),
      size: PNG_1x1.byteLength,
      type: 'image/png',
      birthtimeMs: Date.now(),
    },
  ];
  const fileStatsMap = new Map([[ fileName, { size: PNG_1x1.byteLength, type: 'image/png', birthtimeMs: Date.now() } ]]);

  await new Promise<void>((resolve, reject) => {
    processingQueue.enqueue(async () => {
      try {
        const { phaseB } = await processFiles(
          fileEntries as any,
          () => {},
          () => { /* Phase A batches are NOT added in the watch path */ },
          dir.id,
          dir.name,
          false,
          () => {},
          undefined,
          undefined,
          {
            concurrency: 2,
            fileStats: fileStatsMap as any,
            onEnrichmentBatch: (batch: any[]) => {
              useImageStore.getState().addImages(batch);
            },
          },
        );
        await phaseB;
        useImageStore.getState().flushPendingImages();
        useImageStore.getState().processPostIndexingPipeline();
        resolve();
      } catch (e) {
        reject(e);
      }
    }, { label: `watcher: ${fileName}` });
  });

  // Let the pipeline reach phase 3, then complete the auto-tag run.
  await new Promise(r => setTimeout(r, 100));
  const worker = FakeTaggingWorker.lastInstance;
  if (worker) {
    worker.onmessage?.({ data: { type: 'complete', payload: { autoTags: {} } } } as any);
  }

  await processingQueue.waitForIdle(5000);
}

function taggingImageIds(): string[] {
  const worker = FakeTaggingWorker.lastInstance;
  const startMsg = worker?.posted.find(m => m.type === 'start')?.payload as { images?: Array<{ id: string }> } | undefined;
  return (startMsg?.images ?? []).map(i => i.id);
}

function semanticIndexedIds(): string[] {
  const indexedCalls = coordinatorMock.indexImages.mock.calls.flat() as Array<Array<{ id: string }>>;
  return indexedCalls.flat().map(i => i.id);
}

describe('REAL watch flow: processFiles → addImages → flush → pipeline round', () => {
  it('auto-tag worker and semantic coordinator both see the watched image', async () => {
    await runWatchRound('new-image.png');

    expect(taggingImageIds()).toContain(IMAGE_ID);
    expect(semanticIndexedIds()).toContain(IMAGE_ID);
  });

  it('delete → re-add of the same path clears the stale annotation so all pipeline phases run again', async () => {
    // The OLD file's annotation (stamped by an earlier auto-tag + semantic +
    // stacking run) is what a deleted file leaves behind in IndexedDB. Its
    // stamps must be cleared when the image is removed, or every phase skips
    // the NEW file at the same path (see the negative control below).
    const staleAnnotation = {
      imageId: IMAGE_ID,
      isFavorite: false,
      tags: [],
      autoTags: ['old-file-tag'],
      metadataTags: [],
      isAutoTagged: true,
      searchTagVersion: 2,
      isSemanticIndexed: true,
      isStackAnalyzed: true,
      stackGroupId: 'old-stack-hash',
      similarityGroupId: 'old-sim-id',
      addedAt: Date.now(),
      updatedAt: Date.now(),
    };
    useImageStore.setState({ annotations: new Map([[IMAGE_ID, staleAnnotation]]) });

    // Watcher 'unlink' → processDeletedWatchedFiles → removeImagesByPaths → removeImages.
    useImageStore.getState().removeImages([IMAGE_ID]);

    // Annotation must be gone from the store AND persisted-deleted.
    expect(useImageStore.getState().annotations.has(IMAGE_ID)).toBe(false);
    expect((await import('../services/imageAnnotationsStorage')).deleteAnnotation).toHaveBeenCalledWith(IMAGE_ID);

    // Later the same path re-appears ('add') — full watch round, fresh gates.
    await runWatchRound('new-image.png');

    expect(taggingImageIds()).toContain(IMAGE_ID);
    expect(semanticIndexedIds()).toContain(IMAGE_ID);
  });

  it('NEGATIVE CONTROL: a stale annotation left in place is detected by prompt-hash reconciliation', async () => {
    // The original bug: nothing called deleteAnnotation, so the re-added file
    // inherited the stamps and both AI phases reported "no images need
    // enrichment" / "all images already indexed". The reconcile pass (added
    // with vector similarity) now detects the mismatch between the stale
    // stack hash and the re-added file's (prompt-less) content and re-opens
    // every prompt-derived gate.
    const staleAnnotation = {
      imageId: IMAGE_ID,
      isFavorite: false,
      tags: [],
      autoTags: ['old-file-tag'],
      metadataTags: [],
      isAutoTagged: true,
      searchTagVersion: 2,
      isSemanticIndexed: true,
      isStackAnalyzed: true,
      stackGroupId: 'old-stack-hash',
      similarityGroupId: 'old-sim-id',
      addedAt: Date.now(),
      updatedAt: Date.now(),
    };
    useImageStore.setState({ annotations: new Map([[IMAGE_ID, staleAnnotation]]) });

    await runWatchRound('new-image.png');

    // The prompt changed → the index text changed → the semantic gate
    // re-opens and the file re-enters the indexing pass (self-healed).
    expect(semanticIndexedIds()).toContain(IMAGE_ID);
    // Auto-tag stamps are not prompt-derived — reconciliation leaves them
    // alone, and the phase still reports nothing to do.
    expect(taggingImageIds()).not.toContain(IMAGE_ID);
  });
});
