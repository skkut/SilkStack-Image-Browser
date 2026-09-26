import { describe, it, expect } from 'vitest';
import {
  computeCompactContentSize,
  compactPinnedSize,
  compactMinUserScale,
  compactWindowMinimumScale,
  compactDisplayCaps,
  compactPanAxes,
  parseDimensionsString,
  compactImageArea,
  clampUserScale,
  userScaleFromResize,
  COMPACT_BAR_HEIGHT,
  COMPACT_PADDING,
  COMPACT_MAX_FRACTION,
  COMPACT_MIN_FRACTION,
  COMPACT_MIN_USER_SCALE,
  COMPACT_MAX_USER_SCALE,
  COMPACT_MIN_WINDOW_WIDTH,
  COMPACT_MIN_WINDOW_HEIGHT,
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

  it('treats an omitted or nonsensical zoom as no magnification', () => {
    // Zoom is a multiplier, so only a positive one means anything: NaN, zero and
    // negatives are a caller that has no magnification to declare, and the fit is
    // the answer that changes nothing.
    const fit = computeCompactContentSize(...SMALL);
    expect(computeCompactContentSize(...SMALL, 1, 1)).toEqual(fit);
    expect(computeCompactContentSize(...SMALL, 1, 0)).toEqual(fit);
    expect(computeCompactContentSize(...SMALL, 1, NaN)).toEqual(fit);
    expect(computeCompactContentSize(...SMALL, 1, -3)).toEqual(fit);
  });

  it('shrinks the frame below the fit for a zoom under 1', () => {
    // The fit stopped being a floor when the frame and the picture both started
    // from the pinned size. The viewer lays the picture out at that pinned 200x100
    // and magnifies it with a transform, so at 0.5x a 100x50 frame is covered by
    // it exactly as a 400x200 one is at 2x — zooming out takes the window down
    // with the picture rather than running out of room at the fit. The viewer asks
    // for this shape no longer — it shrinks a window through the size factor, so
    // the size survives into the next image — but a frame smaller than the picture
    // is a size this rule has to answer for either way.
    expect(computeCompactContentSize(...SMALL, 1, 0.5)).toEqual({
      contentWidth: 100 + COMPACT_PADDING * 2,
      contentHeight: 50 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
    expect(computeCompactContentSize(...SMALL, 1, 0.25)).toEqual({
      contentWidth: 50 + COMPACT_PADDING * 2,
      contentHeight: 25 + COMPACT_PADDING * 2 + COMPACT_BAR_HEIGHT,
    });
  });

  it('multiplies the zoom with the user size factor', () => {
    // The frame is the pinned size times the magnification and the pin is the
    // factor's own size, so a factor and a zoom with the same product are the same
    // window: half the factor and twice the zoom cancel exactly. On a
    // screen-filling file, because a factor below 1 is capped at the display fit
    // and the product only survives below that cap.
    expect(computeCompactContentSize(1000, 500, 1000, 1000, 0.25, 2)).toEqual(
      computeCompactContentSize(1000, 500, 1000, 1000, 0.5, 1),
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
    // …and it holds below the fit for the same reason: a frame a quarter the size
    // of the picture is covered by a picture drawn at a quarter scale.
    for (const zoom of [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 4.92, 8, 50]) {
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

describe('compactMinUserScale', () => {
  // The display the report came from, and the image area it allows: 2032 x 1136
  // once the padding and the drag bar are paid for.
  const DISPLAY = [2048, 1152] as const;

  it('never forbids the fit itself', () => {
    // A small picture sits inside the share the floor names, and no longer needs a
    // clamp to protect it: a factor below 1 is capped at the display fit, so at the
    // floor such a file is still laid out at 100%. The floor bounds the shrink and
    // nothing else — which is the whole of what "never forbid the fit" means now.
    const CASES = [
      [200, 100, 1000, 1000],
      [50, 50, 4000, 4000],
    ] as const;
    for (const [w, h, availW, availH] of CASES) {
      const floor = compactMinUserScale(w, h, availW, availH);
      expect(computeCompactContentSize(w, h, availW, availH, floor)).toEqual(
        computeCompactContentSize(w, h, availW, availH),
      );
    }
  });

  it('stops where the window is 40% of the screen', () => {
    // The user's rule, asserted as the rule rather than as its arithmetic — and
    // below 1 the rule is *literally* the stored factor, so the floor is this
    // constant with no conversion in between. What the constant means on screen is
    // a share of the picture at its display fit, the largest it may be here: a
    // 2048x1152 file on a 2048x1152 work area is 2019x1136 of that, so 40% of it is
    // the 808x454 window this file now opens at, where a quarter gave 505x284.
    const floor = compactMinUserScale(2048, 1152, ...DISPLAY);
    const pin = compactPinnedSize(2048, 1152, ...DISPLAY, floor)!;
    const { width: capW, height: capH } = compactDisplayCaps(...DISPLAY);
    const largest = Math.max(2048, 1152) * Math.min(capW / 2048, capH / 1152);
    expect(floor).toBeCloseTo(COMPACT_MIN_FRACTION, 5);
    expect(Math.max(pin.width, pin.height) / largest).toBeCloseTo(
      COMPACT_MIN_FRACTION,
      3, // three digits: 808 is 2019.6 rounded to a whole pixel
    );
    // …and it is the binding term here, not one of the window minimums.
    expect(floor).toBeGreaterThan(
      (COMPACT_MIN_WINDOW_WIDTH - COMPACT_PADDING * 2) / pin.width,
    );
  });

  it('gives pictures of different sizes the same share of the screen', () => {
    // The point of reading the factor as a share below 1: it means the same
    // *window* on the next image rather than the same multiple of a fit that
    // differs per file. Two files that reach the display caps exactly both stop at
    // 40% of the cap their own dominant axis answers to — and the edge they share,
    // the height, is the same 454px in both.
    const { width: capW, height: capH } = compactDisplayCaps(...DISPLAY);
    const landscape = compactPinnedSize(capW, capH, ...DISPLAY, COMPACT_MIN_FRACTION)!;
    const square = compactPinnedSize(capH, capH, ...DISPLAY, COMPACT_MIN_FRACTION)!;
    expect(landscape.width).toBe(Math.round(capW * COMPACT_MIN_FRACTION));
    expect(landscape.height).toBe(Math.round(capH * COMPACT_MIN_FRACTION));
    expect(square.width).toBe(Math.round(capH * COMPACT_MIN_FRACTION));
    expect(square.height).toBe(square.width);
  });

  it('stops sooner when the window minimum will not let it go smaller', () => {
    // A 4000x500 panorama fits at 1984x248, so 40% of it would be a 99 DIP tall
    // window — below the 160 the window manager will make. The height term binds
    // instead, and the frame stops at 112 DIP of picture.
    const pin = compactPinnedSize(4000, 500, 2000, 1000)!;
    const floor = compactMinUserScale(4000, 500, 2000, 1000);
    expect(floor).toBeCloseTo(
      (COMPACT_MIN_WINDOW_HEIGHT - COMPACT_PADDING * 2 - COMPACT_BAR_HEIGHT) / pin.height,
      5,
    );
    // Which matters, because a naive "it stopped at the 40% rule" reading of the
    // same window would be wrong about what stopped it — that term is lower.
    expect(floor).toBeGreaterThan((COMPACT_MIN_WINDOW_WIDTH - COMPACT_PADDING * 2) / pin.width);
    expect(floor).toBeGreaterThan(COMPACT_MIN_FRACTION);
  });

  it('stands down on a display too small for the window minimum', () => {
    // Both window-minimum terms come out above 1 on a 240x140 display, and a floor
    // above 1 would forbid the fit itself — a compact mode that could not show the
    // whole image at 100%. The clamp is what makes "no shrink to give" the answer
    // there, so the gesture behaves as it did before there is room for it. Nothing
    // else can push the floor up: it is a share of the display, read against the
    // picture at its display fit rather than at the size the window is showing, so
    // it is a fixed rectangle as the gesture runs and a hand-drag inside it is not
    // undone by the next scroll.
    expect(compactMinUserScale(200, 100, 240, 140)).toBe(1);
  });

  it('leaves a frame at the floor still covered by the picture', () => {
    // The invariant the floor exists to respect: whatever it allows, the frame is
    // never larger than the picture drawn into it. Asserted at the floor itself,
    // the smallest frame the gesture can ask for — where the frame *is* the shrunk
    // picture, so a floor that ever allowed less than the picture covers would show
    // up here as a frame with the background showing through it.
    const CASES: Array<[number, number, number, number]> = [
      [2048, 1152, 2048, 1152],
      [4000, 500, 2000, 1000],
      [200, 100, 1000, 1000],
    ];
    for (const [w, h, availW, availH] of CASES) {
      const floor = compactMinUserScale(w, h, availW, availH);
      const pin = compactPinnedSize(w, h, availW, availH, floor)!;
      const size = computeCompactContentSize(w, h, availW, availH, floor)!;
      const area = compactImageArea(size.contentWidth, size.contentHeight);
      expect(area.width).toBeLessThanOrEqual(pin.width);
      expect(area.height).toBeLessThanOrEqual(pin.height);
    }
  });

  it('reads unusable input as no shrink at all', () => {
    // No fit to measure against, so the answer that cannot band the frame.
    expect(compactMinUserScale(0, 10, 100, 100)).toBe(1);
    expect(compactMinUserScale(200, 100, 0, 0)).toBe(1);
    expect(compactMinUserScale(200, 100, Number.NaN, 100)).toBe(1);
  });
});

describe('compactWindowMinimumScale', () => {
  const CASES: Array<[number, number, number, number]> = [
    [2048, 1152, 2048, 1152],
    [4000, 500, 2000, 1000],
    [1000, 500, 1000, 1000],
    [200, 100, 1000, 1000],
  ];

  it('names the share at which the picture still covers the window minimum', () => {
    // Unlike the gesture's floor this one is not a matter of taste: below it the
    // OS takes the request and widens the frame, so the frame stops being the
    // picture. Both axes are covered at the floor, and the binding one is at its
    // minimum exactly — which is what makes this the *smallest* share that can be
    // honoured rather than merely a safe one.
    for (const [w, h, availW, availH] of CASES) {
      const { width: capW, height: capH } = compactDisplayCaps(availW, availH);
      const displayFit = Math.min(capW / w, capH / h);
      const floor = compactWindowMinimumScale(w, h, availW, availH);
      expect(floor).toBeLessThan(1);

      const coveredWidth = w * displayFit * floor;
      const coveredHeight = h * displayFit * floor;
      const minWidth = COMPACT_MIN_WINDOW_WIDTH - COMPACT_PADDING * 2;
      const minHeight =
        COMPACT_MIN_WINDOW_HEIGHT - COMPACT_PADDING * 2 - COMPACT_BAR_HEIGHT;

      expect(coveredWidth).toBeGreaterThanOrEqual(minWidth - 1e-9);
      expect(coveredHeight).toBeGreaterThanOrEqual(minHeight - 1e-9);
      expect(
        Math.abs(coveredWidth - minWidth) < 1e-9 ||
          Math.abs(coveredHeight - minHeight) < 1e-9,
      ).toBe(true);
    }
  });

  it('is never above the floor the shrink gesture stops at', () => {
    // What the refusal in ImageModal rests on: a size the *gesture* can leave
    // behind is always one the next image can honour, because the gesture's floor
    // is this one or the 40% rule, whichever is larger. So the refusal can only
    // ever fire on a hand-drag, and the two rules cannot deadlock — a stored size
    // the mode itself would produce and then refuse to use.
    for (const [w, h, availW, availH] of CASES) {
      expect(compactMinUserScale(w, h, availW, availH)).toBeGreaterThanOrEqual(
        compactWindowMinimumScale(w, h, availW, availH),
      );
    }
  });

  it('reads unusable input as no floor at all', () => {
    // 1 is "no shrink", the same answer the gesture's floor gives: neither may
    // forbid the fit itself.
    expect(compactWindowMinimumScale(0, 10, 100, 100)).toBe(1);
    expect(compactWindowMinimumScale(200, 100, 0, 0)).toBe(1);
    expect(compactWindowMinimumScale(200, 100, Number.NaN, 100)).toBe(1);
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

  it('finds nothing to pan when the frame is at or below the fit', () => {
    // Below the fit the frame is *smaller* than the picture, so the picture sits
    // entirely inside it — there is no part outside to bring into view. At exactly
    // the fit the two are the same size. Neither is a crop, and this guard is a
    // condition rather than a floor: it reads the same either way.
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

  it('reads a drag of a zoomed window as the share of the screen it asked for', () => {
    // The 2x frame is the whole display, and the user drags it in to 700x350 of
    // picture. The raw ratio says 0.7 — that is where the file's own pixels are,
    // not what the user asked for, and its magnification is not a size preference
    // at all. Taken against the display fit it is 700/1968: the share of the
    // screen the window would be with the zoom off, which is what the sizing rule
    // multiplies by, so the value reproduces exactly the window the user made.
    expect(userScaleFromResize(...FIT, 716, 398, 2)).toBeCloseTo(700 / 1968, 6);
  });

  it('reads a zoomed drag of a small image as the share it asked for', () => {
    // A 200x100 file is drawn at its own pixels on a display that could show it
    // five times over. Its 3x frame is dragged in to 436x258 of window, which is
    // the picture at 420x210 — 140x70 of it at the fit, the frame the sizing rule
    // would rebuild from 140/984 of the screen. Read the zoom-in ratio instead —
    // 2.1 raw, or 0.7 with the magnification divided out but the base still the
    // file's own pixels — and the same drag stores five times the share the
    // window occupies, which every image that follows would open at.
    //
    // Small shares are read here like any other: whether one can be *honoured* is
    // a question about the image that comes next, and it is refused there, in
    // ImageModal, not clamped into a wrong answer here.
    expect(userScaleFromResize(...SMALL, 436, 258, 3)).toBeCloseTo(140 / 984, 6);
  });

  it('ignores an axis the magnification has pushed against the display', () => {
    // The 2x frame is 1968x984 of picture — more than the display holds, so it
    // sits at the cap on both axes — and the user drags the height in to 452
    // DIP. Read raw, the width says 0.5: that is the cap divided by the zoom, not
    // a window anybody chose. The height says 0.4593, which is the honest
    // statement about the window. One shared reading would have remembered the
    // first and shrunk every later window.
    expect(userScaleFromResize(...FIT, 1000, 500, 2)).toBeCloseTo(452 / 984, 6);
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
    expect(userScaleFromResize(...SMALL, 616, 348, 0)).toBeCloseTo(3, 5);
  });

  // There is no case here for a zoom *below* 1, and deliberately so: shrinking a
  // compact window is the size factor's job now, precisely so that the size
  // survives into the next image, and the viewer never shows one below 1x. A
  // sub-1 zoom would be a state this mode cannot be in, so a reading of it would
  // pin an expectation the code has no way to be wrong about.

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
