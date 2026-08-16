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
 * worker cannot see: the premium license status (`isAiFeaturesEnabled`),
 * the GPU preference, and the user-selected embedding model (Settings →
 * AI Intelligence). It rejects init when the license check fails —
 * semantic search is a premium feature.
 *
 * When the module is absent (open-source build), every method rejects with
 * a clear error and `getStatus()` returns the empty shape.
 */

import type { IndexedImage } from '../types';
import type { ISemanticSearchHit, AiDevicePreference, DetectedGpuInfo } from './aiBridge';
import { isAiFeaturesEnabled } from './aiFeatureAccess';
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
  description: string;
}

/** User-selectable auto-tagging chat model (Settings → AI Intelligence). */
export interface TagModelOption {
  modelId: string;
  label: string;
  description: string;
}

/** Structural view of the module's coordinator (no static module imports). */
interface ModuleCoordinator {
  ensureInitialized(): Promise<void>;
  indexImages(images: Array<{ id: string; prompt?: string; tags?: string[]; models?: string[] }>): Promise<SemanticIndexResult>;
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
  cancelIndexing(): void;
  getStatus(): SemanticSearchStatus;
  dispose(): void;
}

const MODULE_UNAVAILABLE =
  'Semantic search is unavailable: the ai-intelligence module is not present.';

// ── Lazy module load (mirrors aiBridge's guard-then-import) ───────────
let moduleLoaded = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let moduleNamespace: any = null;

/**
 * Load the module namespace once and cache it. Returns null when the module
 * is absent at build time (compile-time guard) or fails to load.
 */
async function getModuleNamespace(): Promise<typeof moduleNamespace> {
  if (moduleLoaded) return moduleNamespace;
  moduleLoaded = true;

  // Compile-time guard: when ai-intelligence wasn't present at build time,
  // Vite dead-code-eliminates the import() below.
  if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) return null;

  try {
    moduleNamespace = await import('@ai-images-browser/ai-intelligence');
  } catch (err) {
    console.warn('[SemanticSearch] ai-intelligence module unavailable:', err);
    moduleNamespace = null;
  }
  return moduleNamespace;
}

async function getCoordinatorClass(): Promise<typeof moduleNamespace> {
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
  ) {}

  private getModule(): Promise<ModuleCoordinator | null> {
    if (this.coordinator) return Promise.resolve(this.coordinator);
    if (!this.loadPromise) {
      this.loadPromise = getCoordinatorClass().then((Coordinator) => {
        if (!Coordinator) return null;
        this.coordinator = new Coordinator({
          onProgress: this.onProgress,
          onGpuInfo: this.onGpuInfo,
          isPremium: () => {
            try {
              return isAiFeaturesEnabled();
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
   * persists, and restores into its worker index).
   */
  indexImages(images: IndexedImage[]): Promise<SemanticIndexResult> {
    return this.withModule((coordinator) => coordinator.indexImages(images));
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

  // ── Clear & dispose ────────────────────────────────────────────────

  /** Wipe the persisted store AND the worker's in-memory index. */
  clearIndex(): Promise<void> {
    return this.withModule((coordinator) => coordinator.clearIndex());
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

  dispose(): void {
    this.coordinator?.dispose();
    this.coordinator = null;
    this.loadPromise = null;
  }
}
