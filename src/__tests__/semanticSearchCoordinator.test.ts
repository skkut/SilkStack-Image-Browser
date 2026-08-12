/**
 * SemanticSearchCoordinator tests — the main-thread owner of the semantic
 * search feature (plan §5.2).
 *
 * Harness: a fake `Worker` (stubbed global) lets the tests drive the worker
 * side of the protocol message-by-message; the storage module is mocked with
 * an in-memory store (its own IndexedDB behavior is covered by
 * semanticVectorsStorage.test.ts). The coordinator itself is the real code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SemanticSearchCoordinator, type SemanticIndexProgress } from '../services/semanticSearchEngine';
import type { ISemanticTextBuilder, ISemanticVectorRecord } from '../services/aiBridge';
import type { WorkerMessage } from '../services/workers/aiWorker';
import type { IndexedImage } from '../types';

// ── Mocks ─────────────────────────────────────────────────────────────

const bridgeMocks = vi.hoisted(() => ({
  createSemanticTextBuilder: vi.fn(),
}));

const featureAccessMocks = vi.hoisted(() => ({
  isAiFeaturesEnabled: vi.fn(),
}));

const storageMocks = vi.hoisted(() => {
  const memoryStore = new Map<string, ISemanticVectorRecord>();
  return {
    memoryStore,
    getAllVectors: vi.fn(async () => Array.from(memoryStore.values())),
    putManyVectors: vi.fn(async (records: ISemanticVectorRecord[]) => {
      for (const r of records) memoryStore.set(r.imageId, r);
    }),
    clearAllVectors: vi.fn(async () => {
      memoryStore.clear();
    }),
    countVectors: vi.fn(async () => memoryStore.size),
  };
});

vi.mock('../services/aiBridge', () => bridgeMocks);
vi.mock('../services/aiFeatureAccess', () => featureAccessMocks);
vi.mock('../services/semanticVectorsStorage', () => storageMocks);

// ── Fake worker ───────────────────────────────────────────────────────

class FakeWorker {
  static instances: FakeWorker[] = [];
  messages: WorkerMessage[] = [];
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: WorkerMessage): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker → main direction. */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

const textBuilderMock: ISemanticTextBuilder = {
  buildSearchableText: (input) =>
    `text:${input.prompt ?? ''}|${(input.tags ?? []).join(',')}|${(input.models ?? []).join(',')}`,
  buildTextHash: (text) => `hash:${text}`,
};

function makeVector(dim = 8, seed = 0): Float32Array {
  const v = new Float32Array(dim);
  for (let d = 0; d < dim; d += 1) v[d] = (d + 1 + seed) / (dim + seed);
  return v;
}

function makeImage(id: string, prompt = '', tags: string[] = []): IndexedImage {
  return { id, name: id, prompt, tags, models: [] } as unknown as IndexedImage;
}

function makeStoredRecord(imageId: string, textHash: string): ISemanticVectorRecord {
  return { imageId, vector: makeVector(8), textHash, modelId: 'fake-embed', dimension: 8, updatedAt: 1 };
}

/** Drain the microtask queue so the coordinator's await chains make progress. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/**
 * Run the init choreography: worker created, `ready` emitted, any restore
 * chunks responded to. Returns the fake worker.
 */
async function initCoordinator(coordinator: SemanticSearchCoordinator): Promise<FakeWorker> {
  const initPromise = coordinator.ensureInitialized();
  const worker = FakeWorker.instances[FakeWorker.instances.length - 1];
  worker.emit({ type: 'ready', payload: { modelId: 'fake-embed', dimension: 8 } });
  await flush();
  const restoreMessages = worker.messages.filter(
    (m): m is Extract<WorkerMessage, { type: 'restore' }> => m.type === 'restore',
  );
  for (const msg of restoreMessages) {
    worker.emit({ type: 'restored', payload: { inserted: msg.payload.vectors.length } });
  }
  await initPromise;
  return worker;
}

/** Respond to the oldest embed message that has not yet been answered. */
function respondToNextEmbed(worker: FakeWorker, responded: Set<string>): void {
  const msg = worker.messages
    .filter((m): m is Extract<WorkerMessage, { type: 'embed' }> => m.type === 'embed')
    .find((m) => !responded.has(m.payload.requestId));
  if (!msg) throw new Error('No pending embed message to respond to');
  responded.add(msg.payload.requestId);
  worker.emit({
    type: 'embeddings',
    payload: {
      embeddings: msg.payload.texts.map((text) => makeVector(8, text.length)),
      requestId: msg.payload.requestId,
      done: msg.payload.texts.length,
      total: msg.payload.texts.length,
    },
  });
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  storageMocks.memoryStore.clear();
  vi.clearAllMocks();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  bridgeMocks.createSemanticTextBuilder.mockResolvedValue(textBuilderMock);
  featureAccessMocks.isAiFeaturesEnabled.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Lifecycle ─────────────────────────────────────────────────────────

describe('SemanticSearchCoordinator — lifecycle', () => {
  it('starts the worker, sends init with premium status, restores, and reports ready', async () => {
    storageMocks.memoryStore.set('img-a', makeStoredRecord('img-a', 'hash-a'));
    const coordinator = new SemanticSearchCoordinator();

    const initPromise = coordinator.ensureInitialized();
    const worker = FakeWorker.instances[0];

    // init is sent immediately; premium is stamped by the main thread.
    expect(worker.messages[0]).toEqual({ type: 'init', payload: { isPremium: true } });

    worker.emit({ type: 'ready', payload: { modelId: 'fake-embed', dimension: 8 } });
    await flush();
    expect(worker.messages[1]).toEqual({
      type: 'restore',
      payload: { vectors: [storageMocks.memoryStore.get('img-a')], isPremium: true },
    });
    worker.emit({ type: 'restored', payload: { inserted: 1 } });
    await initPromise;

    expect(coordinator.getStatus()).toMatchObject({
      ready: true,
      indexed: 1,
      modelId: 'fake-embed',
      dimension: 8,
      error: null,
    });
  });

  it('ensureInitialized is idempotent — one worker, one init', async () => {
    const coordinator = new SemanticSearchCoordinator();
    const p1 = coordinator.ensureInitialized();
    const p2 = coordinator.ensureInitialized();
    const worker = FakeWorker.instances[0];

    expect(FakeWorker.instances).toHaveLength(1);
    worker.emit({ type: 'ready', payload: { modelId: 'fake-embed', dimension: 8 } });
    await flush();
    await p1;
    await p2;

    expect(worker.messages.filter((m) => m.type === 'init')).toHaveLength(1);
  });

  it('restores persisted vectors in chunks of 2000', async () => {
    for (let i = 0; i < 4500; i += 1) {
      storageMocks.memoryStore.set(`img-${i}`, makeStoredRecord(`img-${i}`, `hash-${i}`));
    }
    const coordinator = new SemanticSearchCoordinator();
    const initPromise = coordinator.ensureInitialized();
    const worker = FakeWorker.instances[0];

    worker.emit({ type: 'ready', payload: { modelId: 'fake-embed', dimension: 8 } });
    for (let chunk = 0; chunk < 3; chunk += 1) {
      await flush();
      const restoreMessage = worker.messages.filter(
        (m): m is Extract<WorkerMessage, { type: 'restore' }> => m.type === 'restore',
      )[chunk];
      expect(restoreMessage).toBeDefined();
      expect(restoreMessage.payload.vectors).toHaveLength(chunk === 2 ? 500 : 2000);
      worker.emit({ type: 'restored', payload: { inserted: restoreMessage.payload.vectors.length } });
    }
    await initPromise;

    expect(coordinator.getStatus()).toMatchObject({ ready: true, indexed: 4500 });
  });

  it('rejects ensureInitialized and reports the error when init fails; a retry spawns a fresh worker', async () => {
    const coordinator = new SemanticSearchCoordinator();
    const initPromise = coordinator.ensureInitialized();
    const worker = FakeWorker.instances[0];

    worker.emit({ type: 'error', payload: { error: 'AI module unavailable' } });
    await expect(initPromise).rejects.toThrow('AI module unavailable');
    expect(worker.terminated).toBe(true);
    expect(coordinator.getStatus()).toMatchObject({ ready: false, error: 'AI module unavailable' });

    const retry = coordinator.ensureInitialized();
    expect(FakeWorker.instances).toHaveLength(2);
    const worker2 = FakeWorker.instances[1];
    worker2.emit({ type: 'ready', payload: { modelId: 'fake-embed', dimension: 8 } });
    await flush();
    await retry;
    expect(coordinator.getStatus().ready).toBe(true);
  });

  it('tags worker messages with the live premium status', async () => {
    featureAccessMocks.isAiFeaturesEnabled.mockReturnValue(false);
    const coordinator = new SemanticSearchCoordinator();
    const initPromise = coordinator.ensureInitialized();
    const worker = FakeWorker.instances[0];

    worker.emit({ type: 'ready', payload: { modelId: 'fake-embed', dimension: 8 } });
    await initPromise;

    expect(worker.messages[0]).toEqual({ type: 'init', payload: { isPremium: false } });
  });
});

// ── Δ indexing ────────────────────────────────────────────────────────

describe('SemanticSearchCoordinator — Δ indexing', () => {
  it('embeds only images whose textHash changed, persists them, and restores into the index', async () => {
    // img-a is already indexed with the CURRENT hash — must be skipped.
    storageMocks.memoryStore.set('img-a', makeStoredRecord('img-a', 'hash:text:p1|t|'));
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];
    const responded = new Set<string>();
    const messagesBeforeIndex = worker.messages.length; // init restore already sent

    const indexPromise = coordinator.indexImages([
      makeImage('img-a', 'p1', ['t']), // unchanged → skipped
      makeImage('img-b', 'p2'), // new → indexed
      makeImage('img-c', 'p3'), // new → indexed
    ]);
    await flush();

    // One embed batch of exactly the two new images.
    const embedMessages = worker.messages.filter(
      (m): m is Extract<WorkerMessage, { type: 'embed' }> => m.type === 'embed',
    );
    expect(embedMessages).toHaveLength(1);
    expect(embedMessages[0].payload.texts).toEqual(['text:p2||', 'text:p3||']);

    respondToNextEmbed(worker, responded);
    await flush();

    // Persisted with hash + model metadata, then restored to the worker.
    expect(storageMocks.memoryStore.get('img-b')).toMatchObject({
      imageId: 'img-b',
      textHash: 'hash:text:p2||',
      modelId: 'fake-embed',
      dimension: 8,
    });
    expect(ArrayBuffer.isView(storageMocks.memoryStore.get('img-b')!.vector)).toBe(true);
    const restoreMessages = worker.messages
      .slice(messagesBeforeIndex)
      .filter((m): m is Extract<WorkerMessage, { type: 'restore' }> => m.type === 'restore');
    expect(restoreMessages).toHaveLength(1);
    expect(restoreMessages[0].payload.vectors.map((r) => r.imageId)).toEqual(['img-b', 'img-c']);

    worker.emit({ type: 'restored', payload: { inserted: 2 } });
    await expect(indexPromise).resolves.toEqual({ indexed: 2, skipped: 1 });
    // Status.indexed = total persisted records (seeded img-a + the 2 new ones).
    expect(coordinator.getStatus().indexed).toBe(3);
  });

  it('splits a large Δ into model-native batches of 4', async () => {
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];
    const responded = new Set<string>();

    const images = Array.from({ length: 9 }, (_, i) => makeImage(`img-${i}`, `prompt ${i}`));
    const indexPromise = coordinator.indexImages(images);
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();

    const embedMessages = worker.messages.filter(
      (m): m is Extract<WorkerMessage, { type: 'embed' }> => m.type === 'embed',
    );
    expect(embedMessages.map((m) => m.payload.texts.length)).toEqual([4, 4, 1]);

    const restoreMessage = worker.messages.find((m) => m.type === 'restore');
    expect(restoreMessage?.type === 'restore' && restoreMessage.payload.vectors).toHaveLength(9);
    worker.emit({ type: 'restored', payload: { inserted: 9 } });
    await expect(indexPromise).resolves.toEqual({ indexed: 9, skipped: 0 });
  });

  it('re-indexing an image with changed text replaces its record (upsert)', async () => {
    storageMocks.memoryStore.set('img-a', makeStoredRecord('img-a', 'hash:text:old||'));
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];
    const responded = new Set<string>();

    const indexPromise = coordinator.indexImages([makeImage('img-a', 'new')]);
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();
    worker.emit({ type: 'restored', payload: { inserted: 1 } });
    await indexPromise;

    expect(storageMocks.memoryStore.size).toBe(1); // upsert, not duplicate
    expect(storageMocks.memoryStore.get('img-a')).toMatchObject({ textHash: 'hash:text:new||' });
    expect(coordinator.getStatus().indexed).toBe(1);
  });

  it('empty and fully-matching libraries do no work', async () => {
    storageMocks.memoryStore.set('img-a', makeStoredRecord('img-a', 'hash:text:p1||'));
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];

    await expect(coordinator.indexImages([])).resolves.toEqual({ indexed: 0, skipped: 0 });
    await expect(coordinator.indexImages([makeImage('img-a', 'p1')])).resolves.toEqual({
      indexed: 0,
      skipped: 1,
    });
    expect(worker.messages.some((m) => m.type === 'embed')).toBe(false);
  });

  it('reports indexing progress to the store', async () => {
    const progress: SemanticIndexProgress[] = [];
    const coordinator = new SemanticSearchCoordinator((p) => progress.push(p));
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];
    const responded = new Set<string>();

    const indexPromise = coordinator.indexImages(
      Array.from({ length: 9 }, (_, i) => makeImage(`img-${i}`, `prompt ${i}`)),
    );
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();
    worker.emit({ type: 'restored', payload: { inserted: 9 } });
    await indexPromise;

    expect(progress.some((p) => p.message.startsWith('Indexing images'))).toBe(true);
    expect(progress[progress.length - 1]).toEqual({ current: 9, total: 9, message: 'Indexed 9 images' });
  });
});

// ── Search & preemption ───────────────────────────────────────────────

describe('SemanticSearchCoordinator — search & preemption', () => {
  it('resolves a search with the hits from queryResults (requestId correlation)', async () => {
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];

    const searchPromise = coordinator.search('a red fox');
    await flush();
    const queryMessage = worker.messages.find((m) => m.type === 'query');
    expect(queryMessage).toBeDefined();
    expect(queryMessage?.type === 'query' && queryMessage.payload.text).toBe('a red fox');

    worker.emit({
      type: 'queryResults',
      payload: { hits: [{ imageId: 'img-1', score: 0.91 }], requestId: (queryMessage as { payload: { requestId: string } }).payload.requestId },
    });
    await expect(searchPromise).resolves.toEqual([{ imageId: 'img-1', score: 0.91 }]);
  });

  it('empty or whitespace queries resolve [] without touching the worker', async () => {
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];

    await expect(coordinator.search('   ')).resolves.toEqual([]);
    await expect(coordinator.search('')).resolves.toEqual([]);
    expect(worker.messages.some((m) => m.type === 'query')).toBe(false);
  });

  it('a query sent mid-index is posted before the next embed batch, and the index resumes after', async () => {
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];
    const responded = new Set<string>();

    const indexPromise = coordinator.indexImages(
      Array.from({ length: 9 }, (_, i) => makeImage(`img-${i}`, `prompt ${i}`)),
    );
    await flush();

    // Search while embed batch #1 is in flight (not yet answered).
    const searchPromise = coordinator.search('a fox in snow');
    await flush();
    expect(worker.messages.filter((m) => m.type === 'query')).toHaveLength(1);

    // Batch #1 finishes → the coordinator posts batch #2 AFTER the query.
    respondToNextEmbed(worker, responded);
    await flush();
    const order = worker.messages
      .filter((m) => m.type === 'embed' || m.type === 'query')
      .map((m) => m.type);
    expect(order.slice(0, 3)).toEqual(['embed', 'query', 'embed']);

    // The worker serves the query before the next batch — answer it now.
    const queryMessage = worker.messages.find((m) => m.type === 'query')!;
    worker.emit({
      type: 'queryResults',
      payload: { hits: [{ imageId: 'img-3', score: 0.85 }], requestId: (queryMessage as { payload: { requestId: string } }).payload.requestId },
    });
    await expect(searchPromise).resolves.toEqual([{ imageId: 'img-3', score: 0.85 }]);

    // The index run completes after the query was served.
    respondToNextEmbed(worker, responded);
    await flush();
    respondToNextEmbed(worker, responded);
    await flush();
    worker.emit({ type: 'restored', payload: { inserted: 9 } });
    await expect(indexPromise).resolves.toEqual({ indexed: 9, skipped: 0 });
  });

  it('a newer search supersedes an older one — the old promise settles with []', async () => {
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];

    const first = coordinator.search('first query');
    await flush();
    const firstQuery = worker.messages.find((m) => m.type === 'query')!;

    const second = coordinator.search('second query');
    await flush();
    const secondQuery = worker.messages.filter((m) => m.type === 'query')[1];
    expect(secondQuery).toBeDefined();

    // Superseded: the first search settles with [] instead of hanging.
    await expect(first).resolves.toEqual([]);

    worker.emit({
      type: 'queryResults',
      payload: { hits: [{ imageId: 'img-x', score: 0.8 }], requestId: (secondQuery as { payload: { requestId: string } }).payload.requestId },
    });
    await expect(second).resolves.toEqual([{ imageId: 'img-x', score: 0.8 }]);

    // A late response for the superseded request is ignored.
    worker.emit({
      type: 'queryResults',
      payload: { hits: [{ imageId: 'stale', score: 1 }], requestId: (firstQuery as { payload: { requestId: string } }).payload.requestId },
    });
  });

  it('rejects the pending search when the worker reports a query error', async () => {
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];

    const searchPromise = coordinator.search('fox');
    await flush();
    const queryMessage = worker.messages.find((m) => m.type === 'query')!;

    worker.emit({
      type: 'error',
      payload: { error: 'embedding failed', requestId: (queryMessage as { payload: { requestId: string } }).payload.requestId },
    });
    await expect(searchPromise).rejects.toThrow('embedding failed');
  });
});

// ── Clear & dispose ───────────────────────────────────────────────────

describe('SemanticSearchCoordinator — clear & dispose', () => {
  it('clearIndex wipes the store, clears the worker index, and the feature stays usable', async () => {
    storageMocks.memoryStore.set('img-a', makeStoredRecord('img-a', 'hash-a'));
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];
    expect(coordinator.getStatus().indexed).toBe(1);

    await coordinator.clearIndex();
    expect(storageMocks.memoryStore.size).toBe(0);
    expect(coordinator.getStatus().indexed).toBe(0);
    expect(worker.messages.some((m) => m.type === 'clear')).toBe(true);

    // Still functional: a fresh query works after the clear.
    const searchPromise = coordinator.search('fox');
    await flush();
    const queryMessage = worker.messages.filter((m) => m.type === 'query').pop()!;
    worker.emit({
      type: 'queryResults',
      payload: { hits: [], requestId: (queryMessage as { payload: { requestId: string } }).payload.requestId },
    });
    await expect(searchPromise).resolves.toEqual([]);
  });

  it('clearIndex without initialization still wipes persisted vectors', async () => {
    storageMocks.memoryStore.set('img-a', makeStoredRecord('img-a', 'hash-a'));
    const coordinator = new SemanticSearchCoordinator();
    await coordinator.clearIndex();
    expect(storageMocks.memoryStore.size).toBe(0);
  });

  it('dispose terminates the worker and settles pending work', async () => {
    const coordinator = new SemanticSearchCoordinator();
    await initCoordinator(coordinator);
    const worker = FakeWorker.instances[0];

    const searchPromise = coordinator.search('fox');
    await flush();
    coordinator.dispose();

    expect(worker.terminated).toBe(true);
    await expect(searchPromise).rejects.toThrow('Semantic search disposed');
    expect(coordinator.getStatus().ready).toBe(false);
  });
});
