/// <reference lib="dom" />

import type { ISemanticVectorRecord } from './aiBridge';
import { openDatabase, getIsPersistenceDisabled } from './indexedDb';

const STORE_NAME = 'semanticVectors';

/**
 * Persistence for semantic search vectors.
 *
 * Unlike `imageAnnotationsStorage`, this module keeps NO in-memory cache:
 * vectors are ~3 KB each (768 × float32) and the renderer must stay light —
 * the in-memory index lives on the worker heap, this store is only the
 * persistence layer (read back in chunks at startup via `restore`).
 *
 * Records are keyed by `imageId`; `updatedAt` is indexed so a re-index can
 * sweep oldest-first. `textHash` (FNV-1a of the searchable text) drives
 * incremental re-indexing — see semantic-search.md §7.
 */

/**
 * Load all persisted vectors (used at startup to restore the worker index).
 */
export async function getAllVectors(): Promise<ISemanticVectorRecord[]> {
  if (getIsPersistenceDisabled()) return [];

  const db = await openDatabase();
  if (!db) return [];

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      const close = () => {
        try {
          db.close();
        } catch (error) {
          console.warn('Failed to close semantic vectors storage after getAll', error);
        }
      };

      transaction.oncomplete = close;
      transaction.onabort = close;
      transaction.onerror = close;

      request.onsuccess = () => resolve(request.result as ISemanticVectorRecord[]);
      request.onerror = () => {
        console.error('Failed to load semantic vectors', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Failed to load semantic vectors from IndexedDB:', error);
    return [];
  }
}

/**
 * Of the given imageIds, return those with NO vector record — the Δ for
 * incremental indexing. Order of the input is preserved.
 */
export async function getMissingVectors(imageIds: string[]): Promise<string[]> {
  if (getIsPersistenceDisabled()) return imageIds;
  if (imageIds.length === 0) return [];

  const db = await openDatabase();
  if (!db) return imageIds;

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAllKeys();

      const close = () => {
        try {
          db.close();
        } catch (error) {
          console.warn('Failed to close semantic vectors storage after getMissing', error);
        }
      };

      transaction.oncomplete = close;
      transaction.onabort = close;
      transaction.onerror = close;

      request.onsuccess = () => {
        const present = new Set(request.result as IDBValidKey[]);
        resolve(imageIds.filter((id) => !present.has(id)));
      };
      request.onerror = () => {
        console.error('Failed to query semantic vector keys', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Failed to query missing semantic vectors from IndexedDB:', error);
    return imageIds;
  }
}

/**
 * Persist vectors in a single transaction. Re-adding an existing imageId
 * replaces its record (upsert-by-id).
 */
export async function putManyVectors(records: ISemanticVectorRecord[]): Promise<void> {
  if (records.length === 0) return;

  if (getIsPersistenceDisabled()) {
    console.warn('[SemanticVectors] ⚠️ IndexedDB persistence is DISABLED — semantic vectors will not survive a restart.');
    return;
  }

  const db = await openDatabase();
  if (!db) {
    console.warn('[SemanticVectors] ⚠️ Cannot open database — semantic vectors not persisted.');
    return;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const close = () => {
        try {
          db.close();
        } catch (error) {
          console.warn('Failed to close semantic vectors storage after putMany', error);
        }
      };

      transaction.oncomplete = () => {
        close();
        resolve();
      };
      transaction.onabort = () => {
        close();
        reject(transaction.error);
      };
      transaction.onerror = () => {
        close();
        console.error('Failed to bulk save semantic vectors', transaction.error);
        reject(transaction.error);
      };

      for (const record of records) {
        store.put(record);
      }
    });
  } catch (error) {
    console.error('IndexedDB bulk save error for semantic vectors:', error);
  }
}

/**
 * Delete vector records by imageId (image deleted / excluded from index).
 */
export async function deleteVectorsByImageIds(imageIds: string[]): Promise<void> {
  if (imageIds.length === 0) return;

  if (getIsPersistenceDisabled()) return;

  const db = await openDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);

      const close = () => {
        try {
          db.close();
        } catch (error) {
          console.warn('Failed to close semantic vectors storage after delete', error);
        }
      };

      transaction.oncomplete = () => {
        close();
        resolve();
      };
      transaction.onabort = () => {
        close();
        reject(transaction.error);
      };
      transaction.onerror = () => {
        close();
        console.error('Failed to delete semantic vectors', transaction.error);
        reject(transaction.error);
      };

      for (const imageId of imageIds) {
        store.delete(imageId);
      }
    });
  } catch (error) {
    console.error('IndexedDB delete error for semantic vectors:', error);
  }
}

/**
 * Wipe the entire store (Settings → Re-index).
 */
export async function clearAllVectors(): Promise<void> {
  if (getIsPersistenceDisabled()) return;

  const db = await openDatabase();
  if (!db) return;

  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      const close = () => {
        try {
          db.close();
        } catch (error) {
          console.warn('Failed to close semantic vectors storage after clear', error);
        }
      };

      transaction.oncomplete = close;
      transaction.onabort = close;
      transaction.onerror = close;

      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error('Failed to clear semantic vectors', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('IndexedDB clear error for semantic vectors:', error);
  }
}

/**
 * Number of persisted vector records.
 */
export async function countVectors(): Promise<number> {
  if (getIsPersistenceDisabled()) return 0;

  const db = await openDatabase();
  if (!db) return 0;

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.count();

      const close = () => {
        try {
          db.close();
        } catch (error) {
          console.warn('Failed to close semantic vectors storage after count', error);
        }
      };

      transaction.oncomplete = close;
      transaction.onabort = close;
      transaction.onerror = close;

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.error('Failed to count semantic vectors', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Failed to count semantic vectors from IndexedDB:', error);
    return 0;
  }
}
