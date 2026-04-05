import { describe, it, expect } from 'vitest';
import { resolvePromptFromGraph } from '../services/parsers/comfyUIParser';
import * as fs from 'fs';
import * as path from 'path';

function loadFixture(name: string): any {
  const fixturePath = path.join(__dirname, 'fixtures', 'comfyui', name);
  const content = fs.readFileSync(fixturePath, 'utf-8');
  return JSON.parse(content);
}

describe('ComfyUI Parser - Power Lora Loader', () => {
  it('should extract only enabled LoRAs (on: true) from Power Lora Loader', () => {
    const fixture = loadFixture('power-lora-loader.json');
    const result = resolvePromptFromGraph(fixture.workflow, fixture.prompt);

    // Only 1 enabled LoRA (the other two have on: false)
    expect(result.loras).toBeDefined();
    expect(result.loras).toHaveLength(1);
    expect(result.loras[0].name).toBe('ZIT\\zit_fdpo_enhance_colors_v1.safetensors');
    expect(result.loras[0].weight).toBe(0.85);

    // Backward-compat lora array
    expect(result.lora).toContain('ZIT\\zit_fdpo_enhance_colors_v1.safetensors');
    // Disabled LoRAs must NOT appear
    expect(result.lora).not.toContain('ZIT\\negative_n_hyperbolic.safetensors');
    expect(result.lora).not.toContain('ZIT\\Disney_IZT_ATK_V1.safetensors');
  });
});
