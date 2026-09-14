/**
 * `window.resetStacking()`'s clearing rule.
 *
 * The helper promises a clean slate: after it runs, nothing the stacking or
 * similarity pipeline reads may survive. It used to clear three of the four
 * fields and leave `isSimilarityAnalyzed` set — harmless at the time only
 * because the vector pass's candidate rule had a second arm that admitted
 * every group anyway. These tests pin the slate itself, so the helper no
 * longer depends on that arm existing.
 */
import { describe, expect, it } from 'vitest';
import { clearStackingState, type StackingFields } from '../utils/stackingReset';

const full = (): StackingFields => ({
  stackGroupId: 'hash-a red fox',
  similarityGroupId: 'sim-1',
  isStackAnalyzed: true,
  isSimilarityAnalyzed: true,
});

describe('clearStackingState', () => {
  it('clears all four stacking/similarity fields', () => {
    const ann = full();

    expect(clearStackingState(ann)).toBe(true);
    expect(ann.stackGroupId).toBeUndefined();
    expect(ann.similarityGroupId).toBeUndefined();
    expect(ann.isStackAnalyzed).toBe(false);
    expect(ann.isSimilarityAnalyzed).toBe(false);
  });

  it('clears an annotation carrying ONLY the stale isSimilarityAnalyzed flag', () => {
    // THE regression this guards. resetStacking cleared the other three, so an
    // annotation that had already been reset once — or one whose vector pass
    // ran before any lexical pass — arrives here in exactly this shape. If the
    // flag is neither detected nor cleared, the next round's vector pass sees
    // `isSimilarityAnalyzed: true` and admits the group through the
    // candidate-set arm alone.
    const ann: StackingFields = { isSimilarityAnalyzed: true };

    expect(clearStackingState(ann)).toBe(true);
    expect(ann.isSimilarityAnalyzed).toBe(false);
  });

  it('reports no change for an annotation with nothing to clear', () => {
    // The caller skips a pointless store.put on false, so a false positive
    // means a wasted write on every image in the library.
    expect(clearStackingState({})).toBe(false);
    expect(clearStackingState({ isStackAnalyzed: false, isSimilarityAnalyzed: false })).toBe(false);
    // Falsy-but-present values are not state worth clearing.
    expect(clearStackingState({ stackGroupId: undefined, similarityGroupId: undefined })).toBe(false);
  });

  it('is idempotent — a second pass reports no change', () => {
    const ann = full();
    clearStackingState(ann);
    expect(clearStackingState(ann)).toBe(false);
  });

  it('leaves unrelated annotation fields untouched', () => {
    // The real annotation rides the same object into store.put; dropping
    // enrichment fields re-queues the whole library for auto-tagging on the
    // next round (the same trap toggleFavorite's spread-first comment warns
    // about).
    const ann = {
      ...full(),
      imageId: 'imgA',
      isFavorite: true,
      autoTags: ['already-tagged'],
      synonymTags: ['fox'],
      searchTagVersion: 2,
      isSemanticIndexed: true,
    };

    clearStackingState(ann);

    expect(ann).toMatchObject({
      imageId: 'imgA',
      isFavorite: true,
      autoTags: ['already-tagged'],
      synonymTags: ['fox'],
      searchTagVersion: 2,
      isSemanticIndexed: true,
    });
  });
});
