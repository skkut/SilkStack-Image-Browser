import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { Layers, Copy, ExternalLink, Folder } from 'lucide-react';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStacking } from '../hooks/useImageStacking';
import { useImageSelection } from '../hooks/useImageSelection';
import { useContextMenu } from '../hooks/useContextMenu';
import { IndexedImage, ImageStack } from '../types';
import StackCard from './StackCardWrapper';
import SimilarityStackExpandedView from './SimilarityStackExpandedViewWrapper';
import Footer from './Footer';

interface StacksProps {}

const Stacks: React.FC<StacksProps> = () => {
  const filteredImages = useImageStore((state) => state.filteredImages);
  const isAutoTagging = useImageStore((state) => state.isAutoTagging);
  const autoTaggingProgress = useImageStore((state) => state.autoTaggingProgress);
  const startAutoTagging = useImageStore((state) => state.startAutoTagging);
  const cancelAutoTagging = useImageStore((state) => state.cancelAutoTagging);
  const cancelSemanticIndexing = useImageStore((state) => state.cancelSemanticIndexing);
  const selectionTotalImages = useImageStore((state) => state.selectionTotalImages);
  const selectionDirectoryCount = useImageStore((state) => state.selectionDirectoryCount);
  const enrichmentProgress = useImageStore((state) => state.enrichmentProgress);
  const similarityGroupProgress = useImageStore((state) => state.similarityGroupProgress);
  const directories = useImageStore((state) => state.directories);

  // Use the same selection handler as the library grid so image clicks
  // correctly open the viewer window (Electron) or in-app modal (browser).
  const { handleImageSelection } = useImageSelection();

  // Right-click context menu — same hook + menu as the library grid/table.
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

  // Resolve the image's directory path (needed by "Show in Folder" / "Open in
  // Native Viewer") the same way ImageGrid does.
  const handleContextMenu = useCallback((image: IndexedImage, e: React.MouseEvent) => {
    const directoryPath = directories.find(d => d.id === image.directoryId)?.path;
    showContextMenu(e, image, directoryPath);
  }, [directories, showContextMenu]);

  const imageSize = useSettingsStore((state) => state.viewZoomLevels.smart);
  const { viewMode, toggleViewMode } = useSettingsStore();
  const safeFilteredImages = Array.isArray(filteredImages) ? filteredImages : [];

  // Use the same stacking hook as the library grid — this groups images by
  // similarityGroupId (or stackGroupId fallback) into ImageStacks with subGroups.
  const { stackedItems } = useImageStacking(safeFilteredImages, true);

  // Extract only the ImageStack items (skip singletons).
  // Sorting follows the global sort order from useImageStacking (same as the library grid).
  const stacks = useMemo(() => {
    return stackedItems.filter((item): item is ImageStack =>
      'coverImage' in item
    );
  }, [stackedItems]);

  // ── Drill-down state ───────────────────────────────────────────────
  const [expandedStackId, setExpandedStackId] = useState<string | null>(null);
  const scrollPositionRef = useRef<number>(0);
  const gridScrollPositionRef = useRef<number>(0);
  const sectionRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const getScrollContainer = () => {
    if (!sectionRef.current) return null;
    let parent = sectionRef.current.parentElement;
    while (parent) {
      const style = window.getComputedStyle(parent);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return parent;
      }
      parent = parent.parentElement;
    }
    return null;
  };

  const handleOpenStack = (stackId: string) => {
    const scrollContainer = getScrollContainer();
    if (scrollContainer) scrollPositionRef.current = scrollContainer.scrollTop;
    if (gridRef.current) gridScrollPositionRef.current = gridRef.current.scrollTop;
    setExpandedStackId(stackId);
  };

  const handleCloseStack = () => {
    setExpandedStackId(null);
  };

  useEffect(() => {
    if (!expandedStackId) {
      const timer = setTimeout(() => {
        const scrollContainer = getScrollContainer();
        if (scrollContainer && scrollPositionRef.current > 0) {
          scrollContainer.scrollTop = scrollPositionRef.current;
        }
        if (gridRef.current && gridScrollPositionRef.current > 0) {
          gridRef.current.scrollTop = gridScrollPositionRef.current;
        }
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [expandedStackId]);

  // Clear expanded state if the stack is removed
  useEffect(() => {
    if (expandedStackId && !stacks.some(s => s.id === expandedStackId)) {
      setExpandedStackId(null);
    }
  }, [expandedStackId, stacks]);

  const activeStack = expandedStackId
    ? stacks.find(s => s.id === expandedStackId) ?? null
    : null;

  // Build drill-down props from the active stack
  const drillDownSubGroups = useMemo(() => {
    if (!activeStack?.subGroups) return [];
    return activeStack.subGroups.map(sg => ({
      promptHash: sg.promptHash,
      prompt: sg.prompt,
      label: sg.label,
      groupKey: sg.groupKey,
      dimensions: sg.dimensions,
      imageIds: sg.imageIds,
    }));
  }, [activeStack]);

  const primaryPath = directories[0]?.path ?? '';
  const hasDirectories = directories.length > 0;

  const handleGenerateAutoTags = () => {
    if (!primaryPath) return;
    startAutoTagging(primaryPath, false);
  };

  return (
    <section ref={sectionRef} className="flex flex-col h-full min-h-0 pt-3">
      {/* Drill-down view — replaces the grid content, Footer stays below */}
      {activeStack ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <SimilarityStackExpandedView
            images={activeStack.images}
            subGroups={drillDownSubGroups}
            onImageClick={handleImageSelection}
            selectedImages={new Set()}
            onBack={handleCloseStack}
            imageSize={imageSize}
            onContextMenu={handleContextMenu}
          />
        </div>
      ) : stacks.length === 0 ? (
        /* Empty state */
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <div className="w-14 h-14 rounded-full bg-gray-800/60 flex items-center justify-center mb-3">
              <Layers className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-gray-200">No stacks yet</h3>
            <p className="text-xs max-w-md mt-2">
              {safeFilteredImages.length === 0
                ? 'Add a folder with images to see stacks grouped by prompt similarity.'
                : similarityGroupProgress
                  ? 'Similarity groups are being computed — stacks will appear shortly.'
                  : 'Stacks are created automatically from your images. Each stack groups similar prompts with sub-group labels.'}
            </p>
          </div>
        </div>
      ) : (
        /* Stack grid */
        <div
          ref={gridRef}
          className="flex-1 min-h-0 overflow-y-auto"
          id="smart-library-grid-container"
        >
          <div className="flex items-center gap-2 px-3 mb-3">
            <span className="text-xs text-gray-500">{stacks.length} stacks</span>
          </div>

          <div className="min-h-0 pl-3 pr-2">
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.min(350, Math.max(250, imageSize))}px, 1fr))` }}
            >
              {stacks.map((stack) => (
                <StackCard
                  key={stack.id}
                  stack={stack}
                  onOpen={() => handleOpenStack(stack.id)}
                  onContextMenu={handleContextMenu}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      <Footer
        viewMode={viewMode}
        onViewModeChange={toggleViewMode}
        filteredCount={safeFilteredImages.length}
        totalCount={selectionTotalImages}
        enrichmentProgress={enrichmentProgress}
        autoTaggingProgress={autoTaggingProgress}
        similarityGroupProgress={similarityGroupProgress}
        onCancelAutoTag={cancelAutoTagging}
        onCancelSemanticIndex={cancelSemanticIndexing}
        showAutoTag={true}
        onAutoTag={handleGenerateAutoTags}
        isAutoTagging={isAutoTagging}
        hasDirectories={hasDirectories}
      />

      {/* Right-click context menu (same as the library grid/table) */}
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
      )}
    </section>
  );
};

export default Stacks;
