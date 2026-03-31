import { VariableSizeList as List, ListChildComponentProps, areEqual } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { computeJustifiedLayout, getItemAspectRatio, type LayoutRow } from '../utils/layoutAlgo';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { type IndexedImage, type BaseMetadata, ImageStack } from '../types';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useContextMenu } from '../hooks/useContextMenu';
import { Info, Copy, Folder, Download, Clipboard, Sparkles, Star, Square,  AlertCircle,
  Archive,
  Check,
  CheckSquare,
  Crown,
  EyeOff,
  Package,
  Play
} from 'lucide-react';
import { useThumbnail } from '../hooks/useThumbnail';
import Toast from './Toast';
import { useFeatureAccess } from '../hooks/useFeatureAccess';
import ProBadge from './ProBadge';
import { useImageStacking } from '../hooks/useImageStacking';
import { Layers, Layers2 } from 'lucide-react';

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
  isMarkedBest?: boolean;       // For deduplication: marked as best to keep
  isMarkedArchived?: boolean;   // For deduplication: marked for archive
  isBlurred?: boolean;
  getDragPayload?: (image: IndexedImage) => { sourcePath: string; name: string }[];
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

const ImageCard: React.FC<ImageCardProps> = React.memo(({ image, onImageClick, isSelected, isFocused, onImageLoad, onContextMenu, baseWidth, registerCardRef, isMarkedBest, isMarkedArchived, isBlurred, getDragPayload }) => {
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
  const showFilenames = useSettingsStore((state) => state.showFilenames);
  const showFullFilePath = useSettingsStore((state) => state.showFullFilePath);
  const doubleClickToOpen = useSettingsStore((state) => state.doubleClickToOpen);
  const [showToast, setShowToast] = useState(false);
  const toggleImageSelection = useImageStore((state) => state.toggleImageSelection);
  const setDraggedItems = useImageStore((state) => state.setDraggedItems);
  const clearDraggedItems = useImageStore((state) => state.clearDraggedItems);
  const canDragExternally = typeof window !== 'undefined' && !!window.electronAPI?.startFileDrag;
  const isVideo = isVideoFileName(image.name, image.fileType);

  // Extract filename to display based on showFullFilePath setting
  const displayName = showFullFilePath
    ? image.name || 'Unknown'
    : (image.name || '').split(/[/\\]/).pop() || 'Unknown';

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
    if (!getCachedFallbackUrl(image.id)) {
      // Debounce heavy fallback fetch; if thumbnail becomes ready meanwhile, this effect will rerun and cancel
      fallbackTimer = setTimeout(() => {
        void loadFallback();
      }, 180);
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

  const handleCopyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (image.prompt) {
      navigator.clipboard.writeText(image.prompt);
      setShowToast(true);
    }
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

  return (
    <div className="flex flex-col items-center h-full" style={{ width: `${baseWidth}px` }}>
      {showToast && <Toast message="Prompt copied to clipboard!" onDismiss={() => setShowToast(false)} />}
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
        onClick={(e) => {
          if (doubleClickToOpen) {
            if (e.ctrlKey || e.metaKey) {
              toggleImageSelection(image.id);
            } else {
              useImageStore.setState({
                selectedImages: new Set([image.id]),
                previewImage: image
              });
            }
          } else {
            onImageClick(image, e);
          }
        }}
        onDoubleClick={(e) => {
          if (doubleClickToOpen) {
            onImageClick(image, e);
          }
        }}

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

        {/* Deduplication: Best badge */}
        {isMarkedBest && (
          <div className="absolute top-2 left-11 z-20 px-2 py-1 bg-yellow-500/90 rounded-lg text-white text-xs font-bold shadow-lg flex items-center gap-1">
            <Crown className="h-3.5 w-3.5" />
            Best
          </div>
        )}

        {/* Deduplication: Archived badge */}
        {isMarkedArchived && (
          <div className="absolute top-2 left-11 z-20 px-2 py-1 bg-gray-600/90 rounded-lg text-white text-xs font-bold shadow-lg flex items-center gap-1">
            <Archive className="h-3.5 w-3.5" />
            Archive
          </div>
        )}


        <button
          onClick={handlePreviewClick}
          className="absolute top-11 left-2 z-10 p-1.5 bg-black/50 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:opacity-100"
          title="Show details"
        >
          <Info className="h-4 w-4" />
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
        <button
          onClick={handleCopyClick}
          className="absolute top-2 right-11 z-10 p-1.5 bg-black/50 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-green-500 focus:outline-none focus:ring-2 focus:ring-green-500 focus:opacity-100"
          title="Copy Prompt"
          disabled={!image.prompt}
        >
          <Copy className="h-4 w-4" />
        </button>

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
        {/* Tags display - always visible if tags exist */}
        {image.tags && image.tags.length > 0 && (
          <div className="absolute bottom-0 left-0 right-0 p-1.5 bg-gradient-to-t from-black/90 to-transparent">
            <div className="flex flex-wrap gap-1 items-center">
              {image.tags.slice(0, 2).map(tag => (
                <span
                  key={tag}
                  className="text-[10px] bg-gray-700/80 text-gray-300 px-1.5 py-0.5 rounded"
                >
                  #{tag}
                </span>
              ))}
              {image.tags.length > 2 && (
                <span className="text-[10px] text-gray-400">
                  +{image.tags.length - 2}
                </span>
              )}
            </div>
          </div>
        )}

        {!showFilenames && (
          <div className={`absolute left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 ${
            image.tags && image.tags.length > 0 ? 'bottom-8' : 'bottom-0'
          }`}>
            <p className="text-white text-xs truncate">{displayName}</p>
          </div>
        )}
      </div>
      {showFilenames && (
        <div className="mt-2 w-full px-1">
          <p className="text-[11px] text-gray-400 text-center truncate">{displayName}</p>
        </div>
      )}
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
  focusedItemId: string | null;
  markedBestIds?: Set<string>;
  markedArchivedIds?: Set<string>;

  onImageClick: (image: IndexedImage, event: React.MouseEvent) => void;
  handleStackClick: (stack: ImageStack) => void;
  handleImageLoad: (id: string, aspectRatio: number) => void;
  handleContextMenu: (image: IndexedImage, event: React.MouseEvent) => void;
  registerCardRef: (id: string, el: HTMLDivElement | null) => void;
  getDragPayload: (image: IndexedImage) => { sourcePath: string; name: string }[];
}

const ImageGridRowComponent = React.memo(({ index, style, data }: ListChildComponentProps<ImageGridRowData>) => {
  const { rows, enableSafeMode, sensitiveTagSet, blurSensitiveImages, selectedImages, focusedItemId, markedBestIds, markedArchivedIds, onImageClick, handleStackClick, handleImageLoad, handleContextMenu, registerCardRef, getDragPayload } = data;
  const row = rows[index];
  if (!row) return null;
  
  return (
    <div style={{ ...style, padding: '0 8px 0 0', top: (style.top as number) + 8 }}>
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
                          onClick={() => handleStackClick(item)}
                      >
                          {/* ... stack layers ... */}
                          <div className="absolute top-[-4px] left-[4px] right-[-4px] bottom-[4px] bg-gray-700 rounded-lg border border-gray-600 shadow-sm z-0"></div>
                          <div className="absolute top-[-8px] left-[8px] right-[-8px] bottom-[8px] bg-gray-800 rounded-lg border border-gray-700 shadow-sm z-[-1]"></div>
                          <div className="relative z-10 w-full h-full">
                              <ImageCard
                                  image={item.coverImage}
                                  onImageClick={(img, e) => { e.stopPropagation(); handleStackClick(item); }}
                                  isSelected={selectedImages.has(item.coverImage.id)}
                                  isFocused={focusedItemId === item.coverImage.id}
                                  onImageLoad={handleImageLoad}
                                  onContextMenu={handleContextMenu}
                                  baseWidth={itemWidth}

                                  registerCardRef={registerCardRef}
                                  isMarkedBest={markedBestIds?.has(item.coverImage.id)}
                                  isMarkedArchived={markedArchivedIds?.has(item.coverImage.id)}
                                  isBlurred={isSensitive && enableSafeMode && blurSensitiveImages}
                                  getDragPayload={getDragPayload}
                              />
                              <div className="absolute top-2 right-2 bg-black/60 text-white text-[11px] font-medium px-2 py-0.5 rounded-md backdrop-blur-md z-20 border border-white/10 shadow-sm">+{item.count}</div>
                              <div className="absolute bottom-2 left-2 bg-black/60 text-white text-[10px] font-mono px-1.5 py-0.5 rounded backdrop-blur-sm z-20 pointer-events-none">Stack</div>
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

                          registerCardRef={registerCardRef}
                          isMarkedBest={markedBestIds?.has(image.id)}
                          isMarkedArchived={markedArchivedIds?.has(image.id)}
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
  onBatchExport: () => void;
  // Deduplication support (optional)
  markedBestIds?: Set<string>;      // IDs of images marked as best
  markedArchivedIds?: Set<string>;  // IDs of images marked for archive
}

const ImageGrid: React.FC<ImageGridProps & { width: number; height: number }> = ({ width, height, images, onImageClick, selectedImages, onBatchExport, markedBestIds, markedArchivedIds }) => {
  const imageSize = useSettingsStore((state) => state.imageSize);
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
  const isStackingEnabled = useImageStore((state) => state.isStackingEnabled);
  const setStackingEnabled = useImageStore((state) => state.setStackingEnabled);
  const setViewingStackPrompt = useImageStore((state) => state.setViewingStackPrompt);
  const setSearchQuery = useImageStore((state) => state.setSearchQuery);
  const { stackedItems } = useImageStacking(images, isStackingEnabled);
  const gridRef = useRef<HTMLDivElement>(null);
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
  const prevFocusedImageIndexRef = useRef<number>(focusedImageIndex);

  // Layout logic
  const itemsToRender: (IndexedImage | ImageStack)[] = isStackingEnabled ? stackedItems : images;
  const focusedItemId = itemsToRender[focusedImageIndex] ? (isImageStack(itemsToRender[focusedImageIndex]) ? (itemsToRender[focusedImageIndex] as ImageStack).coverImage.id : (itemsToRender[focusedImageIndex] as IndexedImage).id) : null;
  
  const rows = useMemo(() => {
      // Account for padding (p-2 = 16px) and scrollbar (approx 17px) to avoid horizontal scroll
      const safeWidth = width || 0;
      const availableWidth = Math.max(1, safeWidth - 24); 
      return computeJustifiedLayout(itemsToRender, availableWidth, imageSize);
  }, [itemsToRender, width, imageSize]);

  const prevRowsRef = useRef<LayoutRow[]>([]);
  // Update rowsRef for the scroll handler and reset cache smartly
  useEffect(() => {
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

    // Only reset cache if an EXISTING row changed size. Appended rows don't need cache resets.
    if (listRef.current && firstChangedIndex < prevRows.length) {
      listRef.current.resetAfterIndex(firstChangedIndex, false);
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
          const newScrollTop = foundY + (resizeAnchorRef.current.offsetRatio * foundRowHeight);
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

  // Prevent object URL memory leaks when changing folders
  useEffect(() => {
    import('../services/thumbnailManager').then(m => m.thumbnailManager.clearAllUrls());
    useImageStore.getState().clearAllThumbnails();
  }, [scrollKey]);


  const toggleImageSelection = useImageStore((state) => state.toggleImageSelection);

  // Drag-to-select states
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const [initialSelectedImages, setInitialSelectedImages] = useState<Set<string>>(new Set());
  const { canUseA1111, canUseComfyUI, canUseBatchExport, initialized, canUseDuringTrialOrPro } = useFeatureAccess();
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
    exportImage,
    copyRawMetadata
  } = useContextMenu();


  const handleBatchExport = useCallback(() => {
    hideContextMenu();
    onBatchExport();
  }, [hideContextMenu, onBatchExport]);

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
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [focusedImageIndex, itemsToRender, setFocusedImageIndex, setPreviewImage, onImageClick, rows]);

  // Auto-scroll to focused image
  useEffect(() => {
    if (focusedImageIndex !== null && focusedImageIndex !== -1 && gridRef.current) {
        // Only scroll if the focused image index actually changed
        if (prevFocusedImageIndexRef.current === focusedImageIndex) {
            return;
        }
        prevFocusedImageIndexRef.current = focusedImageIndex;

        // Find row index and offset
        let count = 0;
        let targetRowIndex = 0;
        let offset = 0;
        for (let i = 0; i < rows.length; i++) {
              if (focusedImageIndex < count + rows[i].items.length) {
                  targetRowIndex = i;
                  break;
              }
              count += rows[i].items.length;
              offset += rows[i].height + 8; // row height + margin
        }
        
        const rowHeight = rows[targetRowIndex]?.height || 0;
        const containerHeight = gridRef.current.clientHeight;
        const scrollTop = gridRef.current.scrollTop;

        // Smart scroll logic
        if (offset < scrollTop) {
            gridRef.current.scrollTo({ top: offset, behavior: 'smooth' });
        } else if (offset + rowHeight > scrollTop + containerHeight) {
             gridRef.current.scrollTo({ top: offset + rowHeight - containerHeight + 8, behavior: 'smooth' });
        }

    } else if (focusedImageIndex === -1) {
        // Reset ref if focus is lost/reset so next focus triggers scroll
        prevFocusedImageIndexRef.current = -1;
    }
  }, [focusedImageIndex, rows]);

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
            onClick={showInFolder}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <Folder className="w-4 h-4" />
            Show in Folder
          </button>

            <button
              onClick={exportImage}
              className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Export Image
            </button>

            {selectedCount > 1 && (
              <button
                onClick={handleBatchExport}
                className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
                title={!canUseBatchExport && initialized ? 'Pro feature - start trial' : undefined}
              >
                <Package className="w-4 h-4" />
                <span className="flex-1">Batch Export Selected ({selectedCount})</span>
                {!canUseDuringTrialOrPro && <ProBadge size="sm" />}
              </button>
            )}

        </div>
  );

  const modalsContent = (
    <></>
  );

  // Decision of what to render is already handled above to support navigation hooks


  // Handle drill-down

  const handleStackClick = React.useCallback((stack: ImageStack) => {
    // Set search query to the prompt of the stack
    const prompt = stack.coverImage.metadata?.normalizedMetadata?.prompt || stack.coverImage.metadata?.positive_prompt;
    if (prompt) {
        setSearchQuery(prompt);
        setStackingEnabled(false); // Disable stacking when drilling down to see individual items
        setViewingStackPrompt(prompt); // Enable "Back to Stacks" mode
    }
  }, [setStackingEnabled, setViewingStackPrompt]);

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

  // Ensure all hooks are called consistently before any conditional returns
  const itemData = useMemo<ImageGridRowData>(() => ({
    rows,
    enableSafeMode,
    sensitiveTagSet,
    blurSensitiveImages,
    selectedImages,
    focusedItemId,
    markedBestIds,
    markedArchivedIds,

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
    focusedItemId,
    markedBestIds,
    markedArchivedIds,

    onImageClick,
    handleStackClick,
    handleImageLoad,
    handleContextMenu,
    registerCardRef,
    getDragPayload
  ]);

  return (
    <div 
        className="flex flex-col bg-gray-900 overflow-hidden relative" 
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
            itemSize={index => rows[index] ? rows[index].height + 8 : 0}
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
}; // End of ImageGrid component




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

