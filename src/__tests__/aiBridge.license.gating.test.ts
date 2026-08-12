import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── License gating tests ─────────────────────────────────────────────
// These tests verify that every premium AI feature is locked behind a
// valid license. The ai-intelligence module is mocked as AVAILABLE, so
// any null return below is caused by the license gate, NOT by a missing
// module — proving the closed-source implementations are unreachable
// without premium.
//
// Constructor spies (vi.hoisted — required because vi.mock factories are
// hoisted above top-level const declarations) let us assert exactly which
// closed-source classes were instantiated.

const mocks = vi.hoisted(() => ({
  LLMTagGenerator: vi.fn(),
  TagGenerator: vi.fn(),
  WebLLMEmbeddingProvider: vi.fn(),
  StackingEngine: vi.fn(),
  SharedMLEngine: vi.fn(),
  SemanticSearchEngine: vi.fn(),
}));

// Vitest 4's file-backed localStorage can be inert on some machines (see the
// `--localstorage-file` warning) — it exposes an object with no Storage
// methods, which crashes zustand's persist middleware on setState. Install a
// working in-memory implementation BEFORE the store module is imported.
vi.hoisted(() => {
  const data: Record<string, string> = {};
  const storage: Storage = {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
    removeItem: (k) => {
      delete data[k];
    },
    clear: () => {
      for (const k in data) delete data[k];
    },
    key: (i) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length;
    },
  };
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
});

vi.mock('@ai-images-browser/ai-intelligence', () => {
  class LLMTagGenerator {
    // Forward args verbatim (exact arity) so tests can assert standalone
    // vs shared-engine construction shapes.
    constructor(...args: unknown[]) {
      mocks.LLMTagGenerator(...args);
    }
    async initialize(): Promise<void> {}
    async generateTagsFromPrompt(prompt: string): Promise<string[]> {
      return [prompt, 'llm-tag'];
    }
    dispose(): void {}
    get lastRawResponse(): string | null {
      return null;
    }
  }

  class TagGenerator {
    constructor() {
      mocks.TagGenerator();
    }
    async generateTagsFromPrompt(prompt: string): Promise<string[]> {
      return [prompt, 'module-tag'];
    }
  }

  class WebLLMEmbeddingProvider {
    readonly dimension = 768;
    readonly modelId = 'mock-embed-model';
    // Forward args verbatim (exact arity) so tests can assert standalone
    // vs shared-engine construction shapes.
    constructor(...args: unknown[]) {
      mocks.WebLLMEmbeddingProvider(...args);
    }
    async initialize(): Promise<void> {}
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array(768));
    }
    dispose(): void {}
  }

  class StackingEngine {
    constructor() {
      mocks.StackingEngine();
    }
    generatePromptHash(prompt: string): string {
      return prompt.length.toString(16).padStart(8, '0');
    }
    normalizePrompt(prompt: string): string {
      return prompt.trim();
    }
    computePromptSimilarity(_a: string, _b: string): number {
      return 1;
    }
    async computeSimilarityGroupIds(): Promise<{ groupIdToSimId: Map<string, string> }> {
      return { groupIdToSimId: new Map() };
    }
  }

  class SharedMLEngine {
    // The bridge calls the static create() (lazy engine creation) — that's
    // the surface the spy records.
    static async create(options?: unknown): Promise<SharedMLEngine> {
      mocks.SharedMLEngine(options);
      return new SharedMLEngine();
    }
    getChatEngine() {
      return {
        chat: { completions: { create: async () => ({ choices: [] }) } },
        unload: async () => {},
      };
    }
    getEmbeddingEngine() {
      return {
        embeddings: { create: async () => ({ data: [] }) },
        unload: async () => {},
      };
    }
    async unload(): Promise<void> {}
  }

  class SemanticSearchEngine {
    // Forward the provider verbatim — the bridge wires provider → engine.
    constructor(...args: unknown[]) {
      mocks.SemanticSearchEngine(...args);
    }
    async initialize(): Promise<void> {}
    async addEntries(): Promise<void> {}
    restore(): number {
      return 0;
    }
    remove(): void {}
    getTextHash(): string | undefined {
      return undefined;
    }
    async query(): Promise<Array<{ imageId: string; score: number }>> {
      return [];
    }
    getStatus(): { initialized: boolean; indexedCount: number; modelId: string; dimension: number } {
      return { initialized: false, indexedCount: 0, modelId: 'mock-embed-model', dimension: 768 };
    }
    dispose(): void {}
  }

  // Pure functions (no constructor to spy on) — exposed through the bridge
  // as the semantic text builder.
  const buildSearchableText = (input: { prompt?: string }): string => input.prompt ?? '';
  const buildTextHash = (text: string): string => `hash:${text}`;

  return {
    LLMTagGenerator,
    TagGenerator,
    WebLLMEmbeddingProvider,
    StackingEngine,
    SharedMLEngine,
    SemanticSearchEngine,
    buildSearchableText,
    buildTextHash,
    // The bridge's factories call this before constructing engines; vitest's
    // mock proxy throws on missing exports, so the spy must exist (its calls
    // are asserted by aiBridge.devicePreference.test.ts, not here).
    applyGpuPreference: vi.fn(),
  };
});

// Imported statically so we can control license state; aiBridge's internal
// checkPremiumLicense() dynamic-imports the same module instance.
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';
import type { LicenseStatus } from '../services/licenseService';

const NON_PREMIUM_STATUSES: LicenseStatus[] = ['unchecked', 'invalid', 'expired', 'revoked'];
const PREMIUM_STATUSES: LicenseStatus[] = ['valid', 'offline-valid'];

const setLicenseStatus = (status: LicenseStatus) => {
  const ts = status === 'valid' || status === 'offline-valid' ? Date.now() : 0;
  const key = status === 'valid' || status === 'offline-valid' ? 'TEST-KEY-1234' : '';
  useSettingsStore.setState({
    licenseKey: key,
    licenseStatus: status,
    licenseEmail: '',
    licensePurchaseDate: null,
    licenseLastValidated: ts,
    licenseStamp: key
      ? computeLicenseStamp(key, status, ts)
      : '',
  });
};

describe('aiBridge — premium gating without a license', () => {
  beforeEach(() => {
    for (const spy of Object.values(mocks)) spy.mockClear();
  });

  for (const status of NON_PREMIUM_STATUSES) {
    describe(`license status "${status}"`, () => {
      beforeEach(() => setLicenseStatus(status));

      it('createLLMTagGenerator returns null and never touches the closed-source module', async () => {
        const { createLLMTagGenerator } = await import('../services/aiBridge');
        const llm = await createLLMTagGenerator();
        expect(llm).toBeNull();
        expect(mocks.LLMTagGenerator).not.toHaveBeenCalled();
      });

      it('createEmbeddingProvider returns null and never touches the closed-source module', async () => {
        const { createEmbeddingProvider } = await import('../services/aiBridge');
        const provider = await createEmbeddingProvider();
        expect(provider).toBeNull();
        expect(mocks.WebLLMEmbeddingProvider).not.toHaveBeenCalled();
      });

      it('createStackingEngine returns null and never touches the closed-source module', async () => {
        const { createStackingEngine } = await import('../services/aiBridge');
        const engine = await createStackingEngine();
        expect(engine).toBeNull();
        expect(mocks.StackingEngine).not.toHaveBeenCalled();
      });

      it('createSharedEngine returns null and never touches the closed-source module', async () => {
        const { createSharedEngine } = await import('../services/aiBridge');
        const engine = await createSharedEngine();
        expect(engine).toBeNull();
        expect(mocks.SharedMLEngine).not.toHaveBeenCalled();
      });

      it('createSemanticSearchEngine returns null and never touches the closed-source module', async () => {
        const { createSemanticSearchEngine } = await import('../services/aiBridge');
        const engine = await createSemanticSearchEngine();
        expect(engine).toBeNull();
        expect(mocks.WebLLMEmbeddingProvider).not.toHaveBeenCalled();
        expect(mocks.SemanticSearchEngine).not.toHaveBeenCalled();
      });

      it('createSemanticTextBuilder returns null without a license', async () => {
        const { createSemanticTextBuilder } = await import('../services/aiBridge');
        const builder = await createSemanticTextBuilder();
        expect(builder).toBeNull();
      });

      it('createTagGenerator returns null without a license', async () => {
        const { createTagGenerator } = await import('../services/aiBridge');
        const tagger = await createTagGenerator();

        // The free built-in fallback was dropped (2026-08-12): the module's
        // TagGenerator is only reachable with a valid license.
        expect(tagger).toBeNull();
        expect(mocks.TagGenerator).not.toHaveBeenCalled();
      });
    });
  }
});

// The free built-in tag generator was REMOVED (2026-08-12): auto-tagging
// is premium-only, so createTagGenerator returns null without a license
// (covered by the non-premium describe above).

describe('aiBridge — premium features with a license', () => {
  for (const status of PREMIUM_STATUSES) {
    describe(`license status "${status}"`, () => {
      beforeEach(() => {
        setLicenseStatus(status);
        for (const spy of Object.values(mocks)) spy.mockClear();
      });

      it('createLLMTagGenerator constructs the closed-source LLM generator', async () => {
        const { createLLMTagGenerator } = await import('../services/aiBridge');
        const llm = await createLLMTagGenerator('model-x');

        expect(llm).not.toBeNull();
        expect(mocks.LLMTagGenerator).toHaveBeenCalledTimes(1);
        expect(mocks.LLMTagGenerator).toHaveBeenCalledWith('model-x', undefined);
      });

      it('createEmbeddingProvider constructs the closed-source embedding provider', async () => {
        const { createEmbeddingProvider } = await import('../services/aiBridge');
        const provider = await createEmbeddingProvider('embed-model', 384);

        expect(provider).not.toBeNull();
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledTimes(1);
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledWith('embed-model', 384, undefined);
      });

      it('createStackingEngine constructs the closed-source stacking engine', async () => {
        const { createStackingEngine } = await import('../services/aiBridge');
        const engine = await createStackingEngine();

        expect(engine).not.toBeNull();
        expect(mocks.StackingEngine).toHaveBeenCalledTimes(1);
      });

      it('createSharedEngine constructs the shared engine lazily', async () => {
        const { createSharedEngine } = await import('../services/aiBridge');
        const engine = await createSharedEngine();

        expect(engine).not.toBeNull();
        expect(mocks.SharedMLEngine).toHaveBeenCalledTimes(1);
        // The bridge always passes the options object (onProgress optional).
        expect(mocks.SharedMLEngine).toHaveBeenCalledWith({ onProgress: undefined });
      });

      it('createSharedEngine forwards the onProgress callback', async () => {
        const { createSharedEngine } = await import('../services/aiBridge');
        const onProgress = vi.fn();

        const engine = await createSharedEngine({ onProgress });
        expect(engine).not.toBeNull();
        expect(mocks.SharedMLEngine).toHaveBeenCalledTimes(1);
        expect(mocks.SharedMLEngine).toHaveBeenCalledWith({ onProgress });
      });

      it('createLLMTagGenerator reuses the shared chat engine when one exists', async () => {
        const { createSharedEngine, createLLMTagGenerator } = await import('../services/aiBridge');
        const shared = await createSharedEngine();
        expect(shared).not.toBeNull();

        mocks.LLMTagGenerator.mockClear();
        const llm = await createLLMTagGenerator('model-x', undefined, { sharedEngine: shared! });
        expect(llm).not.toBeNull();
        expect(mocks.LLMTagGenerator).toHaveBeenCalledTimes(1);
        expect(mocks.LLMTagGenerator).toHaveBeenCalledWith(
          'model-x',
          undefined,
          expect.objectContaining({ chat: expect.any(Object), unload: expect.any(Function) }),
        );
      });

      it('createEmbeddingProvider reuses the shared embedding engine when one exists', async () => {
        const { createSharedEngine, createEmbeddingProvider } = await import('../services/aiBridge');
        const shared = await createSharedEngine();
        expect(shared).not.toBeNull();

        mocks.WebLLMEmbeddingProvider.mockClear();
        const provider = await createEmbeddingProvider('embed-model', 384, undefined, {
          sharedEngine: shared!,
        });
        expect(provider).not.toBeNull();
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledTimes(1);
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledWith(
          'embed-model',
          384,
          undefined,
          expect.objectContaining({ embeddings: expect.any(Object), unload: expect.any(Function) }),
        );
      });

      it('createSemanticSearchEngine constructs the provider and the engine standalone', async () => {
        const { createSemanticSearchEngine } = await import('../services/aiBridge');
        const engine = await createSemanticSearchEngine();

        expect(engine).not.toBeNull();
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledTimes(1);
        // Standalone path: provider loads the embed model itself.
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledWith(
          expect.any(String),
          768,
          undefined,
        );
        // The engine receives the freshly constructed provider instance.
        expect(mocks.SemanticSearchEngine).toHaveBeenCalledTimes(1);
        expect(mocks.SemanticSearchEngine).toHaveBeenCalledWith(
          expect.objectContaining({ dimension: 768, modelId: 'mock-embed-model' }),
        );
      });

      it('createSemanticSearchEngine reuses the shared embedding engine when one exists', async () => {
        const { createSharedEngine, createSemanticSearchEngine } = await import('../services/aiBridge');
        const shared = await createSharedEngine();
        expect(shared).not.toBeNull();

        mocks.WebLLMEmbeddingProvider.mockClear();
        mocks.SemanticSearchEngine.mockClear();
        const engine = await createSemanticSearchEngine({ sharedEngine: shared! });

        expect(engine).not.toBeNull();
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledTimes(1);
        // Shared path: the provider is a thin adapter over the engine's
        // embedding record — no standalone model load.
        expect(mocks.WebLLMEmbeddingProvider).toHaveBeenCalledWith(
          expect.any(String),
          768,
          undefined,
          expect.objectContaining({ embeddings: expect.any(Object), unload: expect.any(Function) }),
        );
        expect(mocks.SemanticSearchEngine).toHaveBeenCalledWith(
          expect.objectContaining({ dimension: 768, modelId: 'mock-embed-model' }),
        );
      });

      it('createTagGenerator uses the closed-source TagGenerator', async () => {
        const { createTagGenerator } = await import('../services/aiBridge');
        const tagger = await createTagGenerator();

        expect(tagger).not.toBeNull();
        expect(mocks.TagGenerator).toHaveBeenCalledTimes(1);
      });

      it('createSemanticTextBuilder exposes the module text builder functions', async () => {
        const { createSemanticTextBuilder } = await import('../services/aiBridge');
        const builder = await createSemanticTextBuilder();

        expect(builder).not.toBeNull();
        expect(typeof builder!.buildSearchableText).toBe('function');
        expect(typeof builder!.buildTextHash).toBe('function');
        expect(builder!.buildSearchableText({ prompt: 'a fox' })).toBe('a fox');
        expect(builder!.buildTextHash('x')).toBe('hash:x');
      });
    });
  }
});

describe('aiFeatureAccess — UI gate helper', () => {
  beforeEach(() => {
    setLicenseStatus('unchecked');
  });

  it('isAiFeaturesEnabled() is false without a license', async () => {
    const { isAiFeaturesEnabled } = await import('../services/aiFeatureAccess');
    for (const status of NON_PREMIUM_STATUSES) {
      setLicenseStatus(status);
      expect(isAiFeaturesEnabled(), `status=${status}`).toBe(false);
    }
  });

  it('isAiFeaturesEnabled() is true with a premium license', async () => {
    const { isAiFeaturesEnabled } = await import('../services/aiFeatureAccess');
    for (const status of PREMIUM_STATUSES) {
      setLicenseStatus(status);
      expect(isAiFeaturesEnabled(), `status=${status}`).toBe(true);
    }
  });

  it('isSemanticSearchEnabled() is false without a license or with the feature off', async () => {
    const { isSemanticSearchEnabled, useSemanticSearchEnabled } = await import('../services/aiFeatureAccess');
    // Regression: this imperative variant must run OUTSIDE React render —
    // it is called from zustand actions / the post-indexing pipeline, where
    // the reactive hook would throw "Invalid hook call" (React error #321).
    useSettingsStore.setState({ isSemanticSearchEnabled: false });
    for (const status of NON_PREMIUM_STATUSES) {
      setLicenseStatus(status);
      expect(isSemanticSearchEnabled(), `status=${status}`).toBe(false);
    }
    setLicenseStatus('valid');
    expect(isSemanticSearchEnabled()).toBe(false); // premium OK, pref off

    // The hook itself is unusable outside a component render — exactly why
    // the imperative twin exists.
    expect(() => useSemanticSearchEnabled()).toThrow();
  });

  it('isSemanticSearchEnabled() is true only with premium + the user pref on', async () => {
    const { isSemanticSearchEnabled } = await import('../services/aiFeatureAccess');
    useSettingsStore.setState({ isSemanticSearchEnabled: true });
    for (const status of PREMIUM_STATUSES) {
      setLicenseStatus(status);
      expect(isSemanticSearchEnabled(), `status=${status}`).toBe(true);
    }
  });

  it('useAiFeaturesEnabled() reacts to license changes', async () => {
    const { useAiFeaturesEnabled } = await import('../services/aiFeatureAccess');
    const { result } = renderHook(() => useAiFeaturesEnabled());

    act(() => setLicenseStatus('unchecked'));
    expect(result.current).toBe(false);

    act(() => setLicenseStatus('valid'));
    expect(result.current).toBe(true);

    act(() => setLicenseStatus('revoked'));
    expect(result.current).toBe(false);

    act(() => setLicenseStatus('offline-valid'));
    expect(result.current).toBe(true);
  });
});

describe('aiBridge — license revocation mid-session', () => {
  beforeEach(() => {
    for (const spy of Object.values(mocks)) spy.mockClear();
  });

  it('locks premium features as soon as the license is no longer valid', async () => {
    // Activate first — module gets loaded and cached inside aiBridge.
    setLicenseStatus('valid');
    const { createLLMTagGenerator } = await import('../services/aiBridge');
    const llm = await createLLMTagGenerator();
    expect(llm).not.toBeNull();
    expect(mocks.LLMTagGenerator).toHaveBeenCalledTimes(1);

    // Revoke the license (e.g. refund or expiry) — the module cache must
    // NOT bypass the gate on the next call.
    setLicenseStatus('revoked');
    const llm2 = await createLLMTagGenerator();
    expect(llm2).toBeNull();
    expect(mocks.LLMTagGenerator).toHaveBeenCalledTimes(1); // no new construction
  });
});
