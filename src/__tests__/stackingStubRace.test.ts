// @vitest-environment jsdom
//
// Regression tests for the "stack never comes back" bug.
//
// Cause: the stacking pipeline could run while the store still held Phase A
// catalog stubs — images whose metadata (and therefore prompt) had not been
// read yet. `syncNewImagesToStacks` stamped those stubs `isStackAnalyzed: true`
// with no `stackGroupId`, a shape indistinguishable from a MANUAL unmerge, so
// every later pass skipped them forever — even after a restart, even though
// their prompts were identical.
//
// The fix has two halves, both pinned here:
//   1. No pass judges a catalog stub (no prompt yet).
//   2. The manual-unmerge guard is keyed on the explicit marker the unmerge
//      writes (`isSimilarityAnalyzed: false`), so a stamp written before
//      enrichment is repaired once the prompt exists.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../services/aiBridge', () => ({
  createStackingEngine: vi.fn().mockResolvedValue({
    generatePromptHash: (prompt: string) => `hash-${prompt}`,
    computeSimilarityGroupIds: vi.fn().mockResolvedValue({
      groupIdToSimId: new Map([['hash-test', 'sim-hash-test']]),
    }),
    computePromptSimilarity: vi.fn().mockResolvedValue(0.9),
  }),
  SEARCH_ENRICHMENT_VERSION: 2,
  TAG_GENERATION_MODEL_ID: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
  SIMILARITY_MATCH_THRESHOLD: 0.8,
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
  deleteAnnotation: vi.fn().mockResolvedValue(undefined),
  rekeyAnnotations: vi.fn().mockResolvedValue(0),
}));

vi.mock('../services/aiFeatureAccess', () => ({
  isAiFeaturesEnabled: vi.fn(() => true),
  isAiMasterEnabled: vi.fn(() => true),
  // Model-backed phases (auto-tag / semantic) stay off: the full pipeline
  // round is exercised below, and it must not try to load the AI module.
  isAiModelFeaturesEnabled: vi.fn(() => false),
  isSemanticSearchEnabled: vi.fn(() => false),
}));

import { useImageStore, runPipelineRound } from '../store/useImageStore';
import { bulkSaveAnnotations } from '../services/imageAnnotationsStorage';
import type { ImageAnnotations, IndexedImage } from '../types';

const IMAGE_ID = 'C:/lib::stacked.webp';

const image = (overrides: Partial<IndexedImage> = {}): IndexedImage => ({
  id: IMAGE_ID,
  name: 'stacked.webp',
  handle: {} as FileSystemFileHandle,
  metadata: { normalizedMetadata: { prompt: 'a red fox', negativePrompt: '' } } as any,
  metadataString: '',
  lastModified: Date.now(),
  models: [],
  loras: [],
  scheduler: '',
  prompt: 'a red fox',
  enrichmentState: 'enriched',
  ...overrides,
});

/** The shape syncNewImagesToStacks wrote for an un-enriched image. */
const prematureStamp = (): ImageAnnotations => ({
  imageId: IMAGE_ID,
  isFavorite: false,
  tags: [],
  autoTags: [],
  metadataTags: [],
  isStackAnalyzed: true,
  addedAt: 1000,
  updatedAt: 1000,
  // NOTE: no stackGroupId and — the marker that matters — no
  // isSimilarityAnalyzed key at all.
});

/** The shape unmergeImagesFromStack writes. */
const manualUnstack = (): ImageAnnotations => ({
  ...prematureStamp(),
  similarityGroupId: undefined,
  isSimilarityAnalyzed: false,
});

const seed = (imgs: IndexedImage[], annotations: Map<string, ImageAnnotations>) => {
  useImageStore.setState({
    images: imgs,
    filteredImages: imgs,
    annotations,
    isAnnotationsLoaded: true,
    indexingState: 'idle',
    directories: [],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
  });
  vi.mocked(bulkSaveAnnotations).mockClear();
};

beforeEach(() => {
  // Drain debounced queues left by a previous test before reseeding.
  useImageStore.getState().flushPendingImages();
  useImageStore.getState().flushPendingMerges();
  seed([], new Map());
});

describe('syncNewImagesToStacks — never stamps an un-enriched image', () => {
  it('leaves a Phase A catalog stub untouched', async () => {
    // A stub has no prompt because its metadata has not been read yet.
    const stub = image({
      enrichmentState: 'catalog',
      prompt: undefined,
      metadata: undefined,
    });
    seed([stub], new Map());

    await useImageStore.getState().syncNewImagesToStacks();

    expect(useImageStore.getState().annotations.get(IMAGE_ID)).toBeUndefined();
    expect(bulkSaveAnnotations).not.toHaveBeenCalled();
  });

  it('stacks the same image once enrichment has produced a prompt', async () => {
    const enriched = image({ enrichmentState: 'enriched', prompt: 'a red fox' });
    seed([enriched], new Map());

    await useImageStore.getState().syncNewImagesToStacks();

    const ann = useImageStore.getState().annotations.get(IMAGE_ID);
    expect(ann?.stackGroupId).toBe('hash-a red fox');
    expect(ann?.isStackAnalyzed).toBe(true);
  });
});

describe('reconcilePromptHashes — repairs a premature stamp, respects a manual one', () => {
  it('repairs the stamp written before enrichment once a prompt exists', async () => {
    seed([image()], new Map([[IMAGE_ID, prematureStamp()]]));

    await useImageStore.getState().reconcilePromptHashes();

    const ann = useImageStore.getState().annotations.get(IMAGE_ID)!;
    expect(ann.stackGroupId).toBe('hash-a red fox');
    expect(ann.isStackAnalyzed).toBe(true);
    // A repaired group re-clusters and re-embeds (prompt-derived state).
    expect(ann.isSimilarityAnalyzed).toBe(false);
    expect(ann.isSemanticIndexed).toBe(false);
    expect(bulkSaveAnnotations).toHaveBeenCalledWith([
      expect.objectContaining({ imageId: IMAGE_ID, stackGroupId: 'hash-a red fox' }),
    ]);
  });

  it('still respects a manual unmerge (isSimilarityAnalyzed: false)', async () => {
    seed([image()], new Map([[IMAGE_ID, manualUnstack()]]));

    await useImageStore.getState().reconcilePromptHashes();

    const ann = useImageStore.getState().annotations.get(IMAGE_ID)!;
    expect(ann.stackGroupId).toBeUndefined();
    expect(ann.isSimilarityAnalyzed).toBe(false);
    expect(bulkSaveAnnotations).not.toHaveBeenCalled();
  });

  it('never judges a catalog stub, even one carrying an existing hash', async () => {
    // Cold-start shape: the store was cleared and Phase A re-added stubs
    // while the annotation kept its group id. Clearing it here would
    // permanently unstack a stack that is about to be fully indexed.
    const stub = image({ enrichmentState: 'catalog', prompt: undefined, metadata: undefined });
    seed([stub], new Map([[
      IMAGE_ID,
      { ...prematureStamp(), stackGroupId: 'group1', isSimilarityAnalyzed: true },
    ]]));

    await useImageStore.getState().reconcilePromptHashes();

    const ann = useImageStore.getState().annotations.get(IMAGE_ID)!;
    expect(ann.stackGroupId).toBe('group1');
    expect(ann.isSimilarityAnalyzed).toBe(true);
    expect(bulkSaveAnnotations).not.toHaveBeenCalled();
  });

  it('does not churn a genuinely prompt-less enriched image', async () => {
    const noPrompt = image({ prompt: undefined, metadata: undefined });
    seed([noPrompt], new Map([[IMAGE_ID, prematureStamp()]]));

    await useImageStore.getState().reconcilePromptHashes();

    expect(bulkSaveAnnotations).not.toHaveBeenCalled();
  });
});

describe('runPipelineRound — flushes queued enrichment before judging images', () => {
  it('stacks an image whose Phase B result is still sitting in the merge queue', async () => {
    // The store holds the Phase A stub; the enriched version has arrived from
    // Phase B but mergeImages only QUEUES it (debounced). The round must pull
    // it in before Phase 1, or the stub is skipped and nothing ever stacks it.
    const stub = image({ enrichmentState: 'catalog', prompt: undefined, metadata: undefined });
    seed([stub], new Map());
    useImageStore.getState().mergeImages([image({ enrichmentState: 'enriched', prompt: 'a red fox' })]);

    await runPipelineRound();

    const state = useImageStore.getState();
    // The enriched fields really landed before the pass ran.
    expect(state.images[0].enrichmentState).toBe('enriched');
    expect(state.images[0].prompt).toBe('a red fox');
    const ann = state.annotations.get(IMAGE_ID);
    expect(ann?.stackGroupId).toBe('hash-a red fox');
    expect(ann?.isStackAnalyzed).toBe(true);
  });
});

describe('computeSimilarityGroups — same stub and repair rules', () => {
  it('skips a catalog stub entirely', async () => {
    const stub = image({ enrichmentState: 'catalog', prompt: undefined, metadata: undefined });
    seed([stub], new Map());

    await useImageStore.getState().computeSimilarityGroups();

    expect(useImageStore.getState().annotations.get(IMAGE_ID)).toBeUndefined();
    expect(bulkSaveAnnotations).not.toHaveBeenCalled();
  });

  it('repairs a premature stamp once a prompt exists', async () => {
    seed([image()], new Map([[IMAGE_ID, prematureStamp()]]));

    await useImageStore.getState().computeSimilarityGroups();

    const ann = useImageStore.getState().annotations.get(IMAGE_ID)!;
    expect(ann.stackGroupId).toBe('hash-a red fox');
    expect(ann.isStackAnalyzed).toBe(true);
  });

  it('never re-stacks a manual unmerge', async () => {
    seed([image()], new Map([[IMAGE_ID, manualUnstack()]]));

    await useImageStore.getState().computeSimilarityGroups();

    const ann = useImageStore.getState().annotations.get(IMAGE_ID)!;
    expect(ann.stackGroupId).toBeUndefined();
    expect(ann.isSimilarityAnalyzed).toBe(false);
  });
});
