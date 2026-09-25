import { describe, it, expect } from 'vitest';
import {
  computeCompactContentSize,
  compactPinnedSize,
  compactPanAxes,
  parseDimensionsString,
  compactImageArea,
  clampUserScale,
  userScaleFromResize,
  COMPACT_BAR_HEIGHT,
  COMPACT_PADDING,
  COMPACT_MAX_FRACTION,
  COMPACT_MIN_USER_SCALE,
  COMPACT_MAX_USER_SCALE,
} from '../utils/windowSizing';

/**
 * Compact ("frame the image") window sizing.
 *
 * The contract: the window's content area ends up exactly the image's aspect
 * ratio plus equal padding on all four sides, with the drag bar stacked on top;
 * the image is never scaled above 1x by the automatic fit; the user's own size
 * factor may enlarge it but can never push the window past the work area.
 */

const CONTENT_BUDGET = (avail: number) => Math.floor(avail * COMPACT_MAX_FRACTION);

describe('computeCompactContentSize', () => {
  it('sizes a landscape image to fit the width budget with equal padding', () => {
    // maxWidth = 1000 - 16 = 984 → scale 0.984 → 984 x 492.
    expect(computeCompactContentSize(1000, 500, 1000, 1000)).toEqual({
      contentWidth: 984 + COMPACT_PADDING * 2,
      contentHeight: 492 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('sizes a portrait image to fit the height budget instead', () => {
    // maxHeight = 1000 - 16 - 32 = 952 → scale 0.952 → 476 x 952.
    expect(computeCompactContentSize(500, 1000, 1000, 1000)).toEqual({
      contentWidth: 476 + COMPACT_PADDING * 2,
      contentHeight: 952 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('never upscales a small image', () => {
    expect(computeCompactContentSize(200, 200, 1920, 1080)).toEqual({
      contentWidth: 200 + COMPACT_PADDING * 2,
      contentHeight: 200 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('keeps the content area within the max fraction of the work area', () => {
    const cases: Array<[number, number]> = [
      [1920, 1080],
      [1080, 1920],
      [8000, 4000],
      [512, 512],
      [4000, 8000],
    ];
    for (const [imgWidth, imgHeight] of cases) {
      const size = computeCompactContentSize(imgWidth, imgHeight, 1920, 1040);
      expect(size).not.toBeNull();
      // The whole content region (image + padding + bar) must fit the budget…
      expect(size!.contentWidth).toBeLessThanOrEqual(CONTENT_BUDGET(1920));
      expect(size!.contentHeight).toBeLessThanOrEqual(CONTENT_BUDGET(1040));
      // …and the image area it leaves is close to the image's own aspect ratio
      // (rounding to whole pixels is the only slack).
      const area = compactImageArea(size!.contentWidth, size!.contentHeight);
      expect(Math.abs(area.width / area.height - imgWidth / imgHeight))
        .toBeLessThan(0.01);
    }
  });

  it('scales down a huge image rather than clipping it', () => {
    const size = computeCompactContentSize(8000, 4000, 1000, 1000);
    expect(size).toEqual({
      contentWidth: 984 + COMPACT_PADDING * 2,
      contentHeight: 492 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('returns null for unusable inputs', () => {
    expect(computeCompactContentSize(0, 100, 1000, 1000)).toBeNull();
    expect(computeCompactContentSize(100, 0, 1000, 1000)).toBeNull();
    expect(computeCompactContentSize(-5, 100, 1000, 1000)).toBeNull();
    expect(computeCompactContentSize(NaN, 100, 1000, 1000)).toBeNull();
    // A work area too short to hold the bar and padding at all.
    expect(computeCompactContentSize(100, 100, 1000, 0)).toBeNull();
  });
});

describe('computeCompactContentSize with a user size factor', () => {
  it('shrinks the image area without touching the padding or bar', () => {
    // 0.984 fit × 0.5 → 492 x 246, so the chrome stays 16 + 32.
    expect(computeCompactContentSize(1000, 500, 1000, 1000, 0.5)).toEqual({
      contentWidth: 492 + COMPACT_PADDING * 2,
      contentHeight: 246 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('lets a factor above 1 enlarge an image that the fit left small', () => {
    // A 200x200 file fits untouched; 2x is the user asking for more.
    expect(computeCompactContentSize(200, 200, 1920, 1080, 2)).toEqual({
      contentWidth: 400 + COMPACT_PADDING * 2,
      contentHeight: 400 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('caps even a large factor at the work area', () => {
    // 4x of a 2000px-wide image would be 8000px; the fit (0.492) wins.
    expect(computeCompactContentSize(2000, 1000, 1000, 1000, 4)).toEqual(
      computeCompactContentSize(2000, 1000, 1000, 1000),
    );
  });

  it('keeps the aspect ratio exact at any factor', () => {
    for (const factor of [0.3, 0.5, 0.75, 1, 1.5, 3]) {
      const size = computeCompactContentSize(1600, 900, 1920, 1040, factor)!;
      const area = compactImageArea(size.contentWidth, size.contentHeight);
      expect(Math.abs(area.width / area.height - 1600 / 900)).toBeLessThan(0.01);
    }
  });
});

describe('computeCompactContentSize with a zoom', () => {
  // A 200x100 file is never upscaled by the fit, so it is the case where the
  // zoom has room to enlarge the window: maxWidth 984 / 200 = 4.92 is the
  // ceiling on the scale.
  const SMALL = [200, 100, 1000, 1000] as const;

  it('grows the window with the magnification', () => {
    expect(computeCompactContentSize(...SMALL, 1, 2)).toEqual({
      contentWidth: 400 + COMPACT_PADDING * 2,
      contentHeight: 200 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('treats an omitted, sub-1 or nonsensical zoom as no magnification', () => {
    // The fit is the smallest a compact window goes: below 1x the picture could
    // no longer fill it, so those values are the fit's own answer.
    const fit = computeCompactContentSize(...SMALL);
    expect(computeCompactContentSize(...SMALL, 1, 1)).toEqual(fit);
    expect(computeCompactContentSize(...SMALL, 1, 0.5)).toEqual(fit);
    expect(computeCompactContentSize(...SMALL, 1, NaN)).toEqual(fit);
    expect(computeCompactContentSize(...SMALL, 1, -3)).toEqual(fit);
  });

  it('multiplies the zoom with the user size factor', () => {
    // 0.5 x 4 is the fit at 2x, the same window as a plain 4x of this image.
    expect(computeCompactContentSize(...SMALL, 0.5, 4)).toEqual(
      computeCompactContentSize(...SMALL, 1, 2),
    );
  });

  it('grows each axis until the display stops it, not both at once', () => {
    // 10x of a 200x100 picture is 2000x1000 and the display holds 984x952 of
    // it, so the width runs out at 4.92x and the height only at 9.52x. One
    // shared factor would have frozen the frame at the first of the two and left
    // every later step to the picture alone.
    expect(computeCompactContentSize(...SMALL, 1, 10)).toEqual({
      contentWidth: 984 + COMPACT_PADDING * 2,
      contentHeight: 952 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
    // …so 8x is already as wide as the screen and not yet as tall.
    expect(computeCompactContentSize(...SMALL, 1, 8)).toEqual({
      contentWidth: 984 + COMPACT_PADDING * 2,
      contentHeight: 800 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('never lets the frame outgrow the picture on either axis', () => {
    // This — not a shared aspect ratio — is what makes the bands impossible: the
    // viewer lays the picture out at the 1x fit and scales it by the zoom, so a
    // frame no larger than that on each axis is always covered by it. Rounding
    // down is what keeps the guarantee to the pixel.
    for (const zoom of [1, 1.5, 2, 4, 4.92, 8, 50]) {
      const size = computeCompactContentSize(...SMALL, 1, zoom)!;
      const area = compactImageArea(size.contentWidth, size.contentHeight);
      expect(area.width).toBeLessThanOrEqual(200 * zoom);
      expect(area.height).toBeLessThanOrEqual(100 * zoom);
      // …and never outside the display.
      expect(area.width).toBeLessThanOrEqual(984);
      expect(area.height).toBeLessThanOrEqual(952);
    }
  });

  it('keeps the aspect exact until an axis is bound', () => {
    // Up to the first cap the frame is the picture scaled, so it is the picture's
    // shape — which is what "framed" means. 4.92x is exactly the width's cap.
    for (const zoom of [1, 1.5, 2, 4, 4.92]) {
      const size = computeCompactContentSize(...SMALL, 1, zoom)!;
      const area = compactImageArea(size.contentWidth, size.contentHeight);
      expect(Math.abs(area.width / area.height - 2)).toBeLessThan(0.01);
    }
  });
});

describe('computeCompactContentSize on a display that binds one axis', () => {
  // The display the report came from, and the shape that prompted the per-axis
  // clamp: a portrait file on a 2048x1104 work area is out of height at 1:1 with
  // most of the width still free. Clamping both axes by the zoom's own factor
  // left the frame exactly the size it already was, so zooming a portrait image
  // — and a 1024x1024, and a 1920x1080 — did nothing visible at all.
  const WIDE = [2048, 1104] as const;

  it('frames the whole picture at 1x', () => {
    // 1056 is the height budget, and 832 x 1056/1216 = 722.5 of width with it.
    expect(computeCompactContentSize(832, 1216, ...WIDE)).toEqual({
      contentWidth: 723 + COMPACT_PADDING * 2,
      contentHeight: 1056 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('grows into the free axis as soon as it is zoomed', () => {
    // At 2x the picture is 1446x2112: the frame takes all 1446 of width the
    // display has to give and stays at the height it is bound to. Before the
    // per-axis clamp it stayed 739 wide at every step of the zoom.
    expect(computeCompactContentSize(832, 1216, ...WIDE, 1, 2)).toEqual({
      contentWidth: 1446 + COMPACT_PADDING * 2,
      contentHeight: 1056 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('fills the display once both axes are bound', () => {
    // 3x is 2169x3168 of picture — past both caps, so the frame is the display
    // and the rest of the magnification is the picture cropped inside it. (The
    // width binds at 2.81x, where 723 x 2.81 reaches 2032; between 2x and there
    // it is still growing, which is the whole point.)
    expect(computeCompactContentSize(832, 1216, ...WIDE, 1, 3)).toEqual({
      contentWidth: 2032 + COMPACT_PADDING * 2,
      contentHeight: 1056 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('grows a landscape image that the height alone had bound', () => {
    // 1920x1080 fits a 2048x1104 work area at 1877x1056 — 0% of headroom, and
    // the second case in the report: a wide image with a wide screen still had
    // nothing to grow into. At 2x it takes the 2032 the display gives.
    expect(computeCompactContentSize(1920, 1080, ...WIDE, 1, 2)).toEqual({
      contentWidth: 2032 + COMPACT_PADDING * 2,
      contentHeight: 1056 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });
});

describe('compactImageArea', () => {
  it('subtracts the padding on all sides and the drag bar on top', () => {
    expect(compactImageArea(1000, 540)).toEqual({ width: 984, height: 492 });
  });

  it('never returns a non-positive area', () => {
    expect(compactImageArea(4, 4)).toEqual({ width: 1, height: 1 });
  });
});

describe('compactPinnedSize', () => {
  it('is the fit at the user factor, with the zoom left out of it', () => {
    // The size the viewer pins its <img> to and the base every frame size is
    // grown from, which is why there is one definition of it: the picture and
    // the frame cannot disagree about what 1x is.
    expect(compactPinnedSize(1000, 500, 1000, 1000)).toEqual({
      width: 984,
      height: 492,
    });
    expect(compactPinnedSize(1000, 500, 1000, 1000, 0.5)).toEqual({
      width: 492,
      height: 246,
    });
  });

  it('returns null for inputs that cannot describe a fit', () => {
    expect(compactPinnedSize(0, 10, 100, 100)).toBeNull();
    expect(compactPinnedSize(10, 10, Number.NaN, 100)).toBeNull();
  });
});

describe('compactPanAxes', () => {
  // The display the report came from: 2048 x 1104 of work area, which is
  // 2032 x 1056 of image area once the padding and the drag bar are paid for.
  const WIDE = [2048, 1104] as const;

  it('pans neither axis while the frame can still hold the whole picture', () => {
    // A frame that grows until it holds the picture leaves the middle as the
    // only position the picture can end up in, so a pan taken against the
    // smaller pane it is in now is motion the resize is about to undo.
    expect(compactPanAxes(400, 300, ...WIDE)).toEqual({
      width: false,
      height: false,
    });
    expect(compactPanAxes(400, 300, ...WIDE, 1, 3)).toEqual({
      width: false,
      height: false,
    });
  });

  it('hands over an axis as soon as the display stops the frame on it', () => {
    // The height runs out at 3.52x (1056 / 300) and the width not until 5.08x
    // (2032 / 400), so between the two there is exactly one axis to pan — and a
    // pan along it is now measured against a pane that will not change.
    expect(compactPanAxes(400, 300, ...WIDE, 1, 3.6)).toEqual({
      width: false,
      height: true,
    });
    expect(compactPanAxes(400, 300, ...WIDE, 1, 5.2)).toEqual({
      width: true,
      height: true,
    });
  });

  it('follows the free axis of an image the fit had already bound', () => {
    // 832x1216 on that display is out of height at 1x with most of the width to
    // spare: the frame grows into the width and stays at the height, so the
    // wheel may pan vertically and must not slide the picture sideways.
    expect(compactPanAxes(832, 1216, ...WIDE)).toEqual({
      width: false,
      height: false,
    });
    expect(compactPanAxes(832, 1216, ...WIDE, 1, 2)).toEqual({
      width: false,
      height: true,
    });
    // 723 x 2.81 reaches the 2032 the display has, so by 3x both axes are held.
    expect(compactPanAxes(832, 1216, ...WIDE, 1, 3)).toEqual({
      width: true,
      height: true,
    });
  });

  it('does not call a crop the padding absorbs a pan', () => {
    // 984x952 is exactly what fills a 1000x1000 work area, and the picture keeps
    // 8px of padding inside its pane on all four sides. A picture up to 16px
    // larger than the frame can therefore be slid entirely within that margin —
    // which shows nothing, so there is nothing to anchor a magnification on, and
    // the frame is at its cap the whole way. Past it the picture is really cut
    // off, and the wheel may move it. (The boundary is the work area itself:
    // 1000 / 984 = 1.0163x.)
    const NOTHING_TO_DRAG = { width: false, height: false };
    expect(compactPanAxes(984, 952, 1000, 1000)).toEqual(NOTHING_TO_DRAG);
    expect(compactPanAxes(984, 952, 1000, 1000, 1, 1.001)).toEqual(
      NOTHING_TO_DRAG,
    );
    expect(compactPanAxes(984, 952, 1000, 1000, 1, 1.015)).toEqual(
      NOTHING_TO_DRAG,
    );
    expect(compactPanAxes(984, 952, 1000, 1000, 1, 1.02)).toEqual({
      width: true,
      height: true,
    });
  });

  it('treats an omitted or below-1 zoom as no magnification', () => {
    // The frame never goes below the fit, so a zoom under 1 is not a
    // magnification and cannot make pannable an axis the fit left whole.
    expect(compactPanAxes(984, 952, 1000, 1000, 1, 0.5)).toEqual({
      width: false,
      height: false,
    });
    expect(compactPanAxes(984, 952, 1000, 1000, 1, Number.NaN)).toEqual({
      width: false,
      height: false,
    });
  });

  it('reports an unreadable fit as pannable on neither axis', () => {
    // With no evidence that the picture is cropped, leaving it where it is
    // cannot be wrong — and cannot shift it.
    expect(compactPanAxes(0, 0, 1000, 1000)).toEqual({
      width: false,
      height: false,
    });
    expect(compactPanAxes(100, 100, Number.NaN, 1000)).toEqual({
      width: false,
      height: false,
    });
  });

  it('describes the frame the sizing rule actually asks for', () => {
    // The predicate is a reading of `computeCompactContentSize`, not a second
    // rule of its own: an axis is pannable exactly when the picture is larger
    // than the pane the viewer will be showing it in — which is the window's
    // content area, less the drag bar, since the bar is stacked above the pane
    // rather than inside it. If the sizing ever clamps differently, this fails
    // rather than the two quietly drifting apart.
    const cases: [number, number, number, number][] = [
      [400, 300, 1, 3.6],
      [832, 1216, 1, 2],
      [832, 1216, 1, 3],
      [1920, 1080, 1, 2],
      [984, 952, 1, 1.015],
      [984, 952, 1, 1.02],
      [1000, 500, 0.5, 2.5],
    ];
    for (const [width, height, userScale, zoom] of cases) {
      const size = computeCompactContentSize(
        width,
        height,
        ...WIDE,
        userScale,
        zoom,
      )!;
      const pin = compactPinnedSize(width, height, ...WIDE, userScale)!;
      const axes = compactPanAxes(width, height, ...WIDE, userScale, zoom);
      expect(axes.width).toBe(size.contentWidth < pin.width * zoom - 1);
      expect(axes.height).toBe(
        size.contentHeight - COMPACT_BAR_HEIGHT < pin.height * zoom - 1,
      );
    }
  });
});

describe('clampUserScale', () => {
  it('treats a missing or nonsensical factor as "no preference"', () => {
    expect(clampUserScale(Number(null))).toBe(1);
    expect(clampUserScale(NaN)).toBe(1);
    expect(clampUserScale(0)).toBe(1);
    expect(clampUserScale(-2)).toBe(1);
  });

  it('keeps a real factor inside its bounds', () => {
    expect(clampUserScale(0.7)).toBe(0.7);
    expect(clampUserScale(0.01)).toBe(COMPACT_MIN_USER_SCALE);
    expect(clampUserScale(99)).toBe(COMPACT_MAX_USER_SCALE);
  });
});

describe('userScaleFromResize', () => {
  // A 1000x500 file in a 1000x1000 work area fits at 984x492 (its width is the
  // limit), so the fit's image area is 984x492 and a proportional drag lands on
  // clean fractions of it.
  const FIT = [1000, 500, 1000, 1000] as const;

  it('reads a proportional drag', () => {
    // 984x492 of picture, less the padding and bar, on both axes. A drag lands
    // on whole pixels, so the read is quantised to ~1/492 — two decimals is the
    // resolution a hand-resize actually has.
    expect(userScaleFromResize(...FIT, 704, 392)).toBeCloseTo(0.7, 2);
  });

  it('reads a drag that moved only one edge', () => {
    // Width-only and height-only: the untouched axis must not dilute the read.
    expect(userScaleFromResize(...FIT, 704, 540)).toBeCloseTo(0.7, 2);
    expect(userScaleFromResize(...FIT, 1000, 392)).toBeCloseTo(0.7, 2);
  });

  it('reports what the window is, not what it is replacing', () => {
    // A window at 75% of the fit reads as 0.75. The read used to be multiplied
    // into whatever factor was already in force, so this same window meant 0.6
    // after a 0.8 preference — which is how one bad value, a maximised frame
    // read as "several times the fit", came to inflate every later image.
    expect(userScaleFromResize(...FIT, 754, 417)).toBeCloseTo(0.75, 5);
  });

  it('reads a work-area-filling window as the fit, never as an enlargement', () => {
    // The maximised-frame shape. At worst it says "as big as the display
    // allows", which is the value already in force at 1 — so even a maximise
    // that slipped past the main process could not push the preference past
    // what the screen can show.
    expect(userScaleFromResize(4000, 2000, 2048, 1104, 2048, 1064)).toBeCloseTo(1, 3);
  });

  it('measures the image area, not the content', () => {
    // Halving the *content* takes more than half the picture, because the
    // padding and bar are a fixed cost that does not shrink with it. Reading
    // the raw content ratio would store 0.7 and creep the window down.
    const factor = userScaleFromResize(...FIT, 700, 378);
    expect(factor).toBeCloseTo(330 / 492, 5); // the height's area ratio
    expect(factor).toBeLessThan(0.7);
  });

  it('lets a small image be dragged larger than its own fit', () => {
    // A 200x200 file fits at 200x200 — nothing is ever upscaled — so a bigger
    // window is a statement of preference, not an artefact. Clamping here would
    // make "make this window bigger" impossible for every small image.
    expect(userScaleFromResize(200, 200, 1000, 1000, 416, 448)).toBeCloseTo(2, 4);
  });

  it('clamps a degenerate drag instead of collapsing the window', () => {
    expect(userScaleFromResize(...FIT, 5, 3)).toBe(COMPACT_MIN_USER_SCALE);
  });

  // The same 200x100 file, whose fit is its own size, so a zoomed frame is a
  // clean multiple of it. At 3x the window's content is 616x348 (600x300 of
  // picture, then the padding and bar).
  const SMALL = [200, 100, 1000, 1000] as const;

  it('reads a drag of a zoomed window as a fraction of the fit', () => {
    // 70% of the 3x frame: the raw ratio says 2.1, which is the frame's
    // magnification and not the user's preference. Remembering it would open
    // every later image at 3x of their own fit, for ever.
    expect(userScaleFromResize(...SMALL, 436, 258, 3)).toBeCloseTo(0.7, 5);
  });

  it('ignores an axis the magnification has pushed against the display', () => {
    // A 10x frame is 984x952 of picture — the display, since 2000x1000 of
    // picture is more than it holds — and the user drags the height in to 600
    // DIP. Read raw, the width says 0.492: that is the cap divided by the zoom,
    // not a window anybody chose. The height says 0.552, which is the honest
    // statement about the window. One shared reading would have remembered the
    // first and shrunk every later window.
    expect(userScaleFromResize(...SMALL, 1000, 600, 10)).toBeCloseTo(0.552, 3);
  });

  it('reads a frame against the display on both axes as no preference', () => {
    // Nothing has been dragged — there is nowhere to drag it to — so the honest
    // answer is the fit, not the zoom's own fraction of it. Left to the dominant
    // axis this same window reads 0.492 and becomes permanent.
    expect(userScaleFromResize(...SMALL, 1000, 1000, 10)).toBe(1);
  });

  it('does not read a zoomed frame as an enlargement nobody asked for', () => {
    // The window exactly as the zoom left it: the user has stated nothing about
    // size, and the neutral answer is what keeps the next image framed.
    expect(userScaleFromResize(...SMALL, 616, 348, 3)).toBeCloseTo(1, 5);
  });

  it('treats an omitted or nonsensical zoom as no magnification', () => {
    // The default keeps the reading raw, which is what a caller that has no
    // zoom to declare — or a broken one — is saying.
    expect(userScaleFromResize(...SMALL, 616, 348)).toBeCloseTo(3, 5);
    expect(userScaleFromResize(...SMALL, 616, 348, NaN)).toBeCloseTo(3, 5);
    expect(userScaleFromResize(...SMALL, 616, 348, 0.5)).toBeCloseTo(3, 5);
  });

  it('ignores unusable input', () => {
    // No fit to compare against: 1 is the neutral answer, and the caller only
    // trusts a factor it can see a change in.
    expect(userScaleFromResize(0, 0, 1000, 1000, 704, 392)).toBe(1);
    expect(userScaleFromResize(1000, 500, 10, 10, 704, 392)).toBe(1);
    expect(userScaleFromResize(...FIT, NaN, 392)).toBe(1);
  });
});

describe('parseDimensionsString', () => {
  it('parses the indexer "WxH" format', () => {
    expect(parseDimensionsString('1344x768')).toEqual({
      width: 1344,
      height: 768,
    });
    expect(parseDimensionsString('1344 x 768')).toEqual({
      width: 1344,
      height: 768,
    });
  });

  it('rejects missing or degenerate values', () => {
    expect(parseDimensionsString(undefined)).toBeNull();
    expect(parseDimensionsString(null)).toBeNull();
    expect(parseDimensionsString('unknown')).toBeNull();
    expect(parseDimensionsString('0x100')).toBeNull();
  });
});
