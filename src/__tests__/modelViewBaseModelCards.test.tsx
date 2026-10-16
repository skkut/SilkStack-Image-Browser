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
// imports below run.
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

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ModelView } from '../components/ModelView';
import { useImageStore } from '../store/useImageStore';
import { loadBaseModelTable } from '../services/baseModelTable';
import { type BaseModelEntry, type IndexedImage } from '../types';

/**
 * The Models view merges two dimensions into one grid: checkpoints (from
 * `image.models`) and base models (resolved per checkpoint from the offline
 * table). These tests pin the merge — that both families render, that each
 * card routes to the filter field it belongs to, and that a base model which
 * only becomes known *after* the images are on screen still gets a card.
 */

const SD15 = 'SD 1.5';
const SDXL = 'SDXL 1.0';
const AUTOV2_KEY = 'autov2:6ce0161689';

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
    // Keeps useThumbnail inert — it returns early for a ready thumbnail, so
    // the tests never reach the thumbnail manager.
    thumbnailStatus: 'ready',
    ...extra,
  }) as unknown as IndexedImage;

// A checkpoint identified by hash, one identified only by name, and one with
// no checkpoint metadata at all.
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

const entries = () => ({
  [AUTOV2_KEY]: { baseModel: SD15 },
  'name:juggernautxl v9': { baseModel: SDXL },
});

const load = async (table: Record<string, Partial<BaseModelEntry> & { baseModel: string }>) => {
  ipc.getBaseModelTable.mockResolvedValue({ success: true, entries: table });
  await loadBaseModelTable();
};

const seed = (images: IndexedImage[] = [HASHED, NAMED, BARE]) => {
  useImageStore.setState({
    images,
    filteredImages: images,
    directories: [{ id: 'dir1', path: 'C:/test' }] as any,
    selectedModels: [],
    selectedBaseModels: [],
  });
};

const renderView = () => {
  const onModelSelect = vi.fn();
  const onBaseModelSelect = vi.fn();
  render(<ModelView onModelSelect={onModelSelect} onBaseModelSelect={onBaseModelSelect} />);
  return { onModelSelect, onBaseModelSelect };
};

/** The card whose label is `name` — the label `<p>` carries the title attr. */
const cardFor = (name: string) => screen.getByTitle(name).closest('button') as HTMLButtonElement;

const isBaseModelCard = (card: HTMLElement) => card.textContent?.includes('Base model') ?? false;

beforeEach(() => {
  vi.clearAllMocks();
  useImageStore.setState({ selectedBaseModels: [], selectedModels: [] });
});

describe('Models view — merged checkpoint and base-model grid', () => {
  it('renders a card for each checkpoint and each resolved base model', async () => {
    seed();
    await load(entries());

    renderView();

    // Checkpoints, one per entry in `image.models`.
    expect(cardFor('dreamshaper_8')).toBeTruthy();
    expect(cardFor('juggernautXL_v9.safetensors')).toBeTruthy();
    // Base models, resolved from the table rather than read off the image.
    expect(cardFor(SD15)).toBeTruthy();
    expect(cardFor(SDXL)).toBeTruthy();
  });

  it('marks the base-model cards as such and leaves the checkpoint cards unmarked', async () => {
    seed();
    await load(entries());

    renderView();

    expect(isBaseModelCard(cardFor(SDXL))).toBe(true);
    expect(isBaseModelCard(cardFor('juggernautXL_v9.safetensors'))).toBe(false);
  });

  it('routes each family to its own filter field when clicked', async () => {
    seed();
    await load(entries());

    const { onModelSelect, onBaseModelSelect } = renderView();

    fireEvent.click(cardFor(SDXL));
    expect(onBaseModelSelect).toHaveBeenCalledWith(SDXL);
    expect(onModelSelect).not.toHaveBeenCalled();

    fireEvent.click(cardFor('dreamshaper_8'));
    expect(onModelSelect).toHaveBeenCalledWith('dreamshaper_8');
    expect(onBaseModelSelect).toHaveBeenCalledTimes(1);
  });

  it('labels the two families separately when a checkpoint shares a base model name', async () => {
    // The name is unique within one map but not across both, so the card has
    // to carry its kind rather than re-deriving it from the name.
    const sameName = image('same', { models: [SDXL], thumbnailStatus: 'ready' });
    seed([sameName]);
    await load({ 'name:sdxl 1.0': { baseModel: SDXL } });

    renderView();

    const cards = screen.getAllByTitle(SDXL).map((el) => el.closest('button') as HTMLButtonElement);
    expect(cards).toHaveLength(2);
    expect(cards.filter(isBaseModelCard)).toHaveLength(1);
  });

  it('gives no base-model card to an image whose checkpoint cannot be resolved', async () => {
    // BARE carries no checkpoint at all, so it lands in the '(no model)'
    // bucket and contributes no base model — the '' sentinel gets no card.
    seed([BARE]);
    await load(entries());

    renderView();

    expect(screen.getByTitle('(no model)')).toBeTruthy();
    expect(screen.queryByText('Base model')).toBeNull();
  });

  it('adds the base-model card when the table resolves after the images are on screen', async () => {
    // The real order: images first, an empty table read, then a resolution run
    // fills it in. The cards must follow. (The store's table subscription is
    // what carries this today — it re-filters and bumps its version — so this
    // covers the end-to-end path rather than the memo dep in isolation.)
    seed([HASHED]);
    await load({});

    renderView();
    expect(screen.queryByTitle(SD15)).toBeNull();

    await act(async () => {
      await load(entries());
    });

    expect(cardFor(SD15)).toBeTruthy();
  });

  it('interleaves the two families in one order, sorted by image count', async () => {
    // One checkpoint saved under three filenames: each name is its own 1-image
    // checkpoint card, while the shared hash resolves them all to a single
    // 3-image base model. Sorted by count, that base-model card comes first —
    // the families are ranked together, not grouped one after the other.
    const sharedHash = { normalizedMetadata: { model_hash: '6ce0161689' } } as any;
    seed([
      image('m1', { models: ['ck1'], metadata: sharedHash }),
      image('m2', { models: ['ck2'], metadata: sharedHash }),
      image('m3', { models: ['ck3'], metadata: sharedHash }),
    ]);
    await load(entries());

    renderView();

    const first = screen.getAllByRole('button')[0];
    expect(first.querySelector('p')?.textContent).toBe(SD15);
    expect(isBaseModelCard(first)).toBe(true);
  });

  it('reports both families in the footer', async () => {
    seed([HASHED]);
    await load(entries());

    renderView();

    expect(screen.getByText(`Showing 1 models · 1 base models`)).toBeTruthy();
  });
});
