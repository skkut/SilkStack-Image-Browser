/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Auto-tagging worker route — the MPL-covered chat path of the consolidated
 * AI worker (Image-MetaHub `autoTaggingWorker.ts` lineage, consolidated at
 * `97be3b2`), split out of `aiWorker.ts` on 2026-08-28 so the covered source
 * can be published to the open repository (`mpl-covered-sources/`).
 *
 * The route owns an auto-tag run: cancellation state, the LLM generator
 * (the Hermes chat record of the shared engine), the premium-gated
 * rule-based fallback, and the progress/complete/error reporting contract.
 * The host worker injects the engine and post functions via
 * `AutoTagWorkerContext` and keeps the embed/semantic paths.
 *
 * Protocol (chat / auto-tag):
 *   Main → Worker:  { type: 'start',  payload: { images, topN?, disableFallback?, isPremium?, devicePreference?, tagModelId? } }
 *                   { type: 'cancel' }
 *   Worker → Main:  { type: 'progress', payload: { current, total, message } }
 *                   { type: 'image-tagged', payload: { id, tags, synonyms? } }  — one per image, emitted as soon as that image's tags are generated so the host persists each image incrementally (resume-safe); `synonyms` is the MERGED hidden search vocabulary — synonyms followed by the main-subject categories (zebra → "animal") — absent when the rule-based fallback ran (it has no engine)
 *                   { type: 'complete', payload: { autoTags } }   — the accumulated CONCEPTS-only map for backward compatibility; per-image persistence (incl. the merged search vocabulary) happens on 'image-tagged'
 *                   { type: 'error',    payload: { error } }
 *
 *   Structured split (search enrichment v4): tags, search synonyms, and the
 *   main-subject CATEGORIES (zebra → "animal") come from ONE structured
 *   completion per image — {"concepts":[…≤15], "synonyms":[…≤6],
 *   "categories":[…≤4]} (generateFlatTags — see TAGS_PROMPT). Concepts are
 *   the UI chips; synonyms + categories are hidden search vocabulary merged
 *   on lastSynonyms (categories last), persisted per image from the
 *   'image-tagged' payload. The v2 flat single-list merge starved synonyms
 *   (shared 15-item budget + the concept overlap rule); the v2 bare-array
 *   response shape still parses as concepts-only. The rule-based fallback
 *   path emits no search vocabulary (it has no engine).
 */

import type { AutoTag, TaggingImage } from './types';
import type { AiDevicePreference } from '../gpu/gpuPreference';
import type { SharedMLEngine } from '../core/shared-engine';
import { resolveTagModel } from '../core/types';
import { LLMTagGenerator } from '../modules/llm-tag-generator';
import { TagGenerator } from '../modules/tag-generator';

// ── Chat protocol types ──────────────────────────────────────────────

export interface StartAutoTaggingMessage {
  type: 'start';
  payload: {
    images: TaggingImage[];
    topN?: number;
    disableFallback?: boolean;
    /** Set by main thread — true when the user has a valid premium license. */
    isPremium?: boolean;
    /** GPU preference (Settings → AI Intelligence) at send time. */
    devicePreference?: AiDevicePreference;
    /** User-selected auto-tag chat model id (Settings → AI Intelligence); resolved via the catalog, unknown ids fall back to the default. */
    tagModelId?: string;
  };
}

export interface CancelAutoTaggingMessage {
  type: 'cancel';
}

export interface AutoTagProgressResponse {
  type: 'progress';
  payload: { current: number; total: number; message: string };
}

export interface AutoTagCompleteResponse {
  type: 'complete';
  payload: { autoTags: Record<string, AutoTag[]> };
}

export interface AutoTagErrorResponse {
  type: 'error';
  payload: { error: string };
}

export interface AutoTaggingOptions {
  topN?: number;
  disableFallback?: boolean;
  isPremium?: boolean;
}

// ── Worker context (injected by the host) ────────────────────────────

export interface AutoTagWorkerContext {
  /** Lazily create/fetch the shared engine for the chat record. */
  getChatEngine(): Promise<SharedMLEngine | null>;
  /** The live tag-model id (set from the start payload by the host). */
  getTagModelId(): string;
  /** Auto-tag shape: { current, total, message }. */
  postProgress(current: number, total: number, message: string): void;
  /**
   * One image's tags + (LLM path) its MERGED hidden search vocabulary —
   * synonyms followed by the main-subject categories (zebra → "animal",
   * merged on lastSynonyms). `synonyms` is absent when the rule-based
   * fallback ran — the host then leaves any existing vocabulary untouched
   * instead of clearing it.
   */
  postImageTagged(id: string, tags: AutoTag[], synonyms?: string[]): void;
  postComplete(autoTags: Record<string, AutoTag[]>): void;
  postError(error: string): void;
}

// ── Auto-tag route ───────────────────────────────────────────────────

export class AutoTagWorker {
  private readonly ctx: AutoTagWorkerContext;
  private isCancelled = false;
  private llmGenerator: LLMTagGenerator | null = null;
  private fallbackGenerator: TagGenerator | null = null;
  private llmInitError: string | null = null;
  private mode: 'llm' | 'fallback' = 'fallback';

  constructor(ctx: AutoTagWorkerContext) {
    this.ctx = ctx;
  }

  /** Cancel the current run (the host keeps its own flag for the embed path). */
  cancel(): void {
    this.isCancelled = true;
    this.ctx.postProgress(0, 0, 'Cancelled');
  }

  async start(images: TaggingImage[], options: AutoTaggingOptions): Promise<void> {
    try {
      this.isCancelled = false;

      // Try LLM first; fall back to rule-based only for premium payloads
      // (WebGPU/model unavailable or license absent).
      const llmReady = await this.initLLM();

      if (this.isCancelled) return;

      if (!llmReady && options.disableFallback) {
        const detail = this.llmInitError ? ` Reason: ${this.llmInitError}` : '';
        this.ctx.postError(`AI model failed to load and fallback is disabled. Enable the fallback in Settings or check that WebGPU is available.${detail}`);
        return;
      }

      if (!llmReady && !options.isPremium) {
        this.ctx.postError('AI auto-tagging requires the ai-intelligence module and a valid license.');
        return;
      }

      const autoTags: Record<string, AutoTag[]> = {};
      const total = images.length;

      for (let i = 0; i < images.length; i += 1) {
        if (this.isCancelled) {
          this.ctx.postProgress(0, 0, 'Cancelled');
          return;
        }

        const image = images[i];
        const prompt = image.prompt || '';

        let generatedTags: string[] = [];
        // Hidden merged search vocabulary from the LLM path — undefined until
        // a call runs, so absent also for the fallback/empty-prompt paths.
        let generatedSynonyms: string[] | undefined;
        if (prompt.trim()) {
          if (llmReady && this.llmGenerator) {
            // ONE bounded completion returns the structured {concepts,
            // synonyms, categories} response (see TAGS_PROMPT /
            // SEARCH_ENRICHMENT_VERSION v4). Concepts come back as the list —
            // the UI chips; synonyms + main-subject categories ride out
            // merged on lastSynonyms (categories last) and are emitted per
            // image as hidden search vocabulary. The v2 flat single-list
            // merge starved synonyms; the v2 bare-array shape still parses as
            // concepts-only. Failures degrade to no tags for this image,
            // never a run failure.
            generatedTags = await this.llmGenerator.generateFlatTags(prompt);
            generatedSynonyms = this.llmGenerator.lastSynonyms ?? [];
          } else {
            const fb = await this.getFallbackGenerator(options.isPremium);
            if (fb) {
              generatedTags = await fb.generateTagsFromPrompt(prompt);
            }
          }
        }

        // topN caps the CONCEPT chips only — the hidden search vocabulary
        // (synonyms + categories) has its own independent caps
        // (MAX_SYNONYMS_PER_IMAGE + MAX_CATEGORIES_PER_IMAGE, in the module).
        if (options.topN && generatedTags.length > options.topN) {
          generatedTags = generatedTags.slice(0, options.topN);
        }

        autoTags[image.id] = [...new Set(generatedTags)].map((t) => ({
          tag: t,
          sourceType: 'prompt' as const,
        }));

        // Emit this image's tags (and synonyms, on the LLM path) immediately —
        // the host persists each image as it finishes, so an interrupted run
        // never re-processes it (the next 'start' filters stamped images on
        // its side).
        this.ctx.postImageTagged(image.id, autoTags[image.id], generatedSynonyms);

        const label = this.mode === 'llm' ? 'Generating AI tags' : 'Extracting tags';
        this.ctx.postProgress(i + 1, total, `${label}... (${i + 1}/${total})`);
      }

      // Release the generator reference. With the shared engine injected this
      // is a no-op on the engine itself — the engine stays resident for the
      // worker's lifetime (old per-batch unload removed by design).
      if (this.llmGenerator) {
        this.llmGenerator.dispose();
        this.llmGenerator = null;
      }

      this.ctx.postComplete(autoTags);
    } catch (error) {
      console.error('Auto-tagging worker error:', error);
      this.ctx.postError(error instanceof Error ? error.message : String(error));
    }
  }

  private async initLLM(): Promise<boolean> {
    if (this.llmGenerator) return true;

    this.ctx.postProgress(0, 0, 'Loading tag generation model...');

    try {
      const engine = await this.ctx.getChatEngine();
      if (!engine) {
        this.llmInitError = 'AI intelligence module is not available';
        console.warn('[aiWorker] AI engine unavailable, cannot load tag generation model');
        return false;
      }

      this.llmGenerator = new LLMTagGenerator(
        resolveTagModel(this.ctx.getTagModelId()).modelId,
        (report) => {
          if (!this.isCancelled) {
            this.ctx.postProgress(report.progress, 0, `Loading model: ${report.text}`);
          }
        },
        engine.getChatEngine(),
      );

      await this.llmGenerator.initialize(); // no-op — records already loaded with the engine

      if (!this.isCancelled) {
        this.mode = 'llm';
        return true;
      }
    } catch (err) {
      this.llmInitError = err instanceof Error ? err.message : String(err);
      console.warn('[aiWorker] LLM model failed to load:', err);
    }

    return false;
  }

  /**
   * Rule-based fallback (module `TagGenerator`). Gated on the payload's
   * `isPremium` — decision (2026-08-12): no-module/no-license builds get NO
   * auto-tagging at all; the free fallback was dropped.
   */
  private async getFallbackGenerator(isPremium?: boolean): Promise<TagGenerator | null> {
    if (!isPremium) return null;
    if (!this.fallbackGenerator) {
      this.fallbackGenerator = new TagGenerator();
    }
    return this.fallbackGenerator;
  }
}
