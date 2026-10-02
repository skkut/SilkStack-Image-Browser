import { describe, expect, it } from 'vitest';
import { applyTableSorting, type TableSortField } from '../utils/tableSorting';
import { type IndexedImage } from '../types';

/**
 * The list view's column comparator. It used to live inside ImageTable; it
 * moved to utils/tableSorting so the store can re-sort `filteredImages` with
 * it — these tests pin the behaviour that move must not change.
 */

const img = (id: string, extra: Partial<IndexedImage> = {}): IndexedImage => {
  const name = extra.name ?? `${id}.png`;
  return {
    id,
    name,
    handle: { name } as unknown as FileSystemFileHandle,
    metadata: {} as any,
    metadataString: '',
    lastModified: 0,
    models: [],
    loras: [],
    scheduler: '',
    ...extra,
  } as unknown as IndexedImage;
};

const ids = (list: IndexedImage[]) => list.map((image) => image.id);

const sort = (list: IndexedImage[], field: TableSortField | null, direction: 'asc' | 'desc' | null) =>
  ids(applyTableSorting(list, field, direction));

describe('applyTableSorting', () => {
  it('returns the input array untouched when there is no column sort', () => {
    const list = [img('a'), img('b')];

    expect(applyTableSorting(list, null, 'asc')).toBe(list);
    expect(applyTableSorting(list, 'steps', null)).toBe(list);
  });

  it('sorts filenames case-insensitively, both directions', () => {
    const list = [img('b', { name: 'Banana.png' }), img('a', { name: 'apple.png' })];

    expect(sort(list, 'filename', 'asc')).toEqual(['a', 'b']);
    expect(sort(list, 'filename', 'desc')).toEqual(['b', 'a']);
  });

  it('sorts by model (first entry), case-insensitively', () => {
    const list = [
      img('a', { models: ['Zeta'] }),
      img('b', { models: ['alpha'] }),
      img('c'), // no model → '' sorts first
    ];

    expect(sort(list, 'model', 'asc')).toEqual(['c', 'b', 'a']);
  });

  it('reads steps from the image or its metadata fallbacks', () => {
    const list = [
      img('a', { steps: 30 }),
      img('b', { metadata: { normalizedMetadata: { steps: 10 } } as any }),
      img('c', { steps: 20 }),
    ];

    expect(sort(list, 'steps', 'asc')).toEqual(['b', 'c', 'a']);
    expect(sort(list, 'steps', 'desc')).toEqual(['a', 'c', 'b']);
  });

  it('sorts cfg, seed and file size numerically', () => {
    const cfg = [
      img('a', { cfgScale: 7 }),
      img('b', { cfgScale: 3.5 }),
      img('c', { metadata: { normalizedMetadata: { cfg_scale: 12 } } as any }),
    ];
    expect(sort(cfg, 'cfg', 'asc')).toEqual(['b', 'a', 'c']);

    const seed = [
      img('a', { seed: 100 }),
      img('b', { seed: 5 }),
      img('c', { metadata: { seed: 42 } as any }),
    ];
    expect(sort(seed, 'seed', 'desc')).toEqual(['a', 'c', 'b']);

    const size = [
      img('a', { fileSize: 2048 }),
      img('b', { fileSize: 1024 }),
      img('c'), // missing → 0
    ];
    expect(sort(size, 'filesize', 'asc')).toEqual(['c', 'b', 'a']);
  });

  it('sorts resolution, megapixels and aspect from "W×H" dimensions', () => {
    const list = [
      img('small', { dimensions: '100×100' }), // area 10k, ratio 1.0
      img('big', { dimensions: '300×200' }),   // area 60k, ratio 1.5
      img('wide', { dimensions: '800×100' }),  // area 80k, ratio 8.0
    ];

    // Resolution/megapixels compare pixel area.
    expect(sort(list, 'size', 'asc')).toEqual(['small', 'big', 'wide']);
    expect(sort(list, 'megapixel', 'desc')).toEqual(['wide', 'big', 'small']);
    // Aspect compares the ratio.
    expect(sort(list, 'aspect', 'asc')).toEqual(['small', 'big', 'wide']);
    expect(sort(list, 'aspect', 'desc')).toEqual(['wide', 'big', 'small']);
  });

  it('ties keep the incoming (header-sort) order — the sort is stable', () => {
    // The store hands over the header-sorted list; every value ties here, so
    // the column sort must leave that base order exactly as it found it.
    const list = [img('z'), img('m'), img('a')];
    expect(sort(list, 'steps', 'asc')).toEqual(['z', 'm', 'a']);
    expect(sort(list, 'steps', 'desc')).toEqual(['z', 'm', 'a']);
  });

  it('ties when dimensions use an ASCII "x" — documented current behaviour, not a fix', () => {
    // The comparator splits on '×' (U+00D7). Dimensions stored as '512x512'
    // therefore parse to NaN, every comparison ties, and the column sort is a
    // no-op on that data. This is how the table has always behaved; pinning it
    // here stops a future "fix" from silently changing the list's order.
    const list = [
      img('small', { dimensions: '100x100' }),
      img('big', { dimensions: '200x200' }),
    ];

    expect(sort(list, 'size', 'asc')).toEqual(['small', 'big']);
    expect(sort(list, 'size', 'desc')).toEqual(['small', 'big']);
  });
});
