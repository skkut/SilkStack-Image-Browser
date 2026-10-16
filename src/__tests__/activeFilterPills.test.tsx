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

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import GridToolbar from '../components/GridToolbar';
import ActiveFilters from '../components/ActiveFilters';
import { useImageStore } from '../store/useImageStore';
import { hasActiveFilters, type ActiveFilterState } from '../hooks/useHasActiveFilters';

/**
 * The footer pills are hosted by GridToolbar, which renders nothing at all
 * unless something is filtering. So "does the pill show?" is really two
 * questions — is the pill rendered, and did the toolbar survive to host it —
 * and these tests pin both, because the two answers come from the same
 * predicate for a reason: a base-model filter once made the toolbar return
 * null, taking its own pill down with it.
 */

const renderToolbar = () =>
  render(
    <GridToolbar
      selectedImages={new Set<string>()}
      images={[]}
      directories={[]}
      onDeleteSelected={vi.fn()}
    />,
  );

/** A clean filter slice — only the fields the predicate reads. */
const stateWith = (overrides: Partial<ActiveFilterState> = {}): ActiveFilterState => ({
  selectedModels: [],
  selectedBaseModels: [],
  selectedLoras: [],
  selectedSchedulers: [],
  selectedTags: [],
  searchQuery: '',
  semanticHits: null,
  showFavoritesOnly: false,
  advancedFilters: {},
  ...overrides,
});

beforeEach(() => {
  useImageStore.setState({
    selectedModels: [],
    selectedBaseModels: [],
    selectedLoras: [],
    selectedSchedulers: [],
    selectedTags: [],
    searchQuery: '',
    semanticHits: null,
    showFavoritesOnly: false,
    advancedFilters: {},
  });
});

describe('footer pill for a base-model filter', () => {
  it('shows the pill when a base model is the ONLY active filter', () => {
    useImageStore.setState({ selectedBaseModels: ['SDXL 1.0'] });

    renderToolbar();

    const pill = screen.getByTitle('Base model');
    expect(pill.textContent).toContain('SDXL 1.0');
  });

  it('names the unresolved sentinel instead of showing an empty pill', () => {
    // '' is a real filter value here — it selects the images whose checkpoint
    // the lookup could not answer — so it has to survive a length check.
    useImageStore.setState({ selectedBaseModels: [''] });

    renderToolbar();

    expect(screen.getByTitle('Base model').textContent).toContain('Base model not resolved');
  });

  it('removes the base model from the store when the pill X is clicked', () => {
    useImageStore.setState({ selectedBaseModels: ['SDXL 1.0', 'Flux.1 D'] });

    renderToolbar();

    const pills = screen.getAllByTitle('Base model');
    fireEvent.click(within(pills[0]).getByRole('button'));

    expect(useImageStore.getState().selectedBaseModels).toEqual(['Flux.1 D']);
    expect(screen.getAllByTitle('Base model')).toHaveLength(1);
  });

  it('still renders the model pill it is modelled on', () => {
    useImageStore.setState({ selectedModels: ['juggernautXL'] });

    renderToolbar();

    expect(screen.getByTitle('Model').textContent).toContain('juggernautXL');
  });

  it('renders nothing when no filter is active', () => {
    const { container } = renderToolbar();

    expect(container.innerHTML).toBe('');
  });
});

describe('footer pill for a date-only advanced filter', () => {
  // GridToolbar's old copy of the predicate tested `advancedFilters.dateRange`,
  // a key nothing writes any more — so a date-only filter dropped its pill by
  // the same route the base model did. `date` is the key in use.
  it('shows the date pill when only a date range is set', () => {
    useImageStore.setState({ advancedFilters: { date: { from: '2026-01-01', to: '' } } });

    renderToolbar();

    expect(screen.getByText(/2026-01-01/)).toBeDefined();
  });

  it('shows the CFG pill when only a cfg range is set', () => {
    useImageStore.setState({ advancedFilters: { cfg: { min: 4, max: 9 } } });

    renderToolbar();

    expect(screen.getByText('CFG: 4-9')).toBeDefined();
  });
});

describe('hasActiveFilters predicate', () => {
  it('is false for an empty filter slice and for leftover empty objects', () => {
    expect(hasActiveFilters(stateWith())).toBe(false);
    // The writer deletes these, but an emptied range must not count as
    // narrowing either — the store ignores a date with neither bound set.
    expect(hasActiveFilters(stateWith({ advancedFilters: { steps: null } }))).toBe(false);
    expect(hasActiveFilters(stateWith({ advancedFilters: { date: { from: '', to: '' } } }))).toBe(false);
  });

  it('counts each kind of active filter', () => {
    expect(hasActiveFilters(stateWith({ selectedBaseModels: [''] }))).toBe(true);
    expect(hasActiveFilters(stateWith({ selectedTags: ['cat'] }))).toBe(true);
    expect(hasActiveFilters(stateWith({ searchQuery: 'fox' }))).toBe(true);
    expect(hasActiveFilters(stateWith({ semanticHits: [] }))).toBe(true);
    expect(hasActiveFilters(stateWith({ showFavoritesOnly: true }))).toBe(true);
    expect(hasActiveFilters(stateWith({ advancedFilters: { dimension: '1024x1024' } }))).toBe(true);
    expect(hasActiveFilters(stateWith({ advancedFilters: { steps: { min: 20, max: 40 } } }))).toBe(true);
  });
});

describe('ActiveFilters standalone', () => {
  it('renders nothing when the only filter was cleared', () => {
    useImageStore.setState({ selectedBaseModels: ['Pony'] });
    const { container, rerender } = render(<ActiveFilters />);
    expect(container.innerHTML).not.toBe('');

    useImageStore.setState({ selectedBaseModels: [] });
    rerender(<ActiveFilters />);

    expect(container.innerHTML).toBe('');
  });
});
