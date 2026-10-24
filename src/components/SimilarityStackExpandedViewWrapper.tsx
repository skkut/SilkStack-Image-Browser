import React, { useCallback, useMemo } from 'react';
import { Box, CheckSquare, FileText, Puzzle } from 'lucide-react';
import { IndexedImage, StackGroupByDimension } from '../types';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useThumbnail } from '../hooks/useThumbnail';
import { hoverPreview } from '../services/hoverPreviewCoordinator';
import { buildSubGroups } from '../hooks/useImageStacking';
import { withPromptVariationSegments } from '../utils/promptVariation';
import { safeLazy } from '../utils/safeLazy';
import { useAiFeaturesEnabled } from '../services/aiFeatureAccess';
import { buildDragPayload, type DraggedItemRef } from '../services/imageRelocation';

interface SimilarityStackExpandedViewWrapperProps {
  images: IndexedImage[];
  onImageClick: (image: IndexedImage, event: React.MouseEvent) => void;
  selectedImages: Set<string>;
  onBack: () => void;
  /**
   * This view is the whole content of a window of its own (the popped-out
   * stack), not a drill-down laid over the library.
   *
   * Forwarded straight to the package view, which then drops the header's two
   * leave-this-view buttons: there is no grid behind this window to go *back*
   * to, and it already closes through its own chrome (`StackWindow`'s drag bar
   * and OS controls) and Escape.
   */
  isStandaloneWindow?: boolean;
  imageSize?: number;
  /** Right-click handler — receives the right-clicked image in the drill-down view. */
  onContextMenu?: (image: IndexedImage, event: React.MouseEvent) => void;
  /**
   * Overrides for the store-backed callbacks.
   *
   * The drill-down runs inside the main window, where favourite/selection are
   * the real store actions. The popped-out stack window is a separate renderer
   * whose store holds no images at all, so it passes its own handlers (a local
   * toggle plus an IPC forward) instead. Omitted → the store actions, i.e. the
   * existing behaviour everywhere else.
   */
  onToggleFavorite?: (imageId: string) => void;
  onToggleSelection?: (imageId: string) => void;
  /**
   * Select every image in this stack. Defaults to replacing the store
   * selection with the ids this view was given; the popped-out stack window
   * passes its own because that renderer's store holds no images.
   */
  onSelectAll?: () => void;
}

// ── Thumbnail preloader ────────────────────────────────────────────────
// Triggers useThumbnail for each image so thumbnails load before the
// images become visible. One hook call per component instance satisfies
// React's rules of hooks.

const ThumbnailTrigger: React.FC<{ image: IndexedImage | null }> = ({ image }) => {
  useThumbnail(image);
  return null;
};

// Lazy-load the package component when AI features are available.
// The compile-time ternary lets Vite/Rolldown tree-shake the import()
// entirely when VITE_AI_FEATURES_AVAILABLE is false.
const ExpandedViewInner = import.meta.env.VITE_AI_FEATURES_AVAILABLE
  ? safeLazy(
      () => import('@ai-images-browser/ai-intelligence'),
      'SimilarityStackExpandedView',
      (mod) => (mod as any).SimilarityStackExpandedView,
    )
  : null;

// ── Grouping dimension definitions ─────────────────────────────────────

type SegmentIcon = React.ComponentType<{ size?: number | string; className?: string }>;

const GROUPING_DIMENSIONS: { key: StackGroupByDimension; label: string; Icon: SegmentIcon; color: string }[] = [
  { key: 'prompt', label: 'Prompt', Icon: FileText as SegmentIcon, color: 'blue' },
  { key: 'model',  label: 'Model',  Icon: Box as SegmentIcon,     color: 'amber' },
  { key: 'loras',  label: 'Loras',  Icon: Puzzle as SegmentIcon,  color: 'emerald' },
];

const DIMENSION_COLORS: Record<string, { bg: string; text: string; shadow: string; ring: string }> = {
  blue:    { bg: 'bg-blue-600',    text: 'text-blue-400',    shadow: 'shadow-blue-600/25',    ring: 'ring-blue-500/50' },
  amber:   { bg: 'bg-amber-600',   text: 'text-amber-400',   shadow: 'shadow-amber-600/25',   ring: 'ring-amber-500/50' },
  emerald: { bg: 'bg-emerald-600', text: 'text-emerald-400', shadow: 'shadow-emerald-600/25', ring: 'ring-emerald-500/50' },
};

/**
 * Wrapper around the ai-intelligence SimilarityStackExpandedView that
 * bridges the app's Zustand stores to the component's callback props.
 *
 * Also provides a grouping-dimension toolbar: checkboxes for Model, Prompt,
 * and Loras that control how images are sub-grouped within the expanded
 * stack view. The user can toggle any combination — sub-groups are
 * recomputed on the fly from the raw image list (never passed in), so the
 * drill-down always reflects the images currently in its stack.
 */
const SimilarityStackExpandedViewWrapper: React.FC<SimilarityStackExpandedViewWrapperProps> = ({
  images,
  onImageClick,
  selectedImages,
  onBack,
  isStandaloneWindow = false,
  imageSize: imageSizeProp,
  onContextMenu,
  onToggleFavorite,
  onToggleSelection,
  onSelectAll,
}) => {
  const aiFeaturesEnabled = useAiFeaturesEnabled();
  const libraryImageSize = useSettingsStore(s => s.viewZoomLevels.library);
  const thumbnailsDisabled = useSettingsStore(s => s.disableThumbnails);
  const displayStarredFirst = useSettingsStore(s => s.displayStarredFirst);
  const stackGroupByDimensions = useSettingsStore(s => s.stackGroupByDimensions);
  const setStackGroupByDimensions = useSettingsStore(s => s.setStackGroupByDimensions);
  const stackHighlightPromptVariations = useSettingsStore(s => s.stackHighlightPromptVariations);
  const setStackHighlightPromptVariations = useSettingsStore(s => s.setStackHighlightPromptVariations);
  const toggleFavorite = useImageStore(s => s.toggleFavorite);
  const toggleImageSelection = useImageStore(s => s.toggleImageSelection);

  // Use the zoom level from settings when no explicit imageSize is provided.
  const imageSize = imageSizeProp ?? libraryImageSize;

  // ── Recompute sub-groups from raw images based on current dimensions ──

  const subGroups = useMemo(() => {
    if (images.length === 0) return [];
    const groups = buildSubGroups(images, displayStarredFirst, stackGroupByDimensions);

    // Variation markup is drill-down-only decoration, so it is layered on here
    // rather than inside buildSubGroups — that function also runs for every
    // stack in the library while the drill-down is closed.
    if (!stackHighlightPromptVariations || !stackGroupByDimensions.includes('prompt')) {
      return groups;
    }
    return withPromptVariationSegments(groups, 'Prompt');
  }, [images, displayStarredFirst, stackGroupByDimensions, stackHighlightPromptVariations]);

  // ── Dimension labels for the external component heading ──────────────

  const groupByDimensionLabels = useMemo(() => {
    return stackGroupByDimensions.map(dim => {
      const def = GROUPING_DIMENSIONS.find(d => d.key === dim);
      return def ? def.label : dim;
    });
  }, [stackGroupByDimensions]);

  // ── Dimension toggle handler ─────────────────────────────────────────

  const handleToggleDimension = useCallback((dim: StackGroupByDimension) => {
    const current = useSettingsStore.getState().stackGroupByDimensions;
    const enabled = current.includes(dim);
    if (enabled) {
      setStackGroupByDimensions(current.filter(d => d !== dim));
    } else {
      setStackGroupByDimensions([...current, dim]);
    }
  }, [setStackGroupByDimensions]);

  // ── Select all ───────────────────────────────────────────────────────

  // Stack-level selection. Replacing the selection is deliberate: the footer's
  // bulk actions (favorite, delete, unmerge) then act on exactly this stack,
  // not on whatever happened to be selected behind it.
  const handleSelectAll = useCallback(() => {
    if (onSelectAll) {
      onSelectAll();
      return;
    }
    useImageStore.getState().selectImagesByIds(images.map(image => image.id));
  }, [images, onSelectAll]);

  // Once every member is selected the control is a no-op, so it says so rather
  // than leaving a button that silently does nothing. This is also the only
  // feedback the popped-out stack window has: it has no footer toolbar.
  const allSelected =
    images.length > 1 && images.every(image => selectedImages.has(image.id));

  // ── Build the group-by segmented control as a ReactNode ─────────────

  // Highlighting only has anything to act on while prompts are on screen.
  const promptGroupingActive = stackGroupByDimensions.includes('prompt');

  const groupByToolbar = useMemo(() => (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500 select-none shrink-0">
        Group by
      </span>
      <div className="flex items-center gap-0.5 bg-gray-800/50 rounded-full p-0.5 border border-gray-700/40 shadow-inner shadow-black/20">
        {GROUPING_DIMENSIONS.map(({ key, label, Icon, color }) => {
        const isChecked = stackGroupByDimensions.includes(key);
        const activeCount = stackGroupByDimensions.length;
        const c = DIMENSION_COLORS[color];
        return (
          <button
            key={key}
            onClick={() => handleToggleDimension(key)}
            className={[
              'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium select-none',
              'transition-all duration-200 ease-out',
              `focus:outline-none focus-visible:ring-2 focus-visible:${c.ring} focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900`,
              isChecked
                ? `${c.bg} text-white shadow-lg ${c.shadow} scale-[1.02]`
                : activeCount === 0
                  ? 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5',
            ].join(' ')}
            title={`${isChecked ? 'Disable' : 'Enable'} grouping by ${label}`}
          >
            <Icon
              size={13}
              className={[
                'transition-all duration-200',
                isChecked ? 'opacity-100' : 'opacity-50',
              ].join(' ')}
            />
            {label}
          </button>
        );
      })}
      </div>

      <div className="w-px h-4 bg-gray-700/60 shrink-0" />

      {/* Variation highlighting — disabled rather than hidden when Prompt
          grouping is off, so the toolbar keeps its shape and the tooltip can
          explain why it does nothing. */}
      <label
        className={[
          'flex items-center gap-1.5 shrink-0 select-none px-1 py-1 rounded-md transition-colors',
          promptGroupingActive ? 'cursor-pointer hover:bg-white/5' : 'cursor-not-allowed opacity-40',
        ].join(' ')}
        title={
          promptGroupingActive
            ? 'Highlight the words that differ between prompts'
            : 'Enable Prompt grouping to highlight prompt variations'
        }
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500 shrink-0">
          Highlight
        </span>
        <div className="relative inline-flex items-center">
          <input
            type="checkbox"
            aria-label="Highlight prompt variations"
            checked={stackHighlightPromptVariations}
            disabled={!promptGroupingActive}
            onChange={(e) => setStackHighlightPromptVariations(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-8 h-4 bg-gray-700/80 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500/50 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 peer-checked:after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-500 shadow-inner"></div>
        </div>
      </label>

      <div className="w-px h-4 bg-gray-700/60 shrink-0" />

      {/* Stack-wide selection — a text control in the header, never an icon
          over the cards themselves. Hidden for a one-image group, where
          "select all" would be indistinguishable from selecting the image. */}
      {images.length > 1 && (
        <button
          type="button"
          onClick={handleSelectAll}
          disabled={allSelected}
          title={
            allSelected
              ? 'Every image in this stack is selected'
              : `Select all ${images.length} images in this stack`
          }
          className={[
            'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium select-none shrink-0',
            'border transition-all duration-200 ease-out',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900',
            allSelected
              ? 'text-blue-400 bg-blue-500/10 border-blue-500/20 cursor-default'
              : 'text-gray-400 hover:text-gray-200 hover:bg-white/5 border-transparent',
          ].join(' ')}
        >
          <CheckSquare size={13} className={allSelected ? 'opacity-100' : 'opacity-70'} />
          {allSelected ? 'All selected' : 'Select all'}
        </button>
      )}
    </div>
  ), [
    stackGroupByDimensions,
    handleToggleDimension,
    promptGroupingActive,
    stackHighlightPromptVariations,
    setStackHighlightPromptVariations,
    images.length,
    allSelected,
    handleSelectAll,
  ]);

  // ── Callback bridges ─────────────────────────────────────────────────

  // Store actions are the default; the popped-out stack window supplies its
  // own because its store has no images to act on.
  const handleToggleFavorite = useCallback((imageId: string) => {
    if (onToggleFavorite) {
      onToggleFavorite(imageId);
      return;
    }
    toggleFavorite(imageId);
  }, [onToggleFavorite, toggleFavorite]);

  const handleToggleSelection = useCallback((imageId: string) => {
    if (onToggleSelection) {
      onToggleSelection(imageId);
      return;
    }
    toggleImageSelection(imageId);
  }, [onToggleSelection, toggleImageSelection]);

  // Drag start — payload comes from the shared builder (selection-aware), so
  // the stack view drags exactly what the grid and the table drag.
  const handleDragStart = useCallback((image: IndexedImage, event: React.DragEvent<HTMLDivElement>) => {
    const canDragExternally = typeof window !== 'undefined' && !!(window as any).electronAPI?.startFileDrag;
    if (!canDragExternally) return;

    const storeState = useImageStore.getState();
    const filesToDrag: DraggedItemRef[] = buildDragPayload(
      image,
      storeState.images,
      storeState.selectedImages,
    );

    if (filesToDrag.length > 0) {
      // Set internal drag state
      storeState.setDraggedItems(filesToDrag);

      // Native file drag
      if (event.dataTransfer) {
        event.dataTransfer.setData('application/x-image-metahub-items', JSON.stringify(filesToDrag));
        event.dataTransfer.effectAllowed = 'copyMove';
      }
      event.preventDefault();

      // Electron external drag
      const firstFile = filesToDrag[0];
      const directoryPath = image.directoryId;
      if (directoryPath && (window as any).electronAPI?.startFileDrag) {
        (window as any).electronAPI.startFileDrag({
          files: filesToDrag.map(f => f.sourcePath),
          directoryPath,
          relativePath: firstFile.name,
          id: image.id,
          lastModified: image.lastModified,
        });
      }
    }
  }, []);

  const handleDragEnd = useCallback((_event: React.DragEvent<HTMLDivElement>) => {
    useImageStore.getState().clearDraggedItems();
  }, []);

  if (!aiFeaturesEnabled || !ExpandedViewInner) {
    return null;
  }

  const Inner = ExpandedViewInner;

  return (
    <>
      {/* Trigger thumbnail loading for all images in the expanded view. */}
      {images.map(img => (
        <ThumbnailTrigger key={img.id} image={img} />
      ))}

      {/* ── Expanded view ─────────────────────────────────────────────── */}
      <Inner
        images={images as any}
        subGroups={subGroups as any}
        onImageClick={onImageClick as any}
        selectedImages={selectedImages}
        onBack={onBack}
        isStandaloneWindow={isStandaloneWindow}
        imageSize={imageSize}
        thumbnailsDisabled={thumbnailsDisabled}
        groupByDimensions={groupByDimensionLabels}
        groupByToolbar={groupByToolbar}
        onToggleFavorite={handleToggleFavorite}
        onToggleSelection={handleToggleSelection}
        onDragStart={handleDragStart as any}
        onDragEnd={handleDragEnd}
        onContextMenu={onContextMenu as any}
        hoverPreview={hoverPreview}
      />
    </>
  );
};

export default SimilarityStackExpandedViewWrapper;
