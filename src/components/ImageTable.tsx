import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { FixedSizeList as List } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { type IndexedImage } from '../types';
import { getAspectRatio } from '../utils/imageUtils';
import { type TableSortField, type TableSortDirection } from '../utils/tableSorting';
import { useContextMenu } from '../hooks/useContextMenu';
import { useImageStore } from '../store/useImageStore';
import { buildDragPayload, type DraggedItemRef } from '../services/imageRelocation';
import { Copy, ExternalLink, Folder, ArrowUpDown, ArrowUp, ArrowDown, Package, Play, Sparkles } from 'lucide-react';
import { useThumbnail } from '../hooks/useThumbnail';
import { useSettingsStore } from '../store/useSettingsStore';

interface ImageTableProps {
  images: IndexedImage[];
  /**
   * `displayOrder` is the id of every row this table is showing, in display
   * order (column sorting reorders rows). Shift+click ranges are measured in
   * it — see selectImageRange in useImageStore.
   */
  onImageClick: (image: IndexedImage, event: React.MouseEvent, displayOrder?: string[]) => void;
  selectedImages: Set<string>;
  semanticHitIds?: Set<string>;
}

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
  // The column sort lives in the store while this table is mounted: the
  // store re-orders `filteredImages` with it (see setTableSort), so the
  // viewer window / modal navigates in the order the rows are drawn here.
  // The table still owns the sort — see the release effect below.
  const sortField = useImageStore((state) => state.tableSortField);
  const sortDirection = useImageStore((state) => state.tableSortDirection);
  const setTableSort = useImageStore((state) => state.setTableSort);

  // Leaving the table (grid, Stacks, Models, stack drill-down) ends the
  // column sort's authority over the library order, so the store list goes
  // back to the header's sortOrder. useLayoutEffect, not useEffect: the
  // cleanup must run in the same commit that unmounts this table so the
  // replacement view never paints one frame in the stale order. Deps stay
  // empty and the guard reads the store live — depending on `sortField`
  // here would fire the cleanup the instant a sort is set.
  useLayoutEffect(() => () => {
    const store = useImageStore.getState();
    if (store.tableSortField) store.setTableSort(null, null);
  }, []);

  const {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    copyPrompt,
    copyNegativePrompt,
    copySeed,
    copyImage,
    copyModel,
    copyPath,
    showInFolder,
    openWithNativeViewer,
    copyRawMetadata
  } = useContextMenu();

  const selectedCount = selectedImages.size;

  const handleContextMenu = (image: IndexedImage, e: React.MouseEvent) => {
    const directoryPath = directories.find(d => d.id === image.directoryId)?.path;
    showContextMenu(e, image, directoryPath);
  };



  const handleSort = (field: TableSortField) => {
    let newDirection: TableSortDirection = 'asc';

    if (sortField === field) {
      if (sortDirection === 'asc') {
        newDirection = 'desc';
      } else if (sortDirection === 'desc') {
        // Third click: clear the column sort — the library falls back to
        // the header's sortOrder.
        setTableSort(null, null);
        return;
      }
    }

    setTableSort(field, newDirection);
  };

  const getSortIcon = (field: TableSortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="w-3 h-3 opacity-40" />;
    }
    if (sortDirection === 'asc') {
      return <ArrowUp className="w-3 h-3" />;
    }
    return <ArrowDown className="w-3 h-3" />;
  };

  // Column resize state
  const DEFAULT_COLUMN_WIDTHS = [96, 280, 220, 110, 110, 100, 80, 70, 100, 160, 160];
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

  // The ids of every row this table is showing, in display order. The store
  // has already applied the column sort to `images` (setTableSort), so this is
  // the same order the viewer window / modal navigates in.
  const displayOrder = useMemo(() => images.map(image => image.id), [images]);
  const displayOrderRef = useRef(displayOrder);
  displayOrderRef.current = displayOrder;
  const handleImageClick = useCallback(
    (image: IndexedImage, event: React.MouseEvent) =>
      onImageClick(image, event, displayOrderRef.current),
    [onImageClick],
  );

  // Same payload rule as the grid and the stack views (see buildDragPayload):
  // the whole selection when the dragged row is part of it, else just the row.
  // Reads the store imperatively so the identity stays stable — ImageTableRow
  // is memoized and does not compare this prop (see its comparator).
  const getDragPayload = useCallback((targetImage: IndexedImage) => {
    const storeState = useImageStore.getState();
    return buildDragPayload(targetImage, storeState.images, storeState.selectedImages);
  }, []);

  // Row renderer for virtualized list
  const Row = ({ index, style }: { index: number; style: React.CSSProperties }) => {
    const image = images[index];
    return (
      <div style={style}>
        <ImageTableRow
          image={image}
          onImageClick={handleImageClick}
          isSelected={selectedImages.has(image.id)}
          isSemanticMatch={semanticHitIds?.has(image.id)}
          onContextMenu={handleContextMenu}
          gridTemplateColumns={gridTemplateColumns}
          getDragPayload={getDragPayload}
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
              <div className="relative">
                <button
                  className="w-full px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                  onClick={() => handleSort('seed')}
                >
                  <span className="flex items-center gap-1">Seed {getSortIcon('seed')}</span>
                </button>
                <div
                  className="absolute right-0 top-0 bottom-0 w-[4px] cursor-col-resize z-10 group"
                  onMouseDown={(e) => handleResizeStart(9, e)}
                  onDoubleClick={() => handleResizeDoubleClick(9)}
                >
                  <div className={`absolute right-0 top-0 bottom-0 w-px transition-colors ${resizing?.index === 9 ? 'bg-blue-500' : 'bg-gray-700 group-hover:bg-blue-500'}`} />
                </div>
              </div>
              <button
                className="px-3 py-3 text-left text-xs font-semibold text-gray-300 uppercase tracking-wider cursor-pointer hover:bg-gray-700/50 transition-colors flex items-center gap-1"
                onClick={() => handleSort('created')}
              >
                <span className="flex items-center gap-1">Created {getSortIcon('created')}</span>
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
                  itemCount={images.length}
                  itemSize={ROW_HEIGHT}
                  width={width}
                  overscanCount={5}
                  itemKey={(index) => images[index]?.id ?? index}
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
            onClick={copyPath}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <Copy className="w-4 h-4" />
            Copy Image Path
          </button>

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
  /** Selection-aware drag payload — same builder the grid cards use. */
  getDragPayload?: (image: IndexedImage) => DraggedItemRef[];
}

/**
 * Exported for tests (the row is what owns the drag gesture; the virtualized
 * list around it renders nothing at jsdom's zero measured height).
 */
export const ImageTableRow: React.FC<ImageTableRowProps> = React.memo(({ image, onImageClick, isSelected, isSemanticMatch, onContextMenu, gridTemplateColumns, getDragPayload }) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const thumbnailsDisabled = useSettingsStore((state) => state.disableThumbnails);
  const isVideo = isVideoFileName(image.name, image.fileType);

  const setDraggedItems = useImageStore((state) => state.setDraggedItems);
  const clearDraggedItems = useImageStore((state) => state.clearDraggedItems);
  const canDragExternally = typeof window !== 'undefined' && !!window.electronAPI?.startFileDrag;

  // Click-vs-drag guard, same rule as the grid card: the row opens the viewer
  // on click, so a gesture that moved the pointer is a drag, not a click.
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);

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

  // ── Drag to ComfyUI / other folders / apps ────────────────────────────
  // Two things travel with the gesture: the internal payload (store state +
  // dataTransfer, consumed by the sidebar's folder drop for in-app moves) and
  // the native OS drag started in main, which is what ComfyUI and Explorer
  // receive as real files.
  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!canDragExternally || !image.directoryId) return;

    const payload = getDragPayload ? getDragPayload(image) : [];
    if (payload.length === 0) return;

    if (e.dataTransfer) {
      e.dataTransfer.setData('application/x-image-metahub-items', JSON.stringify(payload));
      e.dataTransfer.effectAllowed = 'copyMove';
    }
    setDraggedItems(payload);

    // Cancel the in-page drag so the native file drag below is the only one
    // running — without this the OS receives a URL/text drag, not the files.
    e.preventDefault();

    window.electronAPI?.startFileDrag({
      files: payload.map((p) => p.sourcePath).filter(Boolean),
      directoryPath: image.directoryId,
      relativePath: image.id.split('::')[1] || image.name,
      id: image.id,
      lastModified: image.lastModified,
    });
  };

  const handleDragEnd = () => {
    clearDraggedItems();
  };

  const handleRowMouseDown = (e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
  };

  const handleRowMouseMove = (e: React.MouseEvent) => {
    if (!mouseDownPos.current) return;
    const dx = Math.abs(e.clientX - mouseDownPos.current.x);
    const dy = Math.abs(e.clientY - mouseDownPos.current.y);
    if (dx > 5 || dy > 5) {
      isDragging.current = true;
      mouseDownPos.current = null; // Reset so subsequent moves are no-ops
    }
  };

  const handleRowClick = (e: React.MouseEvent) => {
    if (isDragging.current) {
      isDragging.current = false;
      return;
    }
    onImageClick(image, e);
  };

  return (
    <div
      className={`border-b border-gray-700 hover:bg-gray-800/50 cursor-pointer transition-colors group grid items-center ${
        isSelected ? 'bg-blue-900/30 border-blue-700' : ''
      }`}
      onClick={handleRowClick}
      onMouseDown={handleRowMouseDown}
      onMouseMove={handleRowMouseMove}
      onContextMenu={(e) => onContextMenu && onContextMenu(image, e)}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      draggable={canDragExternally}
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
                // The row owns the drag (native file drag); the browser's own
                // image drag would hijack the gesture from the thumbnail.
                draggable={false}
              />
              {isVideo && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="rounded-full bg-black/50 p-1.5">
                    <Play className="h-4 w-4 text-white/90" />
                  </div>
                </div>
              )}
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
      {/* Created — same value and same formatting as the modal's date line
          under the filename (`new Date(lastModified).toLocaleString()`):
          lastModified is the indexer's birthtime-with-mtime-fallback, i.e.
          the file's creation time. */}
      <div
        className="px-3 py-2 text-gray-400 font-mono text-xs truncate"
        title={image.lastModified ? new Date(image.lastModified).toLocaleString() : undefined}
      >
        {image.lastModified ? (
          new Date(image.lastModified).toLocaleString()
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  // Custom comparison for performance - only re-render if critical props changed.
  // Like onImageClick / onContextMenu, `getDragPayload` is deliberately not
  // compared: it reads the store imperatively and the table hands out a
  // stable useCallback([]) identity, so comparing it would only cost renders.
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
