/// <reference lib="dom" />

const DB_NAME = 'image-metahub-preferences';
// Version must stay in lockstep with ai-intelligence/src/storage/
// semanticVectorsStorage.ts — the module opens the same database and only
// ensures its stores exist (it never bumps the version).
const DB_VERSION = 9;

// A blocked open request never settles on its own — no onblocked handler
// means the promise hangs forever and takes every caller (pipeline bulk
// saves, annotation loads) down with it. Time out and surface the block as
// a normal open failure instead of wedging the pipeline.
const OPEN_TIMEOUT_MS = 15_000;

let isPersistenceDisabled = false;
let hasResetAttempted = false;

const getIndexedDB = () => {
  if (typeof indexedDB === 'undefined') {
    if (!isPersistenceDisabled) {
      console.warn('IndexedDB is not available in this environment. Persistence is disabled.');
      isPersistenceDisabled = true;
    }
    return null;
  }
  return indexedDB;
};

function disablePersistence(error?: unknown) {
  if (isPersistenceDisabled) return;
  console.error(
    'IndexedDB open error. Persistence will be disabled for this session.',
    error,
  );
  isPersistenceDisabled = true;
}

function getErrorName(error: unknown): string | undefined {
  if (error instanceof DOMException) return error.name;
  if (typeof error === 'object' && error && 'name' in error) {
    return String((error as { name: unknown }).name);
  }
  return undefined;
}

async function deleteDatabase(): Promise<boolean> {
  const idb = getIndexedDB();
  if (!idb) return false;

  return new Promise<boolean>((resolve) => {
    const request = idb.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve(true);
    request.onerror = () => {
      console.error('Failed to reset database', request.error);
      resolve(false);
    };
    request.onblocked = () => {
      console.warn('Database reset is blocked by an open connection.');
      resolve(false);
    };
  });
}

export async function openDatabase(
  { allowReset = true }: { allowReset?: boolean } = {},
): Promise<IDBDatabase | null> {
  if (isPersistenceDisabled) return null;

  const idb = getIndexedDB();
  if (!idb) return null;

  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const request = idb.open(DB_NAME, DB_VERSION);

      // Guard against a request that never settles (blocked by a pending
      // versionchange / deleteDatabase from another connection). Rejecting
      // sends the caller down the existing error path — visible degradation
      // — instead of an invisible permanent hang.
      let settled = false;
      const openTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn('Failed to open database: request timed out (blocked by another connection)');
        reject(new Error('IndexedDB open timed out — another connection is holding the database.'));
      }, OPEN_TIMEOUT_MS);
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(openTimer);
      };
      request.onblocked = () => {
        // Log only — the timeout above turns the block into a failure.
        console.warn('IndexedDB open is blocked by an open connection (versionchange pending).');
      };

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const oldVersion = event.oldVersion;

        // Centralized migration: ensure ALL stores exist regardless of version history.
        // Multiple modules share this database so we must be defensive here.

        if (!db.objectStoreNames.contains('folderSelection')) {
          db.createObjectStore('folderSelection', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('imageAnnotations')) {
          const store = db.createObjectStore('imageAnnotations', { keyPath: 'imageId' });
          store.createIndex('isFavorite', 'isFavorite', { unique: false });
          store.createIndex('tags', 'tags', { unique: false, multiEntry: true });
          store.createIndex('autoTags', 'autoTags', { unique: false, multiEntry: true });
          store.createIndex('metadataTags', 'metadataTags', { unique: false, multiEntry: true });
        } else if (oldVersion < 6) {
          const annotationStore = request.transaction.objectStore('imageAnnotations');
          if (!annotationStore.indexNames.contains('autoTags')) {
            annotationStore.createIndex('autoTags', 'autoTags', { unique: false, multiEntry: true });
          }
          if (!annotationStore.indexNames.contains('metadataTags')) {
            annotationStore.createIndex('metadataTags', 'metadataTags', { unique: false, multiEntry: true });
          }
        }

        if (!db.objectStoreNames.contains('clusterPreferences')) {
          db.createObjectStore('clusterPreferences', { keyPath: 'clusterId' });
        }

        if (!db.objectStoreNames.contains('smartCollections')) {
          const collectionsStore = db.createObjectStore('smartCollections', { keyPath: 'id' });
          collectionsStore.createIndex('type', 'type', { unique: false });
        }

        if (!db.objectStoreNames.contains('folderPreferences')) {
          db.createObjectStore('folderPreferences', { keyPath: 'path' });
        }

        if (!db.objectStoreNames.contains('semanticVectors')) {
          const store = db.createObjectStore('semanticVectors', { keyPath: 'imageId' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        // Vector similarity (prompt clustering): one vector per prompted
        // image + one running-centroid representative per similarity group.
        if (!db.objectStoreNames.contains('promptVectors')) {
          const store = db.createObjectStore('promptVectors', { keyPath: 'imageId' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }

        if (!db.objectStoreNames.contains('promptSimilarityGroups')) {
          const store = db.createObjectStore('promptSimilarityGroups', { keyPath: 'groupId' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };

      request.onsuccess = () => {
        finish();
        const db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch (e) { /* ignore */ }
        };
        hasResetAttempted = false;
        resolve(db);
      };

      request.onerror = () => {
        finish();
        console.warn('Failed to open database', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    const errorName = getErrorName(error);

    if (allowReset && !hasResetAttempted && (errorName === 'UnknownError' || errorName === 'InvalidStateError')) {
      console.warn('Resetting database due to IndexedDB error:', error);
      hasResetAttempted = true;
      const resetSuccessful = await deleteDatabase();
      if (resetSuccessful) {
        return openDatabase({ allowReset: false });
      }
    }

    disablePersistence(error);
    return null;
  }
}

export function getIsPersistenceDisabled() {
  return isPersistenceDisabled;
}

/**
 * Clear ONLY the AI-index stores (defensive path when the semantic
 * coordinator is unusable — e.g. semantic search disabled). Does NOT touch
 * imageAnnotations, folderSelection, or folderPreferences, so user data and
 * folder settings survive (Reprocess Images). The prompt-vector stores ride
 * the same semantic index and are cleared with it.
 */
export async function clearSemanticVectorsStore(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const aiStores = ['semanticVectors', 'promptVectors', 'promptSimilarityGroups'].filter(
      (name) => db.objectStoreNames.contains(name),
    );
    const tx = db.transaction(aiStores, 'readwrite');
    for (const name of aiStores) tx.objectStore(name).clear();
    // resolve on every terminal event — clear() failures must not throw into
    // the reprocess flow; the caller logs and continues.
    tx.oncomplete = tx.onabort = tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

export { DB_NAME };
