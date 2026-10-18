/**
 * Megapixel filter scale — the selectable values, ascending.
 *
 * A deliberately coarse, hand-picked ladder. Nearly all native AI output lives
 * on the first few stops (768×640 ≈ 0.5 MP, 1024×1024 ≈ 1 MP, 1920×1080 ≈ 2 MP)
 * while the upper end is mostly upscales (8, 16, 30 MP …). Uniform steps across
 * 0.5–50 MP would squeeze the useful low end into the first few notches.
 *
 * The top stop is **open-ended**: it means "50 MP and above" and stores no upper
 * bound, so a very large upscale is never lost by parking the knob at the end.
 *
 * Both thumbs snap to these values, so the filter always stores a number from
 * this list — no floating-point drift between the UI and the store.
 */
export const MEGAPIXEL_STEPS = [
  0.5, 1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 50,
] as const;

export const MIN_MEGAPIXELS = MEGAPIXEL_STEPS[0];
export const MAX_MEGAPIXELS = MEGAPIXEL_STEPS[MEGAPIXEL_STEPS.length - 1];

/** The top stop, as the UI writes it: `50+` means "and above". */
export const MEGAPIXEL_MAX_LABEL = `${MAX_MEGAPIXELS}+`;

/** `0.5` and `2.5` keep their decimal; whole values print without `.0`. */
export const formatMegapixels = (megapixels: number): string =>
  Number.isInteger(megapixels) ? String(megapixels) : megapixels.toFixed(1);

/**
 * Nearest step index for a value. A range restored from an older (or newer)
 * scale still lands on the thumb the user would expect instead of leaving the
 * native input with an off-scale value.
 */
export const megapixelStepIndex = (megapixels: number): number => {
  let bestIndex = 0;
  let bestDistance = Infinity;
  MEGAPIXEL_STEPS.forEach((step, index) => {
    const distance = Math.abs(step - megapixels);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
};

/**
 * Megapixels of an image, from its `"WxH"` dimensions string.
 *
 * Handles the spacing the indexer may leave around the separator and the
 * multiplication sign some metadata writers use. Returns null when the value
 * is missing or unusable (including the `"0x0"` stub the indexer writes when
 * no dimensions could be read) — the filter treats null as outside every
 * range rather than guessing.
 */
export const getMegapixels = (dimensions?: string | null): number | null => {
  if (!dimensions) return null;
  const match = dimensions.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return (width * height) / 1_000_000;
};
