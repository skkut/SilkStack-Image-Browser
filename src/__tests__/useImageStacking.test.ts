import { describe, expect, it, vi, beforeEach } from 'vitest';

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

import { renderHook } from '@testing-library/react';
import { useImageStacking } from '../hooks/useImageStacking';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';
import { type IndexedImage } from '../types';

const createImage = (overrides: Partial<IndexedImage>): IndexedImage => ({
  id: overrides.id || 'id',
  name: overrides.name || 'name',
  handle: {} as FileSystemFileHandle,
  metadata: {
    normalizedMetadata: {
      prompt: overrides.prompt || '',
      negativePrompt: overrides.negativePrompt || '',
    }
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
  ...overrides,
});

// This suite exercises the real closed-source stacking engine end to end
// (no module mock). In the no-module CI path (VITE_AI_FEATURES_AVAILABLE
// false) the stacking engine is absent by design, so the suite is skipped.
describe.skipIf(!import.meta.env.VITE_AI_FEATURES_AVAILABLE)('useImageStacking Hook', () => {
  // Stacking is premium-gated: the hook must see an active license to group.
  beforeEach(() => {
    useSettingsStore.setState({
      licenseStatus: 'valid',
      licenseKey: 'TEST-KEY',
      licenseLastValidated: Date.now(),
      licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', Date.now()),
    });
  });

  it('does NOT group images without a premium license (feature locked)', () => {
    useSettingsStore.setState({ licenseStatus: 'unchecked' });
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'A beautiful cat', lastModified: 1000, stackGroupId: 'cat-hash' }),
      createImage({ id: '2', prompt: 'A beautiful cat', lastModified: 800, stackGroupId: 'cat-hash' }),
      createImage({ id: '3', prompt: 'A beautiful dog', lastModified: 700, stackGroupId: 'dog-hash' }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    // Even though stacking is enabled AND annotations exist, no stacks
    // may be constructed — every image stays a flat singleton.
    expect(stacked).toHaveLength(3);
    for (const item of stacked) {
      expect('coverImage' in item).toBe(false);
    }
  });

  it('groups images by stackGroupId annotation field into stacks', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // 'cat-hash' groupId on 3 images, 'dog-hash' on 1 image, no groupId on 1 image
    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'A beautiful cat', lastModified: 1000, stackGroupId: 'cat-hash' }),
      createImage({ id: '2', prompt: 'A beautiful dog', lastModified: 900, stackGroupId: 'dog-hash' }),
      createImage({ id: '3', prompt: 'A beautiful cat', lastModified: 800, stackGroupId: 'cat-hash' }),
      createImage({ id: '4', prompt: 'A beautiful cat', lastModified: 700, stackGroupId: 'cat-hash' }),
      createImage({ id: '5', prompt: '', stackGroupId: undefined }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    // 1 stack (cat, 3 images) + 2 singletons (dog, no-prompt) = 3 items
    expect(stacked.length).toBe(3);

    const catStack = stacked.find(item => 'coverImage' in item) as any;
    expect(catStack).toBeDefined();
    expect(catStack.images.length).toBe(3);
    expect(catStack.images.map((img: any) => img.id)).toEqual(['1', '3', '4']);
    expect(catStack.coverImage.id).toBe('1'); // Latest image is cover

    const dog = stacked.find(item => (item as IndexedImage).id === '2');
    expect(dog).toBeDefined();
    expect('coverImage' in (dog as any)).toBe(false); // Singleton, not stack
  });

  it('treats images without stackGroupId as singletons', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // Different prompts so the exact-prompt fallback does not group them
    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'A beautiful cat', lastModified: 1000 }),
      createImage({ id: '2', prompt: 'A playful dog', lastModified: 800 }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    // Both have no stackGroupId → both are singletons
    expect(stacked.length).toBe(2);
    expect('coverImage' in (stacked[0] as any)).toBe(false);
    expect('coverImage' in (stacked[1] as any)).toBe(false);
  });

  it('excludes images not in the visible set from stacks', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // Image '5' has cat-hash but is NOT in the visible images array
    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'A beautiful cat', lastModified: 1000, stackGroupId: 'cat-hash' }),
      createImage({ id: '2', prompt: 'A beautiful dog', lastModified: 900, stackGroupId: 'dog-hash' }),
      createImage({ id: '3', prompt: 'A beautiful cat', lastModified: 800, stackGroupId: 'cat-hash' }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    // cat stack should contain only 2 visible images
    const catStack = stacked.find(item => 'coverImage' in item) as any;
    expect(catStack).toBeDefined();
    expect(catStack.images.length).toBe(2);
    expect(catStack.images.map((img: any) => img.id)).toEqual(['1', '3']);

    // dog is a singleton
    const dog = stacked.find(item => (item as IndexedImage).id === '2');
    expect(dog).toBeDefined();
  });

  it('places starred images/stacks first when displayStarredFirst is enabled', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: true });

    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'Prompt A', isFavorite: false, lastModified: 1000, stackGroupId: 'hash-a' }),
      createImage({ id: '2', prompt: 'Prompt B', isFavorite: true, lastModified: 900, stackGroupId: 'hash-b' }),
      createImage({ id: '3', prompt: 'Prompt A', isFavorite: false, lastModified: 800, stackGroupId: 'hash-a' }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    // Expected: Starred Prompt B first, then stack for Prompt A
    expect(stacked.length).toBe(2);

    // First item is single starred image
    expect((stacked[0] as IndexedImage).id).toBe('2');

    // Second item is the Prompt A stack
    const stackA = stacked[1] as any;
    expect(stackA.coverImage.id).toBe('1');
    expect(stackA.images.length).toBe(2);
  });

  it('creates subGroups for stacks with images from similar prompts', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // Three images: two similar cat prompts (same stackGroupId = already merged
    // by syncNewImagesToStacks), one different dog prompt
    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'a cat sitting on a chair', lastModified: 1000, stackGroupId: 'sim-group-1' }),
      createImage({ id: '2', prompt: 'a cat sleeping on a chair', lastModified: 900, stackGroupId: 'sim-group-1' }),
      createImage({ id: '3', prompt: 'a cat sitting on a chair', lastModified: 800, stackGroupId: 'sim-group-1' }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    // All three share the same stackGroupId → one stack
    expect(stacked.length).toBe(1);

    const stack = stacked[0] as any;
    expect(stack.coverImage).toBeDefined();
    expect(stack.images.length).toBe(3);
    expect(stack.count).toBe(3);

    // Should have subGroups since images have different exact prompts
    expect(stack.subGroups).toBeDefined();
    expect(stack.subGroups.length).toBe(2); // "a cat sitting on a chair" and "a cat sleeping on a chair"

    // Sub-groups should be sorted by size (largest first)
    expect(stack.subGroups[0].prompt).toBe('a cat sitting on a chair');
    expect(stack.subGroups[0].size).toBe(2);
    expect(stack.subGroups[0].imageIds).toEqual(['1', '3']);

    expect(stack.subGroups[1].prompt).toBe('a cat sleeping on a chair');
    expect(stack.subGroups[1].size).toBe(1);
    expect(stack.subGroups[1].imageIds).toEqual(['2']);

    // basePrompt should be set
    expect(stack.basePrompt).toBe('a cat sitting on a chair');
  });

  it('groups by similarityGroupId when available (post-computation)', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // Two different stackGroupIds merged into one similarityGroupId
    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'a cat sitting', lastModified: 1000, stackGroupId: 'hash-cat-sit', similarityGroupId: 'hash-cat-sit' }),
      createImage({ id: '2', prompt: 'a cat sleeping', lastModified: 900, stackGroupId: 'hash-cat-sleep', similarityGroupId: 'hash-cat-sit' }),
      createImage({ id: '3', prompt: 'a dog running', lastModified: 800, stackGroupId: 'hash-dog', similarityGroupId: 'hash-dog' }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    // Two similarity groups: cat (2 images) and dog (1 image = singleton)
    expect(stacked.length).toBe(2);

    // First should be the cat stack (2 images from different stackGroupIds merged)
    const catStack = stacked.find(item => 'coverImage' in item && (item as any).count === 2) as any;
    expect(catStack).toBeDefined();
    expect(catStack.images.length).toBe(2);
    expect(catStack.subGroups).toBeDefined();
    expect(catStack.subGroups.length).toBe(2); // Two distinct prompts
    expect(catStack.subGroups[0].prompt).toBe('a cat sitting');
    expect(catStack.subGroups[1].prompt).toBe('a cat sleeping');
  });

  it('includes subGroups even for single-prompt stacks', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // All images have the exact same prompt
    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'a cat', lastModified: 1000, stackGroupId: 'cat-hash' }),
      createImage({ id: '2', prompt: 'a cat', lastModified: 900, stackGroupId: 'cat-hash' }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    expect(stacked.length).toBe(1);

    const stack = stacked[0] as any;
    expect(stack.images.length).toBe(2);

    // Even a single-prompt stack gets subGroups (so the prompt is always displayed)
    expect(stack.subGroups).toBeDefined();
    expect(stack.subGroups.length).toBe(1);
    expect(stack.subGroups[0].prompt).toBe('a cat');
    expect(stack.subGroups[0].size).toBe(2);
  });

  it('sorts subGroups by the latest image lastModified date descending', () => {
    useImageStore.setState({ sortOrder: 'date-desc' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // Group 1: prompt "Prompt A", size 3, newest image has lastModified: 500
    // Group 2: prompt "Prompt B", size 1, newest image has lastModified: 1000
    const images: IndexedImage[] = [
      createImage({ id: '1', prompt: 'Prompt A', lastModified: 500, stackGroupId: 'sim-group-1' }),
      createImage({ id: '2', prompt: 'Prompt A', lastModified: 400, stackGroupId: 'sim-group-1' }),
      createImage({ id: '3', prompt: 'Prompt A', lastModified: 300, stackGroupId: 'sim-group-1' }),
      createImage({ id: '4', prompt: 'Prompt B', lastModified: 1000, stackGroupId: 'sim-group-1' }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    expect(stacked.length).toBe(1);

    const stack = stacked[0] as any;
    expect(stack.subGroups).toBeDefined();
    expect(stack.subGroups.length).toBe(2);

    // Group B contains the latest image (lastModified: 1000) vs Group A (lastModified: 500)
    // So Group B (Prompt B) must be first, despite having a smaller size (1) than Group A (3)
    expect(stack.subGroups[0].prompt).toBe('Prompt B');
    expect(stack.subGroups[0].size).toBe(1);
    expect(stack.subGroups[1].prompt).toBe('Prompt A');
    expect(stack.subGroups[1].size).toBe(3);
  });

  it('preserves the incoming (semantic score) order when sortOrder is relevance', () => {
    useImageStore.setState({ sortOrder: 'relevance' });
    useSettingsStore.setState({ displayStarredFirst: false });

    // This is the order the store's semantic merge delivered (score order):
    // '2' first even though it is neither the newest (id '1', 1000), the
    // earliest, nor alphabetically first — date, name, and id sorts would
    // each reorder it differently, so a pass proves 'relevance' really
    // keeps the incoming order rather than coincidentally matching.
    const images: IndexedImage[] = [
      createImage({ id: '2', prompt: 'A playful dog', lastModified: 500 }),
      createImage({ id: '1', prompt: 'A beautiful cat', lastModified: 1000 }),
      createImage({ id: '3', prompt: 'A snowy mountain', lastModified: 700 }),
    ];

    const { result } = renderHook(() => useImageStacking(images, true));
    const stacked = result.current.stackedItems;

    expect(stacked.map((item: any) => item.id)).toEqual(['2', '1', '3']);
  });
});
