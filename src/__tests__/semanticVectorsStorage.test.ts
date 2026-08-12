import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { DB_NAME, openDatabase } from '../services/indexedDb';
import {
  getAllVectors,
  getMissingVectors,
  putManyVectors,
  deleteVectorsByImageIds,
  clearAllVectors,
  countVectors,
} from '../services/semanticVectorsStorage';
import type { ISemanticVectorRecord } from '../services/aiBridge';

// ── IndexedDB harness ────────────────────────────────────────────────
// fake-indexeddb is a full in-memory IndexedDB implementation (not a mock),
// so these tests exercise the real migration + transaction code paths.

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function makeRecord(imageId: string, textHash = `hash-${imageId}`, dimension = 8): ISemanticVectorRecord {
  const vector = new Float32Array(dimension);
  for (let i = 0; i < dimension; i += 1) vector[i] = (i + 1) / dimension;
  return {
    imageId,
    vector,
    textHash,
    modelId: 'test-embedder',
    dimension,
    updatedAt: 1,
  };
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

describe('semanticVectors storage — CRUD', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('round-trips records including Float32Array vectors', async () => {
    const records = [makeRecord('img-a', 'hash-a', 8), makeRecord('img-b', 'hash-b', 8)];
    await putManyVectors(records);

    const loaded = await getAllVectors();
    expect(loaded).toHaveLength(2);

    const byId = new Map(loaded.map((r) => [r.imageId, r]));
    expect(byId.get('img-a')).toMatchObject({
      imageId: 'img-a',
      textHash: 'hash-a',
      modelId: 'test-embedder',
      dimension: 8,
    });
    // Typed arrays survive the structured clone. (isView, not instanceof:
    // fake-indexeddb clones in node's realm, so the prototype differs from
    // jsdom's Float32Array — the internal slot check is realm-independent.)
    const vector = byId.get('img-a')!.vector;
    expect(ArrayBuffer.isView(vector)).toBe(true);
    expect((vector as Float32Array).length).toBe(8);
    expect(Array.from(vector as Float32Array)).toEqual(Array.from(makeRecord('img-a').vector));
  });

  it('putManyVectors upserts by imageId (re-index with changed text)', async () => {
    await putManyVectors([makeRecord('img-a', 'old-hash')]);
    await putManyVectors([makeRecord('img-a', 'new-hash')]);

    expect(await countVectors()).toBe(1);
    const loaded = await getAllVectors();
    expect(loaded[0].textHash).toBe('new-hash');
  });

  it('getMissingVectors returns only imageIds without a record, preserving order', async () => {
    await putManyVectors([makeRecord('img-a'), makeRecord('img-b')]);

    expect(await getMissingVectors(['img-a', 'img-b', 'img-c', 'img-d'])).toEqual(['img-c', 'img-d']);
    expect(await getMissingVectors([])).toEqual([]);
    expect(await getMissingVectors(['img-a'])).toEqual([]);
  });

  it('deleteVectorsByImageIds removes records', async () => {
    await putManyVectors([makeRecord('img-a'), makeRecord('img-b'), makeRecord('img-c')]);

    await deleteVectorsByImageIds(['img-a', 'img-c']);
    const loaded = await getAllVectors();
    expect(loaded.map((r) => r.imageId)).toEqual(['img-b']);
  });

  it('clearAllVectors empties the store (Settings → Re-index)', async () => {
    await putManyVectors([makeRecord('img-a'), makeRecord('img-b')]);
    expect(await countVectors()).toBe(2);

    await clearAllVectors();
    expect(await countVectors()).toBe(0);
    expect(await getAllVectors()).toEqual([]);
  });

  it('putManyVectors with an empty list is a no-op', async () => {
    await putManyVectors([]);
    expect(await countVectors()).toBe(0);
  });
});
