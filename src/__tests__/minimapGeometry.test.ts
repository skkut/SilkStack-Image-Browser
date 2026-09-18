import { describe, it, expect } from 'vitest';
import {
  CENTRE_EASING,
  CENTRE_SETTLE_PX,
  MAX_FRAME_MS,
  REFERENCE_FRAME_MS,
  computeViewBox,
  easeCentre,
  fitMinimap,
  frameFactor,
  panForMinimapCentre,
  type MinimapLayout,
  type MinimapMetrics,
  type Point,
} from '../utils/minimapGeometry';

/**
 * The viewer's minimap mapping.
 *
 * Three spaces meet here and the tests name them explicitly: the image's
 * "display" size (its layout size at scale 1, which is what `pan` lives in), the
 * pane's size, and the minimap's own pixels. Everything below is pure arithmetic,
 * so there is no jsdom, no React and no measuring.
 */

/** A 1000x800 image fitted into a 400x300 pane, at 2x. */
const LANDSCAPE: MinimapMetrics = {
  imageWidth: 1000,
  imageHeight: 800,
  viewportWidth: 400,
  viewportHeight: 300,
  zoom: 2,
};

/** min(1, 180/1000, 140/800) = 0.175 → a 175x140 map. */
const LANDSCAPE_LAYOUT: MinimapLayout = {
  width: 175,
  height: 140,
  scale: 0.175,
};

/** The same pane, but the image is taller than it is wide. */
const TALL: MinimapMetrics = {
  imageWidth: 400,
  imageHeight: 2000,
  viewportWidth: 800,
  viewportHeight: 400,
  zoom: 2,
};

/** min(1, 180/400, 140/2000) = 0.07 → a 28x140 map. */
const TALL_LAYOUT: MinimapLayout = { width: 28, height: 140, scale: 0.07 };

describe('fitMinimap', () => {
  it('caps the widest edge of a landscape image', () => {
    // 1000x800: the width cap (180/1000 = 0.18) beats the height cap (140/800).
    expect(fitMinimap(1000, 800)).toEqual({
      width: 175,
      height: 140,
      scale: 0.175,
    });
  });

  it('caps the tallest edge of a portrait image', () => {
    // 400x2000: the height cap (140/2000 = 0.07) wins, so the map is narrow.
    const layout = fitMinimap(400, 2000)!;
    expect(layout.width).toBeCloseTo(28, 10);
    expect(layout.height).toBeCloseTo(140, 10);
    expect(layout.scale).toBeCloseTo(0.07, 10);
  });

  it('scales both axes by the same factor, so the map cannot distort', () => {
    const layout = fitMinimap(1234, 567)!;
    expect(layout.width / 1234).toBeCloseTo(layout.height / 567, 10);
    expect(layout.width / layout.height).toBeCloseTo(1234 / 567, 10);
  });

  it('never enlarges an image smaller than the map box', () => {
    // A 64x64 image keeps its own size rather than being blown up to 180px.
    expect(fitMinimap(64, 64)).toEqual({ width: 64, height: 64, scale: 1 });
  });

  it('reports nothing to draw when a measurement is missing or absurd', () => {
    // What an image that has not loaded yet measures.
    expect(fitMinimap(0, 0)).toBeNull();
    expect(fitMinimap(0, 100)).toBeNull();
    expect(fitMinimap(100, 0)).toBeNull();
    expect(fitMinimap(-100, 100)).toBeNull();
    expect(fitMinimap(Number.NaN, 100)).toBeNull();
    expect(fitMinimap(Number.POSITIVE_INFINITY, 100)).toBeNull();
    expect(fitMinimap(100, 100, 0, 140)).toBeNull();
  });
});

describe('computeViewBox', () => {
  // The layout is passed rather than derived from `metrics`: a caller that varies
  // one number (a different zoom, say) still means the same map.
  const at = (
    pan: { x: number; y: number },
    metrics: MinimapMetrics = LANDSCAPE,
    layout: MinimapLayout = LANDSCAPE_LAYOUT,
  ) => computeViewBox({ ...metrics, pan, layout });

  it('has nothing to say at 1x, where the whole image is already on screen', () => {
    expect(at({ x: 0, y: 0 }, { ...LANDSCAPE, zoom: 1 })).toBeNull();
    expect(at({ x: 0, y: 0 }, { ...LANDSCAPE, zoom: 0.5 })).toBeNull();
  });

  it('reports nothing while the pane or the image is unmeasured', () => {
    expect(at({ x: 0, y: 0 }, { ...LANDSCAPE, viewportWidth: 0 })).toBeNull();
    expect(at({ x: 0, y: 0 }, { ...LANDSCAPE, viewportHeight: 0 })).toBeNull();
    expect(at({ x: 0, y: 0 }, { ...LANDSCAPE, imageWidth: 0 })).toBeNull();
    expect(at({ x: 0, y: 0 }, { ...LANDSCAPE, imageHeight: 0 })).toBeNull();
  });

  it('sits in the middle of the map when the view is centred', () => {
    // Pane centre (500, 400) display → (87.5, 70) map; the window covers
    // 400/2 x 300/2 = 200x150 display = 35x26.25 map, so it starts at
    // 87.5 - 17.5 and 70 - 13.125.
    const box = at({ x: 0, y: 0 })!;
    expect(box.left).toBeCloseTo(70, 10);
    expect(box.top).toBeCloseTo(56.875, 10);
    expect(box.width).toBeCloseTo(35, 10);
    expect(box.height).toBeCloseTo(26.25, 10);
    // Centred: the box's own centre is the map's centre.
    expect(box.left + box.width / 2).toBeCloseTo(175 / 2, 10);
    expect(box.top + box.height / 2).toBeCloseTo(140 / 2, 10);
  });

  it('halves the box when the zoom doubles', () => {
    const wide = at({ x: 0, y: 0 })!;
    const tighter = at({ x: 0, y: 0 }, { ...LANDSCAPE, zoom: 4 })!;
    expect(tighter.width).toBeCloseTo(wide.width / 2, 10);
    expect(tighter.height).toBeCloseTo(wide.height / 2, 10);
  });
  it('reaches the left edge exactly at the pan limit', () => {
    // maxPan.x = (1000 * 2 - 400) / 2 = 800 — the same limit clampPan computes.
    // Panning the image right reveals its left side, so the box is flush left.
    const box = at({ x: 800, y: 0 })!;
    expect(box.left).toBeCloseTo(0, 10);
  });

  it('reaches the right edge exactly at the opposite limit', () => {
    const box = at({ x: -800, y: 0 })!;
    expect(box.left + box.width).toBeCloseTo(175, 10);
  });

  it('spans the whole map on an axis the pane cannot pan', () => {
    // 400 display wide at 2x is 800 — exactly the pane, so there is nothing to
    // pan to and the box covers that axis of the map completely.
    const box = at({ x: 0, y: 0 }, TALL, TALL_LAYOUT)!;
    expect(box.width).toBeCloseTo(28, 10);
    expect(box.left).toBeCloseTo(0, 10);
    // The vertical axis still works: 2000 display at 2x against a 400 pane leaves
    // 800 of travel, and 400/2 = 200 display = 14 map px of window.
    expect(box.height).toBeCloseTo(14, 10);
  });

  it('holds the box on the map when the pan is stale', () => {
    // clampPan is not re-run when the pane resizes, so a stored pan can exceed
    // what the current pane allows. The box must not escape the map for it.
    expect(at({ x: 99999, y: 99999 })!.left).toBeCloseTo(0, 10);
    const out = at({ x: -99999, y: -99999 })!;
    expect(out.left + out.width).toBeCloseTo(175, 10);
    expect(out.top + out.height).toBeCloseTo(140, 10);
  });
});

describe('panForMinimapCentre', () => {
  const centre = (
    centreX: number,
    centreY: number,
    metrics: MinimapMetrics = LANDSCAPE,
    layout: MinimapLayout = LANDSCAPE_LAYOUT,
  ) =>
    panForMinimapCentre({
      ...metrics,
      layout,
      centreX,
      centreY,
    });

  it('round-trips: the pan a box centre implies puts the box back there', () => {
    const cases = [
      { x: 87.5, y: 70 }, // the map's centre
      { x: 20, y: 20 }, // near a corner
      { x: 150, y: 120 }, // and the far one
    ];
    for (const point of cases) {
      const pan = centre(point.x, point.y);
      const box = computeViewBox({
        ...LANDSCAPE,
        pan,
        layout: LANDSCAPE_LAYOUT,
      })!;
      expect(box.left + box.width / 2).toBeCloseTo(point.x, 8);
      expect(box.top + box.height / 2).toBeCloseTo(point.y, 8);
    }
  });

  it('agrees with clampPan exactly at the travel limits', () => {
    // The box's centre can go no further than half a box from the map edge, and
    // that limit is the same constraint as clampPan's ±(iw*zoom - cw)/2. Asking
    // for the extreme must therefore yield the clamp's own value, not a value a
    // few pixels inside it — this is what removes any dead zone at the edges.
    const limitX = (1000 * 2 - 400) / 2;
    const limitY = (800 * 2 - 300) / 2;
    const topLeft = centre(0, 0);
    expect(topLeft.x).toBeCloseTo(limitX, 8);
    expect(topLeft.y).toBeCloseTo(limitY, 8);
    const bottomRight = centre(LANDSCAPE_LAYOUT.width, LANDSCAPE_LAYOUT.height);
    expect(bottomRight.x).toBeCloseTo(-limitX, 8);
    expect(bottomRight.y).toBeCloseTo(-limitY, 8);
  });

  it('pins a capped axis to zero however far the pointer travels', () => {
    // The 400-wide image at 2x exactly fills the 800 pane: no horizontal travel.
    // (The pan it derives is zero to within float dust, which the caller's
    // clampPan then pins exactly.)
    expect(centre(-500, 70, TALL, TALL_LAYOUT).x).toBeCloseTo(0, 8);
    expect(centre(500, 70, TALL, TALL_LAYOUT).x).toBeCloseTo(0, 8);
  });

  it('clamps a centre asked for beyond the map back onto it', () => {
    // Asking for the corner is asking for more travel than exists; the box lands
    // at its limit rather than off the map.
    const box = computeViewBox({
      ...LANDSCAPE,
      pan: centre(500, 500),
      layout: LANDSCAPE_LAYOUT,
    })!;
    expect(box.left + box.width).toBeCloseTo(LANDSCAPE_LAYOUT.width, 8);
    expect(box.top + box.height).toBeCloseTo(LANDSCAPE_LAYOUT.height, 8);
  });

  it('centres an image that fits the pane entirely, on both axes', () => {
    const contained: MinimapMetrics = {
      imageWidth: 400,
      imageHeight: 300,
      viewportWidth: 800,
      viewportHeight: 600,
      zoom: 2,
    };
    const layout = fitMinimap(400, 300)!;
    const pan = panForMinimapCentre({
      ...contained,
      layout,
      centreX: 0,
      centreY: 0,
    });
    expect(pan).toEqual({ x: 0, y: 0 });
  });

  it('reports no movement for degenerate measurements', () => {
    expect(centre(50, 50, { ...LANDSCAPE, imageWidth: 0 })).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      panForMinimapCentre({
        ...LANDSCAPE,
        layout: { width: 0, height: 0, scale: 0 },
        centreX: 50,
        centreY: 50,
      }),
    ).toEqual({ x: 0, y: 0 });
  });
});

/** Runs the easing to a standstill, the way the frame loop in the component does. */
const settle = (
  from: Point,
  target: Point,
  factor = CENTRE_EASING,
  maxFrames = 200,
): { point: Point; frames: number } => {
  let point = from;
  for (let frames = 1; frames <= maxFrames; frames++) {
    const next = easeCentre(point, target, factor);
    point = next.point;
    if (next.settled) return { point, frames };
  }
  return { point, frames: maxFrames };
};

describe('frameFactor', () => {
  it('closes the tuned share in a reference-length frame', () => {
    expect(frameFactor(CENTRE_EASING, REFERENCE_FRAME_MS)).toBeCloseTo(
      CENTRE_EASING,
      10,
    );
  });

  it('closes more of the gap the longer the frame took', () => {
    const short = frameFactor(CENTRE_EASING, REFERENCE_FRAME_MS);
    const long = frameFactor(CENTRE_EASING, REFERENCE_FRAME_MS * 2);
    const longer = frameFactor(CENTRE_EASING, REFERENCE_FRAME_MS * 4);
    expect(long).toBeGreaterThan(short);
    expect(longer).toBeGreaterThan(long);
    // Two half-length frames and one whole one agree, so the smoothing has the
    // same time constant however the frames happen to fall.
    const halves = 1 - (1 - frameFactor(CENTRE_EASING, REFERENCE_FRAME_MS / 2)) ** 2;
    expect(halves).toBeCloseTo(short, 10);
  });

  it('closes nothing in no time at all', () => {
    expect(frameFactor(CENTRE_EASING, 0)).toBe(0);
    expect(frameFactor(CENTRE_EASING, -5)).toBe(0);
    expect(frameFactor(CENTRE_EASING, Number.NaN)).toBe(0);
  });

  it('bounds a stalled frame rather than letting it lurch', () => {
    const stalled = frameFactor(CENTRE_EASING, 5000);
    expect(stalled).toBeCloseTo(frameFactor(CENTRE_EASING, MAX_FRAME_MS), 10);
    // Catching up is the point; overshooting the target is not.
    expect(stalled).toBeLessThan(1);
  });
});

describe('easeCentre', () => {
  it('moves part of the way and never past the target', () => {
    const next = easeCentre({ x: 0, y: 0 }, { x: 100, y: 50 }, CENTRE_EASING);
    expect(next.settled).toBe(false);
    expect(next.point.x).toBeCloseTo(40, 10);
    expect(next.point.y).toBeCloseTo(20, 10);
  });

  it('arrives exactly, in a bounded number of frames', () => {
    // 35 map px is what one pixel of pointer travel is worth in the fixtures above;
    // at 40% a frame it should be done well inside a sixth of a second.
    const { point, frames } = settle({ x: 0, y: 0 }, { x: 35, y: 0 });
    expect(point).toEqual({ x: 35, y: 0 });
    expect(frames).toBeLessThan(20);
  });

  it('never backs away from the target on the way', () => {
    const target = { x: 35, y: -20 };
    let point: Point = { x: 0, y: 0 };
    let previous = Math.hypot(target.x - point.x, target.y - point.y);
    for (let i = 0; i < 30; i++) {
      point = easeCentre(point, target, CENTRE_EASING).point;
      const distance = Math.hypot(target.x - point.x, target.y - point.y);
      expect(distance).toBeLessThanOrEqual(previous);
      previous = distance;
    }
    expect(previous).toBe(0);
  });

  it('has nothing to do when it is already there', () => {
    const there = { x: 12, y: 34 };
    const next = easeCentre(there, there, CENTRE_EASING);
    expect(next.settled).toBe(true);
    // Identical, not merely close: the caller skips its redraw on this being true.
    expect(next.point).toEqual(there);
  });

  it('lands in one frame when asked for the whole distance', () => {
    const next = easeCentre({ x: 0, y: 0 }, { x: 100, y: 0 }, 1);
    expect(next.point).toEqual({ x: 100, y: 0 });
  });

  it('snaps within the settle distance and keeps travelling outside it', () => {
    const target = { x: 10, y: 10 };
    const justInside = easeCentre(
      { x: 10 + CENTRE_SETTLE_PX / 2, y: 10 },
      target,
      CENTRE_EASING,
    );
    expect(justInside.settled).toBe(true);
    expect(justInside.point).toEqual(target);

    const justOutside = easeCentre(
      { x: 10 + CENTRE_SETTLE_PX * 2, y: 10 },
      target,
      CENTRE_EASING,
    );
    expect(justOutside.settled).toBe(false);
  });

  it('stays put when asked for none of it', () => {
    const next = easeCentre({ x: 0, y: 0 }, { x: 100, y: 0 }, 0);
    expect(next.settled).toBe(false);
    expect(next.point).toEqual({ x: 0, y: 0 });
  });

  it('damps a shaking pointer to a standstill', () => {
    // The complaint this easing exists for: a hand tremor of a pixel or so, which
    // the map would otherwise magnify into a couple of hundred pixels of picture.
    // Alternating the target every frame is the worst case — the pointer never
    // rests, so the easing can never fully catch up.
    let point: Point = { x: 100, y: 100 };
    // Seeded by the first *sampled* frame, not by the starting point: the band is
    // what the shake settles into, not how far it travelled getting there.
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let widestStep = 0;
    for (let frame = 0; frame < 120; frame++) {
      const target = { x: 100 + (frame % 2), y: 100 };
      const before = point;
      point = easeCentre(point, target, CENTRE_EASING).point;
      if (frame >= 60) {
        min = Math.min(min, point.x);
        max = Math.max(max, point.x);
        widestStep = Math.max(widestStep, Math.abs(point.x - before.x));
      }
    }
    // Rather than swinging the full pixel the pointer does, it settles into a band
    // a fraction of that wide, moving a fraction of a pixel each frame. Both are
    // comfortably under half the tremor, so this fails if the easing is weakened
    // or removed — a raw pointer would give a band and a step of 1.
    expect(point.x).toBeGreaterThanOrEqual(100);
    expect(point.x).toBeLessThanOrEqual(101);
    expect(max - min).toBeLessThan(0.5);
    expect(widestStep).toBeLessThan(0.5);
  });
});
