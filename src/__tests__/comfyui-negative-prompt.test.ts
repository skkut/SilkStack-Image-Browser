import { describe, it, expect } from 'vitest';
import { resolvePromptFromGraph } from '../services/parsers/comfyUIParser';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Regression tests: a blank negative prompt must stay blank.
 *
 * Two code paths previously copied the positive prompt into `negativePrompt`:
 *  1. The Tier-3 deep topological reconstructor walked backwards from the
 *     negative encoder into shared nodes (e.g. a style selector's `positive`
 *     input) and returned the longest string it found — the positive prompt.
 *  2. BasicGuider (Flux-style, CFG-less) mapped both `prompt` and
 *     `negativePrompt` to its single `conditioning` input.
 */

const orexFixturePath = path.join(
  __dirname,
  'fixtures',
  'comfyui',
  'orex-style-selector.json'
);

function loadOrexWorkflow(): any {
  return JSON.parse(fs.readFileSync(orexFixturePath, 'utf-8')).workflow;
}

describe('ComfyUI Parser - blank negative prompts', () => {
  it('keeps a blank style-selector negative blank instead of copying the positive prompt', () => {
    const workflow = loadOrexWorkflow();
    // The user cleared the negative prompt text node; its text input still
    // links to the style selector's negative output.
    workflow['228'].inputs.value = '';

    const result = resolvePromptFromGraph(workflow, undefined);

    expect(result.prompt).toContain('beautiful Diwali outfit');
    expect(result.negativePrompt).toBeFalsy();
    expect(result.negativePrompt).not.toBe(result.prompt);
  });

  it('keeps the negative blank when the style-selector negative input is unlinked', () => {
    const workflow = loadOrexWorkflow();
    delete workflow['225'].inputs.negative;

    const result = resolvePromptFromGraph(workflow, undefined);

    expect(result.prompt).toContain('beautiful Diwali outfit');
    expect(result.negativePrompt).toBeFalsy();
  });

  it('does not copy the positive prompt for a BasicGuider (no negative input)', () => {
    const prompt = {
      '1': {
        class_type: 'BasicGuider',
        inputs: { model: ['4', 0], conditioning: ['6', 0] },
      },
      '2': {
        class_type: 'SamplerCustomAdvanced',
        inputs: {
          noise: ['3', 0],
          guider: ['1', 0],
          sampler: ['7', 0],
          sigmas: ['8', 0],
          latent_image: ['5', 0],
        },
      },
      '3': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } },
      '4': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' },
      },
      '5': {
        class_type: 'EmptyLatentImage',
        inputs: { width: 1024, height: 1024, batch_size: 1 },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: 'A surreal, chaotic depiction of a whimsical fox sitting on a tree, oil painting',
          clip: ['9', 0],
        },
      },
      '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
      '8': {
        class_type: 'BasicScheduler',
        inputs: { scheduler: 'simple', steps: 20, denoise: 1, model: ['4', 0] },
      },
      '9': {
        class_type: 'CLIPLoader',
        inputs: { clip_name: 't5xxl_fp16.safetensors', type: 'flux' },
      },
    };

    const result = resolvePromptFromGraph({}, prompt);

    expect(result.prompt).toBe(
      'A surreal, chaotic depiction of a whimsical fox sitting on a tree, oil painting'
    );
    expect(result.negativePrompt).toBeFalsy();
  });

  it('does not fall through to a positive input on an unknown conditioning node', () => {
    const prompt = {
      '1': {
        class_type: 'KSampler',
        inputs: {
          seed: 1,
          steps: 20,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
          model: ['9', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['8', 0],
        },
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'the positive prompt', clip: ['7', 0] },
      },
      // Unknown node carrying both sides: its negative branch is empty, so
      // the walk must stop there instead of continuing into `positive`.
      '3': {
        class_type: 'SomeConditioningMerger',
        inputs: { negative: ['4', 0], positive: ['2', 0] },
      },
      '4': { class_type: 'SomeEmptySource', inputs: {} },
      '7': {
        class_type: 'CLIPLoader',
        inputs: { clip_name: 'clip.safetensors', type: 'flux' },
      },
      '8': {
        class_type: 'EmptyLatentImage',
        inputs: { width: 512, height: 512, batch_size: 1 },
      },
      '9': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'model.safetensors', weight_dtype: 'default' },
      },
    };

    const result = resolvePromptFromGraph({}, prompt);

    expect(result.prompt).toBe('the positive prompt');
    expect(result.negativePrompt).toBeFalsy();
  });
});
