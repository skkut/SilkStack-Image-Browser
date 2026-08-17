import { useMemo } from 'react';
import { IndexedImage, ImageStack, StackSubGroup, StackGroupByDimension, LoRAInfo } from '../types';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAiFeaturesEnabled } from '../services/aiFeatureAccess';

// ── Simple hash for sub-group display keys ──────────────────────────────
// Used only as React key identifiers for StackSubGroup objects in the UI.
// Does not need to match the FNV-1a hash from the stacking engine —
// these hashes are display-only, not computational.
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

interface UseImageStackingResult {
  stackedItems: (IndexedImage | ImageStack)[];
  isStackingEnabled: boolean;
}

// ── Sorting helpers ────────────────────────────────────────────────────

type StackItem = IndexedImage | ImageStack;

const getRepImage = (item: StackItem): IndexedImage =>
  'coverImage' in item ? item.coverImage : item;

/** Check if an item (stack or single image) has any favorited images. */
const isItemStarred = (item: StackItem): boolean => {
  if ('coverImage' in item) {
    // ImageStack: check all images in the stack, not just the cover
    return item.images.some(img => img.isFavorite);
  }
  // IndexedImage
  return item.isFavorite || false;
};

const compareById = (x: IndexedImage, y: IndexedImage) => x.id.localeCompare(y.id);

const compareByNameAsc = (x: IndexedImage, y: IndexedImage) => {
  const c = (x.name || '').localeCompare(y.name || '');
  return c !== 0 ? c : compareById(x, y);
};

// Simple string hash function (mirrors filterAndSort in useImageStore)
const stringHash = (str: string) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
};

// Hash with seed mixed in non-linearly at each step.
// DJB2 is purely linear — appending/prepending the seed doesn't change relative
// ordering for same-length IDs. XOR-ing the seed into each iteration makes the
// hash non-separable so different seeds actually reorder the images.
const hashWithSeed = (str: string, seed: number): number => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = (hash ^ seed) | 0;
  }
  return hash;
};

const sortItems = (
  items: StackItem[],
  sortOrder: 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random' | 'relevance',
  displayStarredFirst: boolean,
  randomSeed?: number
): StackItem[] => {
  return [...items].sort((a, b) => {
    const imgA = getRepImage(a);
    const imgB = getRepImage(b);

    if (displayStarredFirst) {
      const favA = isItemStarred(a);
      const favB = isItemStarred(b);
      if (favA && !favB) return -1;
      if (!favA && favB) return 1;
    }

    if (sortOrder === 'asc') return compareByNameAsc(imgA, imgB);
    if (sortOrder === 'desc') {
      const c = (imgB.name || '').localeCompare(imgA.name || '');
      return c !== 0 ? c : compareById(imgA, imgB);
    }
    if (sortOrder === 'date-asc') {
      const c = (imgA.lastModified || 0) - (imgB.lastModified || 0);
      return c !== 0 ? c : compareByNameAsc(imgA, imgB);
    }
    if (sortOrder === 'date-desc') {
      const c = (imgB.lastModified || 0) - (imgA.lastModified || 0);
      return c !== 0 ? c : compareByNameAsc(imgA, imgB);
    }
    if (sortOrder === 'random') {
      const seed = randomSeed || 0;
      const hashA = hashWithSeed(imgA.id, seed);
      const hashB = hashWithSeed(imgB.id, seed);
      if (hashA !== hashB) return hashA - hashB;
      return compareById(imgA, imgB);
    }
    // 'relevance' (semantic-only) never reaches the stack grid with hits on
    // screen — the stack view shows the whole library, so fall back like the
    // main chain does: newest first.
    if (sortOrder === 'relevance') {
      const c = (imgB.lastModified || 0) - (imgA.lastModified || 0);
      return c !== 0 ? c : compareByNameAsc(imgA, imgB);
    }
    return compareById(imgA, imgB);
  });
};

// ── Dimension resolvers ────────────────────────────────────────────────

function resolvePrompt(image: IndexedImage): string {
  return image.prompt
    || image.metadata?.normalizedMetadata?.prompt
    || image.metadata?.positive_prompt
    || '';
}

function resolveModel(image: IndexedImage): string {
  return image.models?.[0]
    || image.metadata?.normalizedMetadata?.model
    || (image.metadata as any)?.model
    || '';
}

function resolveLoras(image: IndexedImage): string {
  const loras: (string | LoRAInfo)[] = image.loras
    || image.metadata?.normalizedMetadata?.loras
    || (image.metadata as any)?.loras
    || [];
  if (!loras.length) return '';
  return loras
    .map(l => typeof l === 'string' ? l : (l.name || l.model_name || ''))
    .filter(Boolean)
    .sort()
    .join(', ');
}

// ── Sub-group construction ─────────────────────────────────────────────

/**
 * Delimiter used in compound grouping keys. Must not appear in model names,
 * prompt text, or LoRA identifiers.
 */
const KEY_DELIMITER = '|||';

/**
 * Build a compound grouping key from the selected dimensions.
 * Each dimension contributes its normalized value; empty values fall back
 * to a sentinel so images with missing metadata still group together.
 */
function buildGroupKey(image: IndexedImage, dimensions: StackGroupByDimension[]): string {
  return dimensions.map(dim => {
    switch (dim) {
      case 'model': {
        const val = resolveModel(image);
        return val.toLowerCase().trim() || '(no model)';
      }
      case 'prompt': {
        const val = resolvePrompt(image);
        return val.toLowerCase().replace(/[\s\r\n]+/g, ' ').trim() || '(no prompt)';
      }
      case 'loras': {
        const val = resolveLoras(image);
        return val.toLowerCase().replace(/[\s\r\n]+/g, ' ').trim() || '(no loras)';
      }
      default:
        return '';
    }
  }).join(KEY_DELIMITER);
}

/**
 * Build a human-readable label from the selected dimensions for a
 * representative image in a sub-group.
 *
 * For a single dimension the value is returned directly (the heading already
 * identifies the dimension). For multiple dimensions each value is prefixed
 * with its dimension name on its own line, so it's clear which value belongs
 * to which dimension.
 */
function buildGroupLabel(image: IndexedImage, dimensions: StackGroupByDimension[]): string {
  if (dimensions.length === 0) return 'All images';

  if (dimensions.length === 1) {
    // Single dimension — heading already identifies it, just return the value.
    const dim = dimensions[0];
    switch (dim) {
      case 'model':   return resolveModel(image).trim() || '(no model)';
      case 'prompt':  return resolvePrompt(image).trim() || '(no prompt)';
      case 'loras':   return resolveLoras(image).trim() || '(no loras)';
      default:        return '';
    }
  }

  // Multiple dimensions — label each value with its dimension on a separate line.
  const pairs = dimensions.map(dim => {
    switch (dim) {
      case 'model':
        return `Model: ${resolveModel(image).trim() || '(no model)'}`;
      case 'prompt':
        return `Prompt: ${resolvePrompt(image).trim() || '(no prompt)'}`;
      case 'loras':
        return `Loras: ${resolveLoras(image).trim() || '(no loras)'}`;
      default:
        return '';
    }
  }).filter(Boolean);

  return pairs.join('\n');
}

/**
 * Build sub-groups within a set of images, grouped by the given dimensions.
 *
 * When `dimensions` is `['prompt']` (the default), behaviour is identical to
 * the original prompt-only grouping. Pass `['model']`, `['loras']`, or any
 * combination like `['model', 'prompt']` for compound grouping.
 */
function buildSubGroups(
  images: IndexedImage[],
  displayStarredFirst: boolean,
  dimensions: StackGroupByDimension[] = ['prompt'],
): StackSubGroup[] {
  // When no dimensions are selected, collapse everything into a single group.
  if (dimensions.length === 0) {
    const sorted = [...images].sort((a, b) => {
      if (displayStarredFirst) {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
      }
      return (b.lastModified || 0) - (a.lastModified || 0);
    });
    return [{
      promptHash: simpleHash('__all__'),
      prompt: '',
      label: '',
      groupKey: '__all__',
      dimensions: [],  // Empty array = no grouping; signals flat grid display
      imageIds: sorted.map(img => img.id),
      coverImageId: sorted[0]?.id || '',
      size: sorted.length,
    }];
  }

  const byKey = new Map<string, IndexedImage[]>();

  for (const img of images) {
    const key = buildGroupKey(img, dimensions);
    const group = byKey.get(key);
    if (group) {
      group.push(img);
    } else {
      byKey.set(key, [img]);
    }
  }

  // Build a set of starred image IDs for fast lookup in sub-group sorting
  const starredIds = new Set(images.filter(img => img.isFavorite).map(img => img.id));

  interface SubGroupWithDate {
    sg: StackSubGroup;
    maxLastModified: number;
  }

  const subGroupItems: SubGroupWithDate[] = [];

  for (const [groupKey, sgImages] of byKey) {
    const sorted = [...sgImages].sort((a, b) => {
      // Starred images first within each sub-group
      if (displayStarredFirst) {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
      }
      // Then by lastModified descending
      return (b.lastModified || 0) - (a.lastModified || 0);
    });
    const repImage = sorted[0];
    const label = buildGroupLabel(repImage, dimensions);
    // Set prompt to the label so the external SimilarityStackExpandedView
    // component displays the correct header regardless of grouping dimensions.
    const prompt = label;
    const maxLastModified = sgImages.reduce((max, img) => Math.max(max, img.lastModified || 0), 0);

    // Build structured dimension data for separate heading display.
    const dimensionData = dimensions.length > 0 ? dimensions.map(dim => {
      switch (dim) {
        case 'model':
          return { label: 'Model', value: resolveModel(repImage).trim() || '(no model)' };
        case 'prompt':
          return { label: 'Prompt', value: resolvePrompt(repImage).trim() || '(no prompt)' };
        case 'loras':
          return { label: 'Loras', value: resolveLoras(repImage).trim() || '(no loras)' };
        default:
          return { label: dim, value: '' };
      }
    }) : undefined;

    subGroupItems.push({
      sg: {
        promptHash: simpleHash(groupKey),
        prompt,
        label,
        groupKey,
        dimensions: dimensionData,
        imageIds: sorted.map(img => img.id),
        coverImageId: repImage.id,
        size: sorted.length,
      },
      maxLastModified,
    });
  }

  // Sort sub-groups: starred-containing first, then by the latest image's date descending, then size, then alphabetically by label
  subGroupItems.sort((a, b) => {
    if (displayStarredFirst) {
      const starA = a.sg.imageIds.some(id => starredIds.has(id));
      const starB = b.sg.imageIds.some(id => starredIds.has(id));
      if (starA && !starB) return -1;
      if (!starA && starB) return 1;
    }
    // Newest image first
    if (b.maxLastModified !== a.maxLastModified) {
      return b.maxLastModified - a.maxLastModified;
    }
    return b.sg.size - a.sg.size || a.sg.label.localeCompare(b.sg.label);
  });

  return subGroupItems.map(item => item.sg);
}

// Re-export for use in expanded-view wrappers that need to recompute
// sub-groups when the user changes grouping dimensions at drill-down time.
export { buildSubGroups, resolvePrompt, resolveModel, resolveLoras };

// ── Grouping strategies ────────────────────────────────────────────────

/**
 * Group images by similarityGroupId or stackGroupId (fast, O(n)).
 * Used when annotations have been loaded and stackGroupId is available.
 */
function groupByAnnotation(images: IndexedImage[], displayStarredFirst: boolean): StackItem[] {
  const stackGroups = new Map<string, IndexedImage[]>();
  const ungrouped: IndexedImage[] = [];

  for (const img of images) {
    const key = img.similarityGroupId || img.stackGroupId;
    if (key) {
      const group = stackGroups.get(key);
      if (group) {
        group.push(img);
      } else {
        stackGroups.set(key, [img]);
      }
    } else {
      ungrouped.push(img);
    }
  }

  const result: StackItem[] = [];

  for (const [, groupImages] of stackGroups) {
    const sorted = [...groupImages].sort((a, b) => {
      // When starred-first is enabled, favorited images come first within the stack
      if (displayStarredFirst) {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
      }
      // Then by lastModified descending (newest first)
      return (b.lastModified || 0) - (a.lastModified || 0);
    });

    if (sorted.length === 1) {
      result.push(sorted[0]);
    } else {
      const subGroups = buildSubGroups(sorted, displayStarredFirst);

      result.push({
        id: `stack-${sorted[0].id}`,
        coverImage: sorted[0],
        images: sorted,
        count: sorted.length,
        subGroups,
        basePrompt: subGroups[0]?.prompt || '',
      });
    }
  }

  result.push(...ungrouped);
  return result;
}

// ── Hook ───────────────────────────────────────────────────────────────

export const useImageStacking = (
  images: IndexedImage[],
  isEnabled: boolean
): UseImageStackingResult => {
  const sortOrder = useImageStore((state) => state.sortOrder);
  const randomSeed = useImageStore((state) => state.randomSeed);
  const displayStarredFirst = useSettingsStore((state) => state.displayStarredFirst);

  // Premium gate: stacking (grid grouping into ImageStack items) is a
  // premium feature. Without an active license no stacks are constructed,
  // so no stack UI can appear in the library grid.
  const aiFeaturesEnabled = useAiFeaturesEnabled();

  const stackedItems = useMemo(() => {
    if (!isEnabled || !aiFeaturesEnabled || images.length === 0) {
      return images;
    }

    // When stacking is enabled, group by annotation fields (stackGroupId /
    // similarityGroupId). These are populated by the store actions only when
    // the ai-intelligence stacking engine is available. If no annotations
    // exist yet, return ungrouped images — the engine will process them.
    const hasAnnotations = images.some(img => img.stackGroupId !== undefined);

    const items = hasAnnotations
      ? groupByAnnotation(images, displayStarredFirst)
      : images;

    return sortItems(items, sortOrder, displayStarredFirst, randomSeed);
  }, [images, isEnabled, aiFeaturesEnabled, sortOrder, displayStarredFirst, randomSeed]);

  return {
    stackedItems,
    isStackingEnabled: isEnabled,
  };
};
