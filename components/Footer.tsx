import React, { useState, useEffect } from 'react';
import ImageSizeSlider from './ImageSizeSlider';
import { Grid3X3, List, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, EyeOff, Layers, Layers2, Sparkles } from 'lucide-react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';

interface FooterProps {
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  customText?: string;
  filteredCount?: number;
  totalCount?: number;
  directoryCount?: number;
  enrichmentProgress?: { processed: number; total: number } | null;
  showStackingToggle?: boolean;
  showSmartActions?: boolean;
  onCluster?: () => void;
  onAutoTag?: () => void;
  isClustering?: boolean;
  isAutoTagging?: boolean;
  hasDirectories?: boolean;
}

const Token: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <span
    title={title}
    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-800/60 text-gray-300 border border-gray-700/50"
  >
    {children}
  </span>
);

const Footer: React.FC<FooterProps> = ({
  viewMode,
  onViewModeChange,
  customText,
  filteredCount,
  totalCount,
  directoryCount,
  enrichmentProgress,
  showStackingToggle = false,
  showSmartActions = false,
  onCluster,
  onAutoTag,
  isClustering = false,
  isAutoTagging = false,
  hasDirectories = false,
}) => {
  const enableSafeMode = useSettingsStore((state) => state.enableSafeMode);
  const setEnableSafeMode = useSettingsStore((state) => state.setEnableSafeMode);
  const isStackingEnabled = useImageStore((state) => state.isStackingEnabled);
  const setStackingEnabled = useImageStore((state) => state.setStackingEnabled);
  const folderText = directoryCount === 1 ? 'folder' : 'folders';
  const hasEnrichmentJob = enrichmentProgress && enrichmentProgress.total > 0;

  return (
    <footer className={`sticky bottom-0 px-6 flex items-center gap-4 bg-gray-900/90 backdrop-blur-md border-t border-gray-800/60 transition-all duration-300 shadow-footer-up ${hasEnrichmentJob ? 'h-14 md:h-16' : 'h-12 md:h-14'}`}>
      <div className="min-w-0 flex-1 flex items-center gap-3 text-xs">
        {customText ? (
           <Token>
             <span className="font-semibold text-gray-200">{customText}</span>
           </Token>
        ) : (
          <>
            {filteredCount !== undefined && totalCount !== undefined && (
              <Token title="Images in current view / Total images">
                <span className="font-semibold text-gray-200">{filteredCount.toLocaleString()}</span>
                <span className="text-gray-600 mx-1">/</span>
                <span className="text-gray-400">{totalCount.toLocaleString()}</span>
              </Token>
            )}
            {directoryCount !== undefined && directoryCount > 0 && (
              <Token title="Number of folders">
                <span className="font-medium text-gray-200">{directoryCount}</span> <span className="text-gray-400 ml-1">{folderText}</span>
              </Token>
            )}
          </>
        )}
        {hasEnrichmentJob && (
          <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              <span className="font-medium">{enrichmentProgress!.processed}/{enrichmentProgress!.total}</span>
            </div>
            <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-500 ease-out" style={{ width: `${(enrichmentProgress!.processed / enrichmentProgress!.total) * 100}%` }} />
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {/* Stacking Toggle */}
        {showStackingToggle && (
          <button
            onClick={() => setStackingEnabled(!isStackingEnabled)}
            className={`p-1.5 rounded-lg transition-all duration-200 ${
              isStackingEnabled 
                ? 'text-blue-400 bg-blue-500/10' 
                : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
            }`}
            title={isStackingEnabled ? "Disable stacking" : "Stack items by identical prompt"}
          >
            {isStackingEnabled ? <Layers2 size={16} /> : <Layers size={16} />}
          </button>
        )}

        {/* Smart Library Actions */}
        {showSmartActions && (
          <div className="flex items-center gap-2 mr-2">
            <button
              onClick={onCluster}
              disabled={!hasDirectories || isClustering}
              className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                isClustering ? 'text-blue-400/50 cursor-wait' : 'text-blue-400 hover:bg-blue-500/10 hover:text-blue-300'
              }`}
              title="Generate Clusters"
            >
              <Layers size={14} className={isClustering ? 'animate-pulse' : ''}/>
              <span className="hidden xl:inline">Cluster</span>
            </button>
            <button
              onClick={onAutoTag}
              disabled={!hasDirectories || isAutoTagging}
              className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                isAutoTagging ? 'text-purple-400/50 cursor-wait' : 'text-purple-400 hover:bg-purple-500/10 hover:text-purple-300'
              }`}
              title="Generate Auto-Tags"
            >
              <Sparkles size={14} className={isAutoTagging ? 'animate-pulse' : ''}/>
              <span className="hidden xl:inline">Auto-Tag</span>
            </button>
            <div className="w-px h-5 bg-gray-700/50 mx-1"></div>
          </div>
        )}

        {/* Safe Mode Toggle */}
        <button
          onClick={() => setEnableSafeMode(!enableSafeMode)}
          className={`p-1.5 rounded-lg transition-all duration-200 ${
            enableSafeMode
              ? 'text-gray-400 hover:text-gray-100'
              : 'text-gray-600 hover:text-gray-400'
          }`}
          title={enableSafeMode ? 'Safe Mode on' : 'Safe Mode off'}
        >
          {enableSafeMode ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
      </div>
      <div className="flex items-center gap-3 border-l border-gray-700/50 pl-3">
        <ImageSizeSlider />
        <button onClick={() => onViewModeChange(viewMode === 'grid' ? 'list' : 'grid')} className="p-2 hover:bg-gray-800 text-gray-400 hover:text-white rounded-lg transition-all hover:shadow-md" title={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}>
          {viewMode === 'grid' ? <List className="h-4 w-4" /> : <Grid3X3 className="h-4 w-4" />}
        </button>
      </div>
    </footer>
  );
};

export default Footer;
