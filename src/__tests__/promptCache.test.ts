import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  PROMPT_CACHE_DB_NAME,
  PROMPT_CACHE_DB_VERSION,
  PROMPT_CACHE_STORES,
  clearPromptCache,
  deletePromptEnrichmentsForPrompts,
  getPromptCacheStats,
  getPromptCacheWarmup,
  getPromptEnrichments,
  markPromptCacheWarmupComplete,
  openPromptCacheDatabase,
  promptEnrichmentMapKey,
  savePromptEnrichments,
  type PromptEnrichmentRecord,
} from '../services/promptCache';

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(PROMPT_CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function makeRecord(overrides: Partial<PromptEnrichmentRecord> = {}): PromptEnrichmentRecord {
  const now = Date.now();
  return {
    modelId: 'model-a',
    enrichmentVersion: 4,
    prompt: 'a red fox in snow',
    concepts: ['red fox', 'snow'],
    synonyms: ['vulpes', 'animal'],
    source: 'llm',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('prompt cache database', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates the data stores and the warm-up meta store at the current version', async () => {
    const db = await openPromptCacheDatabase();
    expect(db).not.toBeNull();
    expect(db!.version).toBe(PROMPT_CACHE_DB_VERSION);
    expect(db!.objectStoreNames.contains(PROMPT_CACHE_STORES.enrichments)).toBe(true);
    expect(db!.objectStoreNames.contains(PROMPT_CACHE_STORES.promptEmbeddings)).toBe(true);
    expect(db!.objectStoreNames.contains(PROMPT_CACHE_STORES.textEmbeddings)).toBe(true);
    expect(db!.objectStoreNames.contains(PROMPT_CACHE_STORES.meta)).toBe(true);

    const enrichments = db!
      .transaction(PROMPT_CACHE_STORES.enrichments, 'readonly')
      .objectStore(PROMPT_CACHE_STORES.enrichments);
    expect(enrichments.keyPath).toEqual(['modelId', 'enrichmentVersion', 'prompt']);
    db!.close();
  });

  it('round-trips an enrichment and isolates the key by model/version/prompt', async () => {
    const record = makeRecord();
    await savePromptEnrichments([record]);

    const keys = [
      { modelId: record.modelId, enrichmentVersion: record.enrichmentVersion, prompt: record.prompt },
      { modelId: 'model-b', enrichmentVersion: record.enrichmentVersion, prompt: record.prompt },
      { modelId: record.modelId, enrichmentVersion: 3, prompt: record.prompt },
      { modelId: record.modelId, enrichmentVersion: record.enrichmentVersion, prompt: 'another prompt' },
    ];
    const found = await getPromptEnrichments(keys);

    expect(found.size).toBe(1);
    expect(found.get(promptEnrichmentMapKey(keys[0]))).toMatchObject({
      concepts: ['red fox', 'snow'],
      synonyms: ['vulpes', 'animal'],
      source: 'llm',
    });
  });

  it('purges every model/version row for the given prompts only', async () => {
    await savePromptEnrichments([
      makeRecord({ prompt: 'a red fox in snow' }),
      makeRecord({ prompt: 'a red fox in snow', modelId: 'model-b' }),
      makeRecord({ prompt: 'a blue owl at dusk' }),
    ]);

    await deletePromptEnrichmentsForPrompts(['a red fox in snow']);

    const found = await getPromptEnrichments([
      { modelId: 'model-a', enrichmentVersion: 4, prompt: 'a red fox in snow' },
      { modelId: 'model-b', enrichmentVersion: 4, prompt: 'a red fox in snow' },
      { modelId: 'model-a', enrichmentVersion: 4, prompt: 'a blue owl at dusk' },
    ]);
    expect(found.size).toBe(1);
    expect(found.get(promptEnrichmentMapKey({
      modelId: 'model-a',
      enrichmentVersion: 4,
      prompt: 'a blue owl at dusk',
    }))).toBeTruthy();
  });

  it('reports counts and clears every store', async () => {
    await savePromptEnrichments([makeRecord()]);
    const db = await openPromptCacheDatabase();
    await new Promise<void>((resolve) => {
      const transaction = db!.transaction(PROMPT_CACHE_STORES.textEmbeddings, 'readwrite');
      transaction.objectStore(PROMPT_CACHE_STORES.textEmbeddings).put({
        modelId: 'model-a',
        dimension: 8,
        textHash: 'hash-1',
        vector: new Float32Array([1, 2, 3]),
        updatedAt: 1,
      });
      transaction.oncomplete = transaction.onabort = transaction.onerror = () => resolve();
    });
    db!.close();

    await expect(getPromptCacheStats()).resolves.toEqual({
      enrichments: 1,
      promptEmbeddings: 0,
      textEmbeddings: 1,
    });

    await clearPromptCache();
    await expect(getPromptCacheStats()).resolves.toEqual({
      enrichments: 0,
      promptEmbeddings: 0,
      textEmbeddings: 0,
    });
  });

  it('records the one-time warm-up marker and keeps it across Clear prompt cache', async () => {
    await expect(getPromptCacheWarmup()).resolves.toBeNull();

    await markPromptCacheWarmupComplete({
      enrichmentCount: 12,
      textPromoted: 3,
      promptPromoted: 4,
    });
    await expect(getPromptCacheWarmup()).resolves.toMatchObject({
      version: 1,
      enrichmentCount: 12,
      textPromoted: 3,
      promptPromoted: 4,
    });

    // Clear wipes the reusable data but must NOT re-arm the backfill — it is
    // the escape hatch for stale results, not a request to rebuild them.
    await savePromptEnrichments([makeRecord()]);
    await clearPromptCache();
    await expect(getPromptCacheStats()).resolves.toMatchObject({ enrichments: 0 });
    await expect(getPromptCacheWarmup()).resolves.toMatchObject({ version: 1 });
  });
});
