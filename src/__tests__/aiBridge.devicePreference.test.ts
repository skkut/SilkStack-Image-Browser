/**
 * aiBridge GPU-preference tests — the four engine factories must apply the
 * device preference (and, on the shared engine, the adapter-info callback)
 * before constructing. The patch implementation lives in the ai-intelligence
 * module (ai-intelligence/src/gpu/gpuPreference.ts, covered by the module's
 * own tests); the app's gpuPreference.ts is contract-only. The module is
 * mocked with constructable classes plus an `applyGpuPreference` spy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@ai-images-browser/ai-intelligence', () => {
  class LLMTagGenerator {
    constructor(
      public modelId: string,
      public onProgress?: unknown,
      public chatEngine?: unknown,
    ) {}
  }
  class WebLLMEmbeddingProvider {
    constructor(
      public modelId: string,
      public dimension?: number,
      public onProgress?: unknown,
      public embeddingEngine?: unknown,
    ) {}
  }
  class SemanticSearchEngine {
    constructor(public provider: unknown) {}
  }
  class SharedMLEngine {
    static create = vi.fn(async () => ({
      getChatEngine: () => ({}),
      getEmbeddingEngine: () => ({}),
      unload: async () => {},
    }));
  }
  return {
    LLMTagGenerator,
    WebLLMEmbeddingProvider,
    SemanticSearchEngine,
    SharedMLEngine,
    applyGpuPreference: vi.fn(),
  };
});

import { applyGpuPreference } from '@ai-images-browser/ai-intelligence';
import {
  createSharedEngine,
  createLLMTagGenerator,
  createEmbeddingProvider,
  createSemanticSearchEngine,
  TAG_GENERATION_MODEL_ID,
  EMBEDDING_MODEL_ID,
} from '../services/aiBridge';

beforeEach(() => {
  vi.clearAllMocks(); // keeps implementations — only call records reset
});

describe('aiBridge GPU preference application', () => {
  it('createSharedEngine applies high-performance and forwards the info callback', async () => {
    const onAdapterInfo = vi.fn();
    const engine = await createSharedEngine({
      skipPremiumCheck: true,
      devicePreference: 'high-performance',
      onAdapterInfo,
    });
    expect(engine).not.toBeNull();
    expect(applyGpuPreference).toHaveBeenCalledWith('high-performance', onAdapterInfo);
  });

  it('createSharedEngine defaults to auto without a preference', async () => {
    const engine = await createSharedEngine({ skipPremiumCheck: true });
    expect(engine).not.toBeNull();
    expect(applyGpuPreference).toHaveBeenCalledWith('auto', undefined);
  });

  it('createLLMTagGenerator applies low-power before constructing', async () => {
    const tagger = await createLLMTagGenerator(TAG_GENERATION_MODEL_ID, undefined, {
      skipPremiumCheck: true,
      devicePreference: 'low-power',
    });
    expect(tagger).not.toBeNull();
    expect(applyGpuPreference).toHaveBeenCalledWith('low-power');
  });

  it('createEmbeddingProvider applies high-performance', async () => {
    const provider = await createEmbeddingProvider(EMBEDDING_MODEL_ID, 768, undefined, {
      skipPremiumCheck: true,
      devicePreference: 'high-performance',
    });
    expect(provider).not.toBeNull();
    expect(applyGpuPreference).toHaveBeenCalledWith('high-performance');
  });

  it('createSemanticSearchEngine applies software (standalone provider path)', async () => {
    const engine = await createSemanticSearchEngine({
      skipPremiumCheck: true,
      devicePreference: 'software',
    });
    expect(engine).not.toBeNull();
    expect(applyGpuPreference).toHaveBeenCalledWith('software');
  });
});
