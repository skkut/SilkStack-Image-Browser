import { describe, expect, it, vi, beforeEach } from 'vitest';

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

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import ImageTable from '../components/ImageTable';
import { useImageStore } from '../store/useImageStore';
import { type IndexedImage } from '../types';

/**
 * The table's column sort is store state now (useImageStore.tableSortField /
 * setTableSort), not local useState — that is what lets the viewer window and
 * the in-app modal navigate in the order the rows are drawn in. These tests
 * pin the ownership rules: a click claims the sort, a re-render does not
 * release it, and unmounting the table does.
 *
 * The rows themselves are virtualized (react-window inside AutoSizer, which
 * bails out at jsdom's zero measured size) — assertions target the store, the
 * contract the viewer actually reads.
 */

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

// Distinct lastModified values keep the header order (date-desc → c, b, a)
// deterministic and different from the column order, so a passing assertion
// really shows the column sort took effect.
const IMAGES = [
  image('a', { steps: 30, lastModified: 1000 }),
  image('b', { steps: 10, lastModified: 2000 }),
  image('c', { steps: 20, lastModified: 3000 }),
];

const ids = () => useImageStore.getState().filteredImages.map((image) => image.id);

const renderTable = () =>
  render(
    <ImageTable images={IMAGES} onImageClick={vi.fn()} selectedImages={new Set()} />,
  );

const stepsHeader = () => screen.getByRole('button', { name: /^Steps/ });

describe('ImageTable column sort ownership', () => {
  beforeEach(() => {
    useImageStore.setState({
      images: IMAGES,
      filteredImages: IMAGES,
      sortOrder: 'date-desc',
      tableSortField: null,
      tableSortDirection: null,
      // filterAndSort drops images whose directory is unknown/invisible, so
      // the seed has to register one or the derived list comes back empty.
      directories: [{ id: 'dir1', path: 'C:/test' }] as any,
      scanSubfolders: false,
    });
  });

  it('publishes the clicked column to the store and reorders the library with it', () => {
    renderTable();

    fireEvent.click(stepsHeader());

    const store = useImageStore.getState();
    expect(store.tableSortField).toBe('steps');
    expect(store.tableSortDirection).toBe('asc');
    // filteredImages is what the Electron snapshot and the modal walk — it
    // must carry the column order, not just the table's internal rendering.
    expect(ids()).toEqual(['b', 'c', 'a']);
  });

  it('cycles asc → desc → cleared, restoring the header order on the third click', () => {
    renderTable();

    fireEvent.click(stepsHeader());
    expect(useImageStore.getState().tableSortDirection).toBe('asc');

    fireEvent.click(stepsHeader());
    expect(useImageStore.getState().tableSortField).toBe('steps');
    expect(useImageStore.getState().tableSortDirection).toBe('desc');
    expect(ids()).toEqual(['a', 'c', 'b']);

    fireEvent.click(stepsHeader());
    expect(useImageStore.getState().tableSortField).toBeNull();
    expect(useImageStore.getState().tableSortDirection).toBeNull();
    expect(ids()).toEqual(['c', 'b', 'a']); // date-desc again
  });

  it('keeps the sort across re-renders while it stays mounted (stable effect deps)', () => {
    const { rerender } = renderTable();
    fireEvent.click(stepsHeader());

    // A sortField/sortDirection dependency on the release effect would clear
    // the sort the instant it was set, or on any later parent re-render.
    rerender(<ImageTable images={IMAGES} onImageClick={vi.fn()} selectedImages={new Set()} />);

    expect(useImageStore.getState().tableSortField).toBe('steps');
    expect(useImageStore.getState().tableSortDirection).toBe('asc');
  });

  it('sorts by MP for ASCII-x dimensions — the separator the indexer writes', () => {
    // Regression: the comparator used to split on '×' while the indexer
    // writes `${width}x${height}`, so clicking MP (or Resolution / Aspect)
    // re-ordered nothing at all on a real library.
    const list = [
      image('big', { dimensions: '2048x2048', lastModified: 1000 }),
      image('small', { dimensions: '512x512', lastModified: 2000 }),
      image('mid', { dimensions: '1024x1024', lastModified: 3000 }),
    ];
    useImageStore.setState({ images: list, filteredImages: list });

    render(<ImageTable images={list} onImageClick={vi.fn()} selectedImages={new Set()} />);
    fireEvent.click(screen.getByRole('button', { name: /^MP/ }));

    expect(useImageStore.getState().tableSortField).toBe('megapixel');
    expect(ids()).toEqual(['small', 'mid', 'big']);
  });

  it('releases the sort on unmount so the replacement view comes back in header order', () => {
    const { unmount } = renderTable();
    fireEvent.click(stepsHeader());

    unmount();

    expect(useImageStore.getState().tableSortField).toBeNull();
    expect(useImageStore.getState().tableSortDirection).toBeNull();
    expect(ids()).toEqual(['c', 'b', 'a']);
  });
});
