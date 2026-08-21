import { VariableSizeList as List, ListChildComponentProps, areEqual } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { computeJustifiedLayout, getItemAspectRatio, type LayoutRow } from '../utils/layoutAlgo';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { type IndexedImage, type BaseMetadata, ImageStack, type LibraryStackContext } from '../types';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useContextMenu } from '../hooks/useContextMenu';
import { 
  Info, 
  Copy, 
  Folder, 
  Clipboard, 
  Sparkles, 
  Star, 
  Square,  
  AlertCircle,
  Archive,
  Check,
  CheckSquare,
  EyeOff,
  Package,
  Play,
  Trash2,
  ExternalLink,
  Maximize2,
  Layers,
  Layers2
} from 'lucide-react';
import { useThumbnail } from '../hooks/useThumbnail';
import { useImageStacking } from '../hooks/useImageStacking';
import { useStackingEnabled } from '../services/aiFeatureAccess';

class GridErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean, error: Error | null}> {
  constructor(props: {children: React.ReactNode}) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-8 bg-red-900 text-white w-full h-full overflow-auto">
          <h2 className="text-xl font-bold mb-4">ImageGrid Crashed</h2>
          <pre className="text-xs whitespace-pre-wrap">{this.state.error?.stack || this.state.error?.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// Module-level scroll position — survives ImageGrid unmount/remount during
// stack drill-down (when SimilarityStackExpandedView replaces the grid).
let moduleMainLibraryScrollPosition = 0;

// --- ImageCard Component ---
interface ImageCardProps {
  image: IndexedImage;
  onImageClick: (image: IndexedImage, event: React.MouseEvent) => void;
  isSelected: boolean;
  isFocused?: boolean;
  onImageLoad: (id: string, aspectRatio: number) => void;
  onContextMenu?: (image: IndexedImage, event: React.MouseEvent) => void;
  baseWidth: number;

  registerCardRef?: (id: string, el: HTMLDivElement | null) => void;
  isBlurred?: boolean;
  getDragPayload?: (image: IndexedImage) => { sourcePath: string; name: string }[];
  /** Image matched semantically for the active query — show the sparkle badge. */
  isSemanticMatch?: boolean;
}

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];

const isVideoFileName = (fileName?: string | null, fileType?: string | null): boolean => {
  if (fileType && fileType.startsWith('video/')) {
    return true;
  }
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

// Global cache to prevent flickering when react-window shifts ImageCards across rows (triggering unmount/remount)
const fallbackUrlCache = new Map<string, { url: string; timeoutId: ReturnType<typeof setTimeout> | null }>();

const getCachedFallbackUrl = (id: string): string | null => {
  const cached = fallbackUrlCache.get(id);
  if (cached) {
    if (cached.timeoutId) {
      clearTimeout(cached.timeoutId);
      cached.timeoutId = null;
    }
    return cached.url;
  }
  return null;
};

const setCachedFallbackUrl = (id: string, url: string) => {
  const existing = fallbackUrlCache.get(id);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);
  fallbackUrlCache.set(id, { url, timeoutId: null });
};

const releaseCachedFallbackUrl = (id: string) => {
  const cached = fallbackUrlCache.get(id);
  if (cached) {
    if (cached.timeoutId) clearTimeout(cached.timeoutId);
    cached.timeoutId = setTimeout(() => {
      URL.revokeObjectURL(cached.url);
      fallbackUrlCache.delete(id);
    }, 2000); // 2 second grace period for layout shifts
  }
};

export const ImageCard: React.FC<ImageCardProps> = React.memo(({ image, onImageClick, isSelected, isFocused, onImageLoad, onContextMenu, baseWidth, registerCardRef, isBlurred, getDragPayload, isSemanticMatch }) => {
  const [imageUrl, setImageUrl] = useState<string | null>(() => {
    // Determine initial state safely before thumbnail hook runs
    const state = useSettingsStore.getState();
    if (state.disableThumbnails) return null;
    if (image.thumbnailStatus === 'ready' && image.thumbnailUrl) return image.thumbnailUrl;
    if (isVideoFileName(image.name, image.fileType)) return null;
    return getCachedFallbackUrl(image.id);
  });

  const setPreviewImage = useImageStore((state) => state.setPreviewImage);
  const thumbnailsDisabled = useSettingsStore((state) => state.disableThumbnails);

  const toggleImageSelection = useImageStore((state) => state.toggleImageSelection);
  const setDraggedItems = useImageStore((state) => state.setDraggedItems);
  const clearDraggedItems = useImageStore((state) => state.clearDraggedItems);
  const canDragExternally = typeof window !== 'undefined' && !!window.electronAPI?.startFileDrag;
  const isVideo = isVideoFileName(image.name, image.fileType);

  // Track mouse movement to distinguish click from drag: suppress onClick when
  // the pointer has moved more than a few pixels between mousedown and mouseup.
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);

  // Extract filename to display based on showFullFilePath setting
  const displayName = (image.name || '').split(/[/\\]/).pop() || 'Unknown';

  // Virtualization handles visibility, request thumbnail immediately
  useThumbnail(image);

  // Provide cardRef directly
  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (registerCardRef) {
        registerCardRef(image.id, node);
      }
    },
    [registerCardRef, image.id]
  );

  useEffect(() => {
    if (thumbnailsDisabled) {
      setImageUrl(null);
      return;
    }

    if (image.thumbnailStatus === 'ready' && image.thumbnailUrl) {
      setImageUrl(image.thumbnailUrl);
      return;
    }

    if (isVideo) {
      setImageUrl(null);
      return;
    }

    let isMounted = true;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const fileHandle = image.thumbnailHandle || image.handle;
    const isElectron = typeof window !== 'undefined' && window.electronAPI;

    const loadFallback = async () => {
      if (!fileHandle || typeof fileHandle.getFile !== 'function') {
        return;
      }

      try {
        const file = await fileHandle.getFile();
        if (!isMounted) return;
        const newUrl = URL.createObjectURL(file);
        setCachedFallbackUrl(image.id, newUrl);
        setImageUrl(newUrl);
      } catch (error) {
        if (!isMounted) return;
        // Only log non-file-not-found errors to reduce console noise
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (isElectron && !errorMessage.includes('Failed to read file')) {
          console.error('Failed to load image:', error);
        }
        // Set a special marker to indicate load failure
        setImageUrl('ERROR');
      }
    };

    // If we already have a cached URL or thumbnail, we don't need to fetch fallback
    const cachedFallback = getCachedFallbackUrl(image.id);
    if (!cachedFallback) {
      // Debounce heavy fallback fetch; if thumbnail becomes ready meanwhile, this effect will rerun and cancel
      fallbackTimer = setTimeout(() => {
        void loadFallback();
      }, 180);
    } else {
      setImageUrl(cachedFallback);
    }

    return () => {
      isMounted = false;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      // Release cache to be revoked after 2s if not remounted
      releaseCachedFallbackUrl(image.id);
    };
  }, [image.id, image.handle, image.thumbnailHandle, image.thumbnailStatus, image.thumbnailUrl, thumbnailsDisabled, isVideo]);

  const handlePreviewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewImage(image);
  };



  const toggleFavorite = useImageStore((state) => state.toggleFavorite);

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavorite(image.id);
  };

  const handleCheckboxClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleImageSelection(image.id);
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canDragExternally) {
      return;
    }

    const directoryPath = image.directoryId;
    if (!directoryPath) {
      return;
    }

    const [, relativeFromId] = image.id.split('::');
    const relativePath = relativeFromId || image.name;

    // Internal Drag and Drop Data
    if (getDragPayload && e.dataTransfer) {
      const payload = getDragPayload(image);
      e.dataTransfer.setData('application/x-image-metahub-items', JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copyMove';

      // Set global drag state for reliable internal drops
      setDraggedItems(payload);
    }

    // Native File Drag (for external apps)
    e.preventDefault();
    if (e.dataTransfer) {
      // We set copy here for external apps, but internal drop handlers will look at effectAllowed
      e.dataTransfer.effectAllowed = 'copyMove';
    }

    // Get all files to drag
    let filesToDrag: string[] = [];
    if (getDragPayload) {
        const payload = getDragPayload(image);
        filesToDrag = payload.map(p => p.sourcePath).filter(Boolean);
    }

    // Fallback to single file if payload empty or failed
    if (filesToDrag.length === 0) {
        const directoryPath = image.directoryId;
        if (!directoryPath) return; // Cannot drag without path
        const [, relativeFromId] = image.id.split('::');
        const relativePath = relativeFromId || image.name;
        // Reconstruct path manually if needed
        filesToDrag = [`${directoryPath}\\${relativePath}`]; 
    }

    window.electronAPI?.startFileDrag({ 
      files: filesToDrag,
      // Keep legacy single file params just in case, but handler will prioritize 'files'
      directoryPath: image.directoryId, 
      relativePath: (image.id.split('::')[1] || image.name), 
      id: image.id,
      lastModified: image.lastModified 
    });
  };

  const handleDragEnd = (e: React.DragEvent<HTMLDivElement>) => {
    clearDraggedItems();
  };

  // Distinguish click from drag: track pointer movement on the card.
  // If the pointer moves more than 5px between mousedown and mouseup,
  // suppress the onClick so the image doesn't open on a drag gesture.
  const handleCardMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
  };

  const handleCardMouseMove = (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return;
    const dx = Math.abs(e.clientX - mouseDownPos.current.x);
    const dy = Math.abs(e.clientY - mouseDownPos.current.y);
    if (dx > 5 || dy > 5) {
      isDragging.current = true;
      mouseDownPos.current = null; // Reset so subsequent moves are no-ops
    }
  };

  const handleCardClick = (e: React.MouseEvent) => {
    if (isDragging.current) {
      isDragging.current = false;
      return;
    }
    onImageClick(image, e);
  };

  return (
    <div className="flex flex-col items-center h-full" style={{ width: `${baseWidth}px` }}>

      <div
        ref={mergedRef}
        className={`relative group flex items-center justify-center bg-gray-800 rounded-lg overflow-hidden cursor-pointer transition-all duration-300 ease-out border border-gray-700/50 ${
          isSelected 
            ? 'ring-4 ring-blue-500 ring-opacity-75 shadow-lg shadow-blue-500/20 translate-y-[-2px]' 
            : 'hover:shadow-2xl hover:shadow-black/50 hover:border-gray-600 hover:translate-y-[-4px]'
        } ${
          isFocused ? 'outline-2 outline-dashed outline-blue-400 outline-offset-2 z-10' : ''
        }`}
        style={{ width: '100%', height: '100%', flexShrink: 0 }}
        onClick={handleCardClick}
        onMouseDown={handleCardMouseDown}
        onMouseMove={handleCardMouseMove}
        onContextMenu={(e) => onContextMenu && onContextMenu(image, e)}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        draggable={canDragExternally}
      >
        {/* Checkbox for selection - always visible on hover or when selected */}
        <button
          onClick={handleCheckboxClick}
          className={`absolute top-2 left-2 z-20 p-1 rounded transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isSelected
              ? 'bg-blue-500 text-white opacity-100'
              : 'bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-blue-500/80'
          }`}
          title={isSelected ? 'Deselect image' : 'Select image'}
        >
          {isSelected ? (
            <CheckSquare className="h-5 w-5" />
          ) : (
            <Square className="h-5 w-5" />
          )}
        </button>

        <button
          onClick={handleFavoriteClick}
          className={`absolute top-2 right-2 z-10 p-1.5 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:opacity-100 ${
            image.isFavorite
              ? 'bg-yellow-500/80 text-white opacity-100 hover:bg-yellow-600'
              : 'bg-black/50 text-white opacity-0 group-hover:opacity-100 hover:bg-yellow-500'
          }`}
          title={image.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
        >
          <Star className={`h-4 w-4 ${image.isFavorite ? 'fill-current' : ''}`} />
        </button>

        {isSemanticMatch && (
          // Semantic hit badge — top-right corner, left of the favorite star;
          // pointer-events so it never blocks card click/drag (title is
          // self-documentation).
          <div
            className="absolute top-2 right-10 z-10 p-1 rounded-full bg-purple-500/10 text-purple-400 pointer-events-none"
            title="Semantic match"
          >
            <Sparkles className="h-3.5 w-3.5" />
          </div>
        )}

        {imageUrl === 'ERROR' ? (
          <div className="w-full h-full flex items-center justify-center bg-gray-900">
            <div className="text-center text-gray-400 px-4">
              <svg className="w-12 h-12 mx-auto mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              <p className="text-xs">File not found</p>
            </div>
          </div>
        ) : imageUrl ? (
          <img
            src={imageUrl}
            alt={image.name}
            className={`w-full h-full object-contain transition-all duration-200 ${
              isBlurred ? 'filter blur-xl scale-110 opacity-80' : ''
            }`}
            loading="lazy"
            draggable={false}
            onLoad={(e) => {
              const target = e.currentTarget;
              const { naturalWidth, naturalHeight } = target;
              if (naturalWidth > 0 && naturalHeight > 0 && onImageLoad) {
                  onImageLoad(image.id, naturalWidth / naturalHeight);
              }
              const currentDim = image.dimensions;
              const [strW, strH] = currentDim ? currentDim.split('x') : [];
              const curW = parseInt(strW, 10) || 0;
              const curH = parseInt(strH, 10) || 0;
              const currentAspect = curH > 0 ? curW / curH : 0;
              const naturalAspect = naturalWidth / naturalHeight;
              if (!curW || !curH || Math.abs(currentAspect - naturalAspect) > 0.05) {
                  useImageStore.getState().updateImageDimensions(image.id, `${naturalWidth}x${naturalHeight}`);
              }
            }}
          />
        ) : (
          <div className="w-full h-full animate-pulse bg-gray-700"></div>
        )}

        {isVideo && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="rounded-full bg-black/50 p-2 shadow-lg">
              <Play className="h-6 w-6 text-white/90" />
            </div>
          </div>
        )}

        {isBlurred && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <EyeOff className="h-8 w-8 text-white/80 drop-shadow" />
          </div>
        )}

        <div className="absolute left-0 right-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <p className="text-white text-xs truncate">{displayName}</p>
        </div>
      </div>

    </div>
  );
});


// Type guard for ImageStack
function isImageStack(item: IndexedImage | ImageStack): item is ImageStack {
  return (item as ImageStack).coverImage !== undefined;
}

const GAP_SIZE = 8;
const ITEM_HEIGHT_RATIO = 1.2; // Normal aspect ratio (rectangular)

// Helper for geometric navigation
const findClosestItemInRow = (
  targetX: number,
  rowItems: (IndexedImage | ImageStack)[],
  rowHeight: number
): number => {
    let currentX = 0;
    let minDist = Number.MAX_VALUE;
    let bestIndex = -1;

    for (let i = 0; i < rowItems.length; i++) {
        const item = rowItems[i];
        const aspectRatio = getItemAspectRatio(item);
        const width = rowHeight * aspectRatio;
        const centerX = currentX + width / 2;
        const dist = Math.abs(centerX - targetX);
        
        if (dist < minDist) {
            minDist = dist;
            bestIndex = i;
        }
        currentX += width + GAP_SIZE;
    }
    return bestIndex;
}

interface ImageGridRowData {
  rows: LayoutRow[];
  enableSafeMode: boolean;
  sensitiveTagSet?: Set<string>;
  blurSensitiveImages: boolean;
  selectedImages: Set<string>;
  semanticHitIds?: Set<string>;
  focusedItemId: string | null;
  onImageClick: (image: IndexedImage, event: React.MouseEvent) => void;
  handleStackClick: (stack: ImageStack) => void;
  handleImageLoad: (id: string, aspectRatio: number) => void;
  handleContextMenu: (image: IndexedImage, event: React.MouseEvent) => void;
  registerCardRef: (id: string, el: HTMLDivElement | null) => void;
  getDragPayload: (image: IndexedImage) => { sourcePath: string; name: string }[];
}

const ImageGridRowComponent = React.memo(({ index, style, data }: ListChildComponentProps<ImageGridRowData>) => {
  const { rows, enableSafeMode, sensitiveTagSet, blurSensitiveImages, selectedImages, semanticHitIds, focusedItemId, onImageClick, handleStackClick, handleImageLoad, handleContextMenu, registerCardRef, getDragPayload } = data;
  const row = rows[index];
  if (!row) return null;
  
  return (
    <div style={{ ...style, padding: '0 8px 0 12px', top: (style.top as number) + 8 }}>
        <div className="flex flex-row gap-2" style={{ height: row.height }}>
            {row.items.map((item) => {
                const aspectRatio = getItemAspectRatio(item);
                const itemWidth = row.height * aspectRatio;
                const image = isImageStack(item) ? item.coverImage : item;
                const isSensitive = enableSafeMode && sensitiveTagSet && sensitiveTagSet.size > 0 && !!image.tags?.some(tag => tag && sensitiveTagSet.has(tag.toLowerCase()));
                
                if (isImageStack(item)) {
                    return (
                        <div 
                          key={item.id} 
                          className="relative group cursor-pointer" 
                          style={{ width: itemWidth, height: row.height, flexShrink: 0 }}
                          onClick={(e) => onImageClick(item.coverImage, e)}
                      >
                          {/* ... stack layers ... */}
                          <div className="absolute top-[-4px] left-[4px] right-[-4px] bottom-[4px] bg-gray-700 rounded-lg border border-gray-600 shadow-sm z-0"></div>
                          <div className="absolute top-[-8px] left-[8px] right-[-8px] bottom-[8px] bg-gray-800 rounded-lg border border-gray-700 shadow-sm z-[-1]"></div>
                          <div className="relative z-10 w-full h-full">
                              <ImageCard
                                  image={item.coverImage}
                                  onImageClick={(img, e) => { e.stopPropagation(); onImageClick(img, e); }}
                                  isSelected={selectedImages.has(item.coverImage.id)}
                                  isFocused={focusedItemId === item.coverImage.id}
                                  onImageLoad={handleImageLoad}
                                  onContextMenu={handleContextMenu}
                                  baseWidth={itemWidth}
                                  isSemanticMatch={semanticHitIds?.has(item.coverImage.id)}

                                  registerCardRef={registerCardRef}
                                  isBlurred={isSensitive && enableSafeMode && blurSensitiveImages}
                                  getDragPayload={getDragPayload}
                              />
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleStackClick(item);
                                }}
                                className="absolute bottom-2 right-2 bg-gradient-to-r from-blue-600/95 to-indigo-600/95 hover:from-blue-500 hover:to-indigo-500 text-white text-[11px] font-semibold px-2.5 py-1 rounded-md backdrop-blur-md z-20 border border-blue-400/40 shadow-[0_0_8px_rgba(59,130,246,0.25)] hover:shadow-[0_0_14px_rgba(99,102,241,0.45)] flex items-center gap-1.5 transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
                                title={`Open stack (${item.count} images)`}
                              >
                                <Layers size={11} className="text-blue-100" />
                                <span>Stack ({item.count})</span>
                              </div>
                          </div>
                        </div>
                    );
                }

                return (
                  <div key={image.id} style={{ width: itemWidth, height: row.height, flexShrink: 0 }}>
                      <ImageCard
                          image={image}
                          onImageClick={onImageClick}
                          isSelected={selectedImages.has(image.id)}
                          isFocused={focusedItemId === image.id}
                          onImageLoad={handleImageLoad}
                          onContextMenu={handleContextMenu}
                          baseWidth={itemWidth}
                          isSemanticMatch={semanticHitIds?.has(image.id)}

                          registerCardRef={registerCardRef}
                          isBlurred={isSensitive && enableSafeMode && blurSensitiveImages}
                          getDragPayload={getDragPayload}
                      />
                  </div>
                );
            })}
        </div>
    </div>
  );
}, areEqual);

interface ImageGridProps {
  images: IndexedImage[];
  onImageClick: (image: IndexedImage, event: React.MouseEvent) => void;
  selectedImages: Set<string>;
  semanticHitIds?: Set<string>;
  disableStacking?: boolean;
}

const ImageGrid: React.FC<ImageGridProps & { width: number; height: number }> = React.memo(({ width, height, images, onImageClick, selectedImages, semanticHitIds, disableStacking }) => {
  const imageSize = useSettingsStore((state) => state.viewZoomLevels.library);
  const sensitiveTags = useSettingsStore((state) => state.sensitiveTags);
  const blurSensitiveImages = useSettingsStore((state) => state.blurSensitiveImages);
  const enableSafeMode = useSettingsStore((state) => state.enableSafeMode);
  const directories = useImageStore((state) => state.directories);
  const filterAndSortImages = useImageStore((state) => state.filterAndSortImages);
  const focusedImageIndex = useImageStore((state) => state.focusedImageIndex);
  const setFocusedImageIndex = useImageStore((state) => state.setFocusedImageIndex);
  const setPreviewImage = useImageStore((state) => state.setPreviewImage);
  const previewImage = useImageStore((state) => state.previewImage);

  // Scroll position state
  const selectedFolders = useImageStore((state) => state.selectedFolders);
  const setFolderScrollPosition = useImageStore((state) => state.setFolderScrollPosition);
  const scrollKey = useMemo(() => Array.from(selectedFolders).sort().join(',') || 'ALL', [selectedFolders]);
  const scrollStateRef = useRef({ key: scrollKey, top: 0 });

  // --- Stacking Logic (Must be top-level) ---
  // useStackingEnabled() combines the user's toggle preference with the
  // premium gate: without a license (or the module), stacking is OFF
  // regardless of the persisted setting, so images don't silently group
  // from stale premium data.
  const stackingEnabled = useStackingEnabled();
  const setStackingEnabled = useImageStore((state) => state.setStackingEnabled);
  const setLibraryStackContext = useImageStore((state) => state.setLibraryStackContext);
  const libraryStackContext = useImageStore((state) => state.libraryStackContext);
  const pendingRestoreStackScrollRef = useRef<boolean>(false);
  const prevLibraryStackContextRef = useRef<LibraryStackContext | null>(null);

  const { stackedItems } = useImageStacking(images, stackingEnabled);
  const gridRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<List>(null);

  const pendingRestoreKeyRef = useRef<string | null>(scrollKey);
  const lastResizeTimeRef = useRef(0);
  
  // Resize anchor tracking
  const rowsRef = useRef<any[]>([]);
  const resizeAnchorRef = useRef<{ id: string, offsetRatio: number } | null>(null);


  // Handle scroll event
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    // Only track scroll if we are not in the middle of a folder transition
    if (scrollStateRef.current.key === scrollKey && pendingRestoreKeyRef.current === null) {
      const scrollTop = e.currentTarget.scrollTop;
      scrollStateRef.current.top = scrollTop;

      // Update anchor for resize tracking ONLY if not actively resizing (debounce 250ms)
      if (Date.now() - lastResizeTimeRef.current > 250) {
        let currentY = 0;
        for (const row of rowsRef.current) {
          if (currentY + row.height + 8 >= scrollTop) {
            if (row.items && row.items.length > 0) {
              const firstItem = row.items[0];
              const itemId = 'coverImage' in firstItem ? firstItem.coverImage.id : firstItem.id;
              if (itemId) {
                // Calculate proportional offset relative to row height
                const ratio = row.height > 0 ? Math.max(0, scrollTop - currentY) / row.height : 0;
                resizeAnchorRef.current = { id: itemId, offsetRatio: ratio };
              }
            }
            break;
          }
          currentY += row.height + 8; // row.height + margin (gap-2 = 8px)
        }
      }
    }
  }, [scrollKey]);

  // Moved useLayoutEffect below rows definition

  useEffect(() => {
    // Save current position when component unmounts
    return () => {
      setFolderScrollPosition(scrollStateRef.current.key, scrollStateRef.current.top);
    };
  }, [setFolderScrollPosition]);

  const imageCardsRef = useRef<Map<string, HTMLDivElement>>(new Map());

  // Layout logic
  const itemsToRender: (IndexedImage | ImageStack)[] = (stackingEnabled && !disableStacking) ? stackedItems : images;
  const focusedItemId = itemsToRender[focusedImageIndex] ? (isImageStack(itemsToRender[focusedImageIndex]) ? (itemsToRender[focusedImageIndex] as ImageStack).coverImage.id : (itemsToRender[focusedImageIndex] as IndexedImage).id) : null;
  
  const rows = useMemo(() => {
      // Account for padding (p-2 = 16px) and scrollbar (approx 17px) to avoid horizontal scroll
      const safeWidth = width || 0;
      const availableWidth = Math.max(1, safeWidth - 36); 
      return computeJustifiedLayout(itemsToRender, availableWidth, imageSize);
  }, [itemsToRender, width, imageSize]);

  React.useLayoutEffect(() => {
    if (prevLibraryStackContextRef.current !== null && libraryStackContext === null) {
      pendingRestoreStackScrollRef.current = true;
    }
    prevLibraryStackContextRef.current = libraryStackContext;
  }, [libraryStackContext]);

  React.useLayoutEffect(() => {
    if (pendingRestoreStackScrollRef.current && gridRef.current) {
      if (rows.length > 0 || itemsToRender.length === 0) {
        const savedPos = moduleMainLibraryScrollPosition;

        // Reset the virtualized list cache completely from index 0
        // to ensure perfect, pixel-precise height and offset calculations
        if (listRef.current) {
          listRef.current.resetAfterIndex(0, true);
        }

        requestAnimationFrame(() => {
          if (gridRef.current) {
            gridRef.current.scrollTo({ top: savedPos, behavior: 'instant' });
            scrollStateRef.current.top = savedPos;
          }
        });
        pendingRestoreStackScrollRef.current = false;
      }
    }
  }, [libraryStackContext, rows.length, itemsToRender.length]);

  const prevRowsRef = useRef<LayoutRow[]>([]);

  // ── Atomic layout-shift correction ──────────────────────────────────
  // When row heights change (e.g. lazy-loaded thumbnails reveal real
  // image dimensions), two things must happen atomically BEFORE the
  // browser paints:
  //   1. resetAfterIndex  – clear react-window's stale position cache
  //   2. scroll anchoring – adjust scrollTop so the visible anchor item
  //      stays at the same visual position on screen
  //
  // flushSync ensures step 1's forceUpdate is processed synchronously
  // so that when step 2 runs, react-window has already repositioned
  // every item to its correct geometric location.
  React.useLayoutEffect(() => {
    // Detect the first row whose height changed
    let firstChangedIndex = 0;
    const prevRows = prevRowsRef.current;

    while (firstChangedIndex < Math.min(rows.length, prevRows.length)) {
      if (rows[firstChangedIndex].height !== prevRows[firstChangedIndex].height) {
        break;
      }
      firstChangedIndex++;
    }

    prevRowsRef.current = rows;
    rowsRef.current = rows;

    // Step 1: synchronously invalidate react-window cache so items
    //         are repositioned with correct style.top values
    if (listRef.current && firstChangedIndex < prevRows.length) {
      flushSync(() => {
        listRef.current!.resetAfterIndex(firstChangedIndex, false);
      });
    }

    // Step 2: now that positions are correct, adjust the scroll bar
    //         so the anchor item stays pixel-perfect on screen
    if (
      gridRef.current &&
      resizeAnchorRef.current &&
      pendingRestoreKeyRef.current === null &&
      !pendingRestoreStackScrollRef.current
    ) {
      let currentY = 0;
      let found = false;
      let foundY = 0;
      let foundRowHeight = 0;

      for (const row of rows) {
        for (const item of row.items) {
          const itemId = 'coverImage' in item ? item.coverImage.id : item.id;
          if (itemId === resizeAnchorRef.current.id) {
            found = true;
            foundY = currentY;
            foundRowHeight = row.height;
            break;
          }
        }
        if (found) break;
        currentY += row.height + 8;
      }

      if (found) {
        const targetScrollTop = Math.round(
          foundY + resizeAnchorRef.current.offsetRatio * foundRowHeight,
        );
        const currentScrollTop = Math.round(gridRef.current.scrollTop);

        if (Math.abs(targetScrollTop - currentScrollTop) > 1) {
          gridRef.current.scrollTop = targetScrollTop;
          scrollStateRef.current.top = targetScrollTop;
        }
      }
    }
  }, [rows]);

  // Restore scroll position based on anchor after resize
  const prevWidthRef = useRef(width);
  React.useLayoutEffect(() => {
    if (prevWidthRef.current !== width) {
      prevWidthRef.current = width;
      lastResizeTimeRef.current = Date.now();
      
      if (resizeAnchorRef.current && gridRef.current && pendingRestoreKeyRef.current === null) {
        let currentY = 0;
        let foundY = 0;
        let foundRowHeight = 0;
        let found = false;
        
        for (const row of rows) {
          for (const item of row.items) {
            const itemId = 'coverImage' in item ? item.coverImage.id : item.id;
            if (itemId === resizeAnchorRef.current.id) {
              found = true;
              foundY = currentY;
              foundRowHeight = row.height;
              break;
            }
          }
          if (found) break;
          currentY += row.height + 8;
        }

        if (found) {
          const newScrollTop = foundY + resizeAnchorRef.current.offsetRatio * foundRowHeight;
          gridRef.current.scrollTop = newScrollTop;
          scrollStateRef.current.top = newScrollTop;
        }
      }
    }
  }, [width, rows]);

  React.useLayoutEffect(() => {
    const oldKey = scrollStateRef.current.key;
    if (oldKey !== scrollKey) {
      // Save old position
      setFolderScrollPosition(oldKey, scrollStateRef.current.top);
      scrollStateRef.current.key = scrollKey;
      pendingRestoreKeyRef.current = scrollKey;
    }

    if (pendingRestoreKeyRef.current === scrollKey && gridRef.current) {
      // Only restore if we actually have rows rendered (meaning width > 0 and height is established)
      // or if itemsToRender is truly empty (meaning the folder is empty and we can just set to 0)
      if (rows.length > 0 || itemsToRender.length === 0) {
        const savedPos = useImageStore.getState().folderScrollPositions[scrollKey] || 0;
        
        // Use a short timeout to ensure the browser has applied DOM heights and AutoSizer is completely settled
        requestAnimationFrame(() => {
          if (gridRef.current) {
            gridRef.current.scrollTo({ top: savedPos, behavior: 'instant' });
            scrollStateRef.current.top = savedPos;
          }
        });
        
        pendingRestoreKeyRef.current = null;
      }
    }
  }, [scrollKey, setFolderScrollPosition, rows.length, itemsToRender.length]);

  // Prevent object URL memory leaks when changing folders, but skip on initial mount
  // to avoid destroying the cache when returning from another view
  const prevScrollKeyRef = useRef(scrollKey);
  useEffect(() => {
    if (prevScrollKeyRef.current !== scrollKey) {
      prevScrollKeyRef.current = scrollKey;
      import('../services/thumbnailManager').then(m => m.thumbnailManager.clearAllUrls());
      useImageStore.getState().clearAllThumbnails();
    }
  }, [scrollKey]);


  const toggleImageSelection = useImageStore((state) => state.toggleImageSelection);

  // Drag-to-select states
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [initialSelectedImages, setInitialSelectedImages] = useState<Set<string>>(new Set());

  const selectedCount = selectedImages.size;
  const sensitiveTagSet = useMemo(() => {
    return new Set(
      (sensitiveTags ?? [])
        .map(tag => (typeof tag === 'string' ? tag.trim().toLowerCase() : ''))
        .filter(Boolean)
    );
  }, [sensitiveTags]);


  const {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    copyPrompt,
    copyNegativePrompt,
    copySeed,
    copyImage,
    copyModel,
    showInFolder,
    openWithNativeViewer,
    copyRawMetadata
  } = useContextMenu();




  // Drag-to-select handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start selection if clicking on the grid background (not on an image)
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).hasAttribute('data-grid-background')) {
      return;
    }

    // Windows behavior: Clicking background deselects everything (unless Ctrl/Shift is held)
    if (!e.ctrlKey && !e.shiftKey) {
        useImageStore.setState({ selectedImages: new Set() });
        setFocusedImageIndex(-1); // Also clear focus
    }

    e.preventDefault();
    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = e.clientX - rect.left + (gridRef.current?.scrollLeft || 0);
    const y = e.clientY - rect.top + (gridRef.current?.scrollTop || 0);

    setIsSelecting(true);
    setSelectionStart({ x, y });
    setSelectionEnd({ x, y });
    // If we just cleared selection, initial is empty. If we held Ctrl/Shift, we keep it.
    // However, since we updated store generated state above, we should read from it? 
    // Actually, React state updates are scheduled.
    // If we want to support "Add to selection with Drag", we need to handle that.
    
    // For now, if no modifiers, start fresh.
    const currentSelection = (!e.ctrlKey && !e.shiftKey) ? new Set<string>() : new Set(selectedImages);
    setInitialSelectedImages(currentSelection);
  }, [selectedImages]);

  // Throttled with requestAnimationFrame for performance
  const rafIdRef = useRef<number | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isSelecting || !selectionStart) return;

    // Cancel any pending animation frame
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    // Schedule the intersection calculation for the next animation frame
    rafIdRef.current = requestAnimationFrame(() => {
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;

      const x = e.clientX - rect.left + (gridRef.current?.scrollLeft || 0);
      const y = e.clientY - rect.top + (gridRef.current?.scrollTop || 0);

      setSelectionEnd({ x, y });

      // Calculate which images are within the selection box
      const box = {
        left: Math.min(selectionStart.x, x),
        right: Math.max(selectionStart.x, x),
        top: Math.min(selectionStart.y, y),
        bottom: Math.max(selectionStart.y, y),
      };

      const newSelection = new Set(e.shiftKey ? initialSelectedImages : []);

      imageCardsRef.current.forEach((element, imageId) => {
        const imageRect = element.getBoundingClientRect();
        const scrollTop = gridRef.current?.scrollTop || 0;
        const scrollLeft = gridRef.current?.scrollLeft || 0;

        const imageBox = {
          left: imageRect.left - rect.left + scrollLeft,
          right: imageRect.right - rect.left + scrollLeft,
          top: imageRect.top - rect.top + scrollTop,
          bottom: imageRect.bottom - rect.top + scrollTop,
        };

      // Check if boxes intersect
        const intersects = !(
          imageBox.right < box.left ||
          imageBox.left > box.right ||
          imageBox.bottom < box.top ||
          imageBox.top > box.bottom
        );

        if (intersects) {
          newSelection.add(imageId);
        }
      });

      // Avoid unnecessary state updates by deeply comparing Sets
      const currentSelection = useImageStore.getState().selectedImages;
      let hasChanged = newSelection.size !== currentSelection.size;
      
      if (!hasChanged) {
          for (const item of newSelection) {
              if (!currentSelection.has(item)) {
                  hasChanged = true;
                  break;
              }
          }
      }

      if (hasChanged) {
        useImageStore.setState({ selectedImages: newSelection });
      }
      rafIdRef.current = null;
    });
  }, [isSelecting, selectionStart, initialSelectedImages]);

  const handleMouseUp = useCallback(() => {
    setIsSelecting(false);
    setSelectionStart(null);
    setSelectionEnd(null);
  }, []);

  // --- Stacking Logic ---
  // const itemsToRender moved to top

  // ALL HOOKS MUST BE BEFORE ANY EARLY RETURNS
  // Sync focusedImageIndex when previewImage changes
  useEffect(() => {
    if (previewImage) {
      const index = itemsToRender.findIndex((item: IndexedImage | ImageStack) => {
        if (isImageStack(item)) return item.coverImage.id === previewImage.id;
        return (item as IndexedImage).id === previewImage.id;
      });
      if (index !== -1 && index !== focusedImageIndex) {
        setFocusedImageIndex(index);
      }
    }
  }, [previewImage?.id, itemsToRender]); // ✅ Removed focusedImageIndex to break circular dependency

  useEffect(() => {
    if (focusedImageIndex === -1 && itemsToRender.length > 0) {
      // Quando volta de página, vai para última imagem
      setFocusedImageIndex(itemsToRender.length - 1);
      
      const lastItem = itemsToRender[itemsToRender.length - 1];
      const imageToPreview = isImageStack(lastItem) ? lastItem.coverImage : lastItem;
      
      // Only update if there's already a preview open (don't auto-open)
      if (useImageStore.getState().previewImage) {
        setPreviewImage(imageToPreview);
      }
    }
  }, [itemsToRender.length, setFocusedImageIndex, setPreviewImage, itemsToRender]); // ✅ Added missing dependencies

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInModal = document.querySelector('[role="dialog"]') !== null;
      const isInCommandPalette = document.querySelector('.command-palette, [data-command-palette]') !== null;
      const isTyping = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (isInModal || isInCommandPalette) return;

      const needsFocus = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key);
      if (needsFocus && !gridRef.current?.contains(document.activeElement)) return;

      if (e.key === 'Enter' && !isTyping) {
        const currentIndex = focusedImageIndex ?? -1;
        if (currentIndex >= 0 && currentIndex < itemsToRender.length) {
          e.preventDefault();
          e.stopPropagation();

          const selectedItem = itemsToRender[currentIndex];

          if (isImageStack(selectedItem)) {
              handleStackClick(selectedItem);
              return;
          }

          if (e.altKey) {
            sessionStorage.setItem('openImageFullscreen', 'true');
            onImageClick(selectedItem, e as any);
          } else {
            sessionStorage.removeItem('openImageFullscreen');
            onImageClick(selectedItem, e as any);
          }
          return;
        }
      }

      const currentIndex = focusedImageIndex ?? -1;
      let nextIndex = currentIndex;

      // Find which row the current index belongs to
      let currentRowIndex = -1;
      let startIndexInRow = 0;
      let count = 0;
      
      if (currentIndex !== -1) {
          for (let i = 0; i < rows.length; i++) {
              if (currentIndex < count + rows[i].items.length) {
                  currentRowIndex = i;
                  startIndexInRow = count;
                  break;
              }
              count += rows[i].items.length;
          }
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextIndex = currentIndex + 1;
        if (nextIndex < itemsToRender.length) {
           // Standard move right
        } else {
            nextIndex = -1;
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        nextIndex = currentIndex - 1;
        if (nextIndex >= 0) {
           // Standard move left
        } else {
            nextIndex = -1;
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentRowIndex !== -1 && currentRowIndex < rows.length - 1) {
            const currentRow = rows[currentRowIndex];
            const nextRow = rows[currentRowIndex + 1];
            
            // Calculate current item center X
            let currentX = 0;
            const indexInRow = currentIndex - startIndexInRow;
            for (let i=0; i<indexInRow; i++) {
                currentX += (currentRow.height * getItemAspectRatio(currentRow.items[i])) + GAP_SIZE;
            }
            const currentItemWidth = currentRow.height * getItemAspectRatio(currentRow.items[indexInRow]);
            const targetCenter = currentX + currentItemWidth / 2;
            
            const closestIndexInNextRow = findClosestItemInRow(targetCenter, nextRow.items, nextRow.height);
            
            // Calculate global index
            let nextRowStartIndex = startIndexInRow + currentRow.items.length;
            nextIndex = nextRowStartIndex + closestIndexInNextRow;
        } else {
            nextIndex = -1;
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentRowIndex > 0) {
            const currentRow = rows[currentRowIndex];
            const prevRow = rows[currentRowIndex - 1];
            
            // Calculate current item center X
            let currentX = 0;
            const indexInRow = currentIndex - startIndexInRow;
            for (let i=0; i<indexInRow; i++) {
                currentX += (currentRow.height * getItemAspectRatio(currentRow.items[i])) + GAP_SIZE;
            }
            const currentItemWidth = currentRow.height * getItemAspectRatio(currentRow.items[indexInRow]);
            const targetCenter = currentX + currentItemWidth / 2;
            
            const closestIndexInPrevRow = findClosestItemInRow(targetCenter, prevRow.items, prevRow.height);
            
            // Calculate global index of prev row start
            let prevRowStartIndex = 0;
            for(let i=0; i<currentRowIndex-1; i++) {
                prevRowStartIndex += rows[i].items.length;
            }
            nextIndex = prevRowStartIndex + closestIndexInPrevRow;
        } else {
             nextIndex = -1; 
        }
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextIndex = itemsToRender.length - 1;
      }

      if (nextIndex !== -1 && nextIndex !== currentIndex) {
          setFocusedImageIndex(nextIndex);
          const nextItem = itemsToRender[nextIndex];
          const imageToPreview = isImageStack(nextItem) ? nextItem.coverImage : nextItem;
          if (useImageStore.getState().previewImage) {
            setPreviewImage(imageToPreview);
          }
          if (!e.ctrlKey && !e.shiftKey) {
             const imageId = isImageStack(nextItem) ? nextItem.coverImage.id : (nextItem as IndexedImage).id;
             useImageStore.setState({ selectedImages: new Set([imageId]) });
          }

          // Scroll the newly focused image into view (keyboard nav only —
          // clicks never reach this handler, so grid position stays static
          // when opening an image with the mouse).
          if (gridRef.current) {
            let rowOffset = 0;
            let itemCount = 0;
            let targetRowHeight = 0;
            for (let i = 0; i < rows.length; i++) {
              if (nextIndex < itemCount + rows[i].items.length) {
                targetRowHeight = rows[i].height;
                break;
              }
              itemCount += rows[i].items.length;
              rowOffset += rows[i].height + 8;
            }
            const scrollTop = gridRef.current.scrollTop;
            const containerHeight = gridRef.current.clientHeight;
            if (rowOffset < scrollTop) {
              gridRef.current.scrollTo({ top: rowOffset, behavior: 'smooth' });
            } else if (rowOffset + targetRowHeight > scrollTop + containerHeight) {
              gridRef.current.scrollTo({
                top: rowOffset + targetRowHeight - containerHeight + 8,
                behavior: 'smooth',
              });
            }
          }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [focusedImageIndex, itemsToRender, setFocusedImageIndex, setPreviewImage, onImageClick, rows]);

  // Add global mouseup listener to handle selection end even outside the grid
  useEffect(() => {
    if (!isSelecting) return;

    const handleGlobalMouseUp = () => {
      setIsSelecting(false);
      setSelectionStart(null);
      setSelectionEnd(null);
    };

    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [isSelecting]);

  // Handle ctrl+wheel zoom
  useEffect(() => {
    const handleWheelZoom = (e: WheelEvent) => {
      // Must have Ctrl/Cmd key pressed
      if (!e.ctrlKey && !e.metaKey) return;
      
      // Check if mouse is over the grid container
      const isOverGrid = containerRef.current && (containerRef.current.contains(e.target as Node));
      if (!isOverGrid) return;

      // Intercept the event to prevent browser zoom and grid scrolling
      e.preventDefault();
      e.stopPropagation();
      
      // Step of 20px like the Zoom In button to make it feel responsive
      const delta = e.deltaY > 0 ? -20 : 20; 
      const currentSize = useSettingsStore.getState().viewZoomLevels.library;
      const newSize = Math.max(150, Math.min(500, currentSize + delta));
      
      if (newSize !== currentSize) {
        useSettingsStore.getState().setViewZoomLevel('library', newSize);
      }
    };

    // Use capture phase to ensure we intercept the event early
    window.addEventListener('wheel', handleWheelZoom, { passive: false, capture: true });
    return () => {
      window.removeEventListener('wheel', handleWheelZoom, { capture: true });
    };
  }, []); // Grid container ref is stable, listener will check its current value

  useEffect(() => {
    filterAndSortImages();
  }, [filterAndSortImages, sensitiveTags, blurSensitiveImages, enableSafeMode]);

  // Memoized callbacks - MUST be before early return
  const handleContextMenu = useCallback((image: IndexedImage, e: React.MouseEvent) => {
    const directoryPath = directories.find(d => d.id === image.directoryId)?.path;
    showContextMenu(e, image, directoryPath);
  }, [directories, showContextMenu]);

  // Memoized cardRef callback factory
  const registerCardRef = useCallback((imageId: string, el: HTMLDivElement | null) => {
    if (el) {
      imageCardsRef.current.set(imageId, el);
    } else {
      imageCardsRef.current.delete(imageId);
    }
  }, []);



 

  const contextMenuContent = contextMenu.visible && (
        <div
          className="fixed z-[60] bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px] context-menu-class"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={copyImage}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <Copy className="w-4 h-4" />
            Copy to Clipboard
          </button>

          <div className="border-t border-gray-600 my-1"></div>

          <button
            onClick={copyPrompt}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.prompt && !(contextMenu.image?.metadata as any)?.prompt}
          >
            <Copy className="w-4 h-4" />
            Copy Prompt
          </button>
          <button
            onClick={copyNegativePrompt}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.negativePrompt && !(contextMenu.image?.metadata as any)?.negativePrompt}
          >
            <Copy className="w-4 h-4" />
            Copy Negative Prompt
          </button>
          <button
            onClick={copySeed}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.seed && !(contextMenu.image?.metadata as any)?.seed}
          >
            <Copy className="w-4 h-4" />
            Copy Seed
          </button>
          <button
            onClick={copyModel}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.models?.[0] && !(contextMenu.image?.metadata as any)?.model}
          >
            <Copy className="w-4 h-4" />
            Copy Model
          </button>


          <div className="border-t border-gray-600 my-1"></div>

          <button
              onClick={copyRawMetadata}
              className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
              disabled={!contextMenu.image?.metadata}
            >
              <Copy className="w-4 h-4" />
              Copy Raw Metadata
            </button>

          <div className="border-t border-gray-600 my-1"></div>

          <button
            onClick={openWithNativeViewer}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Open in Native Viewer
          </button>

          <button
            onClick={showInFolder}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <Folder className="w-4 h-4" />
            Show in Folder
          </button>



        </div>
  );

  const modalsContent = (
    <></>
  );

  // Decision of what to render is already handled above to support navigation hooks


  // Handle drill-down

  const handleStackClick = React.useCallback((stack: ImageStack) => {
    // Guard: stack must have images to display.
    if (stack.images.length === 0) return;

    // Save current scroll position of the grid before entering the stack
    if (gridRef.current) {
      moduleMainLibraryScrollPosition = gridRef.current.scrollTop;
    }

    // Build ID-based stack context — filters by explicit image IDs instead of
    // polluting the search bar. This supports future manual image addition.
    // Use a fallback label when no prompt is available (e.g. manually merged
    // stacks of images without embedded prompt metadata).
    const prompt = stack.basePrompt
      || stack.coverImage.metadata?.normalizedMetadata?.prompt
      || stack.coverImage.metadata?.positive_prompt
      || 'Untitled stack';

    if (!stack.basePrompt && !stack.coverImage.metadata?.normalizedMetadata?.prompt && !stack.coverImage.metadata?.positive_prompt) {
      console.log('[Stack] Opening stack without prompt metadata — using fallback label:', stack.id);
    }

    const context: LibraryStackContext = {
      stackId: stack.id,
      imageIds: stack.images.map(img => img.id),
      basePrompt: prompt,
      // Pass sub-group info for prompt-grouped drill-down display
      subGroups: stack.subGroups?.map(sg => ({
        promptHash: sg.promptHash,
        prompt: sg.prompt,
        label: sg.label,
        groupKey: sg.groupKey,
        dimensions: sg.dimensions,
        imageIds: sg.imageIds,
      })),
    };
    setLibraryStackContext(context);
    setStackingEnabled(false); // Disable stacking when drilling down to see individual items
  }, [setLibraryStackContext, setStackingEnabled]);

  // Use itemsToRender for calculations
  const isEmpty = itemsToRender.length === 0;

  const getDragPayload = useCallback((targetImage: IndexedImage) => {
    const storeState = useImageStore.getState();
    const currentSelectedImages = storeState.selectedImages;
    const currentImages = storeState.images;

    // If the dragged image is part of the selection, drag all selected images
    if (currentSelectedImages.has(targetImage.id)) {
      // Find all selected images from the current images list
      const selectedItems = currentImages.filter(img => currentSelectedImages.has(img.id));
      
      // If we found them, map them to the payload
      if (selectedItems.length > 0) {
        return selectedItems.map(img => {
            const [, relativeFromId] = img.id.split('::');
            const relativePath = relativeFromId || img.name;
            // Best effort path reconstruction using directoryId
            const sourcePath = img.directoryId 
              ? `${img.directoryId}\\${relativePath}`.replace(/\\\\/g, '\\') 
              : img.id.includes('::') ? img.id.split('::')[1] : img.id;

            return {
              sourcePath,
              name: img.name
            };
        });
      }
    }
    
    // Fallback: if not selected or mapping failed, just drag the target image
    const [, relativeFromId] = targetImage.id.split('::');
    const relativePath = relativeFromId || targetImage.name;
    const sourcePath = targetImage.directoryId 
      ? `${targetImage.directoryId}\\${relativePath}`.replace(/\\\\/g, '\\') 
      : targetImage.id.includes('::') ? targetImage.id.split('::')[1] : targetImage.id;

    return [{
       sourcePath,
       name: targetImage.name
    }];
  }, []); // Removed `selectedImages` and `images` dependencies to preserve React.memo

  // Dummy handler for image loading since aspect ratio tracking was removed but prop is required
  const handleImageLoad = useCallback((id: string, aspectRatio: number) => {
    // No-op
  }, []);

  // Stable itemSize reference so react-window doesn't recalculate layout on every render
  const itemSize = useCallback((index: number) => {
    return rows[index] ? rows[index].height + 8 : 0;
  }, [rows]);

  // Ensure all hooks are called consistently before any conditional returns
  const itemData = useMemo<ImageGridRowData>(() => ({
    rows,
    enableSafeMode,
    sensitiveTagSet,
    blurSensitiveImages,
    selectedImages,
    semanticHitIds,
    focusedItemId,

    onImageClick,
    handleStackClick,
    handleImageLoad,
    handleContextMenu,
    registerCardRef,
    getDragPayload
  }), [
    rows,
    enableSafeMode,
    sensitiveTagSet,
    blurSensitiveImages,
    selectedImages,
    semanticHitIds,
    focusedItemId,

    onImageClick,
    handleStackClick,
    handleImageLoad,
    handleContextMenu,
    registerCardRef,
    getDragPayload
  ]);

  return (
    <div 
        ref={containerRef}
        className="flex flex-col bg-gray-900 overflow-hidden relative pt-3" 
        style={{ width, height, userSelect: isSelecting ? 'none' : 'auto' }}
        data-area="main-content"
        onClick={() => gridRef.current?.focus()}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
    >
      <GridErrorBoundary>
        {isEmpty ? (
          <div className="flex-1 flex items-center justify-center h-full w-full text-gray-500">
            No images found
          </div>
        ) : (
          <List
            ref={listRef}
            outerRef={gridRef as any}
            className="flex-1 outline-none overflow-y-auto overflow-x-hidden scrollbar-adaptive"
            style={{ minWidth: 0, minHeight: 0 }}
            width={width}
            height={height}
            itemCount={rows.length}
            itemSize={itemSize}
            overscanCount={10}
            onScroll={({ scrollOffset }) => {
              handleScroll({ currentTarget: { scrollTop: scrollOffset } } as any);
            }}
            itemData={itemData}
          >
            {ImageGridRowComponent}
          </List>
        )}
      </GridErrorBoundary>

        {/* Selection box visual */}
        {isSelecting && selectionStart && selectionEnd && (
          <div
            className="absolute pointer-events-none z-30"
            style={{
              left: `${Math.min(selectionStart.x, selectionEnd.x)}px`,
              top: `${Math.min(selectionStart.y, selectionEnd.y)}px`,
              width: `${Math.abs(selectionEnd.x - selectionStart.x)}px`,
              height: `${Math.abs(selectionEnd.y - selectionStart.y)}px`,
              border: '2px solid rgba(59, 130, 246, 0.8)',
              backgroundColor: 'rgba(59, 130, 246, 0.1)',
            }}
          />
        )}

        {contextMenuContent}
        {modalsContent}
    </div>
  );
}); // End of ImageGrid component (React.memo)




const ImageGridWrapper: React.FC<ImageGridProps> = (props) => {
  return (
    <div className="h-full w-full" data-area="main-content-wrapper">
      <AutoSizer>
        {({ width, height }) => (
          <ImageGrid width={width} height={height} {...props} />
        )}
      </AutoSizer>
    </div>
  );
};

export default ImageGridWrapper;

