// @vitest-environment jsdom
//
// The Base Model column has two things that can break silently.
//
// 1. The row is a React.memo with a hand-written comparator. The base model is
//    not a field on the image — it arrives from the offline table long after
//    the row first painted — so a comparator that does not compare it leaves
//    every already-mounted row blank forever, with no error anywhere.
// 2. There is no column registry: widths, header cells, resize grips and row
//    cells are four hand-written lists whose literal indices have to agree. A
//    grip one position off resizes the neighbouring column and nothing else
//    complains.
//
// Rows are rendered directly because they live inside react-window, which
// measures zero in jsdom and renders nothing.
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

import React from 'react';
import { render, fireEvent, screen, cleanup } from '@testing-library/react';
import ImageTable, { ImageTableRow } from '../components/ImageTable';
import { useImageStore } from '../store/useImageStore';
import type { IndexedImage } from '../types';

const image = (id: string, extra: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id,
    name: `${id}.png`,
    directoryId: 'dir1',
    directoryName: 'lib',
    handle: { name: `${id}.png` } as unknown as FileSystemFileHandle,
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 1000,
    // A ready poster keeps the thumbnail manager and the row's own 180ms
    // fallback out of the picture.
    thumbnailStatus: 'ready',
    thumbnailUrl: 'blob:poster',
    models: [],
    loras: [],
    scheduler: '',
    ...extra,
  }) as unknown as IndexedImage;

const rowProps = (image: IndexedImage, baseModel?: string) => ({
  image,
  onImageClick: vi.fn(),
  isSelected: false,
  gridTemplateColumns: '1fr',
  baseModel,
});

// ── The row cell ──────────────────────────────────────────────────────────

describe('ImageTableRow base model cell', () => {
  afterEach(cleanup);

  it('shows the resolved base model', () => {
    render(<ImageTableRow {...rowProps(image('a'), 'SD 1.5')} />);
    expect(screen.getByText('SD 1.5')).toBeTruthy();
  });

  it('shows a dash that explains itself when the checkpoint is not in the table', () => {
    render(<ImageTableRow {...rowProps(image('a'), '')} />);

    const cell = screen.getByTitle(/not in the offline table/i);
    expect(cell.textContent).toContain('—');
    expect(screen.queryByText('SD 1.5')).toBeNull();
  });

  it('treats a missing prop as unresolved rather than as a value', () => {
    // baseModel is optional so the drag/hover tests that predate the column
    // keep compiling — omitting it has to render the same as an empty string.
    const { image: img, ...rest } = rowProps(image('a'));
    render(<ImageTableRow image={img} {...rest} />);
    expect(screen.getByTitle(/not in the offline table/i)).toBeTruthy();
  });

  it('repaints an already-mounted row when the lookup resolves later', () => {
    // This is the memo trap. The row is re-rendered with a *new* image object
    // carrying the same id — exactly what the store hands down on every
    // enrichment pass — and the only thing that can carry the change through
    // the comparator is the baseModel prop.
    const { rerender } = render(<ImageTableRow {...rowProps(image('a'), '')} />);
    expect(screen.queryByText('SDXL 1.0')).toBeNull();

    rerender(<ImageTableRow {...rowProps(image('a'), 'SDXL 1.0')} />);

    expect(screen.getByText('SDXL 1.0')).toBeTruthy();
  });

  it('repaints when the value changes with the image object untouched', () => {
    const same = image('a');
    const { rerender } = render(<ImageTableRow {...rowProps(same, 'SD 1.5')} />);
    expect(screen.getByText('SD 1.5')).toBeTruthy();

    rerender(<ImageTableRow {...rowProps(same, 'Pony')} />);

    expect(screen.queryByText('SD 1.5')).toBeNull();
    expect(screen.getByText('Pony')).toBeTruthy();
  });

  it('paints the value on a row that re-renders for an unrelated reason', () => {
    // A re-render the comparator *does* allow through (selection changed) must
    // not lose the value that was already resolved.
    const { rerender } = render(<ImageTableRow {...rowProps(image('a'), 'Flux.1 D')} />);

    rerender(
      <ImageTableRow {...rowProps(image('a'), 'Flux.1 D')} isSelected />,
    );

    expect(screen.getByText('Flux.1 D')).toBeTruthy();
  });
});

// ── The column itself ─────────────────────────────────────────────────────

const IMAGES = [
  image('a', { models: ['dreamshaper_8'], lastModified: 1000 }),
  image('b', { models: ['juggernautXL'], lastModified: 2000 }),
];

const renderTable = () =>
  render(
    <ImageTable images={IMAGES} onImageClick={vi.fn()} selectedImages={new Set()} />,
  );

const baseModelHeader = () => screen.getByRole('button', { name: /^Base Model/ });

const headerWidths = (container: HTMLElement): number[] => {
  const grid = container.querySelector<HTMLElement>('.grid.text-sm')!;
  return grid.style.gridTemplateColumns.split(' ').map((px) => parseInt(px, 10));
};

/** The resize grip is the header cell's own sibling, not a child of the button. */
const gripFor = (name: RegExp) =>
  screen.getByRole('button', { name }).parentElement!.querySelector<HTMLElement>('.cursor-col-resize')!;

describe('ImageTable base model column', () => {
  beforeEach(() => {
    useImageStore.setState({
      images: IMAGES,
      filteredImages: IMAGES,
      sortOrder: 'date-desc',
      tableSortField: null,
      tableSortDirection: null,
      directories: [{ id: 'dir1', path: 'C:/test' }] as any,
      scanSubfolders: false,
    });
  });

  afterEach(cleanup);

  it('sits between Model and Steps and publishes its sort to the store', () => {
    renderTable();
    fireEvent.click(baseModelHeader());
    expect(useImageStore.getState().tableSortField).toBe('baseModel');
    expect(useImageStore.getState().tableSortDirection).toBe('asc');
  });

  it('cycles asc → desc → cleared like every other column', () => {
    renderTable();

    fireEvent.click(baseModelHeader());
    fireEvent.click(baseModelHeader());
    expect(useImageStore.getState().tableSortDirection).toBe('desc');

    fireEvent.click(baseModelHeader());
    expect(useImageStore.getState().tableSortField).toBeNull();
    expect(useImageStore.getState().tableSortDirection).toBeNull();
  });

  it('declares one width per column, in header order', () => {
    const { container } = renderTable();
    // 12 columns: preview, filename, model, base model, steps, cfg, size, mp,
    // aspect, filesize, seed, created.
    expect(headerWidths(container)).toEqual([96, 280, 220, 140, 110, 110, 100, 80, 70, 100, 160, 160]);
  });

  it('resizes its own column and no other when its grip is dragged', () => {
    // The literal handleResizeStart(3) is what this pins: inserting a column
    // shifts every index after it, and a stale index silently resizes the
    // wrong column with nothing to report it.
    const { container } = renderTable();
    fireEvent.mouseDown(gripFor(/^Base Model/), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 140 });
    fireEvent.mouseUp(document);

    expect(headerWidths(container)).toEqual([96, 280, 220, 180, 110, 110, 100, 80, 70, 100, 160, 160]);
  });

  it('resizes a neighbouring column to a different width, proving 3 is not shared', () => {
    const { container } = renderTable();
    fireEvent.mouseDown(gripFor(/^Model/), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 140 });
    fireEvent.mouseUp(document);

    expect(headerWidths(container)).toEqual([96, 280, 260, 140, 110, 110, 100, 80, 70, 100, 160, 160]);
  });
});
