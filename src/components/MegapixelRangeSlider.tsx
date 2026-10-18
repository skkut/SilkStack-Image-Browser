import React from 'react';
import {
  MEGAPIXEL_STEPS,
  formatMegapixels,
  megapixelStepIndex,
} from '../utils/megapixels';

interface MegapixelRangeSliderProps {
  value: [number, number];
  onChange: (value: [number, number]) => void;
}

/**
 * Shared by both thumbs. The inputs themselves are click-through — only the
 * thumb receives pointer events — so each knob can be grabbed independently
 * even though the two inputs overlap across the whole track. Their values are
 * step *indices*, not megapixels: the step list is non-uniform, which a native
 * range input can only express through an index.
 */
const THUMB_CLASSES = [
  'pointer-events-none absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent focus:outline-none',
  '[&::-webkit-slider-runnable-track]:bg-transparent',
  '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-gray-900 [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:shadow-md',
  '[&:focus-visible::-webkit-slider-thumb]:ring-2 [&:focus-visible::-webkit-slider-thumb]:ring-blue-300',
  '[&::-moz-range-track]:bg-transparent',
  '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-gray-900 [&::-moz-range-thumb]:bg-blue-500',
].join(' ');

const MegapixelRangeSlider: React.FC<MegapixelRangeSliderProps> = ({ value, onChange }) => {
  const lastIndex = MEGAPIXEL_STEPS.length - 1;

  // Snap a stored pair onto the scale and normalise its order, so a range
  // written by an older version can never produce an undefined step.
  const snappedLow = megapixelStepIndex(value[0]);
  const snappedHigh = megapixelStepIndex(value[1]);
  const lowIndex = Math.min(snappedLow, snappedHigh);
  const highIndex = Math.max(snappedLow, snappedHigh);

  const emit = (nextLow: number, nextHigh: number) => {
    onChange([MEGAPIXEL_STEPS[nextLow], MEGAPIXEL_STEPS[nextHigh]]);
  };

  const handleLowChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    // The thumbs may meet but never cross; the min thumb has to leave the max
    // thumb one step of room.
    const nextLow = Math.max(0, Math.min(Number(event.target.value), highIndex - 1));
    emit(nextLow, highIndex);
  };

  const handleHighChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextHigh = Math.min(lastIndex, Math.max(Number(event.target.value), lowIndex + 1));
    emit(lowIndex, nextHigh);
  };

  const lowPercent = (lowIndex / lastIndex) * 100;
  const highPercent = (highIndex / lastIndex) * 100;
  // When the knobs are adjacent their 16 px thumbs overlap; putting the min
  // input on top makes the knob the user is pushing up reachable.
  const minOnTop = lowIndex >= highIndex - 1;

  return (
    <div className="relative h-5 select-none">
      {/* The rail is inset by half a thumb (8 px), which is exactly the range
          the native thumb centre can travel — so the fill starts and ends
          under the knob centres rather than at the bare track edges. */}
      <div className="pointer-events-none absolute inset-x-2 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gray-700">
        <div
          className="absolute top-0 h-full rounded-full bg-blue-500"
          style={{ left: `${lowPercent}%`, right: `${100 - highPercent}%` }}
        />
      </div>
      <input
        type="range"
        min={0}
        max={lastIndex}
        step={1}
        value={lowIndex}
        onChange={handleLowChange}
        aria-label="Minimum megapixels"
        aria-valuetext={`${formatMegapixels(MEGAPIXEL_STEPS[lowIndex])} megapixels`}
        className={THUMB_CLASSES}
        style={{ zIndex: minOnTop ? 30 : 20 }}
      />
      <input
        type="range"
        min={0}
        max={lastIndex}
        step={1}
        value={highIndex}
        onChange={handleHighChange}
        aria-label="Maximum megapixels"
        aria-valuetext={
          highIndex === lastIndex
            ? `${formatMegapixels(MEGAPIXEL_STEPS[highIndex])}+ megapixels`
            : `${formatMegapixels(MEGAPIXEL_STEPS[highIndex])} megapixels`
        }
        className={THUMB_CLASSES}
        style={{ zIndex: minOnTop ? 20 : 30 }}
      />
    </div>
  );
};

export default MegapixelRangeSlider;
