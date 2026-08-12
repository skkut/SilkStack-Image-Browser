/**
 * AI Bridge — optional dependency abstraction layer with premium gating.
 *
 * All AI features (LLM auto-tagging, prompt embeddings, smart stacking) flow
 * through this module. When the `@ai-images-browser/ai-intelligence` package
 * is available AND the user has a valid premium license, real WebLLM-powered
 * implementations are used. When absent, graceful fallbacks ensure the app
 * compiles and runs without AI features.
 *
 * Premium features (require license — everything inside ai-intelligence):
 *   - createLLMTagGenerator()    — LLM-based auto-tagging
 *   - createEmbeddingProvider()  — Semantic prompt embeddings
 *   - createSharedEngine()       — Shared WebLLM engine (chat + embeddings)
 *   - createSemanticSearchEngine() — Natural-language search over prompts/tags
 *   - createSemanticTextBuilder() — Searchable-text build + FNV-1a hash (Δ re-indexing)
 *   - createStackingEngine()     — AI-powered image grouping
 *   - createTagGenerator()       — Rule-based extraction from ai-intelligence
 *
 * Free features (always available, open-source code in this repo):
 *   - createTagGenerator()       — falls back to BuiltInTagGenerator without a license
 *
 * Usage:
 *   const llm = await createLLMTagGenerator(modelId, onProgress);
 *   if (!llm) { ... handle unavailable case ... }
 *
 *   const tagger = await createTagGenerator();  // always succeeds (built-in fallback)
 */

import {
  applyGpuPreference,
  type AiDevicePreference,
  type DetectedGpuInfo,
} from './gpuPreference';

// Re-exported so workers and stores consume the types through the bridge.
export type { AiDevicePreference, DetectedGpuInfo };

// ── Local type declarations (mirrored from ai-intelligence) ──────────

/** Progress callback used during model loading. */
export interface LoadProgressReport {
  progress: number; // 0–1
  text: string;
}

/** Interface for rule-based tag extraction (no ML dependency). */
export interface ITagGenerator {
  generateTagsFromPrompt(prompt: string): Promise<string[]>;
}

/** Interface for LLM-powered tag extraction (WebLLM/WebGPU). */
export interface ILLMTagGenerator extends ITagGenerator {
  initialize(): Promise<void>;
  dispose(): void;
  readonly lastRawResponse: string | null;
  generateTagsFromPrompt(prompt: string, systemPrompt?: string): Promise<string[]>;
}

/** Interface for text embedding generation (WebLLM/WebGPU). */
export interface IEmbeddingProvider {
  readonly dimension: number;
  readonly modelId: string;
  initialize(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): void;
}

/**
 * Shared ML engine — one WebLLM engine holding two model records
 * (Hermes-3 chat + Arctic embed) under a single WebGPU context.
 * Mirrored from ai-intelligence's SharedMLEngine; the module's own types
 * never flow into the app (see the ambient stub in vite-env.d.ts).
 */
export interface ISharedMLEngine {
  /** Chat view used by the LLM tag generator (auto-tagging). */
  getChatEngine(): ISharedChatEngine;
  /** Embedding view used by the embedding provider (semantic search). */
  getEmbeddingEngine(): ISharedEmbeddingEngine;
  /** Unload all models and release the WebGPU context. */
  unload(): Promise<void>;
}

/** Structural view of the shared engine's chat surface. */
export interface ISharedChatEngine {
  chat: {
    completions: {
      create(params: {
        messages: Array<{ role: string; content: string }>;
        max_tokens?: number;
        temperature?: number;
        /** Required when the engine holds multiple loaded records. */
        model?: string;
      }): Promise<unknown>;
    };
  };
  unload(): Promise<void>;
}

/** Structural view of the shared engine's embedding surface. */
export interface ISharedEmbeddingEngine {
  embeddings: {
    create(params: { input: string | string[]; model?: string }): Promise<unknown>;
  };
  unload(): Promise<void>;
}

/** Progress report while the shared engine loads its records. */
export interface SharedEngineProgressReport extends LoadProgressReport {
  /** The model record currently loading (best-effort). */
  modelId: string;
}

// ── Semantic search (mirrored from ai-intelligence) ───────────────────

/** Cosine threshold below which semantic hits are dropped. */
export const SEMANTIC_SEARCH_THRESHOLD = 0.55;

/** Maximum semantic hits returned by default. */
export const SEMANTIC_SEARCH_TOP_N = 200;

/** One entry to embed and index (textHash invalidates on content change). */
export interface ISemanticIndexEntry {
  imageId: string;
  text: string;
  textHash: string;
}

/** A persisted vector record — restored at startup without re-embedding. */
export interface ISemanticVectorRecord {
  imageId: string;
  vector: Float32Array;
  textHash: string;
  modelId: string;
  dimension: number;
  updatedAt: number;
}

/** A ranked hit from a semantic query. */
export interface ISemanticSearchHit {
  imageId: string;
  score: number;
}

/** Interface for semantic search (WebLLM embeddings + in-memory index). */
export interface ISemanticSearchEngine {
  initialize(): Promise<void>;
  addEntries(entries: ISemanticIndexEntry[]): Promise<void>;
  restore(records: ISemanticVectorRecord[]): number;
  remove(imageIds: string[]): void;
  getTextHash(imageId: string): string | undefined;
  query(
    text: string,
    options?: { limit?: number; threshold?: number },
  ): Promise<ISemanticSearchHit[]>;
  getStatus(): {
    initialized: boolean;
    indexedCount: number;
    modelId: string;
    dimension: number;
  };
  dispose(): void;
}

// ── Mirrored constants (always available, even without ai-intelligence) ──

/** Model used for LLM-based tag extraction. */
export const TAG_GENERATION_MODEL_ID = 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC';

/** Model used for prompt embedding generation. */
export const EMBEDDING_MODEL_ID = 'snowflake-arctic-embed-m-q0f32-MLC-b4';

/** Default system prompt for LLM tag generation. */
export const SYSTEM_PROMPT = `You are an expert image tagging and analyzing system that extracts visual concept tags from image generation prompts.

Rules:
- If the provided text is explicitly sex oriented, add 'nsfw' to the return list
- Return ONLY a valid JSON array of strings. No markdown, no explanations, no other text.
- Ignore quality keywords (masterpiece, 8k, award winning, etc.) and technical tokens (<lora:...>, etc.).
- Extract subjects, clothing, objects, settings, and styles.
- Keep tags simple and concise (no more than 2 words).
- For weighted tags like (cyberpunk city:1.2), extract just the descriptive text: "cyberpunk city".
- remove adjectives from subjects

Examples:
Input: a red fox sitting in a snowy forest, digital painting
Output: ["red fox", "snowy forest", "digital painting"]

Input: A oil painting in style of raja ravi varma, of a young busty fair beautiful and sexy indian girl holding a bouquet of flowers elegantly. bouquet with multi colored tulips, daffodils, in a majestic palace room. she is wearing an elegant yellow saree.
Output: ["oil painting", "raja ravi varma", "indian girl", "flowers", "tulips", "daffodils", "palace room", "yellow saree"]

Input: 1girl, solo, (cyberpunk city:1.2), neon lights, <lora:detailer:0.8>, 8k, high resolution
Output: ["1girl", "solo", "cyberpunk city", "neon lights"]`;

// ── Dynamic module loader ───────────────────────────────────────────

let aiModule: Record<string, unknown> | null = null;

// ── License gate ─────────────────────────────────────────────────────

/**
 * Lazy-imported check to avoid a circular dependency between aiBridge and
 * useSettingsStore. The check is deferred until first use so the store
 * singleton is guaranteed to exist.
 */
async function checkPremiumLicense(): Promise<boolean> {
  try {
    const { isPremiumUnlocked } = await import('../services/aiFeatureAccess');
    return isPremiumUnlocked();
  } catch {
    // Dynamic import failed — likely running in a context where the settings
    // store cannot be initialized (e.g. a Web Worker without `window`).
    // Premium features are unavailable; callers fall back to free alternatives.
    return false;
  }
}
let loadAttempted = false;
let loadError: string | null = null;

async function loadAiModule(): Promise<Record<string, unknown> | null> {
  if (loadAttempted) return aiModule;
  loadAttempted = true;

  // Compile-time guard: when ai-intelligence wasn't present at build time,
  // Vite dead-code-eliminates the import() below, so the module is never
  // resolved. This is what makes the dependency truly optional.
  if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) {
    loadError = 'AI features not available (ai-intelligence package not present at build time)';
    console.warn('[aiBridge] AI intelligence module not available at build time');
    return null;
  }

  try {
    aiModule = await import('@ai-images-browser/ai-intelligence');
    return aiModule;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    console.warn('[aiBridge] AI intelligence module unavailable:', loadError);
    return null;
  }
}

// ── Factory functions ────────────────────────────────────────────────

/**
 * Create an LLM-powered tag generator.
 * Returns `null` if the ai-intelligence module is unavailable or WebGPU
 * isn't supported.
 *
 * Pass `sharedEngine` (from createSharedEngine()) to reuse the shared
 * WebGPU context instead of loading the chat model standalone.
 */
export async function createLLMTagGenerator(
  modelId: string = TAG_GENERATION_MODEL_ID,
  onProgress?: (report: LoadProgressReport) => void,
  opts?: { skipPremiumCheck?: boolean; sharedEngine?: ISharedMLEngine; devicePreference?: AiDevicePreference },
): Promise<ILLMTagGenerator | null> {
  // Premium gate: LLM-based tag generation requires a valid license.
  // Trusted callers (e.g. the auto-tagging worker) may skip this check when
  // the main thread has already verified premium status — the worker's own
  // Zustand store is a separate instance and cannot see the user's license.
  if (!opts?.skipPremiumCheck && !(await checkPremiumLicense())) return null;

  const mod = await loadAiModule();
  if (!mod) return null;

  // Steer the WebGPU adapter before the engine requests one (see gpuPreference.ts).
  applyGpuPreference(opts?.devicePreference ?? 'auto');

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const LLMTagGenerator = (mod as any).LLMTagGenerator;
    if (!LLMTagGenerator) return null;
    // Only pass the engine when one exists — the standalone call shape
    // stays identical so the module owns its own engine (and lifecycle).
    const chatEngine = opts?.sharedEngine?.getChatEngine();
    return (
      (chatEngine
        ? new LLMTagGenerator(modelId, onProgress, chatEngine)
        : new LLMTagGenerator(modelId, onProgress)) as ILLMTagGenerator
    );
  } catch (err) {
    console.warn('[aiBridge] Failed to create LLMTagGenerator:', err);
    return null;
  }
}

/**
 * Create a rule-based tag generator.
 * Always succeeds: uses the real TagGenerator from ai-intelligence if
 * available AND the user has a valid premium license; otherwise falls
 * back to the built-in (open-source) implementation.
 *
 * The closed-source TagGenerator is a premium feature — it must not be
 * reachable without a license, even though the built-in fallback is free.
 */
export async function createTagGenerator(
  opts?: { skipPremiumCheck?: boolean },
): Promise<ITagGenerator> {
  // Premium gate: the closed-source TagGenerator requires a license.
  // Without one, skip the module entirely and use the built-in extractor.
  // Trusted callers (e.g. the auto-tagging worker) may skip the check when
  // the main thread has already verified premium status.
  if (opts?.skipPremiumCheck || await checkPremiumLicense()) {
    const mod = await loadAiModule();

    if (mod) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const TagGenerator = (mod as any).TagGenerator;
        if (TagGenerator) return new TagGenerator() as ITagGenerator;
      } catch {
        // Fall through to built-in fallback
      }
    }
  }

  return new BuiltInTagGenerator();
}

/**
 * Create a WebLLM embedding provider.
 * Returns `null` if the ai-intelligence module is unavailable.
 *
 * Pass `sharedEngine` (from createSharedEngine()) to reuse the shared
 * WebGPU context instead of loading the embed model standalone.
 */
export async function createEmbeddingProvider(
  modelId: string = EMBEDDING_MODEL_ID,
  dimension: number = 768,
  onProgress?: (report: LoadProgressReport) => void,
  opts?: { sharedEngine?: ISharedMLEngine; skipPremiumCheck?: boolean; devicePreference?: AiDevicePreference },
): Promise<IEmbeddingProvider | null> {
  // Premium gate: embedding generation requires a valid license.
  // Trusted callers (e.g. the AI worker) may skip this check when the
  // main thread has already verified premium status.
  if (!opts?.skipPremiumCheck && !(await checkPremiumLicense())) return null;

  const mod = await loadAiModule();
  if (!mod) return null;

  // Steer the WebGPU adapter before the engine requests one (see gpuPreference.ts).
  applyGpuPreference(opts?.devicePreference ?? 'auto');

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WebLLMEmbeddingProvider = (mod as any).WebLLMEmbeddingProvider;
    if (!WebLLMEmbeddingProvider) return null;
    // Only pass the engine when one exists — the standalone call shape
    // stays identical so the provider owns its own engine (and lifecycle).
    const embeddingEngine = opts?.sharedEngine?.getEmbeddingEngine();
    return (
      (embeddingEngine
        ? new WebLLMEmbeddingProvider(modelId, dimension, onProgress, embeddingEngine)
        : new WebLLMEmbeddingProvider(modelId, dimension, onProgress)) as IEmbeddingProvider
    );
  } catch (err) {
    console.warn('[aiBridge] Failed to create EmbeddingProvider:', err);
    return null;
  }
}

/**
 * Create the shared WebLLM engine — one engine holding two model records
 * (Hermes-3 chat + Arctic embed) under a single WebGPU context. This is
 * the "one engine, two records" foundation for auto-tagging and semantic
 * search: pass the result to createLLMTagGenerator() / createEmbeddingProvider()
 * so both features reuse one context instead of each loading their own
 * model (~2.8 GB VRAM combined).
 *
 * Returns `null` if the ai-intelligence module is unavailable or the user
 * lacks a premium license. The engine is created lazily — nothing loads
 * until this factory is called, and both records load in one call.
 */
export async function createSharedEngine(opts?: {
  onProgress?: (report: SharedEngineProgressReport) => void;
  skipPremiumCheck?: boolean;
  devicePreference?: AiDevicePreference;
  /** Receives the detected adapter (vendor/device) when the engine requests one. */
  onAdapterInfo?: (info: DetectedGpuInfo) => void;
}): Promise<ISharedMLEngine | null> {
  // Premium gate: the shared engine serves premium features (semantic
  // search + LLM auto-tagging). Trusted callers may skip this check when
  // the main thread has already verified premium status.
  if (!opts?.skipPremiumCheck && !(await checkPremiumLicense())) return null;

  const mod = await loadAiModule();
  if (!mod) return null;

  // Steer the WebGPU adapter before the engine requests one (see gpuPreference.ts).
  applyGpuPreference(opts?.devicePreference ?? 'auto', opts?.onAdapterInfo);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SharedMLEngine = (mod as any).SharedMLEngine;
    if (!SharedMLEngine) return null;
    return (await SharedMLEngine.create({ onProgress: opts?.onProgress })) as ISharedMLEngine;
  } catch (err) {
    console.warn('[aiBridge] Failed to create SharedMLEngine:', err);
    return null;
  }
}

/**
 * Create the semantic search engine — the module's SemanticSearchEngine
 * backed by the Arctic embed provider. Pass `sharedEngine` (from
 * createSharedEngine()) to reuse the shared WebGPU context; without one the
 * provider loads the embed model standalone (devtools/tests unchanged).
 *
 * Returns `null` if the ai-intelligence module is unavailable or the user
 * lacks a premium license. The caller is responsible for `initialize()` —
 * on the standalone path that loads the embed model; with a shared engine
 * it is a no-op (both records load when the engine is created).
 */
export async function createSemanticSearchEngine(opts?: {
  sharedEngine?: ISharedMLEngine;
  onProgress?: (report: LoadProgressReport) => void;
  skipPremiumCheck?: boolean;
  devicePreference?: AiDevicePreference;
}): Promise<ISemanticSearchEngine | null> {
  // Premium gate: semantic search requires a valid license.
  if (!opts?.skipPremiumCheck && !(await checkPremiumLicense())) return null;

  const mod = await loadAiModule();
  if (!mod) return null;

  // Steer the WebGPU adapter before the engine requests one (see gpuPreference.ts).
  applyGpuPreference(opts?.devicePreference ?? 'auto');

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WebLLMEmbeddingProvider = (mod as any).WebLLMEmbeddingProvider;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SemanticSearchEngine = (mod as any).SemanticSearchEngine;
    if (!WebLLMEmbeddingProvider || !SemanticSearchEngine) return null;

    // Both constructions flow through the bridge so no file outside
    // aiBridge.ts ever imports the module directly.
    const embeddingEngine = opts?.sharedEngine?.getEmbeddingEngine();
    const provider = embeddingEngine
      ? new WebLLMEmbeddingProvider(EMBEDDING_MODEL_ID, 768, opts?.onProgress, embeddingEngine)
      : new WebLLMEmbeddingProvider(EMBEDDING_MODEL_ID, 768, opts?.onProgress);
    return new SemanticSearchEngine(provider) as ISemanticSearchEngine;
  } catch (err) {
    console.warn('[aiBridge] Failed to create SemanticSearchEngine:', err);
    return null;
  }
}

/**
 * Pure text-building + hashing for semantic indexing. Both functions are
 * closed-source module code, so they flow through the bridge like every
 * other module capability — the coordinator never imports the module.
 *
 * `buildSearchableText` produces the per-image text that gets embedded
 * (prompt ×10, tags ×8, models ×5 repetitions, capped 1600 chars);
 * `buildTextHash` is the FNV-1a hash of that text, which drives
 * incremental re-indexing (Δ by textHash: a stored vector is only stale
 * when its hash no longer matches).
 */
export interface ISemanticTextBuilder {
  buildSearchableText(input: ISearchableTextInput): string;
  buildTextHash(text: string): string;
}

/** The per-image searchable content — same shape as the module's input. */
export interface ISearchableTextInput {
  prompt?: string;
  tags?: string[];
  models?: string[];
}

/**
 * Create the semantic text builder (premium-gated like every module
 * capability). Returns `null` when the ai-intelligence module is absent or
 * the user lacks a valid license — the coordinator then reports the
 * feature as unavailable.
 */
export async function createSemanticTextBuilder(opts?: {
  skipPremiumCheck?: boolean;
}): Promise<ISemanticTextBuilder | null> {
  // Premium gate: the module's text builder is closed-source code and only
  // serves semantic search, a premium feature. Trusted callers (worker)
  // may skip the check when the main thread already verified premium.
  if (!opts?.skipPremiumCheck && !(await checkPremiumLicense())) return null;

  const mod = await loadAiModule();
  if (!mod) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildSearchableText = (mod as any).buildSearchableText;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildTextHash = (mod as any).buildTextHash;
    if (typeof buildSearchableText !== 'function' || typeof buildTextHash !== 'function') {
      return null;
    }
    return { buildSearchableText, buildTextHash } as ISemanticTextBuilder;
  } catch (err) {
    console.warn('[aiBridge] Failed to create semantic text builder:', err);
    return null;
  }
}

// ── Stacking Engine ──────────────────────────────────────────────────

export type StackingProgressCallback = (current: number, total: number, message: string) => void;

export interface ISimilarityGroupInput {
  groups: Array<{ groupId: string; prompt: string }>;
  threshold?: number;
  onProgress?: StackingProgressCallback;
}

export interface ISimilarityGroupResult {
  groupIdToSimId: Map<string, string>;
}

export interface IStackingEngine {
  generatePromptHash(prompt: string): string;
  normalizePrompt(prompt: string): string;
  computePromptSimilarity(promptA: string, promptB: string): number;
  computeSimilarityGroupIds(input: ISimilarityGroupInput): Promise<ISimilarityGroupResult>;
}

/**
 * Create a stacking engine for prompt-based image grouping.
 * Returns `null` if the ai-intelligence module is unavailable.
 */
export async function createStackingEngine(): Promise<IStackingEngine | null> {
  // Premium gate: AI stacking engine requires a valid license
  if (!(await checkPremiumLicense())) return null;

  const mod = await loadAiModule();
  if (!mod) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const StackingEngine = (mod as any).StackingEngine;
    if (!StackingEngine) return null;
    return new StackingEngine() as IStackingEngine;
  } catch (err) {
    console.warn('[aiBridge] Failed to create StackingEngine:', err);
    return null;
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────

/** Check whether the ai-intelligence module is available at runtime. */
export async function isAiAvailable(): Promise<boolean> {
  return (await loadAiModule()) !== null;
}

/** Get the error message from the last load attempt, or null if successful. */
export async function getAiLoadError(): Promise<string | null> {
  await loadAiModule();
  return loadError;
}

// ── Built-in rule-based tag generator (no dependencies) ──────────────

/**
 * Minimal rule-based tag extractor for Stable Diffusion-style prompts.
 * Inlined from ai-intelligence so basic auto-tagging always works even
 * when the optional AI module is absent.
 */
class BuiltInTagGenerator implements ITagGenerator {
  async generateTagsFromPrompt(prompt: string): Promise<string[]> {
    return this.extractTags(prompt);
  }

  private extractTags(prompt: string): string[] {
    if (!prompt) return [];

    let cleaned = this.stripAngleBrackets(prompt);

    // Remove weight notation: (tag:1.2) → tag
    cleaned = cleaned.replace(/\(([^:)]+):\s*[0-9.]+\)/g, '$1');
    cleaned = cleaned.replace(/[\[\]\{\}\(\)]/g, ' ');

    // Remove weight suffixes: tag:1.2 → tag
    cleaned = cleaned.replace(/:\s*[0-9.]+/g, '');

    // Replace periods with commas (sentence separators → tag separators)
    cleaned = cleaned.replace(/\./g, ',');

    const stopWords = new Set([
      'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to',
      'by', 'for', 'with', 'is', 'it', 'its', 'be', 'as', 'has',
      'from', 'are', 'was', 'were', 'been', 'being', 'have', 'had',
      'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
      'might', 'can', 'shall', 'this', 'that', 'these', 'those',
      'very', 'really', 'highly', 'extremely', 'ultra', 'over',
      'her', 'his', 'their', 'itself', 'into', 'up', 'out', 'just',
      'about', 'above', 'after', 'again', 'all', 'also', 'any',
      'because', 'before', 'between', 'both', 'but', 'during',
      'each', 'few', 'further', 'how', 'if', 'more', 'most',
      'no', 'not', 'now', 'once', 'only', 'other', 'our',
      'own', 'same', 'she', 'so', 'some', 'such', 'than',
      'then', 'there', 'through', 'too', 'under', 'until',
      'what', 'when', 'where', 'which', 'while', 'who', 'why',
      'you', 'your', 'should', 'would', 'could', 'here',
    ]);

    const boilerplate = new Set([
      'masterpiece', 'best quality', 'high quality', 'award winning',
      'trending', 'viral', 'beautiful', 'stunning', 'gorgeous', 'amazing',
      'fantastic', 'wonderful', 'excellent', 'perfect', 'great', 'awesome',
      'breathtaking', 'epic', 'impressive', 'incredible', 'spectacular',
      'dynamic', 'stylized', 'elaborate', 'centered',
      '4k', '8k', 'hd', 'hdr', 'uhd', 'ultra hd', 'high resolution',
      'high detail', 'highly detailed', 'intricate details', 'sharp focus',
      'hyperrealistic', 'photorealistic', 'realistic', 'ultra realistic',
      'hype realistic', 'high-quality', 'high quality detail',
      'close up', 'rendered', 'artwork',
    ]);

    const parts = cleaned
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    const tags: string[] = [];

    for (const part of parts) {
      const stripped = part.replace(/^(a|an|the)\s+/, '').trim();
      if (!stripped) continue;

      const words = stripped.split(/\s+/).filter((w) => w.length > 0);
      const contentWords = words.filter((w) => !stopWords.has(w) && w.length > 1);
      if (contentWords.length === 0) continue;

      if (words.length <= 4) {
        tags.push(stripped);
      } else {
        for (let i = 0; i < contentWords.length; i++) {
          tags.push(contentWords[i]);
          if (i + 1 < contentWords.length) {
            tags.push(`${contentWords[i]} ${contentWords[i + 1]}`);
          }
        }
      }
    }

    return this.removeSubsetTags(
      [...new Set(tags)]
        .filter((t) => {
          if (t.length < 3) return false;
          if (t.length > 60) return false;
          if (stopWords.has(t)) return false;
          if (boilerplate.has(t)) return false;
          if (/^\d+$/.test(t)) return false;
          if (/[<>]/.test(t)) return false;
          if (/^\W+$/.test(t)) return false;
          return true;
        }),
    ).slice(0, 10);
  }

  /** Strip angle-bracket tokens like <lora:name:1.0> from the prompt. */
  private stripAngleBrackets(text: string): string {
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .replace(/,\s*,/g, ',')
      .trim();
  }

  /**
   * Remove tags whose words are all contained within another, longer tag.
   * E.g. "dress" is removed when "red dress" is present.
   */
  private removeSubsetTags(tags: string[]): string[] {
    const unique = [...new Set(tags)];
    if (unique.length <= 1) return unique;

    return unique.filter((tag, i) => {
      const tagWords = tag.split(/\s+/).sort();
      return !unique.some((other, j) => {
        if (i === j || other === tag) return false;
        const otherWords = other.split(/\s+/).sort();
        if (
          tagWords.length === otherWords.length &&
          tagWords.every((w, idx) => w === otherWords[idx])
        ) {
          return i > j;
        }
        return (
          otherWords.length > tagWords.length &&
          tagWords.every((w) => otherWords.includes(w))
        );
      });
    });
  }
}
