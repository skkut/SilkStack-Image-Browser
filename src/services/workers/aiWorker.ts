/**
 * Consolidated AI Web Worker — "one engine, two records".
 *
 * The single worker behind auto-tagging (Hermes chat record), semantic
 * indexing/query (Arctic embed record), and (planned) rerank. It replaces
 * `autoTaggingWorker.ts` and `embeddingWorker.ts`, which are retired after
 * the auto-tag regression suite passes against this worker.
 *
 * Engine: lazily created once via the bridge's `createSharedEngine()` —
 * both records load in one call and stay resident for the worker's lifetime
 * (the store terminates the worker to release GPU memory). Every premium
 * factory is engine-injected, so nothing loads a second engine.
 *
 * Protocol ─────────────────────────────────────────────────────────
 *
 *  chat / auto-tag (unchanged from autoTaggingWorker.ts):
 *   Main → Worker:  { type: 'start',  payload: { images, topN?, disableFallback?, isPremium?, devicePreference? } }
 *                   { type: 'cancel' }
 *   Worker → Main:  { type: 'progress', payload: { current, total, message } }
 *                   { type: 'complete', payload: { autoTags } }
 *                   { type: 'error',    payload: { error } }
 *
 *  embed (unchanged from embeddingWorker.ts, + isPremium on init):
 *   Main → Worker:  { type: 'init',  payload: { modelId?, isPremium?, devicePreference? } }
 *                   { type: 'embed', payload: { texts, requestId } }
 *   Worker → Main:  { type: 'progress', payload: { progress, text } }
 *                   { type: 'ready', payload: { modelId, dimension } }
 *                   { type: 'embeddings', payload: { embeddings, requestId, done, total } }
 *                   { type: 'error', payload: { error, requestId? } }
 *
 *  semantic search (new — Phase 3+ consumers):
 *   Main → Worker:  { type: 'restore', payload: { vectors, isPremium?, devicePreference? } }
 *                   { type: 'query',   payload: { text, requestId, limit?, threshold?, isPremium?, devicePreference? } }
 *                   { type: 'rerank',  payload: { hits, query, requestId } }
 *                   { type: 'clear' }   — dispose the in-memory index (Settings → Re-index)
 *   Worker → Main:  { type: 'restored', payload: { inserted } }
 *                   { type: 'queryResults', payload: { hits, requestId } }
 *                   { type: 'rerankResults', payload: { hits, requestId } }
 *                   (errors reuse { type: 'error', payload: { error, requestId? } })
 *
 *  gpu info (all paths):
 *   Worker → Main:  { type: 'gpu-info', payload: DetectedGpuInfo } — detected WebGPU
 *                    adapter, sent when the shared engine requests one
 *
 * Preemption (§5.1): the embed record is one pipeline — embed batches and
 * queries both use it, so they run one at a time. A query arriving mid-batch
 * preempts the QUEUE, not the running batch: the batch finishes, the query
 * runs, then queued embed ops resume. Cross-record ops (chat vs embed) run
 * concurrently via web-llm's per-model locks. `cancel` drops pending batches.
 *
 * All AI imports flow through the aiBridge — when the ai-intelligence package
 * is unavailable, the worker degrades gracefully (rule-based tags for chat,
 * explicit errors for embed/search).
 */

import type { AutoTag } from '../../types';
import type { TaggingImage } from '../autoTaggingEngine';
import {
  createEmbeddingProvider,
  createLLMTagGenerator,
  createSemanticSearchEngine,
  createSharedEngine,
  createTagGenerator,
  EMBEDDING_MODEL_ID,
  SEMANTIC_SEARCH_THRESHOLD,
  SEMANTIC_SEARCH_TOP_N,
  TAG_GENERATION_MODEL_ID,
  type IEmbeddingProvider,
  type ILLMTagGenerator,
  type ISemanticSearchEngine,
  type ISemanticSearchHit,
  type ISharedMLEngine,
  type ISemanticVectorRecord,
  type ITagGenerator,
  type AiDevicePreference,
  type DetectedGpuInfo,
} from '../aiBridge';

// Arctic Embed M produces 768-dimensional vectors
const EMBEDDING_DIMENSION = 768;

type WorkerMessage =
  // ── chat / auto-tag (unchanged from autoTaggingWorker.ts) ──────────
  | {
      type: 'start';
      payload: {
        images: TaggingImage[];
        topN?: number;
        disableFallback?: boolean;
        /** Set by main thread — true when the user has a valid premium license. */
        isPremium?: boolean;
        /** GPU preference (Settings → AI Intelligence) at send time. */
        devicePreference?: AiDevicePreference;
      };
    }
  // ── embed (unchanged from embeddingWorker.ts, + isPremium) ─────────
  | {
      type: 'init';
      payload?: { modelId?: string; isPremium?: boolean; devicePreference?: AiDevicePreference };
    }
  | { type: 'embed'; payload: { texts: string[]; requestId: string } }
  // ── semantic search (new) ─────────────────────────────────────────
  | {
      type: 'restore';
      payload: {
        vectors: ISemanticVectorRecord[];
        isPremium?: boolean;
        devicePreference?: AiDevicePreference;
      };
    }
  | {
      type: 'query';
      payload: {
        text: string;
        requestId: string;
        limit?: number;
        threshold?: number;
        isPremium?: boolean;
        devicePreference?: AiDevicePreference;
      };
    }
  | { type: 'rerank'; payload: { hits: ISemanticSearchHit[]; query: string; requestId: string } }
  | { type: 'clear' }
  | { type: 'cancel' };

type WorkerResponse =
  | {
      // Auto-tag shape (chat path) — see the old autoTaggingWorker protocol.
      type: 'progress';
      payload:
        | { current: number; total: number; message: string }
        // Embed shape (embed/search path) — see the old embeddingWorker protocol.
        | { progress: number; text: string };
    }
  | {
      type: 'complete';
      payload: {
        autoTags: Record<string, AutoTag[]>;
      };
    }
  | { type: 'ready'; payload: { modelId: string; dimension: number } }
  | {
      type: 'embeddings';
      payload: { embeddings: Float32Array[]; requestId: string; done: number; total: number };
    }
  | { type: 'restored'; payload: { inserted: number } }
  | { type: 'queryResults'; payload: { hits: ISemanticSearchHit[]; requestId: string } }
  | { type: 'rerankResults'; payload: { hits: ISemanticSearchHit[]; requestId: string } }
  | { type: 'gpu-info'; payload: DetectedGpuInfo }
  | { type: 'error'; payload: { error: string; requestId?: string } };

// ── Shared engine (one engine, two records) ──────────────────────────

/**
 * GPU preference for the shared engine. Read at send time on the main
 * thread (the worker's own store can't see settings); set synchronously
 * from each message payload so a load triggered by ANY path honors it.
 */
let devicePreference: AiDevicePreference = 'auto';

let sharedEngine: ISharedMLEngine | null = null;
let engineLoading: Promise<ISharedMLEngine | null> | null = null;

/**
 * Which path triggered the shared engine load. The engine loads both records
 * in one call, but chat consumers expect `{current,total,message}` progress
 * while embed consumers expect `{progress,text}` — so the first caller's
 * shape wins and every report is routed through it. Concurrent first-loads
 * from both paths (edge case) see the chat shape.
 */
let engineLoadingFor: 'chat' | 'embed' | null = null;

async function getSharedEngine(
  isPremium: boolean | undefined,
  forPath: 'chat' | 'embed',
): Promise<ISharedMLEngine | null> {
  if (sharedEngine) return sharedEngine;
  if (engineLoading) return engineLoading; // dedupe concurrent first loads

  engineLoadingFor = forPath;
  engineLoading = (async () => {
    try {
      sharedEngine = await createSharedEngine({
        skipPremiumCheck: isPremium,
        devicePreference,
        onAdapterInfo: (info) => postGpuInfo(info),
        onProgress: (report) => {
          if (isCancelled) return;
          if (engineLoadingFor === 'chat') {
            postAutoTagProgress(report.progress, 0, `Loading model: ${report.text}`);
          } else {
            postEmbedProgress(report.progress, report.text ?? 'Downloading model weights...');
          }
        },
      });
    } finally {
      engineLoadingFor = null;
      engineLoading = null;
    }
    return sharedEngine;
  })();
  return engineLoading;
}

// ── Embed-record serialization (§5.1 preemption) ─────────────────────

interface PendingQuery {
  text: string;
  requestId: string;
  limit?: number;
  threshold?: number;
}

/** FIFO of embed batches waiting behind the current op. */
let embedQueue: Array<() => Promise<void>> = [];
/** A query waiting to jump the embed queue (latest wins). */
let pendingQuery: PendingQuery | null = null;
let embedOpRunning = false;

function enqueueEmbedOp(op: () => Promise<void>): void {
  embedQueue.push(op);
  pumpEmbedRecord();
}

/**
 * Drive the embed pipeline. Queries preempt queued embed work: a pending
 * query always runs before the next queued batch, so an embed batch in
 * flight finishes, the query is served, then the queue resumes (§5.1).
 */
function pumpEmbedRecord(): void {
  if (embedOpRunning) return;

  const q = pendingQuery;
  if (q) {
    pendingQuery = null;
    embedOpRunning = true;
    void runQuery(q).finally(() => {
      embedOpRunning = false;
      pumpEmbedRecord();
    });
    return;
  }

  const next = embedQueue.shift();
  if (next) {
    embedOpRunning = true;
    void next().finally(() => {
      embedOpRunning = false;
      pumpEmbedRecord();
    });
  }
}

// ── Chat path (auto-tagging, unchanged from autoTaggingWorker.ts) ─────

let isCancelled = false;
let llmGenerator: ILLMTagGenerator | null = null;
let fallbackGenerator: ITagGenerator | null = null;
let llmInitError: string | null = null;
let mode: 'llm' | 'fallback' = 'fallback';

async function initLLM(isPremium?: boolean): Promise<boolean> {
  if (llmGenerator) return true;

  postAutoTagProgress(0, 0, 'Loading tag generation model...');

  try {
    const engine = await getSharedEngine(isPremium, 'chat');
    if (!engine) {
      llmInitError = 'AI intelligence module is not available';
      console.warn('[aiWorker] AI module unavailable, falling back to rule-based extraction');
      return false;
    }

    llmGenerator = await createLLMTagGenerator(
      TAG_GENERATION_MODEL_ID,
      (report) => {
        if (!isCancelled) {
          postAutoTagProgress(report.progress, 0, `Loading model: ${report.text}`);
        }
      },
      { skipPremiumCheck: isPremium, sharedEngine: engine },
    );

    if (!llmGenerator) {
      llmInitError = 'AI intelligence module is not available';
      console.warn('[aiWorker] AI module unavailable, falling back to rule-based extraction');
      return false;
    }

    await llmGenerator.initialize(); // no-op — records already loaded with the engine

    if (!isCancelled) {
      mode = 'llm';
      return true;
    }
  } catch (err) {
    llmInitError = err instanceof Error ? err.message : String(err);
    console.warn('[aiWorker] LLM model failed to load, falling back to rule-based:', err);
  }

  return false;
}

async function getFallbackGenerator(isPremium?: boolean): Promise<ITagGenerator> {
  if (!fallbackGenerator) {
    fallbackGenerator = await createTagGenerator({ skipPremiumCheck: isPremium });
  }
  return fallbackGenerator;
}

async function startAutoTagging(
  images: TaggingImage[],
  options: { topN?: number; disableFallback?: boolean; isPremium?: boolean },
): Promise<void> {
  try {
    isCancelled = false;

    // Try LLM first; fall back to rule-based if WebGPU/model unavailable
    const llmReady = await initLLM(options.isPremium);

    if (isCancelled) return;

    if (!llmReady && options.disableFallback) {
      const detail = llmInitError ? ` Reason: ${llmInitError}` : '';
      postError(`AI model failed to load and fallback is disabled. Enable the fallback in Settings or check that WebGPU is available.${detail}`);
      return;
    }

    const autoTags: Record<string, AutoTag[]> = {};
    const total = images.length;

    for (let i = 0; i < images.length; i += 1) {
      if (isCancelled) {
        postAutoTagProgress(0, 0, 'Cancelled');
        return;
      }

      const image = images[i];
      const prompt = image.prompt || '';

      let generatedTags: string[] = [];
      if (prompt.trim()) {
        if (llmReady && llmGenerator) {
          generatedTags = await llmGenerator.generateTagsFromPrompt(prompt);
        } else {
          const fb = await getFallbackGenerator(options.isPremium);
          generatedTags = await fb.generateTagsFromPrompt(prompt);
        }
      }

      if (options.topN && generatedTags.length > options.topN) {
        generatedTags = generatedTags.slice(0, options.topN);
      }

      autoTags[image.id] = [...new Set(generatedTags)].map((t) => ({
        tag: t,
        sourceType: 'prompt' as const,
      }));

      const label = mode === 'llm' ? 'Generating AI tags' : 'Extracting tags';
      postAutoTagProgress(i + 1, total, `${label}... (${i + 1}/${total})`);
    }

    // Release the generator reference. With the shared engine injected this
    // is a no-op on the engine itself — the engine stays resident for the
    // worker's lifetime (old per-batch unload removed by design).
    if (llmGenerator) {
      llmGenerator.dispose();
      llmGenerator = null;
    }

    postComplete(autoTags);
  } catch (error) {
    console.error('Auto-tagging worker error:', error);
    postError(error instanceof Error ? error.message : String(error));
  }
}

// ── Embed path (unchanged from embeddingWorker.ts, + shared engine) ───

let provider: IEmbeddingProvider | null = null;

async function handleInit(modelIdOverride?: string, isPremium?: boolean): Promise<void> {
  try {
    isCancelled = false;
    const modelId = modelIdOverride ?? EMBEDDING_MODEL_ID;

    postEmbedProgress(0, 'Loading embedding model...');

    const engine = await getSharedEngine(isPremium, 'embed');
    if (!engine) {
      postError(
        'AI intelligence module is not available. Embedding features require the ai-intelligence package.',
      );
      return;
    }

    provider = await createEmbeddingProvider(
      modelId,
      EMBEDDING_DIMENSION,
      (report) => {
        // report.progress is 0–1; report.text describes current step
        postEmbedProgress(report.progress, report.text ?? 'Downloading model weights...');
      },
      { skipPremiumCheck: isPremium, sharedEngine: engine },
    );

    if (!provider) {
      postError(
        'AI intelligence module is not available. Embedding features require the ai-intelligence package.',
      );
      return;
    }

    await provider.initialize(); // no-op — records already loaded with the engine

    if (isCancelled) return;

    postReady(modelId);
  } catch (err) {
    postError(err instanceof Error ? err.message : String(err));
  }
}

async function handleEmbed(texts: string[], requestId: string): Promise<void> {
  enqueueEmbedOp(async () => {
    if (isCancelled) return;
    if (!provider) {
      postError(
        'Provider not initialized. The AI module may be unavailable. Send "init" first.',
        requestId,
      );
      return;
    }

    try {
      const total = texts.length;
      const embeddings = await provider.embed(texts);

      if (isCancelled) return;

      // Transfer Float32Array buffers for zero-copy postMessage
      const buffers = embeddings.map((e) => e.buffer as ArrayBuffer);
      const response: WorkerResponse = {
        type: 'embeddings',
        payload: { embeddings, requestId, done: total, total },
      };
      // Use bare postMessage — the global in DedicatedWorkerGlobalScope accepts Transferable[]
      postMessage(response, buffers);
    } catch (err) {
      postError(err instanceof Error ? err.message : String(err), requestId);
    }
  });
}

// ── Semantic search path (new) ────────────────────────────────────────

let semanticEngine: ISemanticSearchEngine | null = null;

async function ensureSearchEngine(isPremium?: boolean): Promise<ISemanticSearchEngine | null> {
  if (semanticEngine) return semanticEngine;

  const engine = await getSharedEngine(isPremium, 'embed');
  if (!engine) return null;

  semanticEngine = await createSemanticSearchEngine({
    sharedEngine: engine,
    skipPremiumCheck: isPremium,
  });
  if (semanticEngine) {
    await semanticEngine.initialize(); // no-op — records already loaded with the engine
  }
  return semanticEngine;
}

async function handleRestore(vectors: ISemanticVectorRecord[], isPremium?: boolean): Promise<void> {
  try {
    const engine = await ensureSearchEngine(isPremium);
    if (!engine) {
      postError(
        'AI intelligence module is not available. Semantic search requires the ai-intelligence package.',
      );
      return;
    }

    const inserted = engine.restore(vectors);
    const response: WorkerResponse = { type: 'restored', payload: { inserted } };
    self.postMessage(response);
  } catch (err) {
    postError(err instanceof Error ? err.message : String(err));
  }
}

async function handleQuery(
  text: string,
  requestId: string,
  options: { limit?: number; threshold?: number },
  isPremium?: boolean,
): Promise<void> {
  const engine = await ensureSearchEngine(isPremium);
  if (!engine) {
    postError(
      'AI intelligence module is not available. Semantic search requires the ai-intelligence package.',
      requestId,
    );
    return;
  }

  // Preempt: jump the embed queue (§5.1). The pump serves pending queries
  // before queued embed batches, so an in-flight batch finishes first, the
  // query runs, then embed work resumes. Latest query wins.
  pendingQuery = { text, requestId, limit: options.limit, threshold: options.threshold };
  pumpEmbedRecord();
}

async function runQuery(q: PendingQuery): Promise<void> {
  if (isCancelled || !semanticEngine) return;
  try {
    const hits = await semanticEngine.query(q.text, {
      limit: q.limit ?? SEMANTIC_SEARCH_TOP_N,
      threshold: q.threshold ?? SEMANTIC_SEARCH_THRESHOLD,
    });
    if (isCancelled) return;

    const response: WorkerResponse = {
      type: 'queryResults',
      payload: { hits, requestId: q.requestId },
    };
    self.postMessage(response);
  } catch (err) {
    postError(err instanceof Error ? err.message : String(err), q.requestId);
  }
}

function handleRerank(_hits: ISemanticSearchHit[], _query: string, requestId: string): void {
  // Phase 7: cross-encoder rerank over candidate hits via the chat record.
  // Until then, fail loudly rather than silently returning unranked results.
  postError('Semantic rerank is not implemented yet (planned for Phase 7).', requestId);
}

// ── Message dispatch ──────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const message = e.data;

  switch (message.type) {
    case 'start':
      devicePreference = message.payload.devicePreference ?? 'auto';
      await startAutoTagging(message.payload.images, {
        topN: message.payload.topN,
        disableFallback: message.payload.disableFallback,
        isPremium: message.payload.isPremium,
      });
      break;
    case 'init':
      devicePreference = message.payload?.devicePreference ?? 'auto';
      await handleInit(message.payload?.modelId, message.payload?.isPremium);
      break;
    case 'embed':
      await handleEmbed(message.payload.texts, message.payload.requestId);
      break;
    case 'restore':
      devicePreference = message.payload.devicePreference ?? 'auto';
      await handleRestore(message.payload.vectors, message.payload.isPremium);
      break;
    case 'query':
      devicePreference = message.payload.devicePreference ?? 'auto';
      await handleQuery(
        message.payload.text,
        message.payload.requestId,
        { limit: message.payload.limit, threshold: message.payload.threshold },
        message.payload.isPremium,
      );
      break;
    case 'rerank':
      handleRerank(message.payload.hits, message.payload.query, message.payload.requestId);
      break;
    case 'clear':
      // Wipe the in-memory index (Settings → Re-index). The shared engine
      // stays resident — only the SemanticSearchEngine is disposed and
      // recreated lazily on the next restore/query. Pending embed batches
      // are dropped; an in-flight batch finishes first (§5.1).
      embedQueue = [];
      pendingQuery = null;
      semanticEngine?.dispose();
      semanticEngine = null;
      break;
    case 'cancel':
      isCancelled = true;
      embedQueue = [];
      pendingQuery = null;
      postAutoTagProgress(0, 0, 'Cancelled');
      break;
  }
};

// ── Post helpers ──────────────────────────────────────────────────────

/** Auto-tag shape: { current, total, message }. */
function postAutoTagProgress(current: number, total: number, message: string): void {
  self.postMessage({
    type: 'progress',
    payload: { current, total, message },
  } satisfies WorkerResponse);
}

/** Embed shape: { progress, text }. */
function postEmbedProgress(progress: number, text: string): void {
  self.postMessage({
    type: 'progress',
    payload: { progress, text },
  } satisfies WorkerResponse);
}

function postComplete(autoTags: Record<string, AutoTag[]>): void {
  self.postMessage({
    type: 'complete',
    payload: { autoTags },
  } satisfies WorkerResponse);
}

function postReady(modelId: string): void {
  self.postMessage({
    type: 'ready',
    payload: { modelId, dimension: EMBEDDING_DIMENSION },
  } satisfies WorkerResponse);
}

function postGpuInfo(info: DetectedGpuInfo): void {
  self.postMessage({
    type: 'gpu-info',
    payload: info,
  } satisfies WorkerResponse);
}

function postError(error: string, requestId?: string): void {
  self.postMessage({
    type: 'error',
    payload: { error, requestId },
  } satisfies WorkerResponse);
}

export type { WorkerMessage, WorkerResponse };
