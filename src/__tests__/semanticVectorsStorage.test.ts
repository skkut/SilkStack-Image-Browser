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
// v7 → v8 MIGRATION contract: the app's openDatabase (indexedDb.ts) is the
// one place the store definition must be created, and the module's storage
// opens the same DB name/version without touching other stores.

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

  it('openDatabase() creates the store at version 8 with keyPath imageId and updatedAt index', async () => {
    const db = await openDatabase();
    expect(db).not.toBeNull();
    expect(db!.version).toBe(8);
    expect(db!.objectStoreNames.contains('semanticVectors')).toBe(true);

    const store = db!.transaction('semanticVectors', 'readonly').objectStore('semanticVectors');
    expect(store.keyPath).toBe('imageId');
    expect(store.indexNames.contains('updatedAt')).toBe(true);
    db!.close();
  });

  it('upgrading an existing v7 database preserves its data and adds semanticVectors', async () => {
    // Simulate a pre-existing v7 database with an annotations record.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 7);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('imageAnnotations')) {
          const store = db.createObjectStore('imageAnnotations', { keyPath: 'imageId' });
          store.createIndex('isFavorite', 'isFavorite', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('imageAnnotations', 'readwrite');
        tx.objectStore('imageAnnotations').put({
          imageId: 'img-seeded',
          isFavorite: true,
          tags: ['fox'],
          autoTags: [],
          metadataTags: [],
          addedAt: 1,
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
    expect(db!.version).toBe(8);
    expect(db!.objectStoreNames.contains('semanticVectors')).toBe(true);

    // The seeded annotation survived the upgrade untouched.
    const annotation = await new Promise<unknown>((resolve) => {
      const tx = db!.transaction('imageAnnotations', 'readonly');
      const request = tx.objectStore('imageAnnotations').get('img-seeded');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
    expect(annotation).toMatchObject({ imageId: 'img-seeded', isFavorite: true, tags: ['fox'] });
    db!.close();
  });
});
