import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The store reads localStorage at module load — stub it before any import.
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
import { render, screen, fireEvent, act } from '@testing-library/react';
import MegapixelFilter from '../components/MegapixelFilter';
import { useImageStore } from '../store/useImageStore';
import {
  MAX_MEGAPIXELS,
  MEGAPIXEL_STEPS,
  MIN_MEGAPIXELS,
  formatMegapixels,
  getMegapixels,
  megapixelStepIndex,
} from '../utils/megapixels';
import type { IndexedImage } from '../types';

/**
 * The megapixel filter is two pieces joined by one scale: a dual-thumb slider
 * in its own sidebar section under Folders, and a store filter that every view
 * reads through `filteredImages`. These tests pin the parsing/snapping helpers
 * and both ends of that contract, including the "full span means no filter"
 * rule that keeps a sub-0.5 MP 512×512 image visible by default, and the
 * open-ended top stop that keeps images above 50 MP visible.
 */

const image = (id: string, dimensions?: string): IndexedImage =>
  ({
    id,
    name: `${id}.png`,
    handle: {} as FileSystemFileHandle,
    metadata: {},
    metadataString: '',
    lastModified: 0,
    models: [],
    loras: [],
    scheduler: '',
    dimensions,
    directoryId: 'dir1',
  }) as unknown as IndexedImage;

const seedStore = (images: IndexedImage[], advancedFilters: Record<string, unknown>) => {
  useImageStore.setState({
    images,
    filteredImages: images,
    advancedFilters,
    selectedModels: [],
    selectedBaseModels: [],
    selectedLoras: [],
    selectedSchedulers: [],
    selectedTags: [],
    searchQuery: '',
    showFavoritesOnly: false,
    sortOrder: 'date-desc',
    annotations: new Map(),
    // filterAndSort drops images whose directory is unknown or invisible.
    directories: [{ id: 'dir1', path: 'C:/test' }] as any,
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    scanSubfolders: false,
  });
  useImageStore.getState().filterAndSortImages();
};

const filteredIds = () =>
  useImageStore
    .getState()
    .filteredImages.map((img) => img.id)
    .sort();

describe('megapixel helpers', () => {
  it('reads WxH dimensions with or without spaces around the separator', () => {
    expect(getMegapixels('1024x1024')).toBeCloseTo(1.048576);
    expect(getMegapixels('1920 x 1080')).toBeCloseTo(2.0736);
    expect(getMegapixels('2048×2048')).toBeCloseTo(4.194304);
  });

  it('returns null for missing or unusable dimensions', () => {
    expect(getMegapixels(undefined)).toBeNull();
    expect(getMegapixels('')).toBeNull();
    expect(getMegapixels('0x0')).toBeNull();
    expect(getMegapixels('not a size')).toBeNull();
  });

  it('spans 0.5 to 50+ MP in ascending order', () => {
    expect(MIN_MEGAPIXELS).toBe(0.5);
    expect(MAX_MEGAPIXELS).toBe(50);
    expect([...MEGAPIXEL_STEPS]).toEqual([
      0.5, 1, 2, 3, 5, 8, 10, 12, 15, 20, 25, 30, 50,
    ]);
  });

  it('formats fractions with one decimal and whole values without one', () => {
    expect(formatMegapixels(0.5)).toBe('0.5');
    expect(formatMegapixels(12)).toBe('12');
    expect(formatMegapixels(50)).toBe('50');
  });

  it('snaps an off-scale value to the nearest step', () => {
    expect(MEGAPIXEL_STEPS[megapixelStepIndex(3.9)]).toBe(3);
    expect(MEGAPIXEL_STEPS[megapixelStepIndex(7)]).toBe(8);
    expect(MEGAPIXEL_STEPS[megapixelStepIndex(0.4)]).toBe(0.5);
    expect(MEGAPIXEL_STEPS[megapixelStepIndex(999)]).toBe(50);
  });
});

describe('store filtering by megapixels', () => {
  it('keeps only images inside the inclusive range, dropping unknown sizes', () => {
    seedStore(
      [
        image('sub', '512x512'), // 0.26 MP
        image('one', '1024x1024'), // 1.05 MP
        image('two', '1920x1080'), // 2.07 MP
        image('large', '4096x4096'), // 16.8 MP
        image('unknown'), // no dimensions
      ],
      { megapixels: { min: 1, max: 3 } },
    );

    expect(filteredIds()).toEqual(['one', 'two']);
  });

  it('treats the bounds as inclusive', () => {
    seedStore([image('exact', '1000x500')], {
      megapixels: { min: 0.5, max: 0.5 },
    });

    expect(filteredIds()).toEqual(['exact']);
  });

  it('applies no size filter when the key is absent', () => {
    seedStore(
      [image('sub', '512x512'), image('unknown')],
      {},
    );

    expect(filteredIds()).toEqual(['sub', 'unknown']);
  });
});

describe('MegapixelFilter slider', () => {
  const renderFilter = (
    advancedFilters: {
      megapixels?: { min?: number | null; max?: number | null } | null;
      [key: string]: unknown;
    } = {},
  ) => {
    const onChange = vi.fn();
    render(
      <MegapixelFilter
        advancedFilters={advancedFilters}
        onAdvancedFiltersChange={onChange}
      />,
    );
    return onChange;
  };

  const sliders = () => ({
    min: screen.getByLabelText('Minimum megapixels') as HTMLInputElement,
    max: screen.getByLabelText('Maximum megapixels') as HTMLInputElement,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at the full 0.5–50+ MP span and reads "All"', () => {
    renderFilter();

    const { min, max } = sliders();
    expect(min.value).toBe('0');
    expect(max.value).toBe(String(MEGAPIXEL_STEPS.length - 1));
    expect(screen.getByText('Megapixels')).toBeTruthy();
    expect(screen.getByText('All')).toBeTruthy();
    expect(screen.getByText('0.5 MP')).toBeTruthy();
    expect(screen.getByText('50+ MP')).toBeTruthy();
  });

  it('writes the chosen range into the advanced filters after the debounce', () => {
    const onChange = renderFilter();
    const { min, max } = sliders();

    fireEvent.change(min, { target: { value: '3' } }); // 3 MP
    fireEvent.change(max, { target: { value: '6' } }); // 10 MP
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onChange).toHaveBeenLastCalledWith({ megapixels: { min: 3, max: 10 } });
  });

  it('stores an open-ended upper bound when the max thumb sits on 50+', () => {
    const onChange = renderFilter({ megapixels: { min: 3, max: 10 } });
    const { max } = sliders();

    fireEvent.change(max, { target: { value: String(MEGAPIXEL_STEPS.length - 1) } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onChange).toHaveBeenLastCalledWith({ megapixels: { min: 3 } });
  });

  it('removes the filter when both thumbs return to the ends', () => {
    const onChange = renderFilter({ megapixels: { min: 3, max: 10 } });
    const { min, max } = sliders();

    expect(min.value).toBe('3');
    expect(max.value).toBe('6');

    fireEvent.change(min, { target: { value: '0' } });
    fireEvent.change(max, { target: { value: String(MEGAPIXEL_STEPS.length - 1) } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('does not let the minimum thumb cross the maximum thumb', () => {
    const onChange = renderFilter();
    const { min, max } = sliders();

    fireEvent.change(max, { target: { value: '3' } }); // 3 MP
    fireEvent.change(min, { target: { value: '6' } }); // clamps to 2 MP
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(onChange).toHaveBeenLastCalledWith({ megapixels: { min: 2, max: 3 } });
  });
});
