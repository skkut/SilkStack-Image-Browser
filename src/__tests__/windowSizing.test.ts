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
  // Sizes below are chosen so the *image area* — not the content — is a clean
  // fraction: an applied 996x538 leaves 980x490, whose 70% is 686x343.
  it('reads a proportional drag', () => {
    expect(userScaleFromResize(1, 996, 538, 702, 391)).toBeCloseTo(0.7, 5);
  });

  it('reads a drag that moved only one edge', () => {
    // Width-only and height-only: the untouched axis must not dilute the read.
    expect(userScaleFromResize(1, 996, 538, 702, 538)).toBeCloseTo(0.7, 5);
    expect(userScaleFromResize(1, 996, 538, 996, 391)).toBeCloseTo(0.7, 5);
  });

  it('compounds onto the factor already in force', () => {
    // 0.75 of the image area, on top of the 0.8 already in force.
    expect(userScaleFromResize(0.8, 1000, 540, 754, 417)).toBeCloseTo(0.6, 5);
  });

  it('measures the image area, not the content', () => {
    // Halving the *content* takes more than half the picture, because the
    // padding and bar are a fixed cost that does not shrink with it. Reading
    // the raw content ratio would store 0.7 and slowly creep the window down.
    const factor = userScaleFromResize(1, 1000, 540, 700, 378);
    expect(factor).toBeCloseTo(330 / 492, 5); // the height's area ratio
    expect(factor).toBeLessThan(0.7);
  });

  it('clamps a degenerate drag instead of collapsing the window', () => {
    expect(userScaleFromResize(1, 996, 538, 5, 3)).toBe(COMPACT_MIN_USER_SCALE);
  });

  it('ignores unusable input', () => {
    expect(userScaleFromResize(0.7, 0, 0, 702, 391)).toBeCloseTo(0.7, 5);
    expect(userScaleFromResize(0.7, 996, 538, NaN, 391)).toBeCloseTo(0.7, 5);
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
