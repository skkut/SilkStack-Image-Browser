import React from 'react';
import { useImageStore } from '../store/useImageStore';

interface StatusBarProps {
  filteredCount: number;
  totalCount: number;
  directoryCount: number;
  enrichmentProgress: { processed: number; total: number } | null;
}

const StatusBar: React.FC<StatusBarProps> = ({
  filteredCount,
  totalCount,
  directoryCount,
  enrichmentProgress
}) => {
  const folderText = directoryCount === 1 ? 'folder' : 'folders';
  // Semantic index progress (§9) — store-read like Footer's pill, rendered
  // only while a run is active.
  const semanticIndexProgress = useImageStore((state) => state.semanticIndexProgress);
  const hasSemanticIndexJob = semanticIndexProgress && semanticIndexProgress.total > 0;
  
  return (
    <div className="mb-4 px-4 py-2 bg-gray-800/50 rounded-lg border border-gray-700 text-gray-300 flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <span>
          Displaying <span className="font-semibold text-gray-100">{filteredCount}</span> of <span className="font-semibold text-gray-100">{totalCount}</span> images across <span className="font-semibold text-gray-100">{directoryCount}</span> {folderText}
        </span>
        <span className="text-xs text-gray-500">v{import.meta.env.VITE_APP_VERSION}</span>
      </div>

      {/* Metadata Enrichment Progress Bar */}
      {enrichmentProgress && enrichmentProgress.total > 0 && (
        <div className="flex flex-col gap-1 pt-2 border-t border-gray-700">
          <div className="flex justify-between items-center text-xs">
            <span className="text-blue-400">
              📊 Extracting metadata: {enrichmentProgress.processed} / {enrichmentProgress.total}
            </span>
            <span className="text-gray-400">
              {Math.round((enrichmentProgress.processed / enrichmentProgress.total) * 100)}%
            </span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className="bg-blue-500 h-full transition-all duration-300 ease-out"
              style={{ width: `${(enrichmentProgress.processed / enrichmentProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Semantic Search Index Progress (Phase 6) */}
      {hasSemanticIndexJob && (
        <div className="flex flex-col gap-1 pt-2 border-t border-gray-700">
          <div className="flex justify-between items-center text-xs">
            <span className="text-indigo-400">
              ✨ Semantic indexing: {semanticIndexProgress!.current} / {semanticIndexProgress!.total}
            </span>
            <span className="text-gray-400">
              {Math.round((semanticIndexProgress!.current / semanticIndexProgress!.total) * 100)}%
            </span>
          </div>
          <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
            <div
              className="bg-indigo-500 h-full transition-all duration-300 ease-out"
              style={{ width: `${(semanticIndexProgress!.current / semanticIndexProgress!.total) * 100}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};export default StatusBar;