import React, { useState, useEffect, useCallback } from 'react';
import { FixedSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { type IndexedImage } from '../types';
import { getAspectRatio } from '../utils/imageUtils';
import { useContextMenu } from '../hooks/useContextMenu';
import { useImageStore } from '../store/useImageStore';
import { Copy, ExternalLink, Folder, ArrowUpDown, ArrowUp, ArrowDown, Info, Package, Play, Sparkles } from 'lucide-react';
import { useThumbnail } from '../hooks/useThumbnail';
import { useSettingsStore } from '../store/useSettingsStore';

interface ImageTableProps {
  images: IndexedImage[];
  onImageClick: (image: IndexedImage, event: React.MouseEvent) => void;
  selectedImages: Set<string>;
  semanticHitIds?: Set<string>;
}

type SortField = 'filename' | 'model' | 'steps' | 'cfg' | 'size' | 'megapixel' | 'aspect' | 'seed' | 'filesize';
type SortDirection = 'asc' | 'desc' | null;

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];

const formatFileSize = (bytes?: number): string => {
  if (bytes == null || isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
};

const isVideoFileName = (fileName: string, fileType?: string | null): boolean => {
  if (fileType && fileType.startsWith('video/')) {
    return true;
  }
  const lower = fileName.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const ImageTable: React.FC<ImageTableProps> = ({ images, onImageClick, selectedImages, semanticHitIds }) => {
  const directories = useImageStore((state) => state.directories);
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [sortedImages, setSortedImages] = useState<IndexedImage[]>(images);

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

  const selectedCount = selectedImages.size;

  const handleContextMenu = (image: IndexedImage, e: React.MouseEvent) => {
    const directoryPath = directories.find(d => d.id === image.directoryId)?.path;
    showContextMenu(e, image, directoryPath);
  };



  // Function to apply sorting based on current field and direction
  // Memoized for performance - avoids recreating sort function on every render
  const applySorting = useCallback((imagesToSort: IndexedImage[], field: SortField | null, direction: SortDirection) => {
    if (!field || !direction) {
      return imagesToSort;
    }

    return [...imagesToSort].sort((a, b) => {
      let aValue: string | number;
      let bValue: string | number;

      switch (field) {
        case 'filename':
          aValue = a.handle.name.toLowerCase();
          bValue = b.handle.name.toLowerCase();
          break;
        case 'model':
          aValue = (a.models?.[0] || '').toLowerCase();
          bValue = (b.models?.[0] || '').toLowerCase();
          break;
        case 'steps': {
          const aSteps = a.steps || (a.metadata as any)?.steps || (a.metadata as any)?.normalizedMetadata?.steps || 0;
          const bSteps = b.steps || (b.metadata as any)?.steps || (b.metadata as any)?.normalizedMetadata?.steps || 0;
          aValue = aSteps;
          bValue = bSteps;
          break;
        }
        case 'cfg': {
          const aCfg = a.cfgScale || (a.metadata as any)?.cfg_scale || (a.metadata as any)?.cfgScale || (a.metadata as any)?.normalizedMetadata?.cfg_scale || 0;
          const bCfg = b.cfgScale || (b.metadata as any)?.cfg_scale || (b.metadata as any)?.cfgScale || (b.metadata as any)?.normalizedMetadata?.cfg_scale || 0;
          aValue = aCfg;
          bValue = bCfg;
          break;
        }
        case 'size': {
          const aDims = a.dimensions || (a.metadata as any)?.dimensions || '0x0';
          const bDims = b.dimensions || (b.metadata as any)?.dimensions || '0x0';
          const [aW, aH] = aDims.split('×').map(Number);
          const [bW, bH] = bDims.split('×').map(Number);
          aValue = aW * aH;
          bValue = bW * bH;
          break;
        }
        case 'megapixel': {
          const aDims = a.dimensions || (a.metadata as any)?.dimensions || '0x0';
          const bDims = b.dimensions || (b.metadata as any)?.dimensions || '0x0';
          const [aW, aH] = aDims.split('×').map(Number);
          const [bW, bH] = bDims.split('×').map(Number);
          aValue = aW * aH;
          bValue = bW * bH;
          break;
        }
        case 'aspect': {
          const aDims = a.dimensions || (a.metadata as any)?.dimensions || '0×0';
          const bDims = b.dimensions || (b.metadata as any)?.dimensions || '0×0';
          const [aW, aH] = aDims.split('×').map(Number);
          const [bW, bH] = bDims.split('×').map(Number);
          const aRatio = aW && aH ? aW / aH : 0;
          const bRatio = bW && bH ? bW / bH : 0;
          aValue = aRatio;
          bValue = bRatio;
          break;
        }
        case 'filesize':
          aValue = a.fileSize || 0;
          bValue = b.fileSize || 0;
          break;
        case 'seed': {
          const aSeed = a.seed || (a.metadata as any)?.seed || (a.metadata as any)?.normalizedMetadata?.seed || 0;
          const bSeed = b.seed || (b.metadata as any)?.seed || (b.metadata as any)?.normalizedMetadata?.seed || 0;
          aValue = aSeed;
          bValue = bSeed;
          break;
        }
        default:
          return 0;
      }

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return direction === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
      } else {
        return direction === 'asc' ? (aValue as number) - (bValue as number) : (bValue as number) - (aValue as number);
      }
    });
  }, []); // No dependencies - pure function

  const handleSort = (field: SortField) => {
    let newDirection: SortDirection = 'asc';
    
    if (sortField === field) {
      if (sortDirection === 'asc') {
        newDirection = 'desc';
      } else if (sortDirection === 'desc') {
        newDirection = null;
        setSortField(null);
        setSortDirection(null);
        return;
      }
    }
    
    setSortField(field);
    setSortDirection(newDirection);
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-3 h-3 opacity-40" />;
    }
    if (sortDirection === 'asc') {
      return <ArrowUp className="w-3 h-3" />;
    }
    return <ArrowDown className="w-3 h-3" />;
  };

  // Update sorted images when images prop changes OR when sort settings change
  useEffect(() => {
    const sorted = applySorting(images, sortField, sortDirection);
    setSortedImages(sorted);
  }, [images, sortField, sortDirection, applySorting]);

  // Column resize state
  const DEFAULT_COLUMN_WIDTHS = [96, 280, 220, 110, 110, 100, 80, 70, 100, 160];
  const MIN_COLUMN_WIDTH = 50;

  const [columnWidths, setColumnWidths] = useState<number[]>(DEFAULT_COLUMN_WIDTHS);
  const [resizing, setResizing] = useState<{ index: number; startX: number; startWidth: number } | null>(null);

  const handleResizeStart = useCallback((index: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing({ index, startX: e.clientX, startWidth: columnWidths[index] });
  }, [columnWidths]);

  const handleResizeDoubleClick = useCallback((index: number) => {
    setColumnWidths(prev => {
      const next = [...prev];
      next[index] = DEFAULT_COLUMN_WIDTHS[index];
      return next;
    });
  }, []);

  useEffect(() => {
    if (!resizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizing.startX;
      const newWidth = Math.max(MIN_COLUMN_WIDTH, resizing.startWidth + delta);
      setColumnWidths(prev => {
        const next = [...prev];
        next[resizing.index] = newWidth;
        return next;
      });
    };

    const handleMouseUp = () => {
      setResizing(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing]);

  const gridTemplateColumns = columnWidths.map(w => `${w}px`).join(' ');
  const totalWidth = columnWidths.reduce((sum, w) => sum + w, 0);

  // Row renderer for virtualized list
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const image = sortedImages[index];
    return (
      <div style={style}>
        <ImageTableRow
          image={image}
          onImageClick={onImageClick}
          isSelected={selectedImages.has(image.id)}
          isSemanticMatch={semanticHitIds?.has(image.id)}
          onContextMenu={handleContextMenu}
          gridTemplateColumns={gridTemplateColumns}
        />
      </div>
    );
  };

  const ROW_HEIGHT = 64; // Height of each table row in pixels
  const HEADER_HEIGHT = 48; // Height of table header

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="overflow-x-auto">
        <div style={{ minWidth: totalWidth }}>
          {/* Fixed Header */}
          <div className="bg-gray-800 border-b border-gray-700" style={{ height: HEADER_HEIGHT }}>
            <div className="grid text-sm" style={{ gridTemplateColumns }}>
              <div className="relative px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider select-none">
                Preview
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(0, e)}
                  onDoubleClick={() => handleResizeDoubleClick(0)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 0 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('filename')}
                >
                  <span className="flex items-center gap-1">Filename {getSortIcon('filename')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(1, e)}
                  onDoubleClick={() => handleResizeDoubleClick(1)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 1 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('model')}
                >
                  <span className="flex items-center gap-1">Model {getSortIcon('model')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(2, e)}
                  onDoubleClick={() => handleResizeDoubleClick(2)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 2 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('steps')}
                >
                  <span className="flex items-center gap-1">Steps {getSortIcon('steps')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(3, e)}
                  onDoubleClick={() => handleResizeDoubleClick(3)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 3 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('cfg')}
                >
                  <span className="flex items-center gap-1">CFG {getSortIcon('cfg')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(4, e)}
                  onDoubleClick={() => handleResizeDoubleClick(4)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 4 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('size')}
                >
                  <span className="flex items-center gap-1">Resolution {getSortIcon('size')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(5, e)}
                  onDoubleClick={() => handleResizeDoubleClick(5)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 5 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('megapixel')}
                >
                  <span className="flex items-center gap-1">MP {getSortIcon('megapixel')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(6, e)}
                  onDoubleClick={() => handleResizeDoubleClick(6)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 6 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('aspect')}
                >
                  <span className="flex items-center gap-1">Aspect {getSortIcon('aspect')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(7, e)}
                  onDoubleClick={() => handleResizeDoubleClick(7)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 7 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('filesize')}
                >
                  <span className="flex items-center gap-1">File Size {getSortIcon('filesize')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(8, e)}
                  onDoubleClick={() => handleResizeDoubleClick(8)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 8 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <button
                className="px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                onClick={() => handleSort('seed')}
              >
                <span className="flex items-center gap-1">Seed {getSortIcon('seed')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Virtualized Content */}
      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-x-auto">
          <div style={{ minWidth: totalWidth }} className="h-full">
            <AutoSizer>
              {({ height, width }: { height: number; width: number }) => (
                <List
                  height={height}
                  itemCount={sortedImages.length}
                  itemSize={ROW_HEIGHT}
                  width={width}
                  overscanCount={5}
                  itemKey={(index) => sortedImages[index]?.id ?? index}
                >
                  {Row}
                </List>
              )}
            </AutoSizer>
          </div>
        </div>
      </div>

      {contextMenu.visible && (
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
            disabled={!contextMenu.image?.prompt}
          >
            <Copy className="w-4 h-4" />
            Copy Prompt
          </button>
          <button
            onClick={copyNegativePrompt}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.negativePrompt}
          >
            <Copy className="w-4 h-4" />
            Copy Negative Prompt
          </button>
          <button
            onClick={copySeed}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.seed}
          >
            <Copy className="w-4 h-4" />
            Copy Seed
          </button>
          <button
            onClick={copyModel}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.models?.[0]}
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
        )}
    </div>
  );
};

// Componente separado para cada linha da tabela com preview
interface ImageTableRowProps {
  image: IndexedImage;
  onImageClick: (image: IndexedImage, event: React.MouseEvent) => void;
  isSelected: boolean;
  isSemanticMatch?: boolean;
  onContextMenu?: (image: IndexedImage, event: React.MouseEvent) => void;
  gridTemplateColumns: string;
}

const ImageTableRow: React.FC<ImageTableRowProps> = React.memo(({ image, onImageClick, isSelected, isSemanticMatch, onContextMenu, gridTemplateColumns }) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const setPreviewImage = useImageStore((state) => state.setPreviewImage);
  const thumbnailsDisabled = useSettingsStore((state) => state.disableThumbnails);
  const isVideo = isVideoFileName(image.name, image.fileType);

  useThumbnail(image);

  useEffect(() => {
    if (thumbnailsDisabled) {
      setImageUrl(null);
      setIsLoading(false);
      return;
    }

    if (image.thumbnailStatus === 'ready' && image.thumbnailUrl) {
      setImageUrl(image.thumbnailUrl);
      setIsLoading(false);
      return;
    }

    if (isVideo) {
      setImageUrl(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    let fallbackUrl: string | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const fileHandle = image.thumbnailHandle || image.handle;
    const isElectron = typeof window !== 'undefined' && window.electronAPI;

    if (!fileHandle || typeof fileHandle.getFile !== 'function') {
      setIsLoading(false);
      return;
    }

    const loadFallback = async () => {
      setIsLoading(true);
      try {
        const file = await fileHandle.getFile();
        if (!isMounted) return;
        fallbackUrl = URL.createObjectURL(file);
        setImageUrl(fallbackUrl);
      } catch (error) {
        if (isElectron) {
          console.error('Failed to load image:', error);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    fallbackTimer = setTimeout(() => {
      void loadFallback();
    }, 180);

    return () => {
      isMounted = false;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
      if (fallbackUrl) {
        URL.revokeObjectURL(fallbackUrl);
      }
    };
  }, [image.thumbnailHandle, image.handle, image.thumbnailStatus, image.thumbnailUrl, thumbnailsDisabled, isVideo]);

  const handlePreviewClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewImage(image);
  };

  return (
    <div
      className={`border-b border-gray-700 hover:bg-gray-800/50 cursor-pointer transition-colors group grid items-center ${
        isSelected ? 'bg-blue-900/30 border-blue-700' : ''
      }`}
      onClick={(e) => onImageClick(image, e)}
      onContextMenu={(e) => onContextMenu && onContextMenu(image, e)}
      style={{ height: '64px', gridTemplateColumns }}
    >
      <div className="px-3 py-2">
        <div className="relative w-12 h-12 bg-gray-700 rounded overflow-hidden flex items-center justify-center">
          {isLoading ? (
            <div className="w-4 h-4 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"></div>
          ) : imageUrl ? (
            <>
              <img
                src={imageUrl}
                alt={image.handle.name}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              {isVideo && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="rounded-full bg-black/50 p-1.5">
                    <Play className="h-4 w-4 text-white/90" />
                  </div>
                </div>
              )}
              <button
                onClick={handlePreviewClick}
                className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-blue-500/70"
                title="Show details"
              >
                <Info className="h-4 w-4 text-white" />
              </button>
              {isSemanticMatch && (
                // Semantic hit badge — corner sparkle, never blocks clicks.
                <div
                  className="absolute top-0.5 right-0.5 z-10 p-0.5 rounded-full bg-purple-500/10 text-purple-400 pointer-events-none"
                  title="Semantic match"
                >
                  <Sparkles className="h-3 w-3" />
                </div>
              )}
            </>
          ) : (
            <span className="text-xs text-gray-500">ERR</span>
          )}
        </div>
      </div>
      <div className="px-3 py-2 text-gray-300 font-medium truncate" title={image.handle.name}>
        {image.handle.name}
      </div>
      <div className="px-3 py-2 text-gray-400 truncate" title={image.models?.[0] || 'Unknown'}>
        {image.models?.[0] || <span className="text-gray-600">Unknown</span>}
      </div>
      <div className="px-3 py-2 text-center">
        {(() => {
          const steps = image.steps || (image.metadata as any)?.steps || (image.metadata as any)?.normalizedMetadata?.steps;
          return steps ? (
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
              steps < 20 ? 'bg-green-900/40 text-green-300' :
              steps < 35 ? 'bg-blue-900/40 text-blue-300' :
              'bg-orange-900/40 text-orange-300'
            }`}>
              {steps}
            </span>
          ) : (
            <span className="text-gray-600 text-xs">—</span>
          );
        })()}
      </div>
      <div className="px-3 py-2 text-center text-gray-400">
        {(() => {
          const cfg = image.cfgScale || (image.metadata as any)?.cfg_scale || (image.metadata as any)?.cfgScale || (image.metadata as any)?.normalizedMetadata?.cfg_scale;
          return cfg ? (
            <span className="font-mono text-sm">{typeof cfg === 'number' ? cfg.toFixed(1) : cfg}</span>
          ) : (
            <span className="text-gray-600 text-xs">—</span>
          );
        })()}
      </div>
      <div className="px-3 py-2 text-gray-400 font-mono text-xs">
        {(() => {
          const width = (image.metadata as any)?.width || (image.metadata as any)?.normalizedMetadata?.width;
          const height = (image.metadata as any)?.height || (image.metadata as any)?.normalizedMetadata?.height;
          const dims = image.dimensions ||
                      (image.metadata as any)?.dimensions ||
                      (width && height ? `${width}×${height}` : null);
          if (!dims) return <span className="text-gray-600">—</span>;
          return <span>{dims}</span>;
        })()}
      </div>
      <div className="px-3 py-2 text-gray-400 font-mono text-xs">
        {(() => {
          const width = (image.metadata as any)?.width || (image.metadata as any)?.normalizedMetadata?.width;
          const height = (image.metadata as any)?.height || (image.metadata as any)?.normalizedMetadata?.height;
          if (!width || !height) return <span className="text-gray-600">—</span>;
          const mp = (width * height) / 1_000_000;
          return <span>{mp >= 10 ? mp.toFixed(0) : mp.toFixed(1)} MP</span>;
        })()}
      </div>
      <div className="px-3 py-2 text-gray-400 font-mono text-xs">
        {(() => {
          const width = (image.metadata as any)?.width || (image.metadata as any)?.normalizedMetadata?.width;
          const height = (image.metadata as any)?.height || (image.metadata as any)?.normalizedMetadata?.height;
          const ratio = getAspectRatio(width, height);
          return ratio ? <span>{ratio}</span> : <span className="text-gray-600">—</span>;
        })()}
      </div>
      <div className="px-3 py-2 text-gray-400 font-mono text-xs">
        {formatFileSize(image.fileSize)}
      </div>
      <div className="px-3 py-2 text-gray-500 font-mono text-xs truncate" title={(image.seed || (image.metadata as any)?.seed || (image.metadata as any)?.normalizedMetadata?.seed)?.toString()}>
        {(() => {
          const seed = image.seed || (image.metadata as any)?.seed || (image.metadata as any)?.normalizedMetadata?.seed;
          return seed || <span className="text-gray-600">—</span>;
        })()}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison for performance - only re-render if critical props changed
  return (
    prevProps.image.id === nextProps.image.id &&
    prevProps.image.thumbnailUrl === nextProps.image.thumbnailUrl &&
    prevProps.image.thumbnailStatus === nextProps.image.thumbnailStatus &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isSemanticMatch === nextProps.isSemanticMatch &&
    prevProps.gridTemplateColumns === nextProps.gridTemplateColumns
  );
});

export default ImageTable;
