/**
 * Semantic Search Coordinator — THIN APP-SIDE BOUNDARY.
 *
 * The implementation moved to the closed-source ai-intelligence module
 * (ai-intelligence/src/coordinator/semanticSearchEngine.ts, 2026-08-12) so
 * the open repo contains no working premium implementation. This file keeps
 * the exact public surface the app consumes — `SemanticSearchCoordinator`
 * with the positional `(onProgress?, onGpuInfo?)` constructor and the
 * `ensureInitialized / indexImages / search / clearIndex / getStatus /
 * dispose` methods, plus the result/status types — and delegates to the
 * module's coordinator via a guarded dynamic import.
 *
 * The module coordinator receives injected callbacks for the things its
 * worker cannot see: the premium status, the GPU preference, and the
 * user-selected embedding model (Settings → AI Intelligence). It rejects
 * init when that check fails — semantic search is a premium feature.
 *
 * Which premium check feeds the module differs by caller: app coordinators
 * gate on the master toggle AND the license (`isAiModelFeaturesEnabled`);
 * dev-tester coordinators pass `skipMasterCheck` so the toggle — which
 * governs the main app — gates license-only instead (`isAiFeaturesEnabled`).
 * The module only ever sees one boolean.
 *
 * When the module is absent (open-source build), every method rejects with
 * a clear error and `getStatus()` returns the empty shape.
 */

import type { ISemanticSearchHit, AiDevicePreference, DetectedGpuInfo, AiModelsStatus } from './aiBridge';
import { isAiFeaturesEnabled, isAiModelFeaturesEnabled } from './aiFeatureAccess';
import { useSettingsStore } from '../store/useSettingsStore';

export interface SemanticIndexProgress {
  current: number;
  total: number;
  message: string;
}

export type SemanticProgressCallback = (progress: SemanticIndexProgress) => void;

export interface SemanticIndexResult {
  /** Images embedded + persisted this run. */
  indexed: number;
  /** Images skipped because their textHash already matched the stored record. */
  skipped: number;
}

export interface SemanticSearchStatus {
  ready: boolean;
  indexed: number;
  modelId: string | null;
  dimension: number | null;
  error: string | null;
}

/** User-selectable semantic embedding model (Settings → AI Intelligence). */
export interface EmbeddingModelOption {
  modelId: string;
  dimension: number;
  label: string;
  /** Recommended VRAM footprint (weights + runtime overhead) — shown next to the label in Settings. */
  vram: string;
  description: string;
}

/** User-selectable auto-tagging chat model (Settings → AI Intelligence). */
export interface TagModelOption {
  modelId: string;
  label: string;
  /** Recommended VRAM footprint of the q4f16_1 build — shown next to the label in Settings. */
  vram: string;
  /** VRAM tier for the Settings optgroup grouping: 'low' | 'mid' | 'high'. */
  tier: 'low' | 'mid' | 'high';
  description: string;
}

/**
 * Index-time text building overrides — mirrors the module's
 * SearchableTextOptions (ai-intelligence docs/SEARCH-QUALITY-TUNING.md §2).
 * Omitted fields fall back to module defaults. Only the dev tester passes
 * these; production callers pass no options.
 */
export interface SemanticIndexOptions {
  promptWeight?: number;
  tagWeight?: number;
  /** LLM visual-concept tags — weighted separately from manual tags (0.9). Mirrored from SearchableTextOptions. */
  autoTagWeight?: number;
  /** Hidden search-enrichment synonyms (auto-tag) — mirrored from the module's SearchableTextOptions. */
  synonymWeight?: number;
  maxChars?: number;
}

/**
 * Per-image semantic index payload — mirrors the module's SemanticIndexInput.
 * The store splits IndexedImage.tags into weighted segments before sending:
 * `tags` = manual + metadata (0.8), `autoTags` = LLM visual concepts (0.9).
 * IndexedImage is structurally assignable (its extra fields are ignored).
 */
export interface SemanticIndexPayload {
  id: string;
  prompt?: string;
  tags?: string[];
  /** LLM visual-concept tags — own 0.9-weight segment in the module. */
  autoTags?: string[];
  /** Module spelling of the enrichment terms — dual-read with synonymTags. */
  synonyms?: string[];
  /** App spelling of the enrichment terms — the module dual-reads this. */
  synonymTags?: string[];
}

// ── Vector similarity (prompt clustering) boundary types ──────────────
// Structural mirrors of the module's prompt-vector surface (the module
// barrel exports the record types, but this file must stay free of static
// module imports — the coordinator arrives via a guarded dynamic import).

/** One prompt vector to demand-embed (the one-time backfill path). */
export interface PromptVectorEmbedEntry {
  id: string;
  prompt: string;
}

export interface PromptEmbedResult {
  embedded: number;
  skipped: number;
}

/** Persisted prompt-vector record (mirror of PromptVectorRecord). */
export interface PromptVectorRecord {
  imageId: string;
  vector: Float32Array;
  promptHash: string;
  modelId: string;
  dimension: number;
  updatedAt: number;
}

/** Persisted similarity-group representative (mirror of PromptSimilarityGroupRecord). */
export interface PromptSimilarityGroupRecord {
  groupId: string;
  representativeVector: Float32Array;
  modelId: string;
  dimension: number;
  memberCount: number;
  updatedAt: number;
}

/**
 * One vector-clustering round: new exact-prompt groups (groupId = the
 * stackGroupId hash) against existing similarity groups. Mirrors the
 * module's PromptGroupClusteringRequest.
 */
export interface PromptGroupClusteringRequest {
  newGroups: Array<{ groupId: string; prompt: string; representativeImageId: string }>;
  existingGroups: Array<{ groupId: string; memberImageIds: string[]; nonLatin?: boolean }>;
  threshold?: number;
  onProgress?: (p: { current: number; total: number; message?: string }) => void;
}

export interface PromptGroupClusteringResult {
  /** New groupId → similarityGroupId (absent = no usable vector — the
   *  caller self-assigns). */
  groupIdToSimId: Map<string, string>;
  updatedRepresentatives: Array<{
    groupId: string;
    representativeVector: Float32Array;
    memberCount: number;
  }>;
}

/** Structural view of the module's coordinator (no static module imports). */
interface ModuleCoordinator {
  ensureInitialized(): Promise<void>;
  indexImages(
    images: Array<SemanticIndexPayload>,
    options?: SemanticIndexOptions,
  ): Promise<SemanticIndexResult>;
  search(
    query: string,
    options?: {
      limit?: number;
      threshold?: number;
      blendWeight?: number;
      expandQuery?: boolean;
      applyInstruction?: boolean;
    },
  ): Promise<ISemanticSearchHit[]>;
  clearIndex(): Promise<void>;
  switchStorageDb(dbName?: string): Promise<void>;
  cancelIndexing(): void;
  getStatus(): SemanticSearchStatus;
  /** Unload both model records from GPU memory (footer eject). */
  unloadModels(): Promise<void>;
  /** Which model records are resident in the worker's engine (footer chips). */
  getModelsStatus(): AiModelsStatus;
  /** Demand-embed prompt vectors with the same Δ as indexImages' prompt half. */
  embedPromptVectors(entries: PromptVectorEmbedEntry[]): Promise<PromptEmbedResult>;
  /** Prompt vectors for the given imageIds (order-preserving, missing skipped). */
  getPromptVectors(imageIds: string[]): Promise<PromptVectorRecord[]>;
  /** All persisted similarity-group representatives. */
  getPromptSimilarityGroups(): Promise<PromptSimilarityGroupRecord[]>;
  /** Vector clustering over prompt groups (chunked, rep-persisting). */
  clusterPromptGroups(input: PromptGroupClusteringRequest): Promise<PromptGroupClusteringResult>;
  /** Delete images from the vector stores + worker index (deletion hook). */
  removeImages(imageIds: string[]): Promise<void>;
  dispose(): void;
}

const MODULE_UNAVAILABLE =
  'Semantic search is unavailable: the ai-intelligence module is not present.';

// ── Lazy module load (mirrors aiBridge's guard-then-import) ───────────
// The load PROMISE is cached, not a started-flag + namespace pair: the
// Settings modal calls getEmbeddingModelOptions() and getTagModelOptions()
// back-to-back, and with a flag the second caller can observe the namespace
// before the import settles — `null` → the tag list rendered as "No models
// available" on the deployed build. All concurrent callers await the same
// in-flight import; the result is sticky (no retry on failure).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let moduleLoadPromise: Promise<any> | null = null;

/**
 * Load the module namespace once, caching the in-flight promise so
 * concurrent first callers share a single import. Resolves null when the
 * module is absent at build time (compile-time guard) or fails to load.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getModuleNamespace(): Promise<any> {
  if (!moduleLoadPromise) {
    moduleLoadPromise = (async () => {
      // Compile-time guard: when ai-intelligence wasn't present at build
      // time, Vite dead-code-eliminates the import() below.
      if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) return null;

      try {
        return await import('@ai-images-browser/ai-intelligence');
      } catch (err) {
        console.warn('[SemanticSearch] ai-intelligence module unavailable:', err);
        return null;
      }
    })();
  }
  return moduleLoadPromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getCoordinatorClass(): Promise<any> {
  const mod = await getModuleNamespace();
  return mod?.SemanticSearchCoordinator ?? null;
}

/**
 * The user-selectable semantic embedding models (Settings → AI
 * Intelligence). `[]` when the module is absent — the UI shows
 * "No models available".
 */
export async function getEmbeddingModelOptions(): Promise<EmbeddingModelOption[]> {
  const mod = await getModuleNamespace();
  return mod?.EMBEDDING_MODEL_OPTIONS ?? [];
}

/**
 * The user-selectable auto-tagging chat models (Settings → AI
 * Intelligence). `[]` when the module is absent.
 */
export async function getTagModelOptions(): Promise<TagModelOption[]> {
  const mod = await getModuleNamespace();
  return mod?.TAG_MODEL_OPTIONS ?? [];
}

export class SemanticSearchCoordinator {
  private coordinator: ModuleCoordinator | null = null;
  private loadPromise: Promise<ModuleCoordinator | null> | null = null;

  constructor(
    private readonly onProgress?: SemanticProgressCallback,
    private readonly onGpuInfo?: (info: DetectedGpuInfo) => void,
    private readonly storageDbName?: string,
    private readonly onModelsStatus?: (status: AiModelsStatus) => void,
    /**
     * Dev-tester only: when true, the module's premium gate checks the
     * LICENSE alone (`isAiFeaturesEnabled`) instead of master ∧ license
     * (`isAiModelFeaturesEnabled`). The DevSemanticSearchTester harness
     * passes this — its window is already premium-gated at entry (Ctrl+Y)
     * and the master toggle governs the MAIN APP, not the testers, whose
     * loads are explicit button clicks. Production callers must not set it.
     */
    private readonly skipMasterCheck = false,
  ) {}

  private getModule(): Promise<ModuleCoordinator | null> {
    if (this.coordinator) return Promise.resolve(this.coordinator);
    if (!this.loadPromise) {
      this.loadPromise = getCoordinatorClass().then((Coordinator) => {
        if (!Coordinator) return null;
        this.coordinator = new Coordinator({
          onProgress: this.onProgress,
          onGpuInfo: this.onGpuInfo,
          onModelsStatus: this.onModelsStatus,
          isPremium: () => {
            try {
              // Model-loading gate — the module's coordinator refuses to
              // init when this is false. Default: the master AI toggle AND
              // the license. Dev-tester coordinators (skipMasterCheck) gate
              // on the license alone; the license check still applies.
              return this.skipMasterCheck ? isAiFeaturesEnabled() : isAiModelFeaturesEnabled();
            } catch {
              return false;
            }
          },
          devicePreference: (): AiDevicePreference => {
            try {
              return useSettingsStore.getState().aiDevicePreference;
            } catch {
              return 'auto';
            }
          },
          embedModelId: (): string | undefined => {
            try {
              // '' (fresh install) → the module's default model.
              return useSettingsStore.getState().aiEmbeddingModel || undefined;
            } catch {
              return undefined;
            }
          },
          // The dev tester's isolated test DB; production callers omit it
          // (library DB). Mirrors SEMANTIC_TEST_STORE_DB in the module.
          storageDbName: this.storageDbName,
        }) as ModuleCoordinator;
        return this.coordinator;
      });
    }
    return this.loadPromise;
  }

  private async withModule<T>(fn: (coordinator: ModuleCoordinator) => Promise<T>): Promise<T> {
    const coordinator = await this.getModule();
    if (!coordinator) throw new Error(MODULE_UNAVAILABLE);
    return fn(coordinator);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Lazily start the module's worker, wait for the embed record to be
   * ready, then restore the persisted index in chunks. Rejects when the
   * module is absent or the premium gate fails.
   */
  ensureInitialized(): Promise<void> {
    return this.withModule((coordinator) => coordinator.ensureInitialized());
  }

  // ── Indexing ───────────────────────────────────────────────────────

  /**
   * Incremental index by textHash (the module embeds only what changed,
   * persists, and restores into its worker index). `options` forwards the
   * index-time text overrides (weights/cap) — used by the dev tester's
   * "Indexing parameters" panel; production callers pass nothing.
   */
  indexImages(images: Array<SemanticIndexPayload>, options?: SemanticIndexOptions): Promise<SemanticIndexResult> {
    return this.withModule((coordinator) => coordinator.indexImages(images, options));
  }

  // ── Search ─────────────────────────────────────────────────────────

  /**
   * Single-shot semantic query; preempts indexing worker-side. `options`
   * forwards the module's SemanticQueryOptions — limit/threshold, plus the
   * live-tuning overrides blendWeight / expandQuery / applyInstruction (used
   * by the DevSemanticSearchTester; see ai-intelligence/docs/SEARCH-QUALITY-TUNING.md).
   */
  search(
    query: string,
    options?: {
      limit?: number;
      threshold?: number;
      blendWeight?: number;
      expandQuery?: boolean;
      applyInstruction?: boolean;
    },
  ): Promise<ISemanticSearchHit[]> {
    return this.withModule((coordinator) => coordinator.search(query, options));
  }

  // ── Prompt vectors & similarity clustering ─────────────────────────
  // Vector similarity over prompt groups: the same embedding model embeds
  // each image's normalized prompt (Δ-skipped in steady state), and the
  // module clusters new exact-prompt groups into similarity groups. The app
  // store orchestrates (useImageStore.ts → computeVectorSimilarityGroups);
  // these methods are the thin pass-through.

  /**
   * Demand-embed prompt vectors — the one-time backfill when the library is
   * already stamped but carries no prompt vectors (upgrade). Δ-skips entries
   * whose stored {promptHash, modelId, dimension} match, so steady state
   * costs nothing.
   */
  embedPromptVectors(entries: PromptVectorEmbedEntry[]): Promise<PromptEmbedResult> {
    return this.withModule((coordinator) => coordinator.embedPromptVectors(entries));
  }

  /** Prompt vectors for the given imageIds (order-preserving, missing skipped). */
  getPromptVectors(imageIds: string[]): Promise<PromptVectorRecord[]> {
    return this.withModule((coordinator) => coordinator.getPromptVectors(imageIds));
  }

  /** All persisted similarity-group representatives (running centroids). */
  getPromptSimilarityGroups(): Promise<PromptSimilarityGroupRecord[]> {
    return this.withModule((coordinator) => coordinator.getPromptSimilarityGroups());
  }

  /**
   * Vector clustering over prompt groups — chunked inside the module,
   * representative centroids persisted (union-only: groups merge, never
   * split, so manual merges are preserved).
   */
  clusterPromptGroups(input: PromptGroupClusteringRequest): Promise<PromptGroupClusteringResult> {
    return this.withModule((coordinator) => coordinator.clusterPromptGroups(input));
  }

  /**
   * Delete images from the persisted vector stores and the worker index
   * (annotation deletion hook). Group representatives are kept —
   * identity-preserving.
   */
  removeImages(imageIds: string[]): Promise<void> {
    return this.withModule((coordinator) => coordinator.removeImages(imageIds));
  }

  // ── Clear & dispose ────────────────────────────────────────────────

  /** Wipe the persisted store AND the worker's in-memory index. */
  clearIndex(): Promise<void> {
    return this.withModule((coordinator) => coordinator.clearIndex());
  }

  /**
   * Point the coordinator at a different persistence database (the dev
   * tester's test/library toggle). `dbName` omitted → the production
   * library DB. Pending queries settle, the worker index is wiped and
   * re-restored from the new DB, and subsequent index/search calls act on
   * that store. No-op when the module is absent.
   */
  switchStorageDb(dbName?: string): Promise<void> {
    return this.withModule((coordinator) => coordinator.switchStorageDb(dbName));
  }

  /**
   * Abort an in-flight indexing run (Footer cancel button). No-op when the
   * module is absent or no run is active.
   */
  cancelIndexing(): void {
    this.coordinator?.cancelIndexing();
  }

  getStatus(): SemanticSearchStatus {
    if (this.coordinator) return this.coordinator.getStatus();
    return { ready: false, indexed: 0, modelId: null, dimension: null, error: null };
  }

  /**
   * Unload both model records from GPU memory (footer eject). The module
   * terminates its worker — every WebGPU allocation dies with it — and
   * resets ready state, so the next ensureInitialized() reloads lazily and
   * re-restores the persisted index. No-op when the module is absent.
   */
  unloadModels(): Promise<void> {
    return this.withModule((coordinator) => coordinator.unloadModels());
  }

  /**
   * Which model records are resident in the worker's engine (footer chips).
   * Empty shape when the module is absent.
   */
  getModelsStatus(): AiModelsStatus {
    if (this.coordinator) return this.coordinator.getModelsStatus();
    return {
      chatLoaded: false,
      embedLoaded: false,
      chatModelId: null,
      embedModelId: null,
      chatVramMb: null,
      embedVramMb: null,
    };
  }

  dispose(): void {
    this.coordinator?.dispose();
    this.coordinator = null;
    this.loadPromise = null;
  }
}
