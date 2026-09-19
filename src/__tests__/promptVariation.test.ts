import { describe, expect, it } from 'vitest';
import {
  computeVariationSegments,
  withPromptVariationSegments,
} from '../utils/promptVariation';
import type { PromptVariationSegment, StackSubGroup } from '../types';

/** The individual words flagged as differing, flattened out of merged runs. */
const highlightedWords = (segments: PromptVariationSegment[]): string[] =>
  segments
    .filter((segment) => segment.isVariation)
    .flatMap((segment) => segment.text.split(/\s+/))
    .filter(Boolean);

/** Every value's segments must reproduce that value exactly. */
const expectLossless = (value: string, segments: PromptVariationSegment[]) => {
  expect(segments.map((segment) => segment.text).join('')).toBe(value);
};

const sg = (
  value: string,
  label = 'Prompt',
  extraDimensions: { label: string; value: string }[] = [],
): StackSubGroup => ({
  promptHash: `h-${value}`,
  prompt: value,
  label: value,
  groupKey: value,
  dimensions: [{ label, value }, ...extraDimensions],
  imageIds: [`img-${value}`],
  coverImageId: `img-${value}`,
  size: 1,
});

describe('computeVariationSegments', () => {
  it('flags interleaved differences without over-highlighting', () => {
    // The case that rules out common-prefix/suffix trimming: the shared prefix
    // is only "a", so a trim-based diff would highlight nearly everything.
    const values = ['a cat in a garden', 'a dog in a garden', 'a cat in a house'];
    const result = computeVariationSegments(values);

    expect(highlightedWords(result[0])).toEqual(['cat', 'garden']);
    expect(highlightedWords(result[1])).toEqual(['dog', 'garden']);
    expect(highlightedWords(result[2])).toEqual(['cat', 'house']);
  });

  it('reproduces every value exactly (round-trip invariant)', () => {
    const values = [
      'a cat in a garden',
      'a dog in a garden',
      'a cat in a house',
      'a\ncat\tsitting',
      '!!!',
      '',
      '  leading and trailing  ',
    ];
    const result = computeVariationSegments(values);
    values.forEach((value, i) => expectLossless(value, result[i]));
  });

  it('treats punctuation and case differences as the same word', () => {
    const result = computeVariationSegments(['A cat, sitting', 'a cat, sleeping']);
    expect(highlightedWords(result[0])).toEqual(['sitting']);
    expect(highlightedWords(result[1])).toEqual(['sleeping']);
  });

  it('flags every occurrence of a repeated differing word', () => {
    const result = computeVariationSegments(['a cat and a cat', 'a dog and a dog']);
    expect(highlightedWords(result[0])).toEqual(['cat', 'cat']);
    expect(highlightedWords(result[1])).toEqual(['dog', 'dog']);
  });

  it('highlights a difference that is only a number', () => {
    // Guards the divergence from the similarity tokenizer, which drops digits.
    const result = computeVariationSegments(['a cat, 4k', 'a cat, 8k']);
    expect(highlightedWords(result[0])).toEqual(['4k']);
    expect(highlightedWords(result[1])).toEqual(['8k']);
  });

  it('highlights a difference that is only a stop word', () => {
    // Same guard: the similarity tokenizer would discard "photo"/"picture".
    const result = computeVariationSegments(['a photo of a cat', 'a picture of a cat']);
    expect(highlightedWords(result[0])).toEqual(['photo']);
    expect(highlightedWords(result[1])).toEqual(['picture']);
  });

  it('returns plain output when there is nothing to compare', () => {
    expect(computeVariationSegments([])).toEqual([]);

    const single = computeVariationSegments(['a lone prompt']);
    expect(highlightedWords(single[0])).toEqual([]);

    const identical = computeVariationSegments(['a cat', 'a cat']);
    expect(highlightedWords(identical[0])).toEqual([]);
    expect(highlightedWords(identical[1])).toEqual([]);
  });

  it('ignores degenerate values instead of lighting up every real prompt', () => {
    const result = computeVariationSegments(['(no prompt)', 'a cat', 'a dog']);

    expect(result[0]).toEqual([{ text: '(no prompt)', isVariation: false }]);
    expect(highlightedWords(result[1])).toEqual(['cat']);
    expect(highlightedWords(result[2])).toEqual(['dog']);
  });

  it('ignores pure-punctuation values', () => {
    const result = computeVariationSegments(['!!!', 'a cat', 'a dog']);
    expect(result[0]).toEqual([{ text: '!!!', isVariation: false }]);
    expect(highlightedWords(result[1])).toEqual(['cat']);
  });

  it('handles Unicode words and composes accents before comparing', () => {
    // "café" (decomposed) and "café" (precomposed) are the same word.
    const french = computeVariationSegments(['un chat noir', 'un chien noir']);
    expect(highlightedWords(french[0])).toEqual(['chat']);
    expect(highlightedWords(french[1])).toEqual(['chien']);

    const accents = computeVariationSegments(['café noir', 'café blanc']);
    expect(highlightedWords(accents[0])).toEqual(['noir']);
    expect(highlightedWords(accents[1])).toEqual(['blanc']);
  });

  it('degrades to whole-token granularity for scripts without spaces', () => {
    const values = ['猫が椅子に座っている', '猫がソファに座っている'];
    const result = computeVariationSegments(values);

    // One token each, so the whole sentence is the variation — the documented
    // limitation, pinned here so a future change to it is deliberate.
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].isVariation).toBe(true);
    values.forEach((value, i) => expectLossless(value, result[i]));
  });

  it('flags a whole token when the difference is inside it', () => {
    const result = computeVariationSegments(['(masterpiece:1.2) cat', '(masterpiece:1.3) cat']);
    expect(highlightedWords(result[0])).toEqual(['(masterpiece:1.2)']);
    expect(highlightedWords(result[1])).toEqual(['(masterpiece:1.3)']);
  });

  it('preserves newlines and tabs verbatim', () => {
    const values = ['a\ncat\tsitting', 'a\ncat\tsleeping'];
    const result = computeVariationSegments(values);
    expect(highlightedWords(result[0])).toEqual(['sitting']);
    values.forEach((value, i) => expectLossless(value, result[i]));
  });

  it('bails out to plain text rather than stalling on a huge value set', () => {
    const values = Array.from({ length: 500 }, (_, i) => `prompt number ${i} variant`);
    const result = computeVariationSegments(values);

    expect(result).toHaveLength(500);
    expect(result.every((segments) => highlightedWords(segments).length === 0)).toBe(true);
  });
});

describe('withPromptVariationSegments', () => {
  it('attaches segments to the named dimension only', () => {
    const subGroups = [
      sg('a cat', 'Prompt', [{ label: 'Model', value: 'sdxl' }]),
      sg('a dog', 'Prompt', [{ label: 'Model', value: 'sdxl' }]),
    ];

    const result = withPromptVariationSegments(subGroups, 'Prompt');
    const promptDim = result[0].dimensions!.find((d) => d.label === 'Prompt')!;
    const modelDim = result[0].dimensions!.find((d) => d.label === 'Model')!;

    expect(highlightedWords(promptDim.segments!)).toEqual(['cat']);
    expect(modelDim.segments).toBeUndefined();
  });

  it('leaves sub-groups without dimension data untouched', () => {
    const legacy: StackSubGroup = {
      promptHash: 'h',
      prompt: 'a cat',
      label: 'a cat',
      groupKey: 'k',
      imageIds: ['i'],
      coverImageId: 'i',
      size: 1,
    };

    expect(withPromptVariationSegments([legacy, sg('a dog')])[0]).toBe(legacy);
  });

  it('returns the input array unchanged when nothing is comparable', () => {
    const onlyOne = [sg('a cat'), sg('a cat')];
    expect(withPromptVariationSegments(onlyOne, 'Prompt')).toBe(onlyOne);

    const allLegacy = [sg('(no prompt)'), sg('(no prompt)')];
    expect(withPromptVariationSegments(allLegacy, 'Prompt')).toBe(allLegacy);

    expect(withPromptVariationSegments([], 'Prompt')).toEqual([]);
  });

  it('never mutates the sub-groups it is given', () => {
    const subGroups = [sg('a cat'), sg('a dog')];
    const snapshot = JSON.parse(JSON.stringify(subGroups));

    const result = withPromptVariationSegments(subGroups, 'Prompt');

    expect(result).not.toBe(subGroups);
    expect(result[0]).not.toBe(subGroups[0]);
    expect(JSON.parse(JSON.stringify(subGroups))).toEqual(snapshot);
  });
});
