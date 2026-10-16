import { describe, expect, it, vi, beforeEach } from 'vitest';

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

// `isBaseModelLookupAvailable()` is computed once, at module load, from the
// presence of window.electronAPI — so the bridge has to exist before the
// imports below run. That is what vi.hoisted is for.
const ipc = vi.hoisted(() => {
  const bridge = {
    getBaseModelTable: vi.fn(),
    resolveBaseModels: vi.fn(),
    clearBaseModelTable: vi.fn().mockResolvedValue({ success: true }),
    setBaseModelMappings: vi.fn().mockResolvedValue({ success: true, entries: {} }),
  };
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.electronAPI = bridge;
  return bridge;
});

import { useImageStore } from '../store/useImageStore';
import { loadBaseModelTable, baseModelForImage } from '../services/baseModelTable';
import { type BaseModelEntry, type IndexedImage } from '../types';

/**
 * The base-model column is derived, not stored on the image: the offline
 * checkpoint table is keyed by checkpoint and lives in the service, and every
 * image reads through it. These tests pin the two halves that make that work —
 * the lookup itself, and the reactivity that fills the UI in when the table
 * resolves *after* the images are already on screen.
 */

const AUTOV2_KEY = 'autov2:6ce0161689';
const SD15 = 'SD 1.5';
const SDXL = 'SDXL 1.0';

const image = (id: string, extra: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id,
    name: `${id}.png`,
    handle: { name: `${id}.png` } as unknown as FileSystemFileHandle,
    metadata: {} as any,
    metadataString: '',
    lastModified: 0,
    models: [],
    loras: [],
    scheduler: '',
    directoryId: 'dir1',
    ...extra,
  }) as unknown as IndexedImage;

// Three shapes a real library contains: a checkpoint identified by hash, one
// identified only by name, and one with no checkpoint at all.
const HASHED = image('hashed', {
  models: ['dreamshaper_8'],
  metadata: { normalizedMetadata: { model_hash: '6ce0161689' } } as any,
  lastModified: 3000,
});
const NAMED = image('named', {
  models: ['juggernautXL_v9.safetensors'],
  lastModified: 2000,
});
const BARE = image('bare', { lastModified: 1000 });

const IMAGES = [HASHED, NAMED, BARE];

const entries = () => ({
  [AUTOV2_KEY]: { baseModel: SD15 },
  'name:juggernautxl v9': { baseModel: SDXL },
});

/**
 * The table is module-level state that outlives a single test, so every block
 * below loads an explicit table rather than inheriting whatever the previous
 * test left behind.
 */
const load = async (table: Record<string, Partial<BaseModelEntry> & { baseModel: string }>) => {
  ipc.getBaseModelTable.mockResolvedValue({ success: true, entries: table });
  await loadBaseModelTable();
};

const seed = (images: IndexedImage[] = IMAGES) => {
  useImageStore.setState({
    images,
    filteredImages: images,
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
    annotations: new Map(),
    // filterAndSort drops images whose directory is unknown or invisible, so
    // the fixture's 'dir1' has to be registered or every list comes back empty.
    directories: [{ id: 'dir1', path: 'C:/test' }] as any,
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    scanSubfolders: false,
  });
  useImageStore.getState().filterAndSortImages();
};

const ids = () => useImageStore.getState().filteredImages.map((i) => i.id);

describe('base model lookup — offline table', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await load(entries());
    seed();
  });

  it('resolves a checkpoint by its A1111 hash', () => {
    expect(baseModelForImage(HASHED)).toBe(SD15);
  });

  it('resolves a hash-less checkpoint through the name key', () => {
    // The extension is stripped before keying, so the table entry written for
    // "juggernautXL_v9" answers for "juggernautXL_v9.safetensors" too.
    expect(baseModelForImage(NAMED)).toBe(SDXL);
  });

  it('reports nothing for an image with no checkpoint rather than guessing', () => {
    expect(baseModelForImage(BARE)).toBe('');
  });

  it('never answers for a LoRA', () => {
    // models[0] is a checkpoint by construction, but a stray LoRA string does
    // reach it through the generic object walk some parsers use — and a LoRA's
    // base model says nothing about what rendered the image.
    const lora = image('l', { models: ['myStyle_lora.safetensors'] });
    expect(baseModelForImage(lora)).toBe('');
  });
});

describe('base model lookup — store reactivity', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ipc.clearBaseModelTable.mockResolvedValue({ success: true });
    await load(entries());
  });

  it('re-filters and rebuilds the facet when the table arrives after the images', async () => {
    // The order matters: this is the real one. Images land first, the (empty)
    // table is read, and only later does a resolution run fill it in.
    await load({});
    seed();
    expect(useImageStore.getState().availableBaseModels).toEqual([]);
    const versionBefore = useImageStore.getState().baseModelTableVersion;

    await load(entries());

    const state = useImageStore.getState();
    expect(state.baseModelTableVersion).toBe(versionBefore + 1);
    expect(state.availableBaseModels).toEqual([SD15, SDXL]);
  });

  it('filters to the selected base models', () => {
    seed();
    useImageStore.getState().setSelectedFilters({ baseModels: [SD15] });
    expect(ids()).toEqual(['hashed']);
  });

  it("filters to unresolved images through the '' sentinel", () => {
    seed();
    useImageStore.getState().setSelectedFilters({ baseModels: [''] });
    expect(ids()).toEqual(['bare']);
  });

  it('unions the sentinel with named base models', () => {
    seed();
    useImageStore.getState().setSelectedFilters({ baseModels: [SDXL, ''] });
    expect(ids().sort()).toEqual(['bare', 'named']);
  });

  it('counts a base-model selection as an active filter', () => {
    // isFilteringActive gates the incremental indexing fast path, so missing
    // this would let newly indexed images bypass the facet.
    seed();
    expect(useImageStore.getState().selectedBaseModels).toEqual([]);
    useImageStore.getState().setSelectedFilters({ baseModels: [SD15] });
    expect(useImageStore.getState().selectedBaseModels).toEqual([SD15]);
  });

  it('matches a base model through the search box', () => {
    seed();
    useImageStore.getState().setSearchQuery('sdxl');
    expect(ids()).toEqual(['named']);
  });

  it('sorts the list by base model', () => {
    seed();
    useImageStore.getState().setTableSort('baseModel', 'asc');
    // Ascending: unknown sorts as the empty string, so it leads.
    expect(ids()).toEqual(['bare', 'hashed', 'named']);
    useImageStore.getState().setTableSort('baseModel', 'desc');
    expect(ids()).toEqual(['named', 'hashed', 'bare']);
  });

  it('re-sorts the list when the table resolves under an active base-model sort', async () => {
    await load({});
    seed();
    useImageStore.getState().setTableSort('baseModel', 'asc');
    // Nothing is known yet, so the sort is a no-op and the header order holds.
    expect(ids()).toEqual(['hashed', 'named', 'bare']);

    await load(entries());

    expect(ids()).toEqual(['bare', 'hashed', 'named']);
  });
});

describe('base model lookup — resolution run', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ipc.clearBaseModelTable.mockResolvedValue({ success: true });
    await load({});
  });

  it('resolves once per distinct checkpoint, not per image', async () => {
    // All three hash-known images share a checkpoint; the fourth has none.
    const many = [
      HASHED,
      image('h2', { models: ['dreamshaper_8'], metadata: { normalizedMetadata: { model_hash: '6ce0161689' } } as any }),
      image('h3', { models: ['dreamshaper_8'], metadata: { normalizedMetadata: { model_hash: '6ce0161689' } } as any }),
      BARE,
    ];
    seed(many);

    ipc.resolveBaseModels.mockResolvedValue({
      success: true,
      results: [{ baseModel: SD15 }],
      stats: { total: 1, fromTable: 0, fetched: 1 },
    });

    await useImageStore.getState().resolveBaseModelsNow();

    expect(ipc.resolveBaseModels).toHaveBeenCalledTimes(1);
    const refs = ipc.resolveBaseModels.mock.calls[0][0].refs;
    expect(refs).toHaveLength(1);
    expect(refs[0].key).toBe(AUTOV2_KEY);
    expect(useImageStore.getState().baseModelResolveStatus).toMatchObject({
      state: 'done',
      total: 1,
      fetched: 1,
    });
  });

  it('sends the toggle state through to the main process', async () => {
    seed();
    ipc.resolveBaseModels.mockResolvedValue({ success: true, results: [], stats: { fetched: 0 } });

    await useImageStore.getState().resolveBaseModelsNow({ allowNetwork: false });
    expect(ipc.resolveBaseModels.mock.calls[0][0].allowNetwork).toBe(false);

    await useImageStore.getState().resolveBaseModelsNow();
    expect(ipc.resolveBaseModels.mock.calls[1][0].allowNetwork).toBe(true);
  });

  it('reports zero fetched when the offline table already answered', async () => {
    await load(entries());
    seed([HASHED]);

    ipc.resolveBaseModels.mockResolvedValue({
      success: true,
      results: [{ baseModel: SD15 }],
      stats: { total: 1, fromTable: 1, fetched: 0 },
    });

    await useImageStore.getState().resolveBaseModelsNow();
    // The renderer still asks (that is how the table is consulted), but the
    // main process answers from disk — the count of *requests* stays zero.
    expect(ipc.resolveBaseModels.mock.calls[0][0].refs).toHaveLength(1);
    expect(useImageStore.getState().baseModelResolveStatus.fetched).toBe(0);
  });

  it('clears the table and the status together', async () => {
    await load(entries());
    seed();

    await useImageStore.getState().clearBaseModelTable();

    expect(ipc.clearBaseModelTable).toHaveBeenCalled();
    expect(baseModelForImage(HASHED)).toBe('');
    expect(useImageStore.getState().baseModelResolveStatus.state).toBe('idle');
    expect(useImageStore.getState().availableBaseModels).toEqual([]);
  });
});

/**
 * Settings → Base Models writes here. The promise that screen makes is that a
 * mapping applies to every image using that checkpoint at once, with no
 * re-index — so what these pin is that a hand-written answer reaches exactly
 * the same derived state an automatic one does: the per-image lookup and the
 * sidebar facet.
 */
describe('base model lookup — manual mappings', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ipc.setBaseModelMappings.mockResolvedValue({ success: true, entries: {} });
    await load(entries());
    seed();
  });

  it('applies one mapping to every image using that checkpoint', async () => {
    const third = image('third', { models: ['krea2_turbo_fp8_scaled.safetensors'] });
    seed([...IMAGES, third]);

    ipc.setBaseModelMappings.mockResolvedValue({
      success: true,
      entries: {
        ...entries(),
        'name:krea2 turbo fp8 scaled': { baseModel: 'Krea 2 Turbo', source: 'manual', fetchedAt: 1 },
      },
    });

    await useImageStore
      .getState()
      .setBaseModelMapping('name:krea2 turbo fp8 scaled', 'Krea 2 Turbo', 'krea2_turbo_fp8_scaled');

    expect(baseModelForImage(third)).toBe('Krea 2 Turbo');
    // Rebuilt off the same notification, with nothing re-indexed.
    expect(useImageStore.getState().availableBaseModels).toContain('Krea 2 Turbo');
  });

  it('sends the checkpoint key, the value and the local name', async () => {
    await useImageStore.getState().setBaseModelMapping('name:x', 'Pony', 'X');

    expect(ipc.setBaseModelMappings).toHaveBeenCalledWith({
      mappings: [{ key: 'name:x', baseModel: 'Pony', checkpointName: 'X' }],
    });
  });

  it('ignores an empty key rather than writing an unmatchable row', async () => {
    await useImageStore.getState().setBaseModelMapping('', 'Pony');

    expect(ipc.setBaseModelMappings).not.toHaveBeenCalled();
  });

  it('keeps the mappings when the looked-up entries are cleared', async () => {
    const mapped = image('mapped', { models: ['gamma_model.ckpt'] });
    seed([HASHED, mapped]);
    await load({
      ...entries(),
      'name:gamma model': { baseModel: 'Krea 2', source: 'manual', fetchedAt: 1 },
    });

    await useImageStore.getState().clearBaseModelTable();

    // The main process carries manual rows across the wipe, so memory has to
    // agree — otherwise the column would blank until the next launch even
    // though the mapping is still sitting on disk.
    expect(baseModelForImage(mapped)).toBe('Krea 2');
    expect(baseModelForImage(HASHED)).toBe('');
  });
});
