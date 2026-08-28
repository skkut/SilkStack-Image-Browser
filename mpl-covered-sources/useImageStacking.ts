/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { useMemo } from 'react';
import { StackImage, ImageStack, StackSubGroup } from '../core/stacking-types';

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

// ── Sorting helpers ────────────────────────────────────────────────────

type StackItem = StackImage | ImageStack;

const getRepImage = (item: StackItem): StackImage =>
  'coverImage' in item ? item.coverImage : item;

/** Check if an item (stack or single image) has any favorited images. */
const isItemStarred = (item: StackItem): boolean => {
  if ('coverImage' in item) {
    // ImageStack: check all images in the stack, not just the cover
    return item.images.some(img => img.isFavorite);
  }
  // StackImage
  return item.isFavorite || false;
};

const compareById = (x: StackImage, y: StackImage) => x.id.localeCompare(y.id);

const compareByNameAsc = (x: StackImage, y: StackImage) => {
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

const sortItems = (
  items: StackItem[],
  sortOrder: 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random',
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
      const hashA = stringHash(imgA.id + seed.toString());
      const hashB = stringHash(imgB.id + seed.toString());
      if (hashA !== hashB) return hashA - hashB;
      return compareById(imgA, imgB);
    }
    return compareById(imgA, imgB);
  });
};

// ── Prompt resolution ──────────────────────────────────────────────────

function resolvePrompt(image: StackImage): string {
  return image.prompt
    || (image.metadata as any)?.normalizedMetadata?.prompt
    || (image.metadata as any)?.positive_prompt
    || '';
}

// ── Sub-group construction ─────────────────────────────────────────────

/** Build sub-groups within a set of images by exact prompt text. */
function buildSubGroups(images: StackImage[], displayStarredFirst: boolean): StackSubGroup[] {
  const byPrompt = new Map<string, StackImage[]>();

  for (const img of images) {
    const prompt = resolvePrompt(img);
    const key = prompt.toLowerCase().replace(/[\s\r\n]+/g, ' ').trim() || '(no prompt)';
    const group = byPrompt.get(key);
    if (group) {
      group.push(img);
    } else {
      byPrompt.set(key, [img]);
    }
  }

  // Build a set of starred image IDs for fast lookup in sub-group sorting
  const starredIds = new Set(images.filter(img => img.isFavorite).map(img => img.id));

  const subGroups: StackSubGroup[] = [];
  for (const [, sgImages] of byPrompt) {
    const sorted = [...sgImages].sort((a, b) => {
      // Starred images first within each sub-group
      if (displayStarredFirst) {
        if (a.isFavorite && !b.isFavorite) return -1;
        if (!a.isFavorite && b.isFavorite) return 1;
      }
      // Then by lastModified descending
      return (b.lastModified || 0) - (a.lastModified || 0);
    });
    const prompt = resolvePrompt(sorted[0]);
    subGroups.push({
      promptHash: simpleHash(prompt),
      prompt,
      imageIds: sorted.map(img => img.id),
      coverImageId: sorted[0].id,
      size: sorted.length,
    });
  }

  // Sort sub-groups: starred-containing first, then by size (largest first), then alphabetically
  subGroups.sort((a, b) => {
    if (displayStarredFirst) {
      const starA = a.imageIds.some(id => starredIds.has(id));
      const starB = b.imageIds.some(id => starredIds.has(id));
      if (starA && !starB) return -1;
      if (!starA && starB) return 1;
    }
    return b.size - a.size || a.prompt.localeCompare(b.prompt);
  });
  return subGroups;
}

// ── Grouping strategies ────────────────────────────────────────────────

/**
 * Group images by similarityGroupId or stackGroupId (fast, O(n)).
 * Used when annotations have been loaded and stackGroupId is available.
 */
function groupByAnnotation(images: StackImage[], displayStarredFirst: boolean): StackItem[] {
  const stackGroups = new Map<string, StackImage[]>();
  const ungrouped: StackImage[] = [];

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

// ── Store-agnostic hook ────────────────────────────────────────────────

export type SortOrder = 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random';

export interface UseImageStackingResult {
  stackedItems: (StackImage | ImageStack)[];
  isStackingEnabled: boolean;
}

/**
 * Group and sort images into stacks by annotation-based similarity.
 *
 * This is the store-agnostic version — all configuration is passed as
 * parameters rather than read from Zustand stores. Use the adapter in
 * the main app (`src/hooks/useImageStacking.ts`) for the zero-config
 * version that reads from stores automatically.
 */
export const useImageStacking = (
  images: StackImage[],
  isEnabled: boolean,
  sortOrder: SortOrder,
  displayStarredFirst: boolean,
  randomSeed: number
): UseImageStackingResult => {
  const stackedItems = useMemo(() => {
    if (!isEnabled || images.length === 0) {
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
  }, [images, isEnabled, sortOrder, displayStarredFirst, randomSeed]);

  return {
    stackedItems,
    isStackingEnabled: isEnabled,
  };
};
