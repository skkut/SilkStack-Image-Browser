/**
 * Semantic Search Coordinator — main-thread owner of the semantic search
 * feature (plan §5.2, Phase 4).
 *
 * Mirrors the autoTaggingEngine role: owns the AI worker lifecycle, the
 * chunked restore, Δ indexing, preemption coordination, and progress
 * reporting — but holds **no vectors** itself. The vector index lives on
 * the worker heap; the renderer only touches records transiently
 * (embed → persist → restore) so a 100k-image library never bloats the
 * renderer heap (≈300 MB saved, per the storage design in §7).
 *
 *   ensureInitialized() — lazy worker start + chunked restore of persisted vectors
 *   indexImages()       — Δ by textHash: embed only what changed, persist, restore
 *   search()            — single-shot query; preempts indexing (worker §5.1)
 *   clearIndex()        — wipe store + worker index (Settings → Re-index)
 *   getStatus()         — ready / indexed / model / error
 *   dispose()           — terminate the worker, settle pending work
 *
 * Preemption (§5.1) is implemented worker-side: a `query` message jumps
 * the embed queue (latest query wins; an in-flight batch finishes first).
 * The coordinator mirrors "latest query wins" for its own promise book-
 * keeping — a superseded search resolves `[]` instead of hanging.
 *
 * All worker traffic is premium-tagged at send time via isAiFeaturesEnabled()
 * (the same pattern as the auto-tag path in useImageStore) — the worker's
 * zustand store is a separate instance and cannot see the license.
 *
 * Protocol: src/services/workers/aiWorker.ts (restore/query/embeddings/
 * queryResults/restored/clear).
 */

import type { IndexedImage } from '../types';
import { createSemanticTextBuilder, type ISearchableTextInput, type ISemanticTextBuilder } from './aiBridge';
import type { ISemanticSearchHit, ISemanticVectorRecord } from './aiBridge';
import { isAiFeaturesEnabled } from './aiFeatureAccess';
import { clearAllVectors, countVectors, getAllVectors, putManyVectors } from './semanticVectorsStorage';
import type { WorkerMessage } from './workers/aiWorker';

/** Model-native embed batch size (Arctic Embed M-q0f32-MLC-b4). */
const EMBED_BATCH_SIZE = 4;
/** Records per restore message — keeps a single postMessage bounded. */
const RESTORE_CHUNK_SIZE = 2000;

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

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

interface PendingEmbed extends PendingRequest<Float32Array[]> {}

interface PendingQuery extends PendingRequest<ISemanticSearchHit[]> {}

interface PendingRestore extends PendingRequest<number> {}

export class SemanticSearchCoordinator {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;

  private ready = false;
  private readyError: string | null = null;
  private modelId: string | null = null;
  private dimension: number | null = null;
  /** Number of persisted records — the authoritative "images indexed" count. */
  private indexed = 0;

  private requestSeq = 0;
  private readonly pendingEmbeds = new Map<string, PendingEmbed>();
  private readonly pendingQueries = new Map<string, PendingQuery>();
  private pendingRestore: PendingRestore | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  private textBuilder: ISemanticTextBuilder | null = null;
  private textBuilderPromise: Promise<ISemanticTextBuilder | null> | null = null;

  constructor(private readonly onProgress?: SemanticProgressCallback) {}

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Lazily start the worker, wait for the embed record to be ready, then
   * restore the persisted index in chunks. Idempotent — concurrent calls
   * share one init; a failed init clears the promise so a retry can
   * re-attempt with a fresh worker.
   */
  ensureInitialized(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit().catch((err) => {
      this.initPromise = null; // allow a retry after a transient failure
      throw err;
    });
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (this.ready) return;

    this.worker = this.createWorker();
    const readyPromise = this.waitForReady();

    this.send({ type: 'init', payload: { isPremium: this.isPremium() } });

    try {
      await readyPromise; // rejects when init errors (e.g. module absent)
    } catch (err) {
      this.worker.terminate();
      this.worker = null;
      throw err;
    }

    // Restore persisted vectors chunked so a large library never sends a
    // single giant postMessage. restore() is an upsert-by-id, so a re-index
    // after a partial failure converges without duplicates.
    const records = await getAllVectors();
    for (let i = 0; i < records.length; i += RESTORE_CHUNK_SIZE) {
      await this.restoreChunk(records.slice(i, i + RESTORE_CHUNK_SIZE));
    }
    this.indexed = records.length;
  }

  // ── Indexing ───────────────────────────────────────────────────────

  /**
   * Incremental index by textHash: images whose stored record hash matches
   * the freshly computed hash are skipped; the rest are embedded in
   * model-native batches, persisted, and restored into the worker index.
   *
   * Callers are expected to serialize indexImages runs (the post-indexing
   * pipeline does); concurrent runs are safe but redundant.
   */
  async indexImages(images: IndexedImage[]): Promise<SemanticIndexResult> {
    await this.ensureInitialized();
    if (images.length === 0) return { indexed: 0, skipped: 0 };

    const builder = await this.getTextBuilder();
    if (!builder) {
      throw new Error(
        'Semantic search is unavailable: the ai-intelligence module could not be loaded.',
      );
    }

    // Δ by textHash — only re-embed images whose searchable content changed.
    const persisted = await getAllVectors();
    const persistedByImageId = new Map(persisted.map((r) => [r.imageId, r]));

    const toIndex: Array<{ image: IndexedImage; text: string; hash: string }> = [];
    for (const image of images) {
      const input: ISearchableTextInput = {
        prompt: image.prompt,
        tags: image.tags ?? [],
        models: image.models ?? [],
      };
      const text = builder.buildSearchableText(input);
      const hash = builder.buildTextHash(text);
      const existing = persistedByImageId.get(image.id);
      if (existing && existing.textHash === hash) continue;
      toIndex.push({ image, text, hash });
    }

    const skipped = images.length - toIndex.length;
    const total = toIndex.length;
    if (total === 0) return { indexed: 0, skipped };

    const newRecords: ISemanticVectorRecord[] = [];
    const now = Date.now();

    for (let i = 0; i < toIndex.length; i += EMBED_BATCH_SIZE) {
      const batch = toIndex.slice(i, i + EMBED_BATCH_SIZE);
      const done = Math.min(i + batch.length, total);
      this.report(done, total, `Indexing images... (${done}/${total})`);

      const vectors = await this.embedTexts(batch.map((b) => b.text));
      for (let j = 0; j < batch.length; j += 1) {
        const vector = vectors[j];
        if (!vector) continue; // provider returned fewer embeddings — skip defensively
        newRecords.push({
          imageId: batch[j].image.id,
          vector,
          textHash: batch[j].hash,
          modelId: this.modelId ?? '',
          dimension: this.dimension ?? vector.length,
          updatedAt: now,
        });
      }
    }

    await putManyVectors(newRecords);
    await this.restoreRecords(newRecords);

    // The store is the source of truth — persisted count == indexed images
    // (the worker restores exactly these records).
    this.indexed = await countVectors();
    this.report(total, total, `Indexed ${newRecords.length} images`);
    return { indexed: newRecords.length, skipped };
  }

  // ── Search ─────────────────────────────────────────────────────────

  /**
   * Single-shot semantic query. Debouncing is the caller's job (the store's
   * runSemanticSearch debounces ~300ms). The query preempts a running index
   * batch on the worker (§5.1): the batch in flight finishes, the query is
   * served, then queued embed work resumes.
   *
   * Latest query wins: a search superseded by a newer one resolves `[]`
   * instead of hanging (the worker only serves the newest pending query).
   */
  async search(query: string, options?: { limit?: number; threshold?: number }): Promise<ISemanticSearchHit[]> {
    const text = query.trim();
    if (!text) return [];

    await this.ensureInitialized();

    // Drop superseded searches so their promises settle deterministically.
    for (const [, pending] of this.pendingQueries) pending.resolve([]);
    this.pendingQueries.clear();

    const requestId = `query-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      this.pendingQueries.set(requestId, { resolve, reject });
      this.send({
        type: 'query',
        payload: {
          text,
          requestId,
          limit: options?.limit,
          threshold: options?.threshold,
          isPremium: this.isPremium(),
        },
      });
    });
  }

  // ── Clear & dispose ────────────────────────────────────────────────

  /**
   * Wipe the persisted store AND the worker's in-memory index (Settings →
   * Re-index). Pending requests are settled first so nothing hangs on a
   * cleared index. The shared engine stays resident — the worker recreates
   * its SemanticSearchEngine lazily on the next restore/query.
   */
  async clearIndex(): Promise<void> {
    for (const [, pending] of this.pendingQueries) pending.reject(new Error('Index cleared'));
    this.pendingQueries.clear();
    for (const [, pending] of this.pendingEmbeds) pending.reject(new Error('Index cleared'));
    this.pendingEmbeds.clear();

    await clearAllVectors();
    this.worker?.postMessage({ type: 'clear' } satisfies WorkerMessage);
    this.indexed = 0;
  }

  getStatus(): SemanticSearchStatus {
    return {
      ready: this.ready,
      indexed: this.indexed,
      modelId: this.modelId,
      dimension: this.dimension,
      error: this.readyError,
    };
  }

  dispose(): void {
    for (const [, pending] of this.pendingQueries) pending.reject(new Error('Semantic search disposed'));
    this.pendingQueries.clear();
    for (const [, pending] of this.pendingEmbeds) pending.reject(new Error('Semantic search disposed'));
    this.pendingEmbeds.clear();
    this.pendingRestore?.reject(new Error('Semantic search disposed'));
    this.pendingRestore = null;

    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.initPromise = null;
  }

  // ── Worker plumbing ────────────────────────────────────────────────

  private createWorker(): Worker {
    const worker = new Worker(new URL('./workers/aiWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => this.handleWorkerMessage(e.data);
    worker.onerror = (e) => {
      this.readyError = e.message || 'Semantic search worker crashed';
      this.readyReject?.(new Error(this.readyError));
      this.readyReject = null;
      this.readyResolve = null;
    };
    return worker;
  }

  private waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleWorkerMessage(data: any): void {
    switch (data?.type) {
      case 'ready':
        this.modelId = data.payload.modelId;
        this.dimension = data.payload.dimension;
        this.ready = true;
        this.readyError = null;
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        break;

      case 'restored':
        this.pendingRestore?.resolve(data.payload.inserted);
        this.pendingRestore = null;
        break;

      case 'embeddings': {
        const pending = this.pendingEmbeds.get(data.payload.requestId);
        if (pending) {
          this.pendingEmbeds.delete(data.payload.requestId);
          pending.resolve(data.payload.embeddings);
        }
        break;
      }

      case 'queryResults': {
        const pending = this.pendingQueries.get(data.payload.requestId);
        if (pending) {
          this.pendingQueries.delete(data.payload.requestId);
          pending.resolve(data.payload.hits);
        }
        break;
      }

      case 'progress': {
        // Embed shape { progress, text } — model loading reports. Forwarded
        // so the store's progress UI can show engine-load progress.
        const p = data.payload as { progress?: number; text?: string };
        if (typeof p.progress === 'number') {
          this.report(Math.round(p.progress * 100), 100, p.text ?? 'Loading model...');
        }
        break;
      }

      case 'error': {
        const err = new Error(data.payload?.error ?? 'Semantic search worker error');
        if (data.payload?.requestId) {
          const embed = this.pendingEmbeds.get(data.payload.requestId);
          if (embed) {
            this.pendingEmbeds.delete(data.payload.requestId);
            embed.reject(err);
          }
          const query = this.pendingQueries.get(data.payload.requestId);
          if (query) {
            this.pendingQueries.delete(data.payload.requestId);
            query.reject(err);
          }
        } else if (this.readyReject) {
          // Init-phase failure (no requestId — init/restore errors).
          this.readyError = err.message;
          this.readyReject(err);
          this.readyReject = null;
          this.readyResolve = null;
        } else if (this.pendingRestore) {
          this.pendingRestore.reject(err);
          this.pendingRestore = null;
        } else {
          this.readyError = err.message;
        }
        break;
      }
    }
  }

  private embedTexts(texts: string[]): Promise<Float32Array[]> {
    const requestId = `embed-${++this.requestSeq}`;
    return new Promise((resolve, reject) => {
      this.pendingEmbeds.set(requestId, { resolve, reject });
      this.send({ type: 'embed', payload: { texts, requestId } });
    });
  }

  private async restoreRecords(records: ISemanticVectorRecord[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < records.length; i += RESTORE_CHUNK_SIZE) {
      inserted += await this.restoreChunk(records.slice(i, i + RESTORE_CHUNK_SIZE));
    }
    return inserted;
  }

  private restoreChunk(chunk: ISemanticVectorRecord[]): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pendingRestore = { resolve, reject };
      this.send({ type: 'restore', payload: { vectors: chunk, isPremium: this.isPremium() } });
    });
  }

  private getTextBuilder(): Promise<ISemanticTextBuilder | null> {
    if (!this.textBuilderPromise) {
      this.textBuilderPromise = createSemanticTextBuilder().catch(() => null);
    }
    return this.textBuilderPromise;
  }

  /** Premium status at send time — the worker's store cannot see the license. */
  private isPremium(): boolean {
    try {
      return isAiFeaturesEnabled();
    } catch {
      return false;
    }
  }

  private send(message: WorkerMessage): void {
    if (!this.worker) throw new Error('Semantic search is not initialized');
    this.worker.postMessage(message);
  }

  private report(current: number, total: number, message: string): void {
    this.onProgress?.({ current, total, message });
  }
}
