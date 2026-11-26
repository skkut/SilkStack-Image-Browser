/// <reference lib="dom" />

/**
 * Prompt-processing cache — the app-owned side of the prompt knowledge base.
 *
 * AI output is a pure function of its input. Auto-tag concepts and the hidden
 * search vocabulary depend only on the prompt plus the tag model and the
 * enrichment version; prompt/search embeddings depend only on the prompt (or
 * the built searchable text) plus the embedding model. Storing each result
 * once, keyed by that input, lets every image with the same prompt reuse it —
 * across runs, across images, and across *Reprocess Images*.
 *
 * DATABASE OWNERSHIP
 * ------------------
 * `silkstack-prompt-cache` is deliberately SEPARATE from the main app database
 * (`image-metahub-preferences`):
 *
 *   - The main DB's version is a lockstep contract with the closed
 *     ai-intelligence module. A new database avoids bumping both sides in
 *     step (and avoids the VersionError an older module build would hit).
 *   - This cache must survive Reprocess / Re-index; those clear per-image
 *     data, not prompt-level knowledge. Keeping it apart makes that obvious.
 *   - Deleting it loses only recomputable AI output, never favorites, tags,
 *     stacks, or folder settings.
 *
 * The closed module also opens this database (versionless, same schema) for
 * its two embedding stores. BOTH sides create the SAME three stores when the
 * database is first created — whichever side opens first wins, and the
 * schema definitions must stay in lockstep. Store names and key paths are
 * mirrored in `ai-intelligence/src/storage/embeddingCacheStorage.ts`.
 */

export const PROMPT_CACHE_DB_NAME = 'silkstack-prompt-cache';
/**
 * v1: the three data stores. v2: the `meta` store, which carries the one-time
 * warm-up marker. An existing v1 cache (or a fresh database) upgrades to v2
 * with no marker, which is what schedules the one-time backfill from the
 * existing library on the next app start.
 */
export const PROMPT_CACHE_DB_VERSION = 2;

/**
 * Bump to re-run the one-time warm-up for every install. A bump is for a
 * backfill whose source data could not be discovered lazily (a new cache
 * dimension, a changed key shape, …) — not for routine cache invalidation,
 * which the per-record keys already handle.
 */
export const PROMPT_CACHE_WARMUP_VERSION = 1;

export const PROMPT_CACHE_STORES = {
  /** App-owned: LLM tag enrichment per prompt (auto-tag cache). */
  enrichments: 'promptEnrichments',
  /** Module-owned: embedding of the canonical prompt (similarity stacking). */
  promptEmbeddings: 'promptEmbeddings',
  /** Module-owned: embedding of the built searchable text (semantic search). */
  textEmbeddings: 'textEmbeddings',
  /** App-owned: cache metadata (the one-time warm-up marker). */
  meta: 'meta',
} as const;

/** Stores cleared by Clear prompt cache — `meta` is deliberately excluded. */
export const PROMPT_CACHE_DATA_STORES = [
  PROMPT_CACHE_STORES.enrichments,
  PROMPT_CACHE_STORES.promptEmbeddings,
  PROMPT_CACHE_STORES.textEmbeddings,
] as const;

/** The cache's single metadata key: the one-time library warm-up marker. */
export const PROMPT_CACHE_WARMUP_KEY = 'warmup';

export interface PromptCacheWarmupState {
  key: typeof PROMPT_CACHE_WARMUP_KEY;
  version: number;
  completedAt: number;
  enrichmentCount: number;
  textPromoted: number;
  promptPromoted: number;
}

export interface PromptCacheWarmupStats {
  enrichmentCount: number;
  textPromoted: number;
  promptPromoted: number;
}

/**
 * One processed prompt's LLM enrichment. The key is the compound
 * `[modelId, enrichmentVersion, prompt]` — the prompt itself is part of the
 * key, so records can never collide and the stored prompt always matches the
 * exact string the model was given.
 *
 * `concepts` is the untruncated concept list (the module caps it at
 * MAX_TAGS_PER_IMAGE); callers apply their own display cap at hydration time.
 * `synonyms` is the merged hidden search vocabulary (synonyms + categories).
 */
export interface PromptEnrichmentRecord {
  modelId: string;
  enrichmentVersion: number;
  prompt: string;
  concepts: string[];
  synonyms: string[];
  /** Only LLM output is cached — rule-based output is cheap and upgradeable. */
  source: 'llm';
  createdAt: number;
  updatedAt: number;
}

export interface PromptEnrichmentKey {
  modelId: string;
  enrichmentVersion: number;
  prompt: string;
}

export interface PromptCacheStats {
  enrichments: number;
  promptEmbeddings: number;
  textEmbeddings: number;
}

// ── Connection handling ──────────────────────────────────────────────

let isPersistenceDisabled = false;

const getIndexedDB = (): IDBFactory | null => {
  if (typeof indexedDB === 'undefined') {
    isPersistenceDisabled = true;
    return null;
  }
  return indexedDB;
};

/**
 * Create/upgrade the cache stores. Idempotent — the module's copy performs the
 * same guarded creation, so whichever side creates the database first defines
 * the identical schema.
 */
function ensureCacheStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(PROMPT_CACHE_STORES.enrichments)) {
    db.createObjectStore(PROMPT_CACHE_STORES.enrichments, {
      keyPath: ['modelId', 'enrichmentVersion', 'prompt'],
    });
  }
  if (!db.objectStoreNames.contains(PROMPT_CACHE_STORES.promptEmbeddings)) {
    db.createObjectStore(PROMPT_CACHE_STORES.promptEmbeddings, {
      keyPath: ['modelId', 'dimension', 'textVersion', 'promptHash'],
    });
  }
  if (!db.objectStoreNames.contains(PROMPT_CACHE_STORES.textEmbeddings)) {
    db.createObjectStore(PROMPT_CACHE_STORES.textEmbeddings, {
      keyPath: ['modelId', 'dimension', 'textHash'],
    });
  }
  if (!db.objectStoreNames.contains(PROMPT_CACHE_STORES.meta)) {
    db.createObjectStore(PROMPT_CACHE_STORES.meta, { keyPath: 'key' });
  }
}

export async function openPromptCacheDatabase(): Promise<IDBDatabase | null> {
  if (isPersistenceDisabled) return null;
  const idb = getIndexedDB();
  if (!idb) return null;

  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(PROMPT_CACHE_DB_NAME, PROMPT_CACHE_DB_VERSION);

      request.onupgradeneeded = () => ensureCacheStores(request.result);

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch { /* ignore */ }
        };
        resolve(db);
      };

      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('[PromptCache] Unable to open the prompt cache database:', error);
    isPersistenceDisabled = true;
    return null;
  }
}

const closeQuietly = (db: IDBDatabase, label: string): void => {
  try { db.close(); } catch (error) { console.warn(`Failed to close prompt cache after ${label}`, error); }
};

/** Map key for a compound enrichment key — used by `getPromptEnrichments`. */
export const promptEnrichmentMapKey = (key: PromptEnrichmentKey): string =>
  `${key.modelId}\u0000${key.enrichmentVersion}\u0000${key.prompt}`;

// ── Enrichment cache (auto-tag) ──────────────────────────────────────

/**
 * Load cached enrichments for the given compound keys. Missing records are
 * absent from the result. Fail-soft: an unavailable cache is an empty map.
 */
export async function getPromptEnrichments(
  keys: PromptEnrichmentKey[],
): Promise<Map<string, PromptEnrichmentRecord>> {
  const result = new Map<string, PromptEnrichmentRecord>();
  if (keys.length === 0) return result;

  const db = await openPromptCacheDatabase();
  if (!db) return result;

  try {
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(PROMPT_CACHE_STORES.enrichments, 'readonly');
      const store = transaction.objectStore(PROMPT_CACHE_STORES.enrichments);
      for (const key of keys) {
        const request = store.get([key.modelId, key.enrichmentVersion, key.prompt]);
        request.onsuccess = () => {
          const record = request.result as PromptEnrichmentRecord | undefined;
          if (record) result.set(promptEnrichmentMapKey(key), record);
        };
      }
      transaction.oncomplete = transaction.onabort = transaction.onerror = () => {
        closeQuietly(db, 'enrichment read');
        resolve();
      };
    });
  } catch (error) {
    console.warn('[PromptCache] Failed to read prompt enrichments:', error);
  }
  return result;
}

/** Upsert enrichment rows (one transaction). Fail-soft. */
export async function savePromptEnrichments(records: PromptEnrichmentRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openPromptCacheDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PROMPT_CACHE_STORES.enrichments, 'readwrite');
      const store = transaction.objectStore(PROMPT_CACHE_STORES.enrichments);
      for (const record of records) {
        try {
          store.put(record);
        } catch (error) {
          // An unclonable record must not discard the rest of the batch.
          console.error('[PromptCache] Skipped an unpersistable enrichment record:', error);
        }
      }
      transaction.oncomplete = () => {
        closeQuietly(db, 'enrichment write');
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        closeQuietly(db, 'enrichment write');
        reject(transaction.error ?? new Error('prompt enrichment write aborted'));
      };
    });
  } catch (error) {
    console.warn('[PromptCache] Failed to save prompt enrichments:', error);
  }
}

/**
 * Delete every enrichment row (any model, any version) whose prompt is in the
 * list. Used by Clear Auto-Tags: the user's explicit intent is that those
 * prompts are no longer enriched, so the next auto-tag run must not silently
 * re-hydrate them from the cache.
 */
export async function deletePromptEnrichmentsForPrompts(prompts: string[]): Promise<void> {
  if (prompts.length === 0) return;
  const promptSet = new Set(prompts);
  const db = await openPromptCacheDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PROMPT_CACHE_STORES.enrichments, 'readwrite');
      const store = transaction.objectStore(PROMPT_CACHE_STORES.enrichments);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value as PromptEnrichmentRecord;
        if (promptSet.has(record.prompt)) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = () => {
        closeQuietly(db, 'enrichment purge');
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        closeQuietly(db, 'enrichment purge');
        reject(transaction.error ?? new Error('prompt enrichment purge aborted'));
      };
    });
  } catch (error) {
    console.warn('[PromptCache] Failed to purge prompt enrichments:', error);
  }
}

// ── Stats ────────────────────────────────────────────────────────────

async function countStore(dbName: string): Promise<number> {
  const db = await openPromptCacheDatabase();
  if (!db) return 0;
  if (!db.objectStoreNames.contains(dbName)) {
    closeQuietly(db, 'count');
    return 0;
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = db.transaction(dbName, 'readonly');
      const request = transaction.objectStore(dbName).count();
      transaction.oncomplete = transaction.onabort = transaction.onerror = () => closeQuietly(db, 'count');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn(`[PromptCache] Failed to count ${dbName}:`, error);
    return 0;
  }
}

export async function getPromptCacheStats(): Promise<PromptCacheStats> {
  const [enrichments, promptEmbeddings, textEmbeddings] = await Promise.all([
    countStore(PROMPT_CACHE_STORES.enrichments),
    countStore(PROMPT_CACHE_STORES.promptEmbeddings),
    countStore(PROMPT_CACHE_STORES.textEmbeddings),
  ]);
  return { enrichments, promptEmbeddings, textEmbeddings };
}

// ── One-time warm-up marker ──────────────────────────────────────────

/**
 * The marker that makes the library backfill run once per
 * `PROMPT_CACHE_WARMUP_VERSION`. A cache database that predates the feature
 * (or the meta store) has no row → the next app start warms it from the
 * existing annotations and vectors. Fail-soft: an unreadable marker reads as
 * "not warmed" and the idempotent backfill simply runs again.
 */
export async function getPromptCacheWarmup(): Promise<PromptCacheWarmupState | null> {
  const db = await openPromptCacheDatabase();
  if (!db) return null;
  if (!db.objectStoreNames.contains(PROMPT_CACHE_STORES.meta)) {
    closeQuietly(db, 'warmup read');
    return null;
  }

  try {
    return await new Promise<PromptCacheWarmupState | null>((resolve) => {
      const transaction = db.transaction(PROMPT_CACHE_STORES.meta, 'readonly');
      const request = transaction.objectStore(PROMPT_CACHE_STORES.meta).get(PROMPT_CACHE_WARMUP_KEY);
      transaction.oncomplete = transaction.onabort = transaction.onerror = () => closeQuietly(db, 'warmup read');
      request.onsuccess = () => resolve((request.result as PromptCacheWarmupState | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch (error) {
    console.warn('[PromptCache] Failed to read the warm-up marker:', error);
    return null;
  }
}

export async function markPromptCacheWarmupComplete(stats: PromptCacheWarmupStats): Promise<void> {
  const db = await openPromptCacheDatabase();
  if (!db) return;
  if (!db.objectStoreNames.contains(PROMPT_CACHE_STORES.meta)) {
    closeQuietly(db, 'warmup write');
    return;
  }

  const record: PromptCacheWarmupState = {
    key: PROMPT_CACHE_WARMUP_KEY,
    version: PROMPT_CACHE_WARMUP_VERSION,
    completedAt: Date.now(),
    ...stats,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PROMPT_CACHE_STORES.meta, 'readwrite');
      transaction.objectStore(PROMPT_CACHE_STORES.meta).put(record);
      transaction.oncomplete = () => {
        closeQuietly(db, 'warmup write');
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        closeQuietly(db, 'warmup write');
        reject(transaction.error ?? new Error('warm-up marker write aborted'));
      };
    });
  } catch (error) {
    console.warn('[PromptCache] Failed to save the warm-up marker:', error);
  }
}

// ── Clearing ─────────────────────────────────────────────────────────

/**
 * Wipe the three DATA stores. This is the Settings → Clear prompt cache
 * action: per-image annotations and vectors are untouched, so the library
 * keeps its current tags/results — only the reusable prompt-level knowledge
 * is discarded, which makes the next run call the models again.
 *
 * The warm-up marker is deliberately KEPT: otherwise the next app start
 * would immediately refill the cache from the same per-image data, silently
 * undoing the clear.
 */
export async function clearPromptCache(): Promise<void> {
  const db = await openPromptCacheDatabase();
  if (!db) return;

  const stores = PROMPT_CACHE_DATA_STORES.filter((name) => db.objectStoreNames.contains(name));
  if (stores.length === 0) {
    closeQuietly(db, 'clear');
    return;
  }

  try {
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(stores, 'readwrite');
      for (const name of stores) transaction.objectStore(name).clear();
      transaction.oncomplete = transaction.onabort = transaction.onerror = () => {
        closeQuietly(db, 'clear');
        resolve();
      };
    });
  } catch (error) {
    console.error('[PromptCache] Failed to clear the prompt cache:', error);
  }
}

export function getIsPromptCachePersistenceDisabled(): boolean {
  return isPersistenceDisabled;
}
