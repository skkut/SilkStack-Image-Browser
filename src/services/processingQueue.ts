/**
 * Serial processing queue — one job at a time, FIFO.
 *
 * This is the global sequencer for all image-processing work (catalog,
 * enrichment, stacking, similarity, auto-tag, semantic indexing). Every
 * producer funnels through here so phases never overlap and the UI stays
 * responsive during heavy rounds.
 *
 * ⚠️ DEADLOCK RULE: never `await` an enqueued job's promise from INSIDE a
 * queued job. A queued job cannot start until the outer job finishes (FIFO),
 * so the outer job would wait forever. Queued jobs that need pipeline work
 * must call the RAW implementations instead — `runPipelineRound()` /
 * `runSemanticIndexNow()` in useImageStore — never the queue-wrapped
 * `processPostIndexingPipeline()` / `semanticIndexImages()` actions.
 */

export interface QueueJobMeta {
  /** Human-readable job name surfaced to subscribers (future UI hooks). */
  label?: string;
}

export interface QueueState {
  busy: boolean;
  label: string | null;
}

interface Job {
  key?: string;
  fn: () => Promise<void> | void;
  meta: QueueJobMeta;
  promise: Promise<void>;
  resolve: () => void;
}

let chain: Promise<void> = Promise.resolve();
let currentJob: Job | null = null;
const pending: Job[] = [];
/** key → pending (not yet started) job. A RUNNING job is removed here, so a
 *  new enqueueOnce with the same key while it runs appends a second job. */
const pendingByKey = new Map<string, Job>();
const listeners = new Set<(s: QueueState) => void>();

const emit = () => {
  const state: QueueState = {
    busy: currentJob !== null || pending.length > 0,
    label: currentJob?.meta.label ?? null,
  };
  for (const listener of listeners) listener(state);
};

const makeJob = (
  fn: Job["fn"],
  meta: QueueJobMeta,
  key?: string,
): Job => {
  const job = {} as Job;
  job.key = key;
  job.fn = fn;
  job.meta = meta;
  job.promise = new Promise<void>((resolve) => {
    job.resolve = resolve;
  });
  return job;
};

const runJob = (job: Job): Promise<void> =>
  Promise.resolve()
    .then(job.fn)
    .catch((err) => console.error("[processingQueue] job failed:", err))
    .finally(() => {
      currentJob = null;
      job.resolve();
      emit();
    });

// Same promise-chain idiom as IncrementalCacheWriter.writeQueue
// (cacheManager.ts): every enqueue appends one step; each step runs one job,
// so FIFO order holds and steps never run concurrently.
const pump = () => {
  chain = chain.then(async () => {
    const job = pending.shift();
    if (!job) return;
    if (job.key) pendingByKey.delete(job.key);
    currentJob = job;
    emit();
    await runJob(job);
  });
};

export const processingQueue = {
  /** Append a job; the returned promise resolves when the job has run
   *  (or when it is dropped via dropQueued). Errors are logged, never thrown —
   *  the chain always continues. */
  enqueue(fn: Job["fn"], meta: QueueJobMeta = {}): Promise<void> {
    const job = makeJob(fn, meta);
    pending.push(job);
    pump();
    return job.promise;
  },

  /** Coalesce PENDING duplicates by key — the second caller joins the first
   *  caller's promise. A RUNNING job does NOT swallow a new enqueue: the new
   *  job is appended and runs after the current one completes. */
  enqueueOnce(key: string, fn: Job["fn"], meta: QueueJobMeta = {}): Promise<void> {
    const existing = pendingByKey.get(key);
    if (existing) return existing.promise;
    const job = makeJob(fn, meta, key);
    pendingByKey.set(key, job);
    pending.push(job);
    pump();
    return job.promise;
  },

  /** Remove all pending (not yet started) jobs with this key; their promises
   *  resolve as no-ops. A RUNNING job is unaffected. */
  dropQueued(key: string): void {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].key === key) {
        const [job] = pending.splice(i, 1);
        pendingByKey.delete(key);
        job.resolve();
      }
    }
  },

  hasRunning(key: string): boolean {
    return currentJob?.key === key;
  },

  hasPendingOrRunning(key: string): boolean {
    return pendingByKey.has(key) || currentJob?.key === key;
  },

  isIdle(): boolean {
    return currentJob === null && pending.length === 0;
  },

  /** Resolves true when the queue drains, false on timeout. Polls every
   *  250 ms — for coarse lifecycle waits (reprocess completion), not for
   *  per-job progress. */
  async waitForIdle(timeoutMs = Infinity): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!processingQueue.isIdle()) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  },

  /** Subscribe to busy/label transitions. Returns an unsubscribe fn. */
  subscribe(listener: (s: QueueState) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
