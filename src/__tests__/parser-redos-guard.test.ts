import { describe, it, expect } from 'vitest';
import { parseA1111Metadata } from '../services/parsers/automatic1111Parser';
import { extractLoRAsWithWeights } from '../utils/promptCleaner';
import { parseFooocusMetadata } from '../services/parsers/fooocusParser';

/**
 * Regression guard for the CodeQL `js/polynomial-redos` findings on the
 * parser regexes.
 *
 * Each adversarial input below is the exact shape that made the pre-fix
 * pattern backtrack to the end of the string at every start position, giving
 * O(n^2) behaviour. The hardened patterns bound their quantifiers, so these
 * all finish in milliseconds.
 *
 * The inputs are deliberately sized so that reintroducing an unbounded
 * quantifier pushes the run well past the 5s timeout set on each case. That
 * makes the pass itself the assertion - there is no wall-clock comparison to
 * go flaky on a loaded machine.
 *
 * The companion `- deterministic` cases below pin down that the bounds did
 * not change behaviour on realistic metadata; the `- bound` case documents
 * the one place where a bound is observable, so it is intentional and not a
 * surprise later.
 */

const TIMEOUT_MS = 5000;

describe('parser regex hardening (polynomial ReDoS guard)', () => {
  it(
    'size regex survives a long digit run with no "x"',
    () => {
      // /(\d+)x(\d+)/ -> before the fix, '0'.repeat(200k) took ~11s because
      // \d+ ran to the end hunting for a literal 'x' that never appears.
      const result = parseA1111Metadata('Size: ' + '0'.repeat(200_000) + ', Steps: 30');
      expect(result).toBeDefined();
      expect(result.width).toBeUndefined();
      expect(result.steps).toBe(30);
    },
    TIMEOUT_MS,
  );

  it(
    'lora regex survives repeated "<lora:x:" with no closing ">"',
    () => {
      // <lora:([^:>]+):([^>]+)> -> before the fix, 900KB of '<lora:9:' took
      // over 30s because [^>]+ rescanned to the end at every start position.
      const loras = extractLoRAsWithWeights('<lora:9:'.repeat(100_000));
      expect(loras).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'fooocus parser survives a long digits run in its size field',
    () => {
      const result = parseFooocusMetadata({
        parameters: 'a prompt\nSize: ' + '0'.repeat(200_000) + ', Steps: 30',
      } as never);
      expect(result === null || typeof result === 'object').toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe('parser regex hardening - deterministic behaviour preserved', () => {
  it('still parses a realistic A1111 parameter block', () => {
    const result = parseA1111Metadata(
      [
        'a beautiful landscape, highly detailed',
        'Negative prompt: blurry, lowres, bad anatomy',
        'Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234567890, Size: 512x768, Model hash: a1b2c3d4, Model: dreamshaper_8',
      ].join('\n'),
    );

    expect(result.prompt).toBe('a beautiful landscape, highly detailed');
    expect(result.negativePrompt).toBe('blurry, lowres, bad anatomy');
    expect(result.steps).toBe(30);
    expect(result.scheduler).toBe('DPM++ 2M Karras');
    expect(result.cfg_scale).toBe(7);
    expect(result.seed).toBe(1234567890);
    expect(result.width).toBe(512);
    expect(result.height).toBe(768);
  });

  it('still extracts loras with weights from <lora:name:weight>', () => {
    const loras = extractLoRAsWithWeights(
      'portrait <lora:add_detail:0.8> <lora:epiNoiseoffset_v2:0.5> <lora:FilmGrain:1>',
    );

    expect(loras).toEqual([
      { name: 'add_detail', weight: 0.8 },
      { name: 'epiNoiseoffset_v2', weight: 0.5 },
      { name: 'FilmGrain', weight: 1 },
    ]);
  });

  it('still keeps a non-numeric lora weight as a bare name', () => {
    expect(extractLoRAsWithWeights('<lora:myStyle:high>')).toEqual(['myStyle']);
  });

  it('still reads a civitai resources block', () => {
    const result = parseA1111Metadata(
      'Civitai resources: [{"type":"checkpoint","modelName":"juggernautXL_v9","modelId":133005,"weight":1}], Steps: 30, Size: 1024x1024, Seed: 99',
    );

    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.seed).toBe(99);
  });

  it('still reads a large civitai block (exercises the 20000-char bound)', () => {
    const resources = Array.from(
      { length: 40 },
      (_, i) => `{"type":"lora","modelName":"lora_${i}","modelId":${1000 + i},"weight":0.5}`,
    ).join(',');
    const result = parseA1111Metadata(
      `Civitai resources: [${resources}], Steps: 30, Size: 1024x1024, Seed: 7`,
    );

    expect(result.seed).toBe(7);
    expect(result.width).toBe(1024);
  });

  it('documents the intentional bound: a >200-char lora name is not matched', () => {
    // The {1,200} bound is what makes the pattern linear. Real lora names are
    // far shorter, so this only affects pathological input - but it is a real
    // behavioural edge and is asserted here so it stays deliberate.
    const longName = 'a'.repeat(300);

    expect(extractLoRAsWithWeights(`<lora:${longName}:0.5>`)).toEqual([]);
    expect(extractLoRAsWithWeights(`<lora:${'a'.repeat(200)}:0.5>`)).toEqual([
      { name: 'a'.repeat(200), weight: 0.5 },
    ]);
  });
});
