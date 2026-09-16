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
 * Resize events within this many DIPs of the size we requested are our own.
 * Windows rounds content sizes against a physical-pixel frame (≈3 DIP at 125%
 * scaling), so an exact comparison would mistake every resize for a user drag.
 */
export const COMPACT_RESIZE_TOLERANCE = 12;

export interface CompactContentSize {
  contentWidth: number;
  contentHeight: number;
}

/** Keep a user factor inside its sane range. */
export function clampUserScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(COMPACT_MAX_USER_SCALE, Math.max(COMPACT_MIN_USER_SCALE, scale));
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
 * padding on all four sides, with the drag bar stacked on top — which is what
 * makes the letterbox bands disappear: the container ends up exactly the
 * image's own aspect ratio.
 *
 * `userScale` is the user's own window-size preference, applied to the image
 * area only so the padding and bar stay constant and the aspect stays exact.
 * It is still capped by the work area: dragging a small image larger works, but
 * nothing can outgrow the desktop.
 *
 * @returns the content size, or null when any input is unusable.
 */
export function computeCompactContentSize(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
  userScale = 1,
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

  const maxWidth = availWidth * COMPACT_MAX_FRACTION - COMPACT_PADDING * 2;
  // The drag bar and padding are part of the window, so they eat into the
  // height budget — otherwise the result overshoots the fraction by 2·padding.
  const maxHeight =
    availHeight * COMPACT_MAX_FRACTION -
    COMPACT_PADDING * 2 -
    COMPACT_BAR_HEIGHT;
  if (maxWidth <= 0 || maxHeight <= 0) return null;

  // The automatic fit never enlarges a file beyond its own pixels…
  const fitScale = Math.min(1, maxWidth / imgWidth, maxHeight / imgHeight);
  // …and the user's factor is then clamped by the work area, so the two
  // together can only ever shrink relative to the best fit.
  const scale = Math.min(
    fitScale * clampUserScale(userScale),
    maxWidth / imgWidth,
    maxHeight / imgHeight,
  );

  // At least 1px so a non-integer scale can never round down to nothing.
  const displayWidth = Math.max(1, Math.round(imgWidth * scale));
  const displayHeight = Math.max(1, Math.round(imgHeight * scale));

  return {
    contentWidth: displayWidth + COMPACT_PADDING * 2,
    contentHeight: displayHeight + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
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
 * @returns the factor to remember, or 1 when the inputs cannot describe a fit.
 */
export function userScaleFromResize(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
  observedWidth: number,
  observedHeight: number,
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
  const scaleW = observed.width / fitted.width;
  const scaleH = observed.height / fitted.height;
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
