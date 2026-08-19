/// <reference lib="dom" />

const DB_NAME = 'image-metahub-preferences';
const DB_VERSION = 8;

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
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          try { db.close(); } catch (e) { /* ignore */ }
        };
        hasResetAttempted = false;
        resolve(db);
      };

      request.onerror = () => {
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
 * Clear ONLY the semanticVectors store (defensive path when the semantic
 * coordinator is unusable — e.g. semantic search disabled). Does NOT touch
 * imageAnnotations, folderSelection, or folderPreferences, so user data and
 * folder settings survive (Reprocess Images).
 */
export async function clearSemanticVectorsStore(): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction('semanticVectors', 'readwrite');
    tx.objectStore('semanticVectors').clear();
    // resolve on every terminal event — clear() failures must not throw into
    // the reprocess flow; the caller logs and continues.
    tx.oncomplete = tx.onabort = tx.onerror = () => {
      db.close();
      resolve();
    };
  });
}

export { DB_NAME };
