import { describe, it, expect } from 'vitest';
import {
  computeCompactContentSize,
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

describe('compactImageArea', () => {
  it('subtracts the padding on all sides and the drag bar on top', () => {
    expect(compactImageArea(1000, 540)).toEqual({ width: 984, height: 492 });
  });

  it('never returns a non-positive area', () => {
    expect(compactImageArea(4, 4)).toEqual({ width: 1, height: 1 });
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
