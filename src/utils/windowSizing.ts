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
 * Persisted window-size factor, read two ways that meet at 1.
 *
 * **Below 1** it is the share of the screen the window is to take — the size the
 * user asked for, in the one unit that means the same thing for every file, and
 * the one `COMPACT_MIN_FRACTION` is written in. "This small" is then a statement
 * about a rectangle on the screen rather than about whichever image happens to be
 * on it, which is what lets the next image open at the same size.
 *
 * **At or above 1** it is a multiple of the image's own fit, exactly as it always
 * was, so every value already in storage keeps its meaning.
 */
export const COMPACT_SCALE_STORAGE_KEY = "image_modal_compact_scale";
/**
 * Bounds on that factor: it can neither vanish nor run away.
 *
 * The lower bound is **not** the floor anyone feels — it is a degeneracy guard,
 * and deliberately far below the smallest size a drag can produce in practice.
 * What bounds a hand-drag is the window manager: a frame under
 * `COMPACT_MIN_WINDOW_*` is not refused by Electron but quietly *widened*, which
 * leaves the frame larger than the picture — the background this mode exists to
 * keep out of sight. That floor is per-image and has its own function in these
 * same units (`compactWindowMinimumScale`), and a drag that would fall under it
 * is refused rather than clamped (see the resize handler in ImageModal).
 *
 * It used to be 0.2, which was a *different quantity*: it was written when the
 * factor was read as a multiple of the image's own fit, and 0.2 of the fit is a
 * far smaller window than 0.2 of the screen for every file that does not fill the
 * display. Carried over unchanged it would have turned a drag of a small image's
 * window into a clamp that springs back, so it comes down with the unit.
 */
export const COMPACT_MIN_USER_SCALE = 0.05;
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

/**
 * How small a compact frame may be left: the window's longest side, as a
 * fraction of the largest the picture may be on this display — 40%.
 *
 * The same number as the stored size factor, in the same units, with no
 * conversion between them: the factor *is* "the window's longest side as a share
 * of the screen", so the gesture that writes it and the rule that stops it are
 * speaking about the same edge.
 *
 * Dominant, because the frame keeps the picture's aspect and so its footprint is
 * set by whichever dimension runs out of screen first — for a square image on a
 * wide display that is the height. Holding that axis is what makes "the window
 * shrinks to 40% of the screen" a statement about the window rather than about
 * whichever edge happened to be incidental.
 *
 * It was a quarter, and a quarter turned out to read as far smaller than it
 * sounds: the other axis is **not** held to it, so a square file on a 2048x1152
 * display stopped at 288x288 — 25% of the height, 14% of the width, and 3.5% of
 * the screen's *area*. The number people judge a window by is its footprint, and
 * for anything that is not the display's own shape the two differ by the aspect
 * ratio. 40% of the dominant axis is what makes the window look like a window.
 *
 * Since the shrink gesture *is* a window resize, this is also the unit the
 * remembered size is kept in — `compactMinUserScale` floors the stored factor at
 * exactly this number, with no conversion, because the two are the same thing.
 *
 * A **gesture** floor, not a property of the mode. A hand-drag already leaves a
 * compact window far below it (`COMPACT_MIN_USER_SCALE` is 0.2 of the screen, in
 * the same units), and that is unchanged: what this bounds is how far the shrink
 * gesture goes.
 */
export const COMPACT_MIN_FRACTION = 0.4;

/**
 * Mirrors of `COMPACT_MIN_WIDTH` / `COMPACT_MIN_HEIGHT` in electron/main.mjs,
 * which main applies with `win.setMinimumSize` on entering the mode.
 *
 * They are about the viewer's top bar rather than the image — below ~272px its
 * four buttons would slide under the OS-drawn window controls. They belong in
 * this file because a request below them is **not refused**: Electron takes it,
 * and the window manager quietly widens the frame instead, which leaves the
 * frame bigger than the picture — the background this mode exists to keep out of
 * sight. The floor has to respect them or the invariant has a hole in it.
 *
 * Read as *content* minimums, which is a few DIPs stricter than the window units
 * main actually passes (it measures the frame at main.mjs:386 for the same
 * reason). The error is in the safe direction — the shrink stops a hair early
 * rather than a hair late. Keep in sync with main.mjs.
 */
export const COMPACT_MIN_WINDOW_WIDTH = 272;
export const COMPACT_MIN_WINDOW_HEIGHT = 160;

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
 * A missing or nonsensical value means "not zoomed". Anything finite and
 * positive is taken as written — **including values below 1**, which ask for a
 * frame smaller than the image's fit.
 *
 * That is legal, because the frame is built from the same pinned size the viewer
 * lays its `<img>` out at: a frame of `pin x zoom` is covered by a picture of
 * `pin x zoom` whatever the zoom is. The fit stopped being a special value the
 * moment the two were derived from one size. The viewer no longer *sends* a zoom
 * below 1 — shrinking a window is now the size factor's job, so that the size
 * survives into the next image — but this stays permissive rather than clamping,
 * because clamping *up* to 1 would size a frame larger than the picture the
 * viewer is drawing, which is the one thing these functions exist to prevent.
 */
function compactZoomFactor(zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
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
 * Content size of a compact frame at **1x** — the image at the user's size
 * factor, with no magnification in it.
 *
 * The image is scaled down to fit the work area but never up, so a small file
 * yields a small window. The result is the image at that scale plus equal
 * padding on all four sides, with the drag bar stacked on top, which makes the
 * content exactly the image's own aspect ratio and is what makes the letterbox
 * bands disappear.
 *
 * `userScale` is the user's own window-size preference, applied to the image
 * area only so the padding and bar stay constant. It is still capped by the work
 * area, and the cap is applied to *both* axes together: a hand-sized window
 * shrinks the picture to keep it whole rather than cropping it, because asking
 * for a bigger window is not a request to see less of the image.
 *
 * Split out of `computeCompactContentSize` so that the picture's laid-out size
 * and every frame size grown from it are derived from one definition — see
 * `compactPinnedSize`.
 */
function compactFitContentSize(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
  userScale: number,
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

  // The picture at the largest the display allows: 1:1 for a file that fits, the
  // fit for one that does not. Its longest side is the display's own on that
  // axis, which is exactly what makes the factor below comparable between files.
  const displayFit = Math.min(maxWidth / imgWidth, maxHeight / imgHeight);

  // The automatic fit, which also never enlarges a file beyond its own pixels —
  // so a small file yields a small window.
  const fitScale = Math.min(1, displayFit);
  const wanted = clampUserScale(userScale);

  // The factor is read two ways, and 1 is the one point where they agree: there
  // the answer is `fitScale`, exactly as it always was.
  //
  // **Below 1** it is a share of the screen: the window's longest side, as a
  // fraction of the longest side the display allows. One number, one rectangle,
  // the same meaning whatever file it is read on — so a window shrunk to 26%
  // comes back at 26% for the next image as well. A multiple of the image's own
  // fit could not do that, which is what was wrong before: the fit is 1963px for
  // a file that fills the screen and 1024px for a square one smaller than it, so
  // the same factor meant two different windows and there was no way to ask for
  // "this small" and be understood.
  //
  // **At or above 1** it stays a multiple of the fit — the drag-a-window-larger
  // gesture — which is the reading every stored factor has always had.
  //
  // The `min(1, …)` on the lower branch is what keeps a file smaller than the
  // share from being enlarged to honour it: there the window simply hugs the
  // picture at 100% until the share drops below what the file can fill.
  const factor =
    wanted >= 1
      ? wanted * fitScale
      : Math.min(1, wanted * displayFit);

  // …and the result is capped by the work area on both axes together, so the
  // window can never leave the display and the picture stays whole.
  const scale = Math.min(factor, maxWidth / imgWidth, maxHeight / imgHeight);

  // At least 1px, so a tiny scale cannot round down to nothing. Floor rather
  // than round against the work area: a frame half a pixel wider than the
  // picture is a visible hairline of background, half a pixel narrower is
  // nothing. This is what makes "the picture always covers the frame" exact
  // rather than likely.
  const width = Math.max(1, Math.min(Math.round(imgWidth * scale), Math.floor(maxWidth)));
  const height = Math.max(1, Math.min(Math.round(imgHeight * scale), Math.floor(maxHeight)));

  return {
    contentWidth: width + COMPACT_PADDING * 2,
    contentHeight: height + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
  };
}

/**
 * Content size (the web-page area `setContentSize` takes) for a compact window
 * showing an image of `imgWidth` x `imgHeight` at a magnification of `zoom`.
 *
 * The promise the bands rest on is per axis, not on the aspect: **the frame is
 * never larger than the picture**. The viewer pins its `<img>` to
 * `compactPinnedSize` and magnifies it with a transform, so `floor(that x zoom)`
 * is the largest frame that is still covered on both axes — and that is exactly
 * what this returns. Sizing from the same pinned size is what makes the promise
 * hold to the pixel rather than to whatever rounding happened to agree, and it
 * is why a zoom **below 1** is unremarkable: the picture shrinks by the same
 * factor, so it still covers the frame it is in.
 *
 * `zoom` is clamped **per axis** against the work area, and that difference is
 * the whole point above 1x: an image is usually bound by one axis of the display
 * long before the other — a portrait file on a wide screen has run out of height
 * at 1:1 and has half the width to spare — so clamping the two axes by one
 * shared factor freezes the frame at exactly the moment the user starts zooming.
 * Clamped per axis, the axis that still has room keeps growing into it while the
 * bound one stops, and the picture is cropped along the bound axis instead. That
 * crop is what the viewer's panning and minimap are for, so the frame follows
 * the zoom as far as the display allows and magnifies inside it after that.
 *
 * The floor on how far *down* the frame may go is deliberately **not** applied
 * here — see `compactZoomFactor`. Applying it would make this function produce a
 * frame larger than the picture, which is the one thing it exists to prevent.
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
  const fit = compactFitContentSize(
    imgWidth,
    imgHeight,
    availWidth,
    availHeight,
    userScale,
  );
  if (!fit) return null;

  const { width: maxWidth, height: maxHeight } = compactDisplayCaps(
    availWidth,
    availHeight,
  );

  // The size the viewer pins its <img> to — the same rounded, work-area-clamped
  // pixels the browser lays out — so the magnification below is measured from
  // what is actually on screen.
  const base = compactImageArea(fit.contentWidth, fit.contentHeight);
  const zoomFactor = compactZoomFactor(zoom);
  const displayWidth = Math.max(
    1,
    Math.min(Math.floor(base.width * zoomFactor), Math.floor(maxWidth)),
  );
  const displayHeight = Math.max(
    1,
    Math.min(Math.floor(base.height * zoomFactor), Math.floor(maxHeight)),
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
  const fit = compactFitContentSize(
    imgWidth,
    imgHeight,
    availWidth,
    availHeight,
    userScale,
  );
  return fit ? compactImageArea(fit.contentWidth, fit.contentHeight) : null;
}

/**
 * How far the shrink gesture may take a compact window: the smallest the stored
 * size factor may be left at, for this image on this display.
 *
 * Always at most **1**, so it can never forbid the fit itself. That clamp is what
 * makes the rule safe for a small image — a 200px picture is already far under
 * 40% of the screen and already under the window minimum — and for a window
 * the user has dragged small. Where it comes back as 1 the mode simply has no
 * shrink to give, and the gesture behaves exactly as it did before.
 *
 * Otherwise the largest of two terms wins:
 *
 * - `COMPACT_MIN_FRACTION` of the display, on the frame's dominant axis — which
 *   is *literally the stored factor*, because below 1 that factor is a share of
 *   the screen. No conversion is needed, and that is the point of reading the
 *   factor that way: the number the user's gesture writes and the number this
 *   rule names are the same number.
 * - The window manager's own minimum, on both axes, as a share of the picture at
 *   its display fit — `compactWindowMinimumScale`. It is a physical statement
 *   about the frame about to be requested, and the term that binds for a very
 *   wide or very tall image, where the fixed padding and drag bar are a large
 *   share of a small window: a 4000x500 panorama stops at a 160px-tall frame
 *   whatever 40% of the display would allow, because a shorter one cannot hold
 *   the top bar.
 *
 * Read against the picture at its display fit — scale 1, no factor — so the floor
 * is a *fixed rectangle on the screen* as the gesture moves. Read against the
 * current, already-shrunk picture instead it would be scale-invariant in the
 * wrong way: each step would raise the floor by the factor it just applied, and
 * the gesture would stop after one step.
 *
 * @returns the floor, or 1 when the inputs cannot describe a fit.
 */
export function compactMinUserScale(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
): number {
  return Math.min(
    1,
    Math.max(
      COMPACT_MIN_FRACTION,
      compactWindowMinimumScale(imgWidth, imgHeight, availWidth, availHeight),
    ),
  );
}

/**
 * The window manager's own floor: the smallest size factor a compact frame may
 * hold and still be a frame the OS will actually make, as a share of the picture
 * at its display fit.
 *
 * Electron *takes* a request below `COMPACT_MIN_WINDOW_WIDTH`/`_HEIGHT`; it is
 * the window manager that quietly widens the frame to its minimum, which leaves
 * the frame larger than the picture — the background this mode exists to keep out
 * of sight. So this is not a nicety but the invariant's outer edge: at or above
 * it, the requested frame is one Electron can be asked for and get.
 *
 * Read against the picture at its **display fit** — the window a fresh image
 * would be given, a factor of 1 — because that is the frame a remembered size
 * has to produce on whatever image comes next. A size below it is not one the
 * next image could honour without painting background.
 *
 * The same units as the stored factor (a share of the screen), so the answer can
 * be compared with a drag reading directly.
 *
 * @returns the floor, or 1 when the inputs cannot describe a fit.
 */
export function compactWindowMinimumScale(
  imgWidth: number,
  imgHeight: number,
  availWidth: number,
  availHeight: number,
): number {
  if (
    !Number.isFinite(imgWidth) ||
    !Number.isFinite(imgHeight) ||
    !Number.isFinite(availWidth) ||
    !Number.isFinite(availHeight) ||
    imgWidth <= 0 ||
    imgHeight <= 0 ||
    availWidth <= 0 ||
    availHeight <= 0
  ) {
    return 1;
  }

  const { width: maxWidth, height: maxHeight } = compactDisplayCaps(
    availWidth,
    availHeight,
  );
  const displayFit = Math.min(maxWidth / imgWidth, maxHeight / imgHeight);
  if (!(displayFit > 0)) return 1;

  // The picture at its display fit, which is what a share of the screen is
  // measured against — the same base `userScaleFromResize` reads a drag against.
  const largestWidth = imgWidth * displayFit;
  const largestHeight = imgHeight * displayFit;

  const width = (COMPACT_MIN_WINDOW_WIDTH - COMPACT_PADDING * 2) / largestWidth;
  const height =
    (COMPACT_MIN_WINDOW_HEIGHT - COMPACT_PADDING * 2 - COMPACT_BAR_HEIGHT) /
    largestHeight;

  const floor = Math.max(width, height);
  return Number.isFinite(floor) ? Math.min(1, floor) : 1;
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
 * The factor a resized window implies, read as an absolute share of the screen
 * rather than as a multiple of the last size we applied.
 *
 * Absolute is the whole point. A multiplied factor compounds — each drag is
 * measured from the previous one, so a couple of DIPs of frame rounding per pass
 * walks the remembered size in one direction — and, worse, one bad observation
 * used to be permanent: a window the OS had maximised (a double-click on the
 * drag bar does it) looked like "four times the fit", the factor was raised to
 * match, and from then on every image came back at full size with no way down.
 * Measured against a base the image cannot move, a single honest resize
 * re-derives the true share, so any such value heals itself.
 *
 * That base is the picture at the **display fit** — the largest it may be on
 * this screen — which is the same base `compactFitContentSize` multiplies the
 * factor by. The two have to agree or the mode oscillates: read against anything
 * else, the share stored here is one the sizing rule answers with a different
 * window, and the resize that follows re-reads a third value.
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
 * open at the fit times nine. Magnification is the only thing it ever is: the
 * viewer shows no compact window below 1x, the shrink being the size factor's job
 * rather than the zoom's, so the division only ever divides by 1 or more. What it
 * leaves is a statement about the window alone, which is what a size preference
 * is, and that has to happen before
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
  const caps = compactDisplayCaps(availWidth, availHeight);
  if (
    !Number.isFinite(observedWidth) ||
    !Number.isFinite(observedHeight) ||
    !(imgWidth > 0) ||
    !(imgHeight > 0) ||
    !(caps.width > 0) ||
    !(caps.height > 0)
  ) {
    return 1;
  }
  const displayFit = Math.min(caps.width / imgWidth, caps.height / imgHeight);
  const observed = compactImageArea(observedWidth, observedHeight);
  const factor = compactZoomFactor(zoom);

  // Which of the two readings the frame on screen belongs to, decided by the
  // picture rather than by the factor: a window drawn larger than the file's own
  // pixels is the enlarge gesture, and one at or below them is a share of the
  // screen. Measured on the picture **with the magnification taken out**, because
  // that is the size the sizing rule's two readings are defined on — the frame is
  // `pinned x zoom`, so a 3x frame dragged down to the file's own size is a *fit*
  // the user asked for. With the zoom still in it, that same window reads as an
  // enlargement, and the fit it asked for is stored as a multiple of the fit
  // where the rule will read a share of the screen — a window several times the
  // size the user made, on every image that follows.
  const shown =
    Math.max(observed.width / imgWidth, observed.height / imgHeight) / factor;
  // At 1 the two bases give the same picture — the answer is the file's own
  // pixels either way — so which side the boundary falls on changes nothing.
  const base = shown >= 1 ? 1 : displayFit;
  const largest = {
    width: imgWidth * base,
    height: imgHeight * base,
  };

  const scaleW = observed.width / largest.width / factor;
  const scaleH = observed.height / largest.height / factor;

  // An axis held against the display says nothing about the user's preference:
  // there the frame is the work area, not the size they chose, and the
  // magnification is the only thing that put it there. Reading it would store
  // the zoom's own fraction — dragging a 4x frame that is against the edge would
  // remember 0.25 and shrink every window that followed. Both halves of the test
  // are needed: the axis has to be able to reach the cap at this magnification
  // *and* actually be sitting at it, so a user who has pulled the window in
  // below the cap is still read.
  const boundW =
    largest.width * factor >= caps.width - 1 &&
    observed.width >= caps.width - COMPACT_CAP_SLACK;
  const boundH =
    largest.height * factor >= caps.height - 1 &&
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
