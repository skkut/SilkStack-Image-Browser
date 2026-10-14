import type { IndexedImage, ImageAnnotations } from '../types';

/**
 * The grouping key every stack member shares — the ONE expression that
 * decides stack membership across the whole app.
 *
 * Used by:
 *  - `groupByAnnotation` (useImageStacking) — builds the stacks themselves
 *  - `ImageStack.id` / `ImageStack.groupKey` — the stack's stable identity
 *  - `LibraryStackContext.groupKey` + `filterAndSort` — the drill-down's
 *    LIVE membership (resolved per filter pass, never a snapshot)
 *
 * `similarityGroupId` wins when present — it is the similarity merge's group,
 * or a manual merge's `merged-…` id. Otherwise the exact-prompt
 * `stackGroupId` (a prompt hash) names the group. Both fields live on the
 * image object; `applyAnnotationsToImages` keeps them in sync with the
 * annotation map, which remains the persisted source of truth.
 *
 * Every caller must derive membership from THIS function: two views grouping
 * by two slightly different expressions is exactly how a drill-down ends up
 * disagreeing with the stack card it was opened from.
 */
export function resolveStackGroupKey(image: IndexedImage): string | undefined {
  return image.similarityGroupId || image.stackGroupId;
}

/**
 * Keys a list of images by group, using the same expression as
 * `resolveStackGroupKey`. Shared by the drill-down membership resolve in
 * `filterAndSort`; the stack build in `groupByAnnotation` keeps its own
 * single-pass loop (it also needs the ungrouped remainder).
 */
export function collectGroupMembers(
  images: IndexedImage[],
  annotations: Map<string, ImageAnnotations>,
  groupKey: string,
): Set<string> {
  const ids = new Set<string>();
  for (const image of images) {
    // Image fields first — they are what the grid's grouping read, so a
    // drill-down can never disagree with the stack card it came from. The
    // annotation is the fallback for callers that hand filterAndSort
    // not-yet-merged image objects.
    const key = resolveStackGroupKey(image)
      ?? (annotations.get(image.id)?.similarityGroupId || annotations.get(image.id)?.stackGroupId);
    if (key === groupKey) ids.add(image.id);
  }
  return ids;
}
