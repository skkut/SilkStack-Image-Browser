/// <reference lib="dom" />

import type { ImageAnnotations, TagInfo, SmartCollection } from '../types';
import { openDatabase, getIsPersistenceDisabled } from './indexedDb';

const STORE_NAME = 'imageAnnotations';

const inMemoryAnnotations: Map<string, ImageAnnotations> = new Map();

/**
 * Load all annotations from IndexedDB
 */
export async function loadAllAnnotations(): Promise<Map<string, ImageAnnotations>> {
  if (getIsPersistenceDisabled()) {
    return new Map(inMemoryAnnotations);
  }

  const db = await openDatabase();
  if (!db) {
    return new Map(inMemoryAnnotations);
  }

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      const close = () => {
        try {
          db.close();
        } catch (error) {
          console.warn('Failed to close image annotations storage after load', error);
        }
      };

      transaction.oncomplete = close;
      transaction.onabort = close;
      transaction.onerror = close;

      request.onsuccess = () => {
        const results = request.result as ImageAnnotations[];
        // Merge rather than replace: entries concurrently saved by
        // bulkSaveAnnotations (which updates inMemoryAnnotations synchronously
        // before the async DB write) survive even if the DB read started before
        // their write transaction committed.  The DB is the canonical source,
        // so its entries overwrite in-memory entries with the same key.
        for (const annotation of results) {
          if (!annotation.autoTags) annotation.autoTags = [];
          if (!annotation.metadataTags) annotation.metadataTags = [];
          inMemoryAnnotations.set(annotation.imageId, annotation);
        }
        resolve(new Map(inMemoryAnnotations));
      };

      request.onerror = () => {
        console.error('Failed to load image annotations', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Failed to load image annotations from IndexedDB:', error);
    return new Map(inMemoryAnnotations);
  }
}

/**
 * Save a single annotation to IndexedDB
 */
export async function saveAnnotation(annotation: ImageAnnotations): Promise<void> {
  inMemoryAnnotations.set(annotation.imageId, annotation);

  if (getIsPersistenceDisabled()) {
    if (!__persistenceWarningEmitted) {
      __persistenceWarningEmitted = true;
      console.error('[Annotations] ⚠️ IndexedDB persistence is DISABLED — stack groups, favorites, and tags will NOT survive a restart.');
    }
    return;
  }

  const db = await openDatabase();
  if (!db) {
    console.warn('[Annotations] ⚠️ Cannot open database — annotation not persisted.');
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(annotation);

    const close = () => {
      try {
        db.close();
      } catch (error) {
        console.warn('Failed to close image annotations storage after save', error);
      }
    };

    transaction.oncomplete = close;
    transaction.onabort = close;
    transaction.onerror = close;

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('Failed to save image annotation', request.error);
      reject(request.error);
    };
  }).catch((error) => {
    console.error('IndexedDB save error for image annotation:', error);
  });
}

/**
 * Delete an annotation from IndexedDB
 */
export async function deleteAnnotation(imageId: string): Promise<void> {
  inMemoryAnnotations.delete(imageId);

  if (getIsPersistenceDisabled()) {
    return;
  }

  const db = await openDatabase();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(imageId);

    const close = () => {
      try {
        db.close();
      } catch (error) {
        console.warn('Failed to close image annotations storage after delete', error);
      }
    };

    transaction.oncomplete = close;
    transaction.onabort = close;
    transaction.onerror = close;

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('Failed to delete image annotation', request.error);
      reject(request.error);
    };
  }).catch((error) => {
    console.error('IndexedDB delete error for image annotation:', error);
  });
}

/**
 * Bulk save multiple annotations in a single transaction (for performance)
 */
let __persistenceWarningEmitted = false;

export async function bulkSaveAnnotations(annotations: ImageAnnotations[]): Promise<void> {
  for (const annotation of annotations) {
    inMemoryAnnotations.set(annotation.imageId, annotation);
  }

  if (getIsPersistenceDisabled()) {
    if (!__persistenceWarningEmitted) {
      __persistenceWarningEmitted = true;
      console.error('[Annotations] ⚠️ IndexedDB persistence is DISABLED — stack groups, favorites, and tags will NOT survive a restart. Try clearing the app cache or check for private browsing mode.');
    }
    return;
  }

  const db = await openDatabase();
  if (!db) {
    // openDatabase already logged the error, but we add context so the user
    // knows what data is affected.
    console.warn('[Annotations] ⚠️ Cannot open database — annotations (stacks, favorites, tags) will be lost on restart.');
    return;
  }

  const close = () => {
    try {
      db.close();
    } catch (error) {
      console.warn('Failed to close image annotations storage after bulk save', error);
    }
  };

  try {
    // Chunk into 500-record transactions: one mega-transaction for a full
    // reprocess (thousands of records) blocked the IndexedDB thread for
    // seconds and contributed to the UI freeze. A setTimeout(0) yield
    // between chunks lets the renderer breathe. Chunking is internal — the
    // caller contract (all records saved, errors logged) is unchanged.
    const CHUNK_SIZE = 500;
    for (let i = 0; i < annotations.length; i += CHUNK_SIZE) {
      const chunk = annotations.slice(i, i + CHUNK_SIZE);
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        transaction.oncomplete = () => {
          resolve();
        };
        transaction.onabort = () => {
          reject(transaction.error);
        };
        transaction.onerror = () => {
          console.error('Failed to bulk save image annotations', transaction.error);
          reject(transaction.error);
        };

        for (const annotation of chunk) {
          store.put(annotation);
        }
      }).catch((error) => {
        console.error('IndexedDB bulk save error for image annotations:', error);
      });

      if (i + CHUNK_SIZE < annotations.length) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    close();
  }
}

/**
 * Get a single annotation by imageId
 */
export async function getAnnotation(imageId: string): Promise<ImageAnnotations | null> {
  if (inMemoryAnnotations.has(imageId)) {
    return inMemoryAnnotations.get(imageId) || null;
  }

  if (getIsPersistenceDisabled()) {
    return null;
  }

  const db = await openDatabase();
  if (!db) {
    return null;
  }

  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(imageId);

    const close = () => {
      try {
        db.close();
      } catch (error) {
        console.warn('Failed to close image annotations storage after get', error);
      }
    };

    transaction.oncomplete = close;
    transaction.onabort = close;
    transaction.onerror = close;

    request.onsuccess = () => {
      const result = request.result as ImageAnnotations | undefined;
      if (result) {
        inMemoryAnnotations.set(imageId, result);
        resolve(result);
      } else {
        resolve(null);
      }
    };

    request.onerror = () => {
      console.error('Failed to get image annotation', request.error);
      resolve(null);
    };
  });
}

/**
 * Get all image IDs that are marked as favorites
 */
export async function getFavoriteImageIds(): Promise<string[]> {
  if (getIsPersistenceDisabled()) {
    return Array.from(inMemoryAnnotations.values())
      .filter(ann => ann.isFavorite)
      .map(ann => ann.imageId);
  }

  const db = await openDatabase();
  if (!db) {
    return [];
  }

  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('isFavorite');
    const request = index.getAll(IDBKeyRange.only(true));

    const close = () => {
      try {
        db.close();
      } catch (error) {
        console.warn('Failed to close image annotations storage after favorite query', error);
      }
    };

    transaction.oncomplete = close;
    transaction.onabort = close;
    transaction.onerror = close;

    request.onsuccess = () => {
      const results = request.result as ImageAnnotations[];
      resolve(results.map(ann => ann.imageId));
    };

    request.onerror = () => {
      console.error('Failed to query favorite image IDs', request.error);
      resolve([]);
    };
  });
}

/**
 * Get all image IDs that have a specific tag
 */
export async function getImageIdsByTag(tag: string): Promise<string[]> {
  if (getIsPersistenceDisabled()) {
    return Array.from(inMemoryAnnotations.values())
      .filter(ann =>
        ann.tags.includes(tag) ||
        (ann.autoTags || []).includes(tag) ||
        (ann.metadataTags || []).includes(tag)
      )
      .map(ann => ann.imageId);
  }

  const db = await openDatabase();
  if (!db) {
    return [];
  }

  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const allIds = new Set<string>();

    const close = () => {
      try {
        db.close();
      } catch (error) {
        console.warn('Failed to close image annotations storage after tag query', error);
      }
    };

    transaction.oncomplete = () => {
      close();
      resolve(Array.from(allIds));
    };
    transaction.onabort = close;
    transaction.onerror = close;

    const gatherResults = (indexName: string) => {
      if (store.indexNames.contains(indexName)) {
        const index = store.index(indexName);
        const request = index.getAll(tag);
        request.onsuccess = () => {
          const results = request.result as ImageAnnotations[];
          for (const ann of results) {
            allIds.add(ann.imageId);
          }
        };
      }
    };

    gatherResults('tags');
    gatherResults('autoTags');
    gatherResults('metadataTags');
  });
}

/**
 * Get all tags with their usage counts
 */
export async function getAllTags(): Promise<TagInfo[]> {
  const annotations = await loadAllAnnotations();

  const tagCounts = new Map<string, number>();

  for (const annotation of annotations.values()) {
    const allTags = [
      ...(annotation.tags || []),
      ...(annotation.autoTags || []),
      ...(annotation.metadataTags || []),
    ];
    for (const tag of allTags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  const tags: TagInfo[] = Array.from(tagCounts.entries()).map(([name, count]) => ({
    name,
    count,
  }));

  tags.sort((a, b) => a.name.localeCompare(b.name));

  return tags;
}

/**
 * Clear all annotations (for testing/reset)
 */
export async function clearAllAnnotations(): Promise<void> {
  inMemoryAnnotations.clear();

  if (getIsPersistenceDisabled()) {
    return;
  }

  const db = await openDatabase();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    const close = () => {
      try {
        db.close();
      } catch (error) {
        console.warn('Failed to close image annotations storage after clear', error);
      }
    };

    transaction.oncomplete = close;
    transaction.onabort = close;
    transaction.onerror = close;

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('Failed to clear image annotations', request.error);
      reject(request.error);
    };
  }).catch((error) => {
    console.error('IndexedDB clear error for image annotations:', error);
  });
}

// ===== Smart Collections Functions =====

export async function getSmartCollection(id: string): Promise<SmartCollection | null> {
  const db = await openDatabase();
  if (!db) return null;

  return new Promise((resolve) => {
    const transaction = db.transaction(['smartCollections'], 'readonly');
    const store = transaction.objectStore('smartCollections');
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => {
      console.error('Error getting smart collection:', request.error);
      resolve(null);
    };
  });
}

export async function saveSmartCollection(collection: SmartCollection): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  collection.updatedAt = Date.now();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['smartCollections'], 'readwrite');
    const store = transaction.objectStore('smartCollections');
    const request = store.put(collection);

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('Error saving smart collection:', request.error);
      reject(request.error);
    };
  });
}

export async function deleteSmartCollection(id: string): Promise<void> {
  const db = await openDatabase();
  if (!db) return;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['smartCollections'], 'readwrite');
    const store = transaction.objectStore('smartCollections');
    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => {
      console.error('Error deleting smart collection:', request.error);
      reject(request.error);
    };
  });
}

export async function getAllSmartCollections(): Promise<SmartCollection[]> {
  const db = await openDatabase();
  if (!db) return [];

  return new Promise((resolve) => {
    const transaction = db.transaction(['smartCollections'], 'readonly');
    const store = transaction.objectStore('smartCollections');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => {
      console.error('Error getting all smart collections:', request.error);
      resolve([]);
    };
  });
}

export async function getSmartCollectionsByType(type: SmartCollection['type']): Promise<SmartCollection[]> {
  const db = await openDatabase();
  if (!db) return [];

  return new Promise((resolve) => {
    const transaction = db.transaction(['smartCollections'], 'readonly');
    const store = transaction.objectStore('smartCollections');
    const index = store.index('type');
    const request = index.getAll(type);

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => {
      console.error('Error getting smart collections by type:', request.error);
      resolve([]);
    };
  });
}
