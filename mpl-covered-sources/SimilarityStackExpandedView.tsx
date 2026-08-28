/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { ArrowLeft, Star, Square, CheckSquare, X } from 'lucide-react';
import { StackImage } from '../core/stacking-types';
import { computeJustifiedLayout, getItemAspectRatio, type LayoutRow } from '../utils/layoutAlgo';

// ── Constants (matching ImageGrid) ─────────────────────────────────────

const GAP_SIZE = 8;
const CONTAINER_PADDING = 36; // Matches ImageGrid: p-2 (16px) + scrollbar (17px) + buffer

// ── Helpers ────────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];

const isVideoFile = (img: StackImage): boolean => {
  if (img.fileType?.startsWith('video/')) return true;
  const name = (img.name || '').toLowerCase();
  return VIDEO_EXTENSIONS.some(ext => name.endsWith(ext));
};

// ── Sub-group image card (store-agnostic — callbacks instead of store reads) ──

interface SubGroupImageCardProps {
  image: StackImage;
  isSelected: boolean;
  onClick: (image: StackImage, event: React.MouseEvent) => void;
  onToggleFavorite: (imageId: string) => void;
  onToggleSelection: (imageId: string) => void;
  onDragStart: (image: StackImage, event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: (event: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu?: (image: StackImage, event: React.MouseEvent) => void;
  thumbnailsDisabled: boolean;
}

const SubGroupImageCard: React.FC<SubGroupImageCardProps> = React.memo(({
  image,
  isSelected,
  onClick,
  onToggleFavorite,
  onToggleSelection,
  onDragStart,
  onDragEnd,
  onContextMenu,
  thumbnailsDisabled,
}) => {
  // Thumbnail state — the parent wrapper triggers thumbnail loading via useThumbnail.
  // This component passively reacts to thumbnailUrl / thumbnailStatus becoming ready.
  const [imageUrl, setImageUrl] = useState<string | null>(() => {
    if (image.thumbnailStatus === 'ready' && image.thumbnailUrl) return image.thumbnailUrl;
    if (isVideoFile(image)) return null;
    return null;
  });

  // React to thumbnail becoming ready
  useEffect(() => {
    if (thumbnailsDisabled) {
      setImageUrl(null);
      return;
    }
    if (image.thumbnailStatus === 'ready' && image.thumbnailUrl) {
      setImageUrl(image.thumbnailUrl);
    }
  }, [image.thumbnailStatus, image.thumbnailUrl, thumbnailsDisabled]);

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleFavorite(image.id);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleSelection(image.id);
  };

  const canDragExternally = typeof window !== 'undefined' && !!(window as any).electronAPI?.startFileDrag;

  // Track mouse movement to distinguish click from drag
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return;
    const dx = Math.abs(e.clientX - mouseDownPos.current.x);
    const dy = Math.abs(e.clientY - mouseDownPos.current.y);
    if (dx > 5 || dy > 5) {
      isDragging.current = true;
      mouseDownPos.current = null;
    }
  };

  const handleCardClick = (e: React.MouseEvent) => {
    if (isDragging.current) {
      isDragging.current = false;
      return;
    }
    onClick(image, e);
  };

  return (
    <div
      className={`relative group flex items-center justify-center bg-gray-800 rounded-lg overflow-hidden cursor-pointer transition-all duration-300 ease-out border border-gray-700/50 ${
        isSelected
          ? 'ring-4 ring-blue-500 ring-opacity-75 shadow-lg shadow-blue-500/20 translate-y-[-2px]'
          : 'hover:shadow-2xl hover:shadow-black/50 hover:border-gray-600 hover:translate-y-[-4px]'
      }`}
      style={{ width: '100%', height: '100%', flexShrink: 0 }}
      onClick={handleCardClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onContextMenu={(e) => onContextMenu?.(image, e)}
      onDragStart={(e) => onDragStart(image, e)}
      onDragEnd={onDragEnd}
      draggable={canDragExternally}
    >
      {/* Selection checkbox */}
      <button
        onClick={handleCheckboxClick}
        className={`absolute top-2 left-2 z-20 p-1 rounded transition-all focus:outline-none ${
          isSelected
            ? 'bg-blue-500 text-white opacity-100'
            : 'bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-blue-500/80'
        }`}
        title={isSelected ? 'Deselect image' : 'Select image'}
      >
        {isSelected ? <CheckSquare className="h-6 w-6" /> : <Square className="h-6 w-6" />}
      </button>

      {/* Favorite button */}
      <button
        onClick={handleFavoriteClick}
        className={`absolute top-2 right-2 z-10 p-1.5 rounded-full transition-all focus:outline-none ${
          image.isFavorite
            ? 'bg-yellow-500/80 text-white opacity-100 hover:bg-yellow-600'
            : 'bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-yellow-500'
        }`}
        title={image.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
      >
        <Star className={`h-5 w-5 ${image.isFavorite ? 'fill-current' : ''}`} />
      </button>

      {/* Image content */}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={image.name || 'Image'}
          className="w-full h-full object-contain"
          loading="lazy"
          draggable={false}
        />
      ) : isVideoFile(image) ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1 bg-gray-900">
          <svg className="w-10 h-10 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[10px] text-gray-500">Video</span>
        </div>
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gray-900">
          <div className="flex flex-col items-center gap-1">
            <div className="w-6 h-6 border-2 border-gray-600 border-t-gray-400 rounded-full animate-spin" />
            <span className="text-[10px] text-gray-500">Loading…</span>
          </div>
        </div>
      )}

      {/* Hover overlay with filename */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <p className="text-[10px] text-white truncate leading-tight">
          {(image.name || '').split(/[/\\]/).pop() || 'Unknown'}
        </p>
      </div>
    </div>
  );
});

SubGroupImageCard.displayName = 'SubGroupImageCard';

// ── Justified row of images ────────────────────────────────────────────

interface JustifiedRowProps {
  row: LayoutRow;
  selectedImages: Set<string>;
  onImageClick: (image: StackImage, event: React.MouseEvent) => void;
  onToggleFavorite: (imageId: string) => void;
  onToggleSelection: (imageId: string) => void;
  onDragStart: (image: StackImage, event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: (event: React.DragEvent<HTMLDivElement>) => void;
  onContextMenu?: (image: StackImage, event: React.MouseEvent) => void;
  thumbnailsDisabled: boolean;
}

const JustifiedRow: React.FC<JustifiedRowProps> = React.memo(({
  row,
  selectedImages,
  onImageClick,
  onToggleFavorite,
  onToggleSelection,
  onDragStart,
  onDragEnd,
  onContextMenu,
  thumbnailsDisabled,
}) => {
  return (
    <div className="flex flex-row" style={{ height: row.height, gap: GAP_SIZE }}>
      {row.items.map((item) => {
        const image = 'coverImage' in item ? item.coverImage : item;
        const aspectRatio = getItemAspectRatio(item);
        const itemWidth = row.height * aspectRatio;

        return (
          <div key={image.id} style={{ width: itemWidth, height: row.height, flexShrink: 0 }}>
            <SubGroupImageCard
              image={image}
              isSelected={selectedImages.has(image.id)}
              onClick={onImageClick}
              onToggleFavorite={onToggleFavorite}
              onToggleSelection={onToggleSelection}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onContextMenu={onContextMenu}
              thumbnailsDisabled={thumbnailsDisabled}
            />
          </div>
        );
      })}
    </div>
  );
});

JustifiedRow.displayName = 'JustifiedRow';

// ── Main view (store-agnostic — callbacks instead of store reads) ──────

export interface SimilarityStackExpandedViewProps {
  images: StackImage[];
  subGroups: { promptHash: string; prompt: string; label?: string; groupKey?: string; dimensions?: { label: string; value: string }[]; imageIds: string[] }[];
  onImageClick: (image: StackImage, event: React.MouseEvent) => void;
  selectedImages: Set<string>;
  onBack: () => void;
  /** Target row height for justified layout. */
  imageSize?: number;
  /** Whether thumbnails are disabled (from settings store). */
  thumbnailsDisabled: boolean;
  /** Callback — toggle favorite on an image by ID. */
  onToggleFavorite: (imageId: string) => void;
  /** Callback — toggle selection on an image by ID. */
  onToggleSelection: (imageId: string) => void;
  /** Callback — drag start. The wrapper implements the drag payload logic. */
  onDragStart: (image: StackImage, event: React.DragEvent<HTMLDivElement>) => void;
  /** Callback — drag end (clears dragged items). */
  onDragEnd: (event: React.DragEvent<HTMLDivElement>) => void;
  /** Callback — right-click on an image card (context menu). */
  onContextMenu?: (image: StackImage, event: React.MouseEvent) => void;
  /** Labels of the active grouping dimensions (e.g. ["Model", "Prompt"]). Used for the sub-group header. */
  groupByDimensions?: string[];
  /** Toolbar content rendered inline in the header bar (e.g. group-by segmented control). */
  groupByToolbar?: React.ReactNode;
}

/**
 * Drill-down view for a similarity-based library stack.
 *
 * Renders sub-groups of images organized by their exact prompt, using the same
 * justified layout algorithm as ImageGrid. Each sub-group displays its prompt
 * in a header panel above its rows of images.
 *
 * This is the store-agnostic version — all store interactions are passed as
 * callback props. Use the wrapper in the main app for the zero-config version.
 */
const SimilarityStackExpandedView: React.FC<SimilarityStackExpandedViewProps> = ({
  images,
  subGroups,
  onImageClick,
  selectedImages,
  onBack,
  imageSize: imageSizeProp,
  thumbnailsDisabled,
  onToggleFavorite,
  onToggleSelection,
  onDragStart,
  onDragEnd,
  onContextMenu,
  groupByDimensions,
  groupByToolbar,
}) => {
  const imageSize = imageSizeProp ?? 150;

  // Derive the sub-group heading from the active grouping dimensions.
  // Falls back to "Prompt" when no dimensions are specified (backward compat).
  const groupHeading = groupByDimensions?.length
    ? groupByDimensions.join(' · ')
    : 'Prompt';

  // Build a map from imageId to image for quick lookup
  const imageMap = useMemo(() => {
    const map = new Map<string, StackImage>();
    for (const img of images) {
      map.set(img.id, img);
    }
    return map;
  }, [images]);

  // Compute unique value counts per dimension directly from the image data,
  // so counts are always visible regardless of which checkboxes are active.
  const variationCounts = useMemo(() => {
    const uniquePrompts = new Set<string>();
    const uniqueModels = new Set<string>();
    const uniqueLoras = new Set<string>();

    for (const img of images) {
      // Prompt
      const p = img.prompt?.trim();
      if (p) uniquePrompts.add(p);

      // Models
      if (img.models) {
        for (const m of img.models) {
          if (m?.trim()) uniqueModels.add(m.trim());
        }
      }

      // Loras — count unique combinations (sets applied together), not individual names
      if (img.loras && img.loras.length > 0) {
        const combo = img.loras
          .map(l => typeof l === 'string' ? l.trim() : ((l as any)?.name?.trim() || ''))
          .filter(Boolean)
          .sort()
          .join(', ');
        if (combo) uniqueLoras.add(combo);
      }
    }

    const counts = [
      { label: 'prompts', count: uniquePrompts.size, active: groupByDimensions?.includes('Prompt') ?? false, color: 'text-blue-400' },
      { label: 'models',  count: uniqueModels.size,  active: groupByDimensions?.includes('Model')  ?? false, color: 'text-amber-400' },
      { label: 'loras',   count: uniqueLoras.size,   active: groupByDimensions?.includes('Loras')  ?? false, color: 'text-emerald-400' },
    ];

    return counts.filter(c => c.count > 0);
  }, [images, groupByDimensions]);

  // Measure available width for justified layout
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setContainerWidth(w);
      }
    });

    observer.observe(el);
    // Initial measurement
    if (el.clientWidth > 0) setContainerWidth(el.clientWidth);

    return () => observer.disconnect();
  }, []);

  const availableWidth = Math.max(1, (containerWidth || (containerRef.current?.clientWidth ?? 800)) - CONTAINER_PADDING);

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex flex-wrap items-center gap-3 flex-shrink-0 px-4 py-1.5 bg-gray-900/40 border-b border-gray-800/40">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500/10 text-blue-400 rounded-md hover:bg-blue-500/20 transition-all text-xs font-medium border border-blue-500/20 shadow-sm shrink-0"
        >
          <ArrowLeft size={14} />
          <span>Library</span>
        </button>
        <span className="text-[11px] text-gray-500 select-none">
          {images.length} {images.length === 1 ? 'image' : 'images'}
          {variationCounts.map(c => (
            <span key={c.label}>
              {' · '}
              <span className={c.active ? `font-semibold ${c.color}` : 'text-gray-600'}>
                {c.count} {c.label}
              </span>
            </span>
          ))}
        </span>

        <div className="flex items-center gap-3 ml-auto">
          {/* Group-by toolbar — injected by the wrapper */}
          {groupByToolbar}

          <button
            type="button"
            onClick={onBack}
            className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-white hover:bg-gray-700/60 transition-all"
            title="Close stack"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Scrollable content with justified rows */}
      <div ref={containerRef} className="flex-1 overflow-y-auto min-h-0 scrollbar-adaptive">
        {subGroups.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-gray-500">No sub-groups found.</p>
          </div>
        )}

        {subGroups.map((sg) => {
          // Resolve images for this sub-group from the ID list
          const sgImages = sg.imageIds
            .map(id => imageMap.get(id))
            .filter((img): img is StackImage => img !== undefined);

          if (sgImages.length === 0) return null;

          // Compute justified layout using the same algorithm as ImageGrid
          const rows = availableWidth > 0
            ? computeJustifiedLayout(sgImages, availableWidth, imageSize, GAP_SIZE)
            : [];

          // Flat grid: when dimensions is an empty array, skip the header panel entirely.
          const isFlatGrid = sg.dimensions && sg.dimensions.length === 0;

          return (
            <div key={sg.promptHash} className="mb-2">
              {/* Sub-group header panel — skipped for flat grid */}
              {!isFlatGrid && (
                <div className="mx-6 mt-4 bg-gray-900/60 border border-gray-800 rounded-xl p-4">
                  {/* Dimension headings — each dimension gets its own heading + value.
                      Image count is on the same line as the first heading. */}
                  {sg.dimensions && sg.dimensions.length > 0 ? (
                    <div className="space-y-3">
                      {sg.dimensions.map((dim, i) => (
                        <div key={dim.label}>
                          {i > 0 && <div className="border-t border-gray-700/50 mb-3" />}
                          <div className="flex items-center justify-between mb-1">
                            <h3 className="text-sm font-bold text-gray-100">
                              {dim.label}
                            </h3>
                            {i === 0 && (
                              <span className="text-xs text-gray-500">
                                {sgImages.length} {sgImages.length === 1 ? 'image' : 'images'}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 leading-relaxed font-mono whitespace-pre-wrap break-all select-text pl-0.5">
                            {dim.value || '(none)'}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* Fallback for subGroups without dimension data (backward compat) */
                    <>
                      <div className="flex items-center justify-between mb-1">
                        <h3 className="text-sm font-semibold text-gray-100">{groupHeading}</h3>
                        <span className="text-xs text-gray-500">
                          {sgImages.length} {sgImages.length === 1 ? 'image' : 'images'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-300 leading-relaxed font-mono whitespace-pre-wrap break-all select-text">
                        {sg.label || sg.prompt || '(no prompt)'}
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* Justified image rows (matching ImageGrid layout exactly) */}
              {rows.length > 0 && (
                <div className="px-3 mt-3" style={{ paddingRight: 12, paddingLeft: 12 }}>
                  {rows.map((row, rowIndex) => (
                    <div key={rowIndex} style={{ marginBottom: GAP_SIZE }}>
                      <JustifiedRow
                        row={row}
                        selectedImages={selectedImages}
                        onImageClick={onImageClick}
                        onToggleFavorite={onToggleFavorite}
                        onToggleSelection={onToggleSelection}
                        onDragStart={onDragStart}
                        onDragEnd={onDragEnd}
                        onContextMenu={onContextMenu}
                        thumbnailsDisabled={thumbnailsDisabled}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Bottom padding */}
        <div className="h-8" />
      </div>
    </div>
  );
};

export default SimilarityStackExpandedView;
