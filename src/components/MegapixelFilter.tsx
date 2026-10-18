import React, { useEffect, useRef, useState } from 'react';
import MegapixelRangeSlider from './MegapixelRangeSlider';
import {
  MAX_MEGAPIXELS,
  MEGAPIXEL_MAX_LABEL,
  MIN_MEGAPIXELS,
  formatMegapixels,
} from '../utils/megapixels';

interface MegapixelFilterValue {
  min?: number | null;
  max?: number | null;
}

/**
 * The slice of the store's untyped `advancedFilters` object this section
 * reads and writes. The index signature leaves every other filter untouched
 * when the merged object is handed back to the store.
 */
interface AdvancedFiltersWithMegapixels {
  megapixels?: MegapixelFilterValue | null;
  [key: string]: unknown;
}

interface MegapixelFilterProps {
  advancedFilters: AdvancedFiltersWithMegapixels | null | undefined;
  onAdvancedFiltersChange: (filters: AdvancedFiltersWithMegapixels) => void;
}

/** The slider's pair for a stored filter; an absent upper bound is the open-ended 50+. */
const readRange = (filters: AdvancedFiltersWithMegapixels | null | undefined): [number, number] => [
  typeof filters?.megapixels?.min === 'number' ? filters.megapixels.min : MIN_MEGAPIXELS,
  typeof filters?.megapixels?.max === 'number' ? filters.megapixels.max : MAX_MEGAPIXELS,
];

/**
 * Image-size filter, rendered as its own sidebar section directly under
 * Folders. It keeps its own thumb position while dragging and commits after a
 * short debounce, merging into the *latest* advanced filters so a pending
 * change from the Advanced Filters panel is never overwritten.
 *
 * Storage rules:
 * - full span (0.5 MP … 50+) removes the key entirely, which is also what
 *   keeps sub-0.5 MP images visible by default;
 * - a max thumb parked on the top stop stores **no** `max`, so "50+" really
 *   means "and above" rather than a hard 50 MP ceiling.
 */
const MegapixelFilter: React.FC<MegapixelFilterProps> = ({
  advancedFilters,
  onAdvancedFiltersChange,
}) => {
  const [range, setRange] = useState<[number, number]>(() => readRange(advancedFilters));

  // The debounced commit must merge into what is in the store now, not into
  // the props captured when the drag started.
  const latestFiltersRef = useRef(advancedFilters);
  // Which range the props last described, so an unrelated filter change does
  // not reset a drag that is still in progress.
  const storedRangeRef = useRef<[number, number]>(range);

  useEffect(() => {
    latestFiltersRef.current = advancedFilters;
    const stored = readRange(advancedFilters);
    const previous = storedRangeRef.current;
    storedRangeRef.current = stored;
    if (previous[0] === stored[0] && previous[1] === stored[1]) return;
    setRange((current) =>
      current[0] === stored[0] && current[1] === stored[1] ? current : stored
    );
  }, [advancedFilters]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      const stored = readRange(latestFiltersRef.current);
      if (stored[0] === range[0] && stored[1] === range[1]) return;

      const [min, max] = range;
      const next = { ...(latestFiltersRef.current || {}) };
      if (min <= MIN_MEGAPIXELS && max >= MAX_MEGAPIXELS) {
        delete next.megapixels;
      } else if (max >= MAX_MEGAPIXELS) {
        next.megapixels = { min };
      } else {
        next.megapixels = { min, max };
      }
      onAdvancedFiltersChange(next);
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [range, onAdvancedFiltersChange]);

  const [min, max] = range;
  const isFullSpan = min <= MIN_MEGAPIXELS && max >= MAX_MEGAPIXELS;
  const rangeLabel = isFullSpan
    ? 'All'
    : `${formatMegapixels(min)} - ${max >= MAX_MEGAPIXELS ? MEGAPIXEL_MAX_LABEL : formatMegapixels(max)} MP`;

  return (
    <div className="border-b border-gray-700 p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-gray-300 font-medium">Megapixels</span>
        <span className="text-xs text-gray-400 tabular-nums">{rangeLabel}</span>
      </div>
      <MegapixelRangeSlider value={range} onChange={setRange} />
      <div className="mt-2 flex justify-between text-[10px] text-gray-500">
        <span>{formatMegapixels(MIN_MEGAPIXELS)} MP</span>
        <span>{MEGAPIXEL_MAX_LABEL} MP</span>
      </div>
    </div>
  );
};

export default MegapixelFilter;
