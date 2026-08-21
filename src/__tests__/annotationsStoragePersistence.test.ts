import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../services/indexedDb';
import {
  bulkSaveAnnotations,
  saveAnnotation,
  loadAllAnnotations,
  clearAllAnnotations,
} from '../services/imageAnnotationsStorage';
import type { ImageAnnotations } from '../types';

// ── Stamp persistence (auto-tag + semantic-index idempotency across restarts) ─
// fake-indexeddb is a full in-memory IndexedDB implementation (not a mock),
// so these tests exercise the REAL storage code path — the same one the
// store's auto-tag 'complete' handler and runSemanticIndexNow use. The
// auto-tag gate (needsSearchEnrichment) keys on annotation.searchTagVersion
// and the semantic gate (needsSemanticIndexing) keys on isSemanticIndexed;
// if a stamp did not survive the save→load round-trip, every image would be
// re-tagged / re-embedded on every app start regardless of the in-memory gate.

const ENRICHED: ImageAnnotations = {
  imageId: 'img1',
  isFavorite: false,
  tags: ['manual'],
  autoTags: ['dragon'],
  metadataTags: [],
  isAutoTagged: true,
  synonymTags: ['wyvern', 'serpent'],
  searchTagVersion: 2,
  isSemanticIndexed: true,
  addedAt: 1000,
  updatedAt: 1000,
};

describe('annotation persistence — enrichment stamp round-trip', () => {
  beforeEach(async () => {
    // Wipes the module-level in-memory cache AND the IndexedDB store, so
    // each test starts from a clean "never ran before" state.
    await clearAllAnnotations();
  });

  it('bulkSaveAnnotations (auto-tag path) stores the stamp — the DB record itself carries searchTagVersion', async () => {
    await bulkSaveAnnotations([ENRICHED]);

    // Read straight from IndexedDB, bypassing the storage module's memory
    // cache — the persisted record must carry the stamp, not just memory.
    const db = await openDatabase();
    expect(db).not.toBeNull();
    const stored = await new Promise<ImageAnnotations | undefined>((resolve) => {
      const request = db!
        .transaction('imageAnnotations', 'readonly')
        .objectStore('imageAnnotations')
        .get('img1');
      request.onsuccess = () => resolve(request.result as ImageAnnotations | undefined);
      request.onerror = () => resolve(undefined);
    });
    db!.close();

    expect(stored?.searchTagVersion).toBe(2);
    expect(stored?.isAutoTagged).toBe(true);
    expect(stored?.autoTags).toEqual(['dragon']);
    expect(stored?.synonymTags).toEqual(['wyvern', 'serpent']);
    expect(stored?.isSemanticIndexed).toBe(true);
  });

  it('loadAllAnnotations (app restart) restores the stamp so the gate stays closed', async () => {
    await bulkSaveAnnotations([ENRICHED]);

    const loaded = await loadAllAnnotations();
    const ann = loaded.get('img1');
    expect(ann?.searchTagVersion).toBe(2);
    expect(ann?.isAutoTagged).toBe(true);
    expect(ann?.autoTags).toEqual(['dragon']);
    expect(ann?.tags).toEqual(['manual']);
    expect(ann?.isSemanticIndexed).toBe(true); // semantic stamp survives the restart too
  });

  it('a later single-record update (e.g. toggleFavorite → saveAnnotation) does not wipe the stamp', async () => {
    await bulkSaveAnnotations([ENRICHED]);

    // Simulates the user toggling a favorite on a tagged image — the store
    // spreads the current annotation and persists via saveAnnotation.
    await saveAnnotation({ ...ENRICHED, isFavorite: true, updatedAt: 2000 });

    const loaded = await loadAllAnnotations();
    const ann = loaded.get('img1');
    expect(ann?.isFavorite).toBe(true);
    expect(ann?.searchTagVersion).toBe(2); // stamp survives the update
    expect(ann?.autoTags).toEqual(['dragon']);
    expect(ann?.isSemanticIndexed).toBe(true); // semantic stamp survives the update
  });

  it('an annotation without the stamp (legacy isAutoTagged-only record) round-trips as version-less', async () => {
    const legacy: ImageAnnotations = {
      imageId: 'img2',
      isFavorite: false,
      tags: [],
      autoTags: ['old-tags'],
      metadataTags: [],
      isAutoTagged: true, // tagged before versions existed
      addedAt: 500,
      updatedAt: 500,
    };
    await bulkSaveAnnotations([legacy]);

    const loaded = await loadAllAnnotations();
    // Version-less on disk → the gate re-includes it exactly once (the
    // intended v1→v2 migration), and the next run stamps the version.
    expect(loaded.get('img2')?.searchTagVersion).toBeUndefined();
    expect(loaded.get('img2')?.autoTags).toEqual(['old-tags']);
  });

  it('a record without the semantic stamp (indexed before the stamp existed) round-trips as unstamped', async () => {
    const legacy: ImageAnnotations = {
      imageId: 'img3',
      isFavorite: false,
      tags: [],
      autoTags: [],
      metadataTags: [],
      searchTagVersion: 2, // enriched — but embedded before isSemanticIndexed existed
      addedAt: 500,
      updatedAt: 500,
    };
    await bulkSaveAnnotations([legacy]);

    const loaded = await loadAllAnnotations();
    // No stamp on disk → needsSemanticIndexing re-includes it exactly once
    // (the pre-stamp migration), and the next run stamps it.
    expect(loaded.get('img3')?.isSemanticIndexed).toBeUndefined();
    expect(loaded.get('img3')?.searchTagVersion).toBe(2);
  });
});
