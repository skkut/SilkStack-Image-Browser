import type { PromptVariationSegment, StackSubGroup } from '../types';

/**
 * Word-level "which parts of these prompts vary?" markup for the Similarity
 * stack drill-down.
 *
 * A prompt is split on whitespace runs, and a word is treated as COMMON when it
 * appears in every prompt of the set; anything else is a variation and gets
 * highlighted. That intersection rule is chosen over common-prefix/suffix
 * trimming because prompts often differ in interleaved places: for
 * `a cat in a garden` / `a dog in a garden` / `a cat in a house`, prefix
 * trimming finds only `a` in common and would highlight nearly everything,
 * whereas the intersection highlights just `cat`/`dog`/`garden`/`house`.
 *
 * This is deliberately NOT built on the similarity engine's
 * `tokenizeForSimilarity` (`ai-intelligence/src/modules/stacking-similarity.ts`).
 * That tokenizer serves scoring, so it discards stop words and pure numbers and
 * returns an unordered Set — the opposite of what a diff needs. It would hide
 * exactly the differences a reader is looking for (`4k` vs `8k`) and cannot
 * reproduce token positions at all.
 *
 * Known limits, accepted deliberately:
 * - Scripts without whitespace (Chinese, Japanese, Thai) arrive as one long
 *   token, so highlighting degrades to whole-sentence granularity.
 * - A difference *inside* a token is not seen: `(masterpiece:1.2)` vs
 *   `(masterpiece:1.3)` flags the whole token, since keys differ.
 */

/** Placeholder strings the grouping code emits for missing metadata. */
const PLACEHOLDER_VALUES = new Set(['(no prompt)', '(no model)', '(no loras)', '(none)']);

/**
 * Defensive ceilings. Beyond these the stack is far larger than any real
 * similarity group, and falling back to plain text is better than a visible
 * stall while the drill-down renders.
 */
const MAX_DISTINCT_VALUES = 400;
const MAX_TOTAL_TOKENS = 20_000;

/**
 * Split a value into whitespace runs and the words between them. The capture
 * group keeps the separators, so the parts concatenate back to the input.
 */
function tokenize(value: string): string[] {
  return value.split(/(\s+)/).filter((part) => part !== '');
}

/**
 * Comparison key for a token: case-folded, Unicode-normalized, with leading and
 * trailing punctuation removed so `chair,` matches `chair`. Returns `''` for
 * tokens that carry no word at all (pure whitespace or punctuation).
 *
 * `normalize('NFC')` matters — `café` and `café` are the same word typed
 * two ways, and must compare equal.
 */
function tokenKey(token: string): string {
  return token
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * A value with nothing to compare: empty, one of the grouping placeholders, or
 * pure punctuation. These are excluded from the common-word computation so that
 * a stack mixing `(no prompt)` with real prompts doesn't light up every word of
 * the real ones.
 */
function isDegenerate(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (PLACEHOLDER_VALUES.has(trimmed)) return true;
  return !tokenize(value).some((token) => tokenKey(token) !== '');
}

/**
 * Mark up each value against the words shared by all of them.
 *
 * Returns one segment array per input value, index-aligned, where the segments
 * of a value always concatenate back to that value exactly:
 * `segments.map(s => s.text).join('') === value`.
 *
 * Fewer than two comparable values yields all-plain output — with a single
 * prompt (or two identical ones) there is no variation to show, and flagging
 * every word would be actively misleading.
 */
export function computeVariationSegments(
  values: readonly string[],
): PromptVariationSegment[][] {
  if (values.length === 0) return [];

  const asPlain = (value: string): PromptVariationSegment[] =>
    value === '' ? [] : [{ text: value, isVariation: false }];

  const reference = [...new Set(values)].filter((value) => !isDegenerate(value));
  if (reference.length < 2 || reference.length > MAX_DISTINCT_VALUES) {
    return values.map(asPlain);
  }

  const keysByValue = new Map<string, string[]>();
  let totalTokens = 0;
  for (const value of reference) {
    const keys = tokenize(value)
      .map(tokenKey)
      .filter((key) => key !== '');
    keysByValue.set(value, keys);
    totalTokens += keys.length;
  }
  if (totalTokens > MAX_TOTAL_TOKENS) return values.map(asPlain);

  // Seed the candidate set from the shortest prompt, then prune it against each
  // remaining one. Pruning in place is linear in the candidate count, so the
  // whole pass stays O(total tokens) rather than testing every word against
  // every prompt.
  const byLength = [...reference].sort(
    (a, b) => keysByValue.get(a)!.length - keysByValue.get(b)!.length,
  );
  const common = new Set(keysByValue.get(byLength[0])!);
  for (let i = 1; i < byLength.length && common.size > 0; i++) {
    const keys = new Set(keysByValue.get(byLength[i])!);
    for (const key of common) {
      if (!keys.has(key)) common.delete(key);
    }
  }

  return values.map((value) => {
    if (isDegenerate(value)) return asPlain(value);

    const segments: PromptVariationSegment[] = [];
    for (const part of tokenize(value)) {
      const key = tokenKey(part);
      // Whitespace and punctuation-only runs are never variations on their own.
      const isVariation = key !== '' && !common.has(key);
      const last = segments[segments.length - 1];
      if (last && last.isVariation === isVariation) {
        last.text += part;
      } else {
        segments.push({ text: part, isVariation });
      }
    }
    return segments;
  });
}

/**
 * Attach variation segments to one dimension of each sub-group's header data.
 *
 * Returns fresh sub-group objects — the input may be memoized elsewhere, and
 * the segments are drill-down-only decoration that must not leak back into the
 * stacks held in the image store.
 *
 * Returns the input array untouched when there is nothing to compare, so the
 * common case allocates nothing.
 */
export function withPromptVariationSegments(
  subGroups: StackSubGroup[],
  dimensionLabel: string = 'Prompt',
): StackSubGroup[] {
  if (subGroups.length === 0) return subGroups;

  const values = subGroups.map(
    (sg) => sg.dimensions?.find((dim) => dim.label === dimensionLabel)?.value ?? '',
  );

  // Skip the work entirely when every sub-group has the same prompt, when none
  // has one, or when the sentinel is all there is to compare.
  const comparable = new Set(values.filter((value) => !isDegenerate(value)));
  if (comparable.size < 2) return subGroups;

  const segments = computeVariationSegments(values);

  return subGroups.map((sg, i) => {
    if (!sg.dimensions || segments[i].length === 0) return sg;
    const index = sg.dimensions.findIndex((dim) => dim.label === dimensionLabel);
    if (index === -1) return sg;
    return {
      ...sg,
      dimensions: sg.dimensions.map((dim, j) =>
        j === index ? { ...dim, segments: segments[i] } : dim,
      ),
    };
  });
}
