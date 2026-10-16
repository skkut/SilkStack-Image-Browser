// @vitest-environment jsdom
//
// Settings → Base Models. This is the escape hatch for checkpoints the online
// lookup cannot answer, so the things worth pinning are the ones that would
// make it quietly useless:
//
//   - the mapping is written against the *checkpoint key* the lookup itself
//     uses. Key it any other way and it saves happily and applies to nothing.
//   - a mapped row and a looked-up row have to be told apart, or the user
//     cannot see which answers are theirs (and which a clear would remove).
//   - the unmapped checkpoints come first, because a library that has already
//     settled is exactly the state where the remaining work is at the bottom
//     of an alphabetical list.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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

// The table service computes its `isElectron` flag once, at module load, so the
// bridge has to exist before the imports below run.
const ipc = vi.hoisted(() => {
  const bridge = {
    getBaseModelTable: vi.fn(),
    resolveBaseModels: vi.fn(),
    clearBaseModelTable: vi.fn(),
    setBaseModelMappings: vi.fn(),
  };
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.electronAPI = bridge;
  return bridge;
});

import React from 'react';
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';
import {
  CheckpointMappingSection,
  EXCLUDED_BASE_MODELS,
  STANDARD_BASE_MODEL_GROUPS,
} from '../components/CheckpointMappingSection';
import { useImageStore } from '../store/useImageStore';
import { loadBaseModelTable } from '../services/baseModelTable';
import type { BaseModelEntry, IndexedImage } from '../types';

const image = (id: string, model: string): IndexedImage =>
  ({
    id,
    name: `${id}.png`,
    directoryId: 'dir1',
    models: [model],
    loras: [],
    metadata: {},
    metadataString: '',
    lastModified: 0,
    scheduler: '',
  }) as unknown as IndexedImage;

// Three shapes the feature exists to distinguish: a checkpoint already answered
// online, one nobody could answer, and one the user mapped by hand.
const ALPHA_KEY = 'name:alpha model';
const BETA_KEY = 'name:beta model';
const GAMMA_KEY = 'name:gamma model';

const IMAGES = [
  image('a1', 'alpha_model.safetensors'),
  image('a2', 'alpha_model.safetensors'),
  image('a3', 'alpha_model.safetensors'),
  image('b1', 'beta_model.safetensors'),
  image('g1', 'gamma_model.ckpt'),
];

const TABLE: Record<string, BaseModelEntry> = {
  [ALPHA_KEY]: { baseModel: 'SD 1.5', source: 'civitai-hash', fetchedAt: 1 },
  [GAMMA_KEY]: { baseModel: 'Krea 2', source: 'manual', fetchedAt: 1 },
};

const slug = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '-');
const rowFor = (key: string) => screen.getByTestId(`checkpoint-mapping-row-${slug(key)}`);
const queryRowFor = (key: string) => screen.queryByTestId(`checkpoint-mapping-row-${slug(key)}`);
const selectFor = (key: string) =>
  screen.getByTestId(`checkpoint-mapping-select-${slug(key)}`) as HTMLSelectElement;

const seed = (images: IndexedImage[] = IMAGES) => {
  useImageStore.setState({
    images,
    filteredImages: images,
    // filterAndSort drops images whose directory is unknown, so the fixture's
    // 'dir1' has to be registered or derived state comes back empty.
    directories: [{ id: 'dir1', path: 'C:/test' }] as any,
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    scanSubfolders: false,
    selectedModels: [],
    selectedBaseModels: [],
  });
};

const load = async (table: Record<string, BaseModelEntry>) => {
  ipc.getBaseModelTable.mockResolvedValue({ success: true, entries: table });
  await loadBaseModelTable();
};

describe('Settings → Base Models mapping table', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks drops these, and the component calls the write path on the
    // first interaction in most tests.
    ipc.clearBaseModelTable.mockResolvedValue({ success: true });
    ipc.setBaseModelMappings.mockResolvedValue({ success: true, entries: TABLE });

    // Seed the library before the table, so the table's change notification
    // reaches a store that already has images to re-filter.
    seed();
    await load(TABLE);
  });

  afterEach(() => {
    cleanup();
  });

  it('lists every distinct checkpoint, with how many images use it', () => {
    render(<CheckpointMappingSection />);

    expect(rowFor(ALPHA_KEY)).toBeTruthy();
    expect(rowFor(BETA_KEY)).toBeTruthy();
    expect(rowFor(GAMMA_KEY)).toBeTruthy();
    // Three images share alpha — one row, not three.
    expect(rowFor(ALPHA_KEY).textContent).toContain('3 images');
    expect(rowFor(BETA_KEY).textContent).toContain('1 image');
  });

  it('puts the unmapped checkpoints first', () => {
    render(<CheckpointMappingSection />);

    const rows = screen.getAllByTestId(/^checkpoint-mapping-row-/);
    // Beta is the only one without an answer, so it leads despite sorting after
    // alpha by both name and image count.
    expect(rows[0].textContent).toContain('beta_model');
  });

  it('shows the resolved value and marks the ones written by hand', () => {
    render(<CheckpointMappingSection />);

    expect(selectFor(ALPHA_KEY).value).toBe('SD 1.5');
    expect(selectFor(BETA_KEY).value).toBe('');
    expect(rowFor(GAMMA_KEY).textContent).toContain('Manual');
    expect(rowFor(ALPHA_KEY).textContent).not.toContain('Manual');
  });

  it('writes a pick against the checkpoint key the lookup itself uses', async () => {
    render(<CheckpointMappingSection />);

    fireEvent.change(selectFor(BETA_KEY), { target: { value: 'Pony' } });

    // The key is what makes the mapping apply to every image at once; the name
    // rides along so a hash-less image of the same file can alias-match it.
    await waitFor(() => {
      expect(ipc.setBaseModelMappings).toHaveBeenCalledWith({
        mappings: [{ key: BETA_KEY, baseModel: 'Pony', checkpointName: 'beta model' }],
      });
    });
  });

  it('offers every image already in the table, not just the built-in list', () => {
    render(<CheckpointMappingSection />);

    const options = Array.from(selectFor(BETA_KEY).options).map((option) => option.value);
    expect(options).toContain('Krea 2');
    expect(options).toContain('SD 1.5');
  });

  it('takes a free-text value for a base model the picker does not list', async () => {
    render(<CheckpointMappingSection />);

    fireEvent.change(selectFor(BETA_KEY), { target: { value: '__custom__' } });
    const input = screen.getByTestId(`checkpoint-mapping-custom-${slug(BETA_KEY)}`);
    fireEvent.change(input, { target: { value: 'Nunchaku 4-bit' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(ipc.setBaseModelMappings).toHaveBeenCalledWith({
        mappings: [{ key: BETA_KEY, baseModel: 'Nunchaku 4-bit', checkpointName: 'beta model' }],
      });
    });
  });

  it('hands a checkpoint back to the lookup when its mapping is cleared', async () => {
    render(<CheckpointMappingSection />);

    fireEvent.click(screen.getByLabelText('Clear manual mapping for gamma_model'));

    await waitFor(() => {
      expect(ipc.setBaseModelMappings).toHaveBeenCalledWith({
        mappings: [{ key: GAMMA_KEY, baseModel: null, checkpointName: 'gamma model' }],
      });
    });
  });

  it('narrows to the unmapped checkpoints on request', () => {
    render(<CheckpointMappingSection />);

    fireEvent.click(screen.getByTestId('checkpoint-mapping-only-unmapped'));

    expect(queryRowFor(BETA_KEY)).toBeTruthy();
    expect(queryRowFor(ALPHA_KEY)).toBeNull();
    expect(queryRowFor(GAMMA_KEY)).toBeNull();
  });

  it('filters by checkpoint name', () => {
    render(<CheckpointMappingSection />);

    fireEvent.change(screen.getByTestId('checkpoint-mapping-filter'), {
      target: { value: 'gamma' },
    });

    expect(queryRowFor(GAMMA_KEY)).toBeTruthy();
    expect(queryRowFor(ALPHA_KEY)).toBeNull();
    expect(queryRowFor(BETA_KEY)).toBeNull();
  });

  it('says so when there is no library yet', () => {
    seed([]);
    render(<CheckpointMappingSection />);

    expect(screen.getByTestId('checkpoint-mapping-empty')).toBeTruthy();
  });
});

/**
 * The picker's list is a hand-copy of Civitai's "Base model" filter dropdown,
 * trimmed by hand. Refreshing it means pasting that dropdown over the top —
 * which is precisely how the trimmed entries would come back without anyone
 * noticing, since every one of them is still a real, filterable Civitai value.
 */
describe('Settings → Base Models picker list', () => {
  const offered = STANDARD_BASE_MODEL_GROUPS.flatMap((group) => group.options);

  it('offers every value exactly once', () => {
    // A paste that lands in two groups would render the same option twice.
    expect(new Set(offered).size).toBe(offered.length);
  });

  it('keeps the hand-removed values out', () => {
    const reappeared = EXCLUDED_BASE_MODELS.filter((value) => offered.includes(value));
    // Asserted against the list itself so a failure names the offending value
    // rather than reporting a count.
    expect(reappeared).toEqual([]);
  });
});
