import { describe, expect, it, vi } from 'vitest';

// ── aiBridge gating tests ───────────────────────────────────────────────
// These tests verify that all bridge factory functions return null gracefully
// when the ai-intelligence module cannot be loaded (simulating the scenario
// where the optional package is not installed).
//
// The vi.mock at the top level is hoisted by Vitest and applies to all tests
// in this file — every test exercises the "AI unavailable" codepath.

vi.mock('@ai-images-browser/ai-intelligence', () => {
  throw new Error('Module not found (simulated)');
});

describe('aiBridge — all factories return null when AI module is unavailable', () => {
  it('createStackingEngine returns null gracefully', async () => {
    const { createStackingEngine } = await import('../services/aiBridge');
    const engine = await createStackingEngine();
    expect(engine).toBeNull();
  });

  it('createLLMTagGenerator returns null gracefully', async () => {
    const { createLLMTagGenerator } = await import('../services/aiBridge');
    const llm = await createLLMTagGenerator();
    expect(llm).toBeNull();
  });

  it('createEmbeddingProvider returns null gracefully', async () => {
    const { createEmbeddingProvider } = await import('../services/aiBridge');
    const provider = await createEmbeddingProvider();
    expect(provider).toBeNull();
  });

  it('createSharedEngine returns null gracefully', async () => {
    const { createSharedEngine } = await import('../services/aiBridge');
    const engine = await createSharedEngine();
    expect(engine).toBeNull();
  });

  it('createSemanticSearchEngine returns null gracefully', async () => {
    const { createSemanticSearchEngine } = await import('../services/aiBridge');
    const engine = await createSemanticSearchEngine();
    expect(engine).toBeNull();
  });

  it('createSemanticTextBuilder returns null gracefully', async () => {
    const { createSemanticTextBuilder } = await import('../services/aiBridge');
    const builder = await createSemanticTextBuilder();
    expect(builder).toBeNull();
  });

  it('createTagGenerator always succeeds with built-in fallback', async () => {
    const { createTagGenerator } = await import('../services/aiBridge');
    const tagger = await createTagGenerator();

    // BuiltInTagGenerator is always available as fallback
    expect(tagger).not.toBeNull();
    expect(typeof tagger!.generateTagsFromPrompt).toBe('function');
  });

  it('isAiAvailable returns false', async () => {
    const { isAiAvailable } = await import('../services/aiBridge');
    const result = await isAiAvailable();
    expect(result).toBe(false);
  });
});
