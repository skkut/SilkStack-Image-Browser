// @vitest-environment jsdom
//
// Keyword search includes the vocabulary the auto-tag pass writes into
// `synonymTags` (synonyms + main-subject categories), which is otherwise
// hidden from every visible surface. A result that is only reachable through
// that vocabulary is flagged so the UI can explain why it appeared — the
// "AI tag" badge. These tests pin the three blobs' precedence: catalog, then
// enriched prompt text, then the hidden AI terms; a badge is reported only
// for the third.
import { describe, expect, it, vi } from 'vitest';

// The store is persisted, so localStorage must exist before it is imported.
vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import { useImageStore } from '../store/useImageStore';
import type { IndexedImage } from '../types';

const image = (id: string, extra: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id,
    name: `${id}.png`,
    handle: { name: `${id}.png` } as unknown as FileSystemFileHandle,
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 0,
    models: [],
    loras: [],
    scheduler: '',
    directoryId: 'dir1',
    ...extra,
  }) as unknown as IndexedImage;

const CATALOG_MATCH = image('catalog', { tags: ['red fox'], lastModified: 3000 });
const SYNONYM_MATCH = image('synonym', {
  tags: ['red fox'],
  synonymTags: ['canine', 'winter woods', 'woodland creature'],
  lastModified: 2000,
});
const PROMPT_MATCH = image('prompt', {
  prompt: 'a winter castle on a hill',
  enrichmentState: 'enriched',
  lastModified: 1000,
});

const seed = () => {
  useImageStore.setState({
    images: [CATALOG_MATCH, SYNONYM_MATCH, PROMPT_MATCH],
    filteredImages: [],
    selectedModels: [],
    selectedBaseModels: [],
    selectedLoras: [],
    selectedSchedulers: [],
    selectedTags: [],
    searchQuery: '',
    advancedFilters: {},
    tableSortField: null,
    tableSortDirection: null,
    sortOrder: 'date-desc',
    semanticMode: 'off',
    semanticHits: null,
    annotations: new Map(),
    // filterAndSort drops images whose directory is unknown or invisible.
    directories: [{ id: 'dir1', path: 'C:/test' }] as any,
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    scanSubfolders: false,
  });
  useImageStore.getState().filterAndSortImages();
};

const search = (query: string) => {
  useImageStore.getState().setSearchQuery(query);
  return useImageStore.getState();
};

describe('keyword search over hidden AI vocabulary', () => {
  it('finds an image through a synonym and flags it as an AI-tag match', () => {
    seed();
    const state = search('canine');

    expect(state.filteredImages.map((i) => i.id)).toEqual(['synonym']);
    expect(Array.from(state.aiTagHitIds)).toEqual(['synonym']);
  });

  it('finds an image through a subject category (same hidden field)', () => {
    seed();
    const state = search('woodland');

    expect(state.filteredImages.map((i) => i.id)).toEqual(['synonym']);
    expect(state.aiTagHitIds.has('synonym')).toBe(true);
  });

  it('does not flag an ordinary tag or filename match', () => {
    seed();
    const state = search('catalog');

    expect(state.filteredImages.map((i) => i.id)).toEqual(['catalog']);
    expect(state.aiTagHitIds.size).toBe(0);
  });

  it('does not flag an enriched-prompt match', () => {
    seed();
    const state = search('winter castle');

    expect(state.filteredImages.map((i) => i.id)).toEqual(['prompt']);
    expect(state.aiTagHitIds.size).toBe(0);
  });

  it('keeps the per-blob AND rule for multi-word queries', () => {
    seed();

    // Both words occur inside one synonym entry.
    expect(search('winter woods').filteredImages.map((i) => i.id)).toEqual(['synonym']);

    // "winter" and "castle" live in different images, and the synonym blob
    // does not contain "castle" — the query must not match.
    const miss = search('winter castle');
    expect(miss.filteredImages.map((i) => i.id)).toEqual(['prompt']);
    expect(miss.aiTagHitIds.size).toBe(0);
  });

  it('never exposes hidden terms as visible tags', () => {
    seed();
    const state = search('canine');

    expect(state.filteredImages[0].tags).toEqual(['red fox']);
    expect(state.filteredImages[0].tags).not.toContain('canine');
  });

  it('clears the flagged set when the query is cleared', () => {
    seed();
    search('canine');
    const state = search('');

    expect(state.aiTagHitIds.size).toBe(0);
  });
});
