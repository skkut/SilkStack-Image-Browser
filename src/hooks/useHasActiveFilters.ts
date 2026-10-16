import { useImageStore } from '../store/useImageStore';

/**
 * The shape `AdvancedFilters.tsx` writes into the store's `advancedFilters`.
 *
 * Typed here on purpose: the store declares that field `any` (see the
 * `advancedFilters` entry in `useImageStore`), so a key renamed on the writer
 * side is invisible to tsc everywhere else. This file is the one place that
 * names those keys, which turns a stale name into a compile error instead of
 * a filter that silently stops reporting itself in the footer.
 */
export interface AdvancedFiltersState {
    dimension?: string | null;
    aspectRatio?: string | null;
    steps?: { min?: number | null; max?: number | null } | null;
    cfg?: { min?: number | null; max?: number | null } | null;
    date?: { from?: string | null; to?: string | null } | null;
}

/** The slice of the image store that can narrow the grid. */
export interface ActiveFilterState {
    selectedModels: string[];
    selectedBaseModels: string[];
    selectedLoras: string[];
    selectedSchedulers: string[];
    selectedTags: string[];
    searchQuery: string;
    semanticHits: unknown;
    showFavoritesOnly: boolean;
    advancedFilters?: AdvancedFiltersState | null;
}

/**
 * Whether an advanced filter is actually narrowing results.
 *
 * Mirrors the conditions `filterAndSort` in `useImageStore` applies, so
 * "active" means "changing the result set" rather than "a key exists" — the
 * writer deletes empty `date` / `steps` / `cfg` objects, so anything left
 * present is doing something. `date` is the exception that needs the inner
 * check, since the store itself requires `from` or `to` to be set.
 */
const hasActiveAdvancedFilters = (filters?: AdvancedFiltersState | null): boolean => {
    if (!filters) return false;
    return (
        !!filters.dimension ||
        !!filters.aspectRatio ||
        !!filters.steps ||
        !!filters.cfg ||
        !!(filters.date && (filters.date.from || filters.date.to))
    );
};

/**
 * Single source of truth for "is anything narrowing the grid?".
 *
 * Two components need the answer and they need it to agree: `ActiveFilters`
 * decides whether to render the footer pills, and `GridToolbar` decides
 * whether to render the toolbar that hosts them. Those were two
 * hand-maintained copies, and they had drifted — GridToolbar's omitted
 * `selectedBaseModels`, so filtering by base model alone made GridToolbar
 * return null and took the pill down with it. Its copy also tested
 * `dateRange` / `cfgScale` / `width` / `height`, keys nothing writes any
 * more. Both now call this.
 */
export const hasActiveFilters = (state: ActiveFilterState): boolean =>
    state.selectedModels.length > 0 ||
    state.selectedBaseModels.length > 0 ||
    state.selectedLoras.length > 0 ||
    state.selectedSchedulers.length > 0 ||
    state.selectedTags.length > 0 ||
    !!state.searchQuery ||
    state.semanticHits != null ||
    state.showFavoritesOnly ||
    hasActiveAdvancedFilters(state.advancedFilters);

/**
 * Reactive form for components. The selector returns a boolean, so zustand
 * compares it with Object.is and this re-renders only when the answer
 * actually flips — not on every unrelated store write.
 */
export const useHasActiveFilters = (): boolean => useImageStore(hasActiveFilters);
