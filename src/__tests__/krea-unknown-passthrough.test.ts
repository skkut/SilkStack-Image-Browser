import { describe, it, expect } from 'vitest';
import { resolvePromptFromGraph } from '../services/parsers/comfyUIParser';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Prompt extraction through an UNREGISTERED custom node (2026-09-10).
 *
 * Krea2 workflows place `RBG_Smart_Seed_Variance` — a custom node with no
 * NodeRegistry entry — on the positive conditioning path, between
 * CLIPTextEncode and KSampler:
 *
 *   PrimitiveStringMultiline("Positive Prompt") ─┬─> StringConcatenate ─> TextGenerate ─> ComfySwitchNode ─> CLIPTextEncode
 *   PrimitiveStringMultiline("System Prompt")   ─┘                                          ↑
 *                                                └──────────────────────────────────────────┘ (on_false)
 *                                                                                          │
 *                            RBG_Smart_Seed_Variance (UNKNOWN) <── CLIPTextEncode <────────┘
 *                                        │
 *                                     KSampler
 *
 * Traversal used to give up at the unknown node, severing the chain. Prompt
 * resolution then fell through to the global fallback scanner, whose
 * "longest string wins" rule returned the TextGenerate system prompt — a long
 * instruction block — instead of the user's prompt.
 *
 * The fix treats unregistered nodes as transparent pass-throughs, so the
 * standard traversal now walks the whole chain. These tests assert both the
 * correct value AND that no fallback tier was needed, because a passing value
 * produced by the wrong tier is exactly the bug being guarded against.
 */
describe('Prompt extraction through an unregistered custom node', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'comfyui', 'krea-unknown-passthrough.json');
  const rawData = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  const EXPECTED_PROMPT =
    'a beautiful woman dressed in a beautiful Diwali outfit, adorned with traditional ' +
    'Indian jewelry and vibrant colors, surrounded by Diwali decorations';
  const EXPECTED_NEGATIVE = 'ugly, bad, blurred, watermark, dithered, freckles';
  const SYSTEM_PROMPT_MARKER = 'You are an expert prompt engineer';

  it('extracts the user prompt, not the TextGenerate system prompt', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.prompt).toBe(EXPECTED_PROMPT);
    expect(result.prompt).not.toContain(SYSTEM_PROMPT_MARKER);
  });

  it('resolves it with the standard traversal, without any fallback tier', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    const warnings: string[] = result._telemetry?.warnings ?? [];
    // A prompt that is merely *correct by accident* after falling through to
    // the global scanner is the original bug — guard the tier, not just the value.
    expect(warnings.join('\n')).not.toMatch(/global graph fallback|deep topological reconstructor/i);
  });

  it('extracts the negative prompt (reached through its own unknown-free path)', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.negativePrompt).toBe(EXPECTED_NEGATIVE);
  });

  it('still reads model and sampling parameters through the unknown node', () => {
    const result = resolvePromptFromGraph(rawData.workflow, undefined);
    expect(result.model).toBe('fasciumKREA2_experimental2008.safetensors');
    expect(result.seed).toBe(706195062765197);
    expect(result.steps).toBe(8);
    expect(result.cfg).toBe(1);
    expect(result.sampler_name).toBe('euler_ancestral');
  });

  it('follows the on_false branch when the enhancement switch is off', () => {
    // Same structural conclusion must hold on the raw-prompt branch, which
    // reaches the text node directly instead of via StringConcatenate.
    const workflow = JSON.parse(JSON.stringify(rawData.workflow));
    workflow['152:213'].inputs.switch = false;

    const result = resolvePromptFromGraph(workflow, undefined);
    expect(result.prompt).toBe(EXPECTED_PROMPT);
  });

  it('does not leak the system prompt when the switch routes to the raw branch', () => {
    const workflow = JSON.parse(JSON.stringify(rawData.workflow));
    workflow['152:213'].inputs.switch = false;

    const result = resolvePromptFromGraph(workflow, undefined);
    expect(result.prompt).not.toContain(SYSTEM_PROMPT_MARKER);
  });
});
