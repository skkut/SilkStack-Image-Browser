import { describe, it, expect } from 'vitest';
import { resolvePromptFromGraph } from '../services/parsers/comfyUIParser';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Seed behind a LINKED SeedNode inside a subgraph (2026-10-05).
 *
 * Original report: the viewer reported seed `1` for a workflow whose SeedNode
 * carries `1011015334254742`. Three independent defects stacked up:
 *
 *  1. Terminal-node selection — the flattened graph holds two samplers: the
 *     "Krea Generate" pass (subgraph instance 152) and the "Upscale Image
 *     (SeedVR2)" pass (instance 201). findTerminalNode kept the first
 *     SINK-role KSampler in *node-array order*, and the upscale instance sits
 *     earlier in the .json — so every sampling parameter came from the wrong
 *     pass, including that KSampler's own scrambled widget list (cfg
 *     "dpmpp_2m", denoise "wavelet").
 *  2. Widget-vs-link precedence — the generation KSampler's `seed` slot is a
 *     converted widget (link → SeedNode) while `widgets_values` still holds
 *     the stale last-used value. Widget-first extraction returned that stale
 *     value and never followed the link.
 *  3. `SeedNode` had no NodeRegistry entry, so even a followed link ended at
 *     an unknown node whose value is a widget — and the unknown-node
 *     pass-through only follows links, never widgets — yielding null.
 *
 * The krea-unknown-passthrough fixture covers a sibling shape of this same
 * family (prompt through an unregistered conditioning node). This fixture is
 * the reported workflow itself, trimmed of display-only top-level nodes only.
 */
describe('Seed behind a linked SeedNode in a subgraph', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'comfyui', 'subgraph-seednode-link.json');
  const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  const EXPECTED_SEED = 1011015334254742;
  /** Stale value left in the KSampler's seed widget after the widget→input conversion. */
  const STALE_WIDGET_SEED = 556739344479063;

  const EXPECTED_PROMPT =
    '1920s, steam locomotive, black smoke from a locomotive chimney, ' +
    'pulling a lot of coaches, sunset, beautiful mountain fields';
  const SYSTEM_PROMPT_MARKER = 'You are an expert prompt engineer';

  it('resolves the seed through the SeedNode link, not the stale widget value', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.seed).toBe(EXPECTED_SEED);
    expect(result.seed).not.toBe(STALE_WIDGET_SEED);
    expect(result.approximateSeed).toBeUndefined();
  });

  it('starts from the generation pass, not the upscale pass', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    // Values of the Krea Generate KSampler (subgraph 152).
    expect(result.steps).toBe(8);
    expect(result.cfg).toBe(1);
    expect(result.sampler_name).toBe('euler_ancestral');
    expect(result.scheduler).toBe('simple');
    expect(result.denoise).toBe(1);
    // Values seen when the SeedVR2 upscale KSampler (201:189) was picked.
    expect(result.cfg).not.toBe('dpmpp_2m');
    expect(result.denoise).not.toBe('wavelet');
  });

  it('extracts the user prompt, not the TextGenerate system prompt', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.prompt).toBe(EXPECTED_PROMPT);
    expect(result.prompt).not.toContain(SYSTEM_PROMPT_MARKER);
  });

  it('resolves it with the standard traversal, without any fallback tier', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    const warnings: string[] = result._telemetry?.warnings ?? [];
    // A right answer produced by the wrong tier is the failure mode this
    // guards against — assert the tier, not just the value.
    expect(warnings.join('\n')).not.toMatch(/global graph fallback|deep topological reconstructor/i);
  });

  it('still resolves the seed when the API prompt chunk overlays the workflow', () => {
    // What ComfyUI writes into the image metadata: the UI workflow plus the
    // flattened execution prompt, where linked values are links (not widgets).
    const prompt = {
      '152:150': {
        class_type: 'KSampler',
        inputs: {
          seed: ['152:232', 0],
          steps: 8, cfg: 1, sampler_name: 'euler_ancestral', scheduler: 'simple', denoise: 1,
          model: ['165', 0], positive: ['152:229', 0], negative: ['152:146', 0], latent_image: ['152:144', 0],
        },
      },
      '152:232': { class_type: 'SeedNode', inputs: { seed: EXPECTED_SEED, fixed: 'randomize' } },
    };

    const result = resolvePromptFromGraph(rawData.workflow, prompt);
    expect(result.seed).toBe(EXPECTED_SEED);
  });
});

/**
 * Terminal-node choice in a two-sampler (generation + refiner) workflow: the
 * pass whose latent traces back to an EmptyLatent* source is the generation
 * pass, regardless of where the refiner sits in the nodes array.
 *
 * Node ids are subgraph-style strings ("20:2") on purpose. Plain numeric ids
 * are integer-like object keys, which JavaScript enumerates in ascending
 * order — masking the insertion-order bug behind id numbering. String keys
 * keep insertion (i.e. nodes-array) order, exactly like the reported workflow.
 */
describe('Terminal node prefers the sampler fed from EmptyLatent', () => {
  const workflow = {
    nodes: [
      // Refiner first in array order — pre-fix this won by insertion order.
      {
        id: '20:2',
        type: 'KSampler',
        mode: 0,
        widgets_values: [777, 'fixed', 12, 9.5, 'dpmpp_2m', 'karras', 0.4],
        inputs: [
          { name: 'model', type: 'MODEL', link: null },
          { name: 'positive', type: 'CONDITIONING', link: null },
          { name: 'negative', type: 'CONDITIONING', link: null },
          { name: 'latent_image', type: 'LATENT', link: 3 },
        ],
      },
      {
        id: '10:1',
        type: 'KSampler',
        mode: 0,
        widgets_values: [424242, 'fixed', 20, 7, 'euler', 'normal', 1],
        inputs: [
          { name: 'model', type: 'MODEL', link: null },
          { name: 'positive', type: 'CONDITIONING', link: null },
          { name: 'negative', type: 'CONDITIONING', link: null },
          { name: 'latent_image', type: 'LATENT', link: 2 },
        ],
      },
      { id: '30:3', type: 'VAEEncode', mode: 0, widgets_values: [], inputs: [{ name: 'pixels', type: 'IMAGE', link: null }] },
      { id: '40:4', type: 'EmptyLatentImage', mode: 0, widgets_values: [1024, 1024, 1], inputs: [] },
    ],
    links: [
      [2, '40:4', 0, '10:1', 3, 'LATENT'],
      [3, '10:1', 0, '20:2', 3, 'LATENT'],
    ],
  };

  it('picks the generation sampler even when the refiner comes first', () => {
    const result = resolvePromptFromGraph(workflow, undefined);
    expect(result.seed).toBe(424242);
    expect(result.steps).toBe(20);
    expect(result.sampler_name).toBe('euler');
  });
});
