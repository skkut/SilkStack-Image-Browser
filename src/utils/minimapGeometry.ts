/**
 * View-box math for the viewer's minimap (navigator).
 *
 * Deliberately pure and DOM-free: the caller measures the pane and the image and
 * hands the numbers in, so the whole mapping is unit-testable without jsdom.
 *
 * Two spaces are in play:
 * - "display" px — the image's rendered size at scale 1, which is what `pan` and
 *   `clampPan` in ImageModal already work in (`scale()` is a CSS transform, so it
 *   never changes `clientWidth`);
 * - "map" px — the minimap's own pixels, related to display px by one uniform
 *   factor so the map can never disagree with the image's aspect ratio.
 *
 * The mapping is anchored on the *map centre* of the view box rather than on a
 * pan delta: a drag asks for a centre and the pan is derived from it. That is what
 * makes a wheel-zoom mid-drag leave the box exactly where the pointer put it, and
 * what lets one function serve both the click-to-travel and drag gestures.
 */

/** Largest the minimap may be, in CSS px. The image fits inside this box. */
export const MINIMAP_MAX_WIDTH = 180;
export const MINIMAP_MAX_HEIGHT = 140;

export interface Point {
  x: number;
  y: number;
}

export interface MinimapLayout {
  width: number;
  height: number;
  /** Map px per display px — the one factor both directions of the mapping use. */
  scale: number;
}

/** The visible region, in minimap px, relative to the map's own top-left. */
export interface ViewBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** What the mapping needs to know about the pane and the image. */
export interface MinimapMetrics {
  /** The image's laid-out size at scale 1 — `imgRef.current.clientWidth/Height`. */
  imageWidth: number;
  imageHeight: number;
  /** The pane's size — `containerRef.current.clientWidth/Height`, as `clampPan` uses. */
  viewportWidth: number;
  viewportHeight: number;
  zoom: number;
}

const isPositive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Fit the image into the minimap's maximum box, preserving its aspect ratio.
 * Never enlarges past 1:1 (a small image gets a small map, not a blurry one), and
 * reports null for any degenerate input — an unloaded image measures 0x0.
 */
export function fitMinimap(
  imageWidth: number,
  imageHeight: number,
  maxWidth: number = MINIMAP_MAX_WIDTH,
  maxHeight: number = MINIMAP_MAX_HEIGHT,
): MinimapLayout | null {
  if (
    !isPositive(imageWidth) ||
    !isPositive(imageHeight) ||
    !isPositive(maxWidth) ||
    !isPositive(maxHeight)
  ) {
    return null;
  }

  const scale = Math.min(1, maxWidth / imageWidth, maxHeight / imageHeight);
  return {
    width: imageWidth * scale,
    height: imageHeight * scale,
    scale,
  };
}

/** How much of the image the pane covers, in display px. */
function visibleExtent(
  metrics: MinimapMetrics,
  layout: MinimapLayout,
): { width: number; height: number } {
  const { imageWidth, imageHeight, viewportWidth, viewportHeight, zoom } =
    metrics;
  return {
    // A pane-sized window, but never more than the image itself: on an axis where
    // even the zoomed image is still smaller than the pane, all of it is visible.
    width: Math.min(imageWidth, viewportWidth / zoom) * layout.scale,
    height: Math.min(imageHeight, viewportHeight / zoom) * layout.scale,
  };
}

export interface ViewBoxInput extends MinimapMetrics {
  pan: Point;
  layout: MinimapLayout;
}

/**
 * The pane's visible window, expressed in minimap px.
 *
 * At scale 1 the whole image is on screen and the box would cover the whole map,
 * so this reports null: the map has nothing to say until the user zooms in.
 */
export function computeViewBox(input: ViewBoxInput): ViewBox | null {
  const { imageWidth, imageHeight, pan, layout } = input;

  if (!isPositive(imageWidth) || !isPositive(imageHeight)) return null;
  if (!isPositive(input.viewportWidth) || !isPositive(input.viewportHeight))
    return null;
  if (!layout || !isPositive(layout.scale)) return null;
  if (!Number.isFinite(input.zoom) || input.zoom <= 1) return null;

  const extent = visibleExtent(input, layout);

  // Where the pane's centre sits on the image. Panning the image right (+x)
  // reveals what was to the left of the previous centre, hence the minus.
  const centreX = imageWidth / 2 - pan.x / input.zoom;
  const centreY = imageHeight / 2 - pan.y / input.zoom;

  // `clampPan` keeps the box inside the image already; this keeps it there anyway
  // when the pane is resized out from under a live drag.
  const left = clamp(
    centreX * layout.scale - extent.width / 2,
    0,
    layout.width - extent.width,
  );
  const top = clamp(
    centreY * layout.scale - extent.height / 2,
    0,
    layout.height - extent.height,
  );

  return { left, top, width: extent.width, height: extent.height };
}

export interface PanForCentreInput extends MinimapMetrics {
  layout: MinimapLayout;
  /** Where the centre of the view box should sit, in minimap px. */
  centreX: number;
  centreY: number;
}

/**
 * The pan that puts the view box's centre at a point on the minimap — the one
 * operation behind both "click to travel there" and "drag the box".
 *
 * The centre is clamped so the box stays on the map. That clamp agrees exactly
 * with `clampPan`'s limits (both are the point where the box meets the edge), so
 * a drag has no dead zone at the edges: it stops when the box stops and resumes
 * the instant the pointer comes back.
 */
export function panForMinimapCentre(input: PanForCentreInput): Point {
  const { imageWidth, imageHeight, zoom, layout, centreX, centreY } = input;
  if (!isPositive(layout?.scale) || !isPositive(zoom)) return { x: 0, y: 0 };
  if (!isPositive(imageWidth) || !isPositive(imageHeight)) return { x: 0, y: 0 };

  const extent = visibleExtent(input, layout);
  const clampedX = clamp(
    centreX,
    extent.width / 2,
    layout.width - extent.width / 2,
  );
  const clampedY = clamp(
    centreY,
    extent.height / 2,
    layout.height - extent.height / 2,
  );

  return {
    x: zoom * (imageWidth / 2 - clampedX / layout.scale),
    y: zoom * (imageHeight / 2 - clampedY / layout.scale),
  };
}

/**
 * Drag smoothing.
 *
 * Pointer positions arrive in whole CSS px and the map magnifies them: one map
 * pixel is `zoom / scale` image pixels, which on a 4000px image at 10x is 222 px
 * of travel, because the view box is only 3.6 px wide up there. Applied straight,
 * a steady drag arrives as a staircase of those steps and a 1px tremor is
 * amplified by the same factor.
 *
 * So the pointer only sets a *target* and the applied centre eases toward it. That
 * interpolates the steps into a ramp and low-passes the tremor, while still
 * following intent: a deliberate drag closes the gap in a few frames, whereas
 * jitter that reverses every frame largely cancels itself out.
 */

/** The frame length the easing is tuned for. */
export const REFERENCE_FRAME_MS = 1000 / 60;
/** Longest frame the easing will believe in — a stall should catch up, not lurch. */
export const MAX_FRAME_MS = 64;
/** Share of the remaining distance closed per reference-length frame. */
export const CENTRE_EASING = 0.4;
/** Within this distance of the target the centre has arrived, in map px. */
export const CENTRE_SETTLE_PX = 0.05;

/**
 * The share to close in a frame that actually took `dtMs`. Without this the
 * smoothing would have a different time constant at 60Hz and 144Hz, and a stalled
 * frame would leave the box further behind instead of letting it catch up.
 */
export function frameFactor(base: number, dtMs: number): number {
  const frames = clamp(dtMs, 0, MAX_FRAME_MS) / REFERENCE_FRAME_MS;
  if (!(frames > 0)) return 0;
  return 1 - Math.pow(1 - base, frames);
}

export interface EasedCentre {
  point: Point;
  /** True once the centre is on the target — the caller can stop redrawing. */
  settled: boolean;
}

/**
 * One frame of that easing. Snaps exactly onto the target within `settle`, rather
 * than approaching it forever, so a drag always finishes at the position asked for
 * and an idle pointer stops producing work.
 */
export function easeCentre(
  current: Point,
  target: Point,
  factor: number,
  settle: number = CENTRE_SETTLE_PX,
): EasedCentre {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  if (Math.abs(dx) <= settle && Math.abs(dy) <= settle) {
    return { point: { x: target.x, y: target.y }, settled: true };
  }
  const share = clamp(factor, 0, 1);
  return {
    point: { x: current.x + dx * share, y: current.y + dy * share },
    settled: false,
  };
}
