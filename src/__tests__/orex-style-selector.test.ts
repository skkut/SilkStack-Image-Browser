import { describe, it, expect } from 'vitest';
import { resolvePromptFromGraph, parseComfyUIMetadataEnhanced } from '../services/parsers/comfyUIParser';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Prompt extraction through the "🪄 Style Selector (OreX)" node
 * (class_type `OrexStyleSelector`), API/execution workflow format.
 *
 * The Krea2 workflow routes the prompt text through the style selector:
 *
 *   positive text (PrimitiveStringMultiline "Positive Prompt")
 *     → OrexStyleSelector.positive      negative text (228)
 *     → OrexStyleSelector.negative
 *   Orex slot 0 (styled positive text) → concat / switch → CLIPTextEncode+
 *   Orex slot 1 (styled negative text) → CLIPTextEncode-
 *
 * The positive CLIPTextEncode is fed through an if/else switch whose
 * alternate branch is a TextGenerate enhancement chain carrying the LLM
 * system template ("You are an expert prompt engineer…") in another
 * PrimitiveStringMultiline. Without a registry entry for OrexStyleSelector
 * the traversal dies at the unknown node, and the fallback scanner picks
 * the longest text in the graph — the system template — as the prompt.
 *
 * The OreX node must be traced structurally: its styled outputs derive from
 * its `positive`/`negative` STRING inputs, so prompt/negativePrompt lookups
 * must follow those inputs back to the underlying text nodes.
 */
describe('Prompt extraction through OrexStyleSelector', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'comfyui', 'orex-style-selector.json');
  const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
  const EXPECTED_PROMPT =
    'a beautiful woman dressed in a beautiful Diwali outfit, adorned with traditional Indian jewelry and vibrant colors, ' +
    'surrounded by Diwali decorations, including lanterns and diyas, illuminating the scene with a magical glow splash paint art background, dynamic composition,';
  const EXPECTED_NEGATIVE = 'ugly, bad, blurred, watermark, dithered, freckles';

  it('extracts the positive prompt through the OreX style selector', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.prompt).toBe(EXPECTED_PROMPT);
    expect(result.prompt).toContain('beautiful Diwali outfit');
  });

  it('extracts the negative prompt through the OreX style selector negative output', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.negativePrompt).toBe(EXPECTED_NEGATIVE);
  });

  it('does NOT confuse the prompt-enhance system template with the image prompt', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.prompt).not.toContain('You are an expert prompt engineer');
    expect(result.prompt).not.toContain('text-to-image models');
  });

  it('works through parseComfyUIMetadataEnhanced as well', async () => {
    const result = await parseComfyUIMetadataEnhanced(rawData);
    expect(result.prompt).toBe(EXPECTED_PROMPT);
    expect(result.negativePrompt).toBe(EXPECTED_NEGATIVE);
  });
});
