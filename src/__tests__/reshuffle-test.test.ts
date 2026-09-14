import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import { useImageStore } from '../store/useImageStore';
import { type IndexedImage, type Directory } from '../types';

const createImage = (id: string, dirId = 'dir-1'): IndexedImage => ({
  id,
  name: `image-${id}`,
  handle: {} as any,
  metadata: { normalizedMetadata: { prompt: '', negativePrompt: '' } } as any,
  metadataString: '',
  lastModified: Date.now() + Math.random() * 100000,
  models: [],
  loras: [],
  scheduler: '',
  isFavorite: false,
  prompt: '',
  negativePrompt: '',
  directoryId: dirId,
} as any);

const createDirectory = (id: string, path: string): Directory => ({
  id,
  path,
  name: path.split('/').pop() || path,
  visible: true,
  isConnected: true,
  handle: {} as any,
});

vi.mock('../services/aiBridge', () => ({
  createStackingEngine: vi.fn().mockResolvedValue({
    generatePromptHash: (prompt: string) => `hash-${prompt}`,
    computeSimilarityGroupIds: vi.fn().mockResolvedValue({
      groupIdToSimId: new Map(),
    }),
    computePromptSimilarity: vi.fn().mockResolvedValue(0.9),
  }),
  // Mirrored — full-replacement mock; see src/services/aiBridge.ts.
  SIMILARITY_MATCH_THRESHOLD: 0.8,
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
}));

describe('Reshuffle Action', () => {
  beforeEach(() => {
    const directories = [createDirectory('dir-1', '/test/path')];
    useImageStore.setState({
      images: [],
      filteredImages: [],
      sortOrder: 'date-desc',
      annotations: new Map(),
      isAnnotationsLoaded: true,
      indexingState: 'idle',
      directories,
      selectedFolders: new Set(),
      excludedFolders: new Set(),
      randomSeed: Date.now(),
    });
  });

  it('should keep the same number of images after reshuffle', () => {
    const images = Array.from({ length: 20 }, (_, i) => createImage(`img-${i.toString().padStart(3, '0')}`));
    const directories = [createDirectory('dir-1', '/test/path')];

    // Set sortOrder to 'random' to trigger initial filterAndSort
    useImageStore.setState({
      images,
      directories,
      sortOrder: 'random',
    });

    const initialCount = useImageStore.getState().filteredImages.length;
    // The initial filteredImages might be empty (state was set directly without filterAndSort)
    // Call reshuffle which uses filterAndSort internally
    useImageStore.getState().reshuffle();
    const newCount = useImageStore.getState().filteredImages.length;

    // After reshuffle, all 20 images should still be present
    expect(newCount).toBe(20);
  });

  it('should change the order of images when reshuffled', async () => {
    const images = Array.from({ length: 20 }, (_, i) => createImage(`img-${i.toString().padStart(3, '0')}`));
    const directories = [createDirectory('dir-1', '/test/path')];

    useImageStore.setState({
      images,
      directories,
      sortOrder: 'random',
    });

    const initialOrder = useImageStore.getState().filteredImages.map(img => img.id);
    console.log('Initial order:', initialOrder.join(', '));

    // Small delay so Date.now() advances
    await new Promise(r => setTimeout(r, 5));

    useImageStore.getState().reshuffle();

    const newOrder = useImageStore.getState().filteredImages.map(img => img.id);
    console.log('After reshuffle:', newOrder.join(', '));
    console.log('Seed:', useImageStore.getState().randomSeed);

    const isDifferent = initialOrder.join(',') !== newOrder.join(',');
    expect(isDifferent).toBe(true);
  });

  it('should produce different orders on consecutive reshuffles', async () => {
    const images = Array.from({ length: 20 }, (_, i) => createImage(`test-img-${i}`));
    const directories = [createDirectory('dir-1', '/test/path')];

    useImageStore.setState({
      images,
      directories,
      sortOrder: 'random',
    });

    const orders: string[][] = [];
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 5));
      useImageStore.getState().reshuffle();
      orders.push(useImageStore.getState().filteredImages.map(img => img.id));
    }

    const uniqueOrders = new Set(orders.map(o => o.join(',')));
    console.log(`Got ${uniqueOrders.size} unique orders out of ${orders.length} reshuffles`);
    expect(uniqueOrders.size).toBeGreaterThan(1);
  });
});
