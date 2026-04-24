import { describe, it, expect } from 'vitest';
import { extractModelsFromInvokeAI } from './invokeAIParser';

describe('extractModelsFromInvokeAI', () => {
  it('should extract models from standard fields', () => {
    const metadata = {
      model: 'model1.safetensors',
      base_model: 'base.ckpt',
      model_name: 'name.pt'
    } as any;
    const models = extractModelsFromInvokeAI(metadata);
    expect(models).toContain('model1.safetensors');
    expect(models).toContain('base.ckpt');
    expect(models).toContain('name.pt');
  });

  it('should extract models from nested JSON fields (regex test)', () => {
    const metadata = {
      random_field: 'extra_model.safetensors',
      another_one: '  spaced_model.ckpt  '
    } as any;
    const models = extractModelsFromInvokeAI(metadata);
    expect(models).toContain('extra_model.safetensors');
    expect(models).toContain('spaced_model.ckpt');
  });

  it('should ignore models in loras field', () => {
    const metadata = {
      loras: [
        { model: { name: 'lora.safetensors' } }
      ]
    } as any;
    const models = extractModelsFromInvokeAI(metadata);
    expect(models).not.toContain('lora.safetensors');
  });

  it('should handle filenames with spaces correctly', () => {
    const metadata = {
      field: 'model with spaces.safetensors'
    } as any;
    const models = extractModelsFromInvokeAI(metadata);
    expect(models).toContain('model with spaces.safetensors');
  });
});
