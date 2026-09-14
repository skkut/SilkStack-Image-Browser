/**
 * Clearing rule for the `window.resetStacking()` debug helper.
 *
 * The helper must leave a genuinely CLEAN slate — every field the stacking and
 * similarity pipeline reads has to be gone, or the next round silently depends
 * on some other mechanism to supply what the stale field would have.
 *
 * ⚠️ The trap this exists to prevent: leaving `isSimilarityAnalyzed` set while
 * clearing the other three. Nothing broke at first, because the vector pass
 * admits a candidate through EITHER arm of:
 *
 *   const isCandidate = (!ann.isSimilarityAnalyzed
 *           || (!!candidateStackGroupIds && candidateStackGroupIds.has(ann.stackGroupId)))
 *       && isStandaloneGroup(ann.stackGroupId, ann.similarityGroupId);
 *
 * With the flag stale-true the first arm is dead for every group, so a reset
 * round was admitted entirely by the candidate-set arm. That works — until a
 * refactor drops the arm, at which point a reset re-clusters nobody and the
 * regression looks like it came back. Clear all four and the helper stands on
 * its own.
 *
 * Kept as a standalone pure function (rather than inline in App.tsx's IndexedDB
 * transaction) so the rule is unit-testable without an IndexedDB harness.
 */

/** The stacking/similarity fields an annotation can carry. */
export interface StackingFields {
  stackGroupId?: string;
  similarityGroupId?: string;
  isStackAnalyzed?: boolean;
  isSimilarityAnalyzed?: boolean;
}

/**
 * Clear every stacking/similarity field on `ann`, in place.
 *
 * @returns `true` when anything needed clearing — the caller uses this both to
 *   count affected images and to skip a pointless `store.put`.
 */
export function clearStackingState(ann: StackingFields): boolean {
  // `isSimilarityAnalyzed` is part of the guard, not just the body: an
  // annotation can carry ONLY the stale flag (the mixed state resetStacking
  // used to produce), and it still needs the write that clears it.
  if (!(ann.stackGroupId || ann.similarityGroupId || ann.isStackAnalyzed || ann.isSimilarityAnalyzed)) {
    return false;
  }

  ann.stackGroupId = undefined;
  ann.similarityGroupId = undefined;
  ann.isStackAnalyzed = false;
  ann.isSimilarityAnalyzed = false;
  return true;
}
