/**
 * The Shift+click range rule, shared by every surface that has a selection:
 * the main library's grid and table (through `useImageStore.selectImageRange`)
 * and the popped-out stack window (which has no store to ask).
 *
 * Keeping this pure — and identical for both callers — is the point. The
 * stack window renders the SAME cards in the SAME order as the library's
 * drill-down, so a Shift+click there has to select the same run it would
 * there; a second hand-written copy of the rule would drift on the first fix.
 */

/**
 * Resolve the anchor a Shift+click measures its run from.
 *
 * The stored anchor wins while it is still part of the selection and still on
 * screen. Otherwise the last selected card in `displayOrder` is used — that
 * keeps Shift+click extending after gestures that set a whole block at once
 * (drag-box, Select All, or a Ctrl+click that deselected the old anchor),
 * instead of silently falling through to "open this image and replace the
 * selection". `displayOrder` is the displayed card order, not `filteredImages`
 * — see `computeRangeSelection`.
 */
export function resolveSelectionAnchorId(
    selectedImages: ReadonlySet<string>,
    selectionAnchorId: string | null,
    displayOrder: readonly string[],
): string | null {
    // The anchor also has to be *displayed*: a selected image the grid
    // collapsed into a stack, or filtered out since it was picked, cannot
    // define a run the user can see — fall through to the derived anchor.
    if (
        selectionAnchorId
        && selectedImages.has(selectionAnchorId)
        && displayOrder.indexOf(selectionAnchorId) !== -1
    ) {
        return selectionAnchorId;
    }

    for (let i = displayOrder.length - 1; i >= 0; i--) {
        if (selectedImages.has(displayOrder[i])) return displayOrder[i];
    }
    return null;
}

/**
 * Shift+click. Union the run between the clicked card and the NEAREST EDGE of
 * the selection — its first drawn card when the click lands before the
 * selection, its last drawn card when it lands after — into the selection.
 * Additive by design, so nothing already selected is ever dropped, and a
 * click before the selection fills up to it instead of re-anchoring and
 * wiping what was there.
 *
 * Reaching for the anchor (the last *pick*) instead is right for a selection
 * built in one sweep and wrong for one built part by part: an anchor sitting
 * in a later part turns "fill up to my selection" into a run that swallows
 * every gap between the parts. Only a click INSIDE the selection's span has
 * no near edge to reach, so that one case still draws from the anchor —
 * filling the gap back to the last image picked.
 *
 * The run is measured in `displayOrder` (the cards actually on screen), not
 * in library order: with stacking on the two differ, and a run over library
 * order would light up images the user cannot see while leaving the cards
 * between the two clicks unselected.
 *
 * Returns `null` when the clicked image is not on screen — there is no run to
 * measure, and the caller should swallow the gesture rather than fall through
 * to a plain click (which would replace the selection and open the viewer).
 */
export function computeRangeSelection(
    selectedImages: ReadonlySet<string>,
    selectionAnchorId: string | null,
    imageId: string,
    displayOrder: readonly string[],
): { selectedImages: Set<string>; selectionAnchorId: string } | null {
    const clickedIndex = displayOrder.indexOf(imageId);
    if (clickedIndex === -1) return null;

    // The selection's edges in drawn order — what an outside run connects to.
    // One pass, and a click is the only thing that triggers it, so the linear
    // scan is not worth caching.
    let firstSelected = -1;
    let lastSelected = -1;
    for (let i = 0; i < displayOrder.length; i++) {
        if (!selectedImages.has(displayOrder[i])) continue;
        if (firstSelected === -1) firstSelected = i;
        lastSelected = i;
    }

    const newSelection = new Set(selectedImages);

    if (firstSelected === -1) {
        // Nothing on screen to measure a run from (selection filtered away,
        // or list not ready) — behave like a plain additive pick.
        newSelection.add(imageId);
        return { selectedImages: newSelection, selectionAnchorId: imageId };
    }

    let start: number;
    let end: number;
    if (clickedIndex < firstSelected) {
        [start, end] = [clickedIndex, firstSelected];
    } else if (clickedIndex > lastSelected) {
        [start, end] = [lastSelected, clickedIndex];
    } else {
        // Inside the span. The anchor is a selected card, so the run stays
        // within the selection and cannot leak past either edge.
        const anchorId = resolveSelectionAnchorId(selectedImages, selectionAnchorId, displayOrder);
        const anchorIndex = anchorId ? displayOrder.indexOf(anchorId) : -1;
        [start, end] = anchorIndex === -1
            ? [clickedIndex, clickedIndex]
            : [Math.min(anchorIndex, clickedIndex), Math.max(anchorIndex, clickedIndex)];
    }

    for (let i = start; i <= end; i++) {
        newSelection.add(displayOrder[i]);
    }

    // The clicked image is now the last one selected, so it becomes the anchor
    // for the next Shift+click.
    return { selectedImages: newSelection, selectionAnchorId: imageId };
}
