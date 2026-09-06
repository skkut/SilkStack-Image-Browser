import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { DB_NAME, openDatabase } from '../services/indexedDb';

// ── IndexedDB harness ────────────────────────────────────────────────
// fake-indexeddb is a full in-memory IndexedDB implementation (not a mock),
// so these tests exercise the real migration + transaction code paths.
//
// The semanticVectors CRUD block moved to the closed-source ai-intelligence
// module (ai-intelligence/src/storage/semanticVectorsStorage.test.ts,
// 2026-08-12) along with the storage implementation. What stays here is the
// v8 → v9 MIGRATION contract: the app's openDatabase (indexedDb.ts) is the
// one place the store definitions must be created (the version stays in
// lockstep with the module), and the module's storage opens the same DB
// name/version without touching other stores.

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

describe('semanticVectors store — migration', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('openDatabase() creates the three AI-index stores at version 9', async () => {
    const db = await openDatabase();
    expect(db).not.toBeNull();
    expect(db!.version).toBe(9);

    expect(db!.objectStoreNames.contains('semanticVectors')).toBe(true);
    const semanticStore = db!.transaction('semanticVectors', 'readonly').objectStore('semanticVectors');
    expect(semanticStore.keyPath).toBe('imageId');
    expect(semanticStore.indexNames.contains('updatedAt')).toBe(true);

    // Vector similarity (prompt clustering): one vector per prompted image…
    expect(db!.objectStoreNames.contains('promptVectors')).toBe(true);
    const promptStore = db!.transaction('promptVectors', 'readonly').objectStore('promptVectors');
    expect(promptStore.keyPath).toBe('imageId');
    expect(promptStore.indexNames.contains('updatedAt')).toBe(true);

    // …and one running-centroid representative per similarity group.
    expect(db!.objectStoreNames.contains('promptSimilarityGroups')).toBe(true);
    const groupStore = db!
      .transaction('promptSimilarityGroups', 'readonly')
      .objectStore('promptSimilarityGroups');
    expect(groupStore.keyPath).toBe('groupId');
    expect(groupStore.indexNames.contains('updatedAt')).toBe(true);
    db!.close();
  });

  it('upgrading an existing v8 database preserves its data and adds the prompt stores', async () => {
    // Simulate a pre-existing v8 database with an annotations record AND a
    // semantic vector (v8 shipped semanticVectors).
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 8);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('imageAnnotations')) {
          const store = db.createObjectStore('imageAnnotations', { keyPath: 'imageId' });
          store.createIndex('isFavorite', 'isFavorite', { unique: false });
        }
        if (!db.objectStoreNames.contains('semanticVectors')) {
          const store = db.createObjectStore('semanticVectors', { keyPath: 'imageId' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['imageAnnotations', 'semanticVectors'], 'readwrite');
        tx.objectStore('imageAnnotations').put({
          imageId: 'img-seeded',
          isFavorite: true,
          tags: ['fox'],
          autoTags: [],
          metadataTags: [],
          addedAt: 1,
          updatedAt: 1,
        });
        tx.objectStore('semanticVectors').put({
          imageId: 'img-seeded',
          vector: new Float32Array([0.5]),
          textHash: 'legacy-hash',
          modelId: 'old-model',
          dimension: 1,
          updatedAt: 1,
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const db = await openDatabase();
    expect(db).not.toBeNull();
    expect(db!.version).toBe(9);
    expect(db!.objectStoreNames.contains('semanticVectors')).toBe(true);
    expect(db!.objectStoreNames.contains('promptVectors')).toBe(true);
    expect(db!.objectStoreNames.contains('promptSimilarityGroups')).toBe(true);

    // The seeded annotation survived the upgrade untouched.
    const annotation = await new Promise<unknown>((resolve) => {
      const tx = db!.transaction('imageAnnotations', 'readonly');
      const request = tx.objectStore('imageAnnotations').get('img-seeded');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    expect(annotation).toMatchObject({ imageId: 'img-seeded', isFavorite: true, tags: ['fox'] });

    // The seeded semantic vector survived too.
    const vector = await new Promise<unknown>((resolve) => {
      const tx = db!.transaction('semanticVectors', 'readonly');
      const request = tx.objectStore('semanticVectors').get('img-seeded');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    expect(vector).toMatchObject({ imageId: 'img-seeded', textHash: 'legacy-hash' });
    db!.close();
  });
});
