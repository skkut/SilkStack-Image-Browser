import type { ImageAnnotations, IndexedImage } from '../types';

/**
 * The annotation shape that means "stacking decided this image has no group"
 * comes from TWO different writers, and the pipeline must never confuse them.
 *
 *  - MANUAL unmerge (`unmergeImagesFromStack`): an explicit user decision to
 *    take images out of a stack. It always writes `isSimilarityAnalyzed: false`
 *    alongside the cleared group ids. That explicit flag is the marker — every
 *    stacking/similarity pass must respect it and never re-assign a hash.
 *
 *  - PREMATURE stamp (`syncNewImagesToStacks`): the pass used to run while an
 *    image was still a Phase A catalog stub — its metadata (and therefore its
 *    prompt) had not been read yet, so it wrote `isStackAnalyzed: true` with no
 *    id and NO `isSimilarityAnalyzed` key. Once the prompt arrived, every pass
 *    mistook that record for a manual unmerge and skipped it forever: the
 *    stack never came back, even across restarts. The modern pass skips
 *    catalog stubs (see `isCatalogStub`), so no new records of this shape are
 *    written; the shape is still repaired when found (see
 *    `reconcilePromptHashes`).
 *
 * A genuinely prompt-less image (a photo with no AI metadata) legitimately
 * ends up in the PREMATURE shape — it will never stack. That is why the
 * premature shape must only be treated as repairable when the image NOW has a
 * prompt; otherwise repairing it would rewrite the same record every round.
 */

/** True when the image's metadata has not been read yet (Phase A stub). */
export function isCatalogStub(
  image: Pick<IndexedImage, 'enrichmentState'>,
): boolean {
  return image.enrichmentState === 'catalog';
}

/**
 * True when the annotation records an explicit manual unmerge — the user
 * decision no pass may undo. Writers of that state MUST keep writing
 * `isSimilarityAnalyzed: false` (see `unmergeImagesFromStack`).
 */
export function isManuallyUnstacked(
  annotation: Pick<ImageAnnotations, 'isStackAnalyzed' | 'stackGroupId' | 'isSimilarityAnalyzed'> | undefined,
): boolean {
  return (
    !!annotation?.isStackAnalyzed &&
    !annotation.stackGroupId &&
    annotation.isSimilarityAnalyzed !== undefined
  );
}

/**
 * True when `isStackAnalyzed` was stamped before the image was enriched — the
 * record has no group id and no similarity flag at all. Repair it only when a
 * prompt is present; otherwise there is nothing to stack and no write is due.
 */
export function hasPrematureStackStamp(
  annotation: Pick<ImageAnnotations, 'isStackAnalyzed' | 'stackGroupId' | 'isSimilarityAnalyzed'> | undefined,
): boolean {
  return (
    !!annotation?.isStackAnalyzed &&
    !annotation.stackGroupId &&
    annotation.isSimilarityAnalyzed === undefined
  );
}
