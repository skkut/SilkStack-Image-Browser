/**
 * Window-sizing math for the viewer's compact ("frame the image") mode.
 *
 * Deliberately pure and Electron-free: the caller supplies the available screen
 * size, so the whole rule is unit-testable without jsdom or a live window.
 */

/** Height of the standalone viewer's drag bar — keep in sync with ImageModal. */
export const COMPACT_BAR_HEIGHT = 32;
/** Padding between the image and the window edge — matches the `p-2` class. */
export const COMPACT_PADDING = 8;
/** Compact windows never exceed the display work area. */
export const COMPACT_MAX_FRACTION = 1;
/**
 * Persisted compact-mode preference. Shared by the viewer (which reads it to
 * decide its initial state) and the main window's open path (which uses it to
 * size a new viewer window before it is ever shown).
 */
export const COMPACT_MODE_STORAGE_KEY = "image_modal_compact_mode";
/**
 * Persisted window-size factor. 1 is "as large as the image allows"; anything
 * lower is the user having shrunk the window by hand, which every later image —
 * and every later window — honours.
 */
export const COMPACT_SCALE_STORAGE_KEY = "image_modal_compact_scale";
/** Bounds on that factor: it can neither vanish nor run away. */
export const COMPACT_MIN_USER_SCALE = 0.2;
export const COMPACT_MAX_USER_SCALE = 4;
/** A hand-resize must clear this to count as intent rather than rounding. */
export const COMPACT_SCALE_EPSILON = 0.02;
/**
 * How close to a display cap a hand-resized window may sit and still count as
 * *against* it. The window manager takes the frame off a screen-sized request
 * before it clamps one (≈14 DIP at 125% scaling), so a frame held at the edge
 * can read that far under the cap. A drag the user actually made on that axis
 * can only have moved it *away* from the cap, so the margin costs nothing.
 */
export const COMPACT_CAP_SLACK = 24;
/**
 * Resize events within this many DIPs of the size we requested are our own.
 * Windows rounds content sizes against a physical-pixel frame (≈3 DIP at 125%
 * scaling), so an exact comparison would mistake every resize for a user drag.
 */
export const COMPACT_RESIZE_TOLERANCE = 12;
/**
 * How long a *growth* of the frame waits for the magnification to settle, in ms.
 *
 * Resizing the window is the one part of a zoom the compositor cannot do
 * cheaply: the window manager commits the new size at once, but Chromium needs a
 * further 45-95ms (measured, on a bare window with no app code at all) before it
 * can present content for it — and for that whole time the screen is holding the
 * previous picture at the previous size. Steps of a wheel flick are ~40ms apart,
 * so at speed the resizes arrive faster than they can be shown and the picture
 * never settles for the length of the gesture. That is the flicker.
 *
 * Waiting for the gesture to stop collapses a flick's worth of steps into one
 * resize: one settle at the end instead of one stale period per step. Growth
 * only — a *shrink* is applied immediately, because a frame left larger than the
 * picture shows the background this mode exists to keep out of sight, and there
 * is nothing to coalesce a one-step zoom-out with.
 */
export const COMPACT_GROW_SETTLE_MS = 160;

/**
 * The largest factor one resize may change the frame's size by.
 *
 * What a resize costs is not the resize: the window manager commits the new
 * rectangle at once, so the frame *is* the new size — but until the compositor
 * has a frame for it, the screen holds the previous one, rescaled into the new
 * rectangle. Photographed through a zoom run (1200x800 region, ~28 shots a
 * second, magenta/green test image), that is what is on the glass for the first
 * 40-60ms of every resize: the picture at the right SIZE, because the frame
 * tracks the magnification 1:1 and the rescale factor is the magnification
 * factor, but a resampled picture — soft — and with the 8px padding and the 32px
 * drag bar rescaled by the same factor, so the picture sits a few pixels off
 * where it will land. Both of those are proportional to how far the resize
 * moved, which is the whole cost of the effect.
 *
 * One wheel detent grows the frame by 1.11-1.24 (the app's own log, a six-step
 * pass at 250ms a step), so that is the natural size of a step and this cap
 * leaves ordinary scrolling alone. What it stops is the coalesced growth at the
 * end of a *flick*: six steps 40ms apart collapse into one resize of x2.4, and
 * x2.4 of resampling is by far the largest flash this mode can draw.
 */
export const COMPACT_GROW_MAX_STEP = 1.25;

/**
 * How long one step of a paced growth waits for the last one to be shown, in ms.
 *
 * Shorter than the time a resize takes to reach the screen and the steps
 * coalesce in the compositor — which draws the picture rescaled by the whole
 * distance rather than by one step, i.e. exactly the flash the pacing exists to
 * avoid. The measurement behind COMPACT_GROW_SETTLE_MS puts that at 45-95ms.
 */
export const COMPACT_GROW_STEP_MS = 80;

export interface CompactContentSize {
  contentWidth: number;
  contentHeight: number;
}

/** Keep a user factor inside its sane range. */
export function clampUserScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(COMPACT_MAX_USER_SCALE, Math.max(COMPACT_MIN_USER_SCALE, scale));
}

/**
 * Guard for the zoom multiplier a compact window is asked to hold.
 *
 * The viewer owns the real bounds (its zoom control's MIN_ZOOM and MAX_ZOOM), so
 * this is only a floor: a missing or nonsensical value means "not zoomed", and
 * anything below 1 would ask for a window smaller than the image's fit, where the
 * picture can no longer fill it. The fit is the smallest a compact window goes.
 */
function compactZoomFactor(zoom: number): number {
  return Number.isFinite(zoom) ? Math.max(1, zoom) : 1;
}

/**
 * The largest image area the display allows, as an image area rather than a
 * content size. Both the sizing rule and the reading of a hand-resize measure
 * against these, so they are derived in one place.
 */
export function compactDisplayCaps(
  availWidth: number,
  availHeight: number,
): { width: number; height: number } {
  return {
    width: availWidth * COMPACT_MAX_FRACTION - COMPACT_PADDING * 2,
    // The drag bar and padding are part of the window, so they eat into the
    // height budget — otherwise the result overshoots the fraction by 2·padding.
    height:
      availHeight * COMPACT_MAX_FRACTION -
      COMPACT_PADDING * 2 -
      COMPACT_BAR_HEIGHT,
  };
}

/** The image area inside a compact window: the content minus padding and bar. */
export function compactImageArea(
  contentWidth: number,
  contentHeight: number,
): { width: number; height: number } {
  return {
    width: Math.max(1, contentWidth - COMPACT_PADDING * 2),
    height: Math.max(
      1,
      contentHeight - COMPACT_PADDING * 2 - COMPACT_BAR_HEIGHT,
    ),
  };
}

/**
 * Content size (the web-page area `setContentSize` takes) for a compact window
 * showing an image of `imgWidth` x `imgHeight`.
 *
 * The image is scaled down to fit the work area but never up, so a small file
 * yields a small window. The result is the image at that scale plus equal
 * padding on all four sides, with the drag bar stacked on top. At 1x that makes
 * the content exactly the image's own aspect ratio, which is what makes the
 * letterbox bands disappear.
 *
 * The promise the bands rest on is per axis, not on the aspect: **the frame is
 * never larger than the picture**. The viewer lays the picture out at
 * `round(image x fit)` and magnifies it with a transform, so a frame of
 * `floor(that x zoom)` or less on each axis is always covered by it. Sizing from
 * the same rounded base is what makes that hold to the pixel rather than to
 * whatever rounding happened to agree.
 *
 * `userScale` is the user's own window-size preference, applied to the image
 * area only so the padding and bar stay constant. It is still capped by the work
 * area, and the cap is applied to *both* axes together: a hand-sized window
 * shrinks the picture to keep it whole rather than cropping it, because asking
 * for a bigger window is not a request to see less of the image.
 *
 * `zoom` is the viewer's magnification, applied on top of that size, and it is
 * clamped **per axis**. That difference is the whole point: an image is usually
 * bound by one axis of the display long before the other — a portrait file on a
 * wide screen has run out of height at 1:1 and has half the width to spare — so
 * clamping the two axes by one shared factor freezes the frame at exactly the
 * moment the user starts zooming. Clamped per axis, the axis that still has room
 * keeps growing into it while the bound one stops, and the picture is cropped
 * along the bound axis instead. That crop is what the viewer's panning and
 * minimap are for, so the frame follows the zoom as far as the display allows
 * and magnifies inside it after that. Below 1 the zoom is ignored — see
 * `compactZoomFactor`.
 *
 * @returns the content size, or null when any input is unusable.
 */
export function computeCompactContentSize(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
  userScale = 1,
  zoom = 1,
): CompactContentSize | null {
  if (
    !Number.isFinite(imgWidth) ||
    !Number.isFinite(imgHeight) ||
    !Number.isFinite(availWidth) ||
    !Number.isFinite(availHeight) ||
    imgWidth <= 0 ||
    imgHeight <= 0
  ) {
    return null;
  }

  const { width: maxWidth, height: maxHeight } = compactDisplayCaps(
    availWidth,
    availHeight,
  );
  if (maxWidth <= 0 || maxHeight <= 0) return null;

  // The automatic fit never enlarges a file beyond its own pixels…
  const fitScale = Math.min(1, maxWidth / imgWidth, maxHeight / imgHeight);
  // …and the user's factor is then clamped by the work area as one scale, so
  // the result can never leave the display and the picture stays whole.
  const scale = Math.min(
    fitScale * clampUserScale(userScale),
    maxWidth / imgWidth,
    maxHeight / imgHeight,
  );

  // The image area at 1x — which is exactly the size the viewer pins its <img>
  // to, so the magnification below is measured from the same rounded pixels the
  // browser lays out. At least 1px, so a tiny scale cannot round down to
  // nothing.
  const baseWidth = Math.max(1, Math.round(imgWidth * scale));
  const baseHeight = Math.max(1, Math.round(imgHeight * scale));

  const zoomFactor = compactZoomFactor(zoom);
  // Floor rather than round: a frame half a pixel wider than the picture is a
  // visible hairline of background, half a pixel narrower is nothing. This is
  // what makes "the picture always covers the frame" exact rather than likely.
  const displayWidth = Math.max(
    1,
    Math.min(Math.floor(baseWidth * zoomFactor), Math.floor(maxWidth)),
  );
  const displayHeight = Math.max(
    1,
    Math.min(Math.floor(baseHeight * zoomFactor), Math.floor(maxHeight)),
  );

  return {
    contentWidth: displayWidth + COMPACT_PADDING * 2,
    contentHeight: displayHeight + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
  };
}

/**
 * The image area the compact frame is built around: an image's fit at the user's
 * size factor, with the zoom left out of it.
 *
 * One definition, used twice, which is the point: this is the size the viewer
 * pins its `<img>` to, and it is also the base every frame size is grown from —
 * so the picture and the frame can never disagree about what "1x" is.
 *
 * @returns the pinned size, or null when the inputs cannot describe a fit.
 */
export function compactPinnedSize(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
  userScale = 1,
): { width: number; height: number } | null {
  const fit = computeCompactContentSize(
    imgWidth,
    imgHeight,
    availWidth,
    availHeight,
    userScale,
  );
  return fit ? compactImageArea(fit.contentWidth, fit.contentHeight) : null;
}

/**
 * Which axes of a compact frame can still be panned at a given magnification —
 * the axes on which the picture is genuinely cropped.
 *
 * A compact window grows with the zoom until the work area stops it, so below
 * that point the frame comes out holding the whole picture and the picture sits
 * in the middle of it: the middle is the only pan there is. Anchoring the pan on
 * the mouse there would slide the picture sideways and then have the resize put
 * it back a moment later — two motions, in opposite directions, for one step of
 * the wheel, which is what a picture jittering sideways during a zoom is. Past
 * the cap the frame cannot follow the zoom, the picture really is cropped — and
 * the pane the pan is measured against is no longer going to change — so the
 * anchoring is both legal and steady.
 *
 * That is the same question the viewer's pan clamp asks of the pane the picture
 * is in now (`maxPan > 0`); the difference is *when* it is asked. Here it is
 * asked of the size the frame is about to take, because during a deferred growth
 * the two disagree: the pane is still the old, smaller one and the picture does
 * overflow it, but only until the resize lands, so a pan taken against it would
 * be undone immediately.
 *
 * A fit that cannot be read reports neither axis as pannable — with no evidence
 * that the picture is cropped, the picture is better left where it is.
 */
export function compactPanAxes(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
  userScale = 1,
  zoom = 1,
): { width: boolean; height: boolean } {
  const pin = compactPinnedSize(
    imgWidth,
    imgHeight,
    availWidth,
    availHeight,
    userScale,
  );
  if (!pin) return { width: false, height: false };

  const caps = compactDisplayCaps(availWidth, availHeight);
  const factor = compactZoomFactor(zoom);

  // The pane the pan is clamped against, once the window has taken the size this
  // magnification asks for: the frame's image area (`min(floor(base x zoom),
  // floor(cap))`, exactly as `computeCompactContentSize` computes it), plus the
  // padding the viewer keeps around the picture. The padding belongs in it
  // because it is not draggable room — the viewer clamps against the container,
  // and a slide of a few pixels *inside* the padding changes nothing anyone can
  // see. So it is part of what has to be overrun before an axis counts.
  const paneOf = (base: number, cap: number): number =>
    Math.min(Math.floor(base * factor), Math.floor(cap)) + COMPACT_PADDING * 2;
  // The frame is floored out of a rounded fit while the picture is the product
  // itself, so the two also miss each other by a fraction of a pixel at every
  // magnification, cap or no cap. One pixel of that is not a crop — the viewer's
  // own pan clamp carries the same tolerance.
  const cropped = (base: number, cap: number): boolean =>
    paneOf(base, cap) < base * factor - 1;

  return {
    width: cropped(pin.width, caps.width),
    height: cropped(pin.height, caps.height),
  };
}

/**
 * The factor a hand-resized window implies, read as an absolute fraction of the
 * best fit for the image on screen rather than as a multiple of the last size we
 * applied.
 *
 * Absolute is the whole point. A multiplied factor compounds — each drag is
 * measured from the previous one, so a couple of DIPs of frame rounding per pass
 * walks the remembered size in one direction — and, worse, one bad observation
 * used to be permanent: a window the OS had maximised (a double-click on the
 * drag bar does it) looked like "four times the fit", the factor was raised to
 * match, and from then on every image came back at full size with no way down.
 * Measured against the fit, a single honest drag re-derives the true fraction,
 * so any such value heals itself.
 *
 * Compared in image areas, not content sizes: the padding and bar are a fixed
 * cost, so a 70% drag of the *content* is a larger fraction of the picture, and
 * reading it raw would miss by a growing margin. Only the dimension the user
 * actually moved is counted, so dragging one edge is not misread as a change in
 * the other.
 *
 * `zoom` is the magnification the window was showing, and it comes out of the
 * reading first. A compact window at 3x is three times the fit before the user
 * touches it, so the raw ratio says 3 — remember that and the next image would
 * open at the fit times nine. Dividing it out leaves a statement about the
 * window alone, which is what a size preference is, and it has to happen before
 * the dominant axis is picked: the zoom moves both axes, so leaving it in would
 * let it decide which edge the user dragged. An axis the magnification has since
 * pushed against the display is dropped too — there the frame is the work area
 * rather than the user's choice — which leaves the reading to the axis that
 * still had room to be dragged.
 *
 * @returns the factor to remember, or 1 when the inputs cannot describe a fit.
 */
export function userScaleFromResize(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
  observedWidth: number,
  observedHeight: number,
  zoom = 1,
): number {
  const fit = computeCompactContentSize(
    imgWidth,
    imgHeight,
    availWidth,
    availHeight,
  );
  if (!fit || !Number.isFinite(observedWidth) || !Number.isFinite(observedHeight)) {
    return 1;
  }
  const fitted = compactImageArea(fit.contentWidth, fit.contentHeight);
  const observed = compactImageArea(observedWidth, observedHeight);
  const factor = compactZoomFactor(zoom);
  const scaleW = observed.width / fitted.width / factor;
  const scaleH = observed.height / fitted.height / factor;

  // An axis held against the display says nothing about the user's preference:
  // there the frame is the work area, not the size they chose, and the
  // magnification is the only thing that put it there. Reading it would store
  // the zoom's own fraction — dragging a 4x frame that is against the edge would
  // remember 0.25 and shrink every window that followed. Both halves of the test
  // are needed: the axis has to be able to reach the cap at this magnification
  // *and* actually be sitting at it, so a user who has pulled the window in
  // below the cap is still read.
  const caps = compactDisplayCaps(availWidth, availHeight);
  const boundW =
    fitted.width * factor >= caps.width - 1 &&
    observed.width >= caps.width - COMPACT_CAP_SLACK;
  const boundH =
    fitted.height * factor >= caps.height - 1 &&
    observed.height >= caps.height - COMPACT_CAP_SLACK;
  // One bound axis, one free: the free one is the statement. A frame against the
  // display on *both* axes has not been resized at all — there is nowhere to drag
  // it — and the neutral answer is the fit, which is what it is sitting at.
  if (boundW !== boundH) return clampUserScale(boundW ? scaleH : scaleW);
  if (boundW) return 1;

  // Neither is bound: the axis the user actually moved is the one that says what
  // they wanted, measured against that same fit.
  const dominant =
    Math.abs(scaleW - 1) >= Math.abs(scaleH - 1) ? scaleW : scaleH;
  return clampUserScale(dominant);
}

/**
 * Parse a `"1920x1080"` dimensions string, as produced by the indexer and used
 * for file-parameter display. Used to size a remembered-compact window before
 * the first image file has been decoded.
 */
export function parseDimensionsString(
  dimensions: string | undefined | null,
): { width: number; height: number } | null {
  const match = dimensions?.match(/(\d+)\s*x\s*(\d+)/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return null;
  return { width, height };
}
