import React, { useState, useEffect } from 'react';
import ImageSizeSlider from './ImageSizeSlider';
import { Grid3X3, List, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, EyeOff, Layers, Layers2, Sparkles, PanelRight, X, Unplug } from 'lucide-react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { useAiFeaturesEnabled, useAiModelFeaturesEnabled } from '../services/aiFeatureAccess';

interface FooterProps {
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  customText?: string;
  filteredCount?: number;
  totalCount?: number;
  enrichmentProgress?: { processed: number; total: number; message?: string } | null;
  autoTaggingProgress?: { current: number; total: number; message: string } | null;
  clusteringProgress?: { current: number; total: number; message: string } | null;
  similarityGroupProgress?: { current: number; total: number; message: string } | null;
  showStackingToggle?: boolean;
  showSmartActions?: boolean;
  showAutoTag?: boolean;
  onCluster?: () => void;
  onAutoTag?: () => void;
  isClustering?: boolean;
  isAutoTagging?: boolean;
  onCancelAutoTag?: () => void;
  onCancelClustering?: () => void;
  onCancelSemanticIndex?: () => void;
  hasDirectories?: boolean;
  isPreviewOpen?: boolean;
  onTogglePreview?: () => void;
  children?: React.ReactNode;
}

const Token: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <span
    title={title}
    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-800/60 text-gray-300 border border-gray-700/50"
  >
    {children}
  </span>
);

/** One resident model's identity inside the combined footer pill. */
interface ResidentModelSegment {
  /** Full web-llm model id (tooltip). */
  modelId: string;
  /** Declared VRAM requirement in MB — null when the record declared none. */
  vramMb: number | null;
  /** tag = purple, embed = indigo. */
  tone: 'purple' | 'indigo';
}

/** Declared record VRAM (MB) → compact label ('6900' → '6.9 GB'). Decimal like the model catalog's own "~6.9 GB" descriptions. */
function formatVramMb(mb: number | null): string | null {
  return mb == null ? null : `${(mb / 1000).toFixed(1)} GB`;
}

/**
 * Combined resident-model pill (footer). ONE pill for both records: shows
 * which models the shared engine holds plus each one's declared VRAM
 * requirement, with ONE eject button — the engine holds the tag + embed
 * records together (web-llm has no per-record unload), so they always
 * unload as a pair via worker termination.
 */
const ModelResidencyPill: React.FC<{
  segments: ResidentModelSegment[];
  onEject: () => void;
  unloading: boolean;
}> = ({ segments, onEject, unloading }) => {
  const title =
    segments
      .map((s) => `${s.modelId} (~${formatVramMb(s.vramMb) ?? 'VRAM unknown'})`)
      .join(' + ') + ' — loaded in GPU memory. Eject to free it.';
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-full bg-gray-800/60 border border-gray-700/50 pl-3 pr-1 py-0.5 text-xs text-gray-300 select-none"
    >
      {segments.map((seg, i) => (
        <span key={seg.tone} className="inline-flex items-center">
          {i > 0 && <span className="text-gray-600 mx-1.5">·</span>}
          <span className={`w-1.5 h-1.5 rounded-full ${seg.tone === 'purple' ? 'bg-purple-400' : 'bg-indigo-400'}`} />
          <span className="ml-1.5 font-medium">{shortModelName(seg.modelId)}</span>
          {formatVramMb(seg.vramMb) && (
            <span className="ml-1 text-gray-500">{formatVramMb(seg.vramMb)}</span>
          )}
        </span>
      ))}
      <button
        onClick={onEject}
        disabled={unloading}
        className="ml-2 p-0.5 rounded transition-colors text-gray-500 hover:bg-gray-700/60 hover:text-gray-300 disabled:opacity-40 disabled:cursor-wait"
        title="Unload AI models from GPU memory"
        aria-label="Unload AI models from GPU memory"
      >
        <Unplug size={11} />
      </button>
    </span>
  );
};

/** Compact footer label for a model id ('Qwen3-Embedding-8B-q4f16_1-MLC' → 'Qwen3-8B'). */
function shortModelName(modelId: string): string {
  const qwen = /^Qwen3-Embedding-(\d+B)/.exec(modelId);
  if (qwen) return `Qwen3-${qwen[1]}`;
  if (modelId.startsWith('Hermes-3-Llama-3.2-3B')) return 'Hermes-3 3B';
  if (modelId.startsWith('snowflake-arctic-embed')) return 'Arctic Embed';
  const first = modelId.split('-')[0];
  return first || modelId;
}

const Footer: React.FC<FooterProps> = ({
  viewMode,
  onViewModeChange,
  customText,
  filteredCount,
  totalCount,
  enrichmentProgress,
  autoTaggingProgress,
  clusteringProgress,
  similarityGroupProgress,
  showStackingToggle = false,
  showSmartActions = false,
  showAutoTag = false,
  onCluster,
  onAutoTag,
  isClustering = false,
  isAutoTagging = false,
  onCancelAutoTag,
  onCancelClustering,
  onCancelSemanticIndex,
  hasDirectories = false,
  isPreviewOpen = false,
  onTogglePreview,
  children,
}) => {
  // Runtime gate: stacking & auto-tag UI requires premium license
  const aiFeaturesEnabled = useAiFeaturesEnabled();
  // Auto-tag (a MODEL-LOADING feature) additionally requires the master
  // AI toggle — stacking is rule-based and keeps working without it.
  const modelFeaturesEnabled = useAiModelFeaturesEnabled();
  const enableSafeMode = useSettingsStore((state) => state.enableSafeMode);
  const setEnableSafeMode = useSettingsStore((state) => state.setEnableSafeMode);
  const isStackingEnabled = useSettingsStore((state) => state.isStackingEnabled);
  const setStackingEnabled = useImageStore((state) => state.setStackingEnabled);
  const indexingProgress = useImageStore((state) => state.progress);
  const pipelinePhase = useImageStore((state) => state.pipelinePhase);
  const semanticIndexProgress = useImageStore((state) => state.semanticIndexProgress);
  // Which AI models are resident in GPU memory (union of the semantic
  // coordinator worker and the per-run auto-tag worker).
  const aiModelsLoaded = useImageStore((state) => state.aiModelsLoaded);
  const [isUnloading, setIsUnloading] = useState(false);
  const handleEjectModels = async () => {
    if (isUnloading) return;
    setIsUnloading(true);
    try {
      await useImageStore.getState().unloadAiModels();
    } finally {
      setIsUnloading(false);
    }
  };
  // One segment per resident record (tag = purple, embed = indigo), each with
  // its declared VRAM — rendered as a single pill with one eject button.
  const residentSegments: ResidentModelSegment[] = [];
  if (aiModelsLoaded.chatLoaded && aiModelsLoaded.chatModelId) {
    residentSegments.push({
      modelId: aiModelsLoaded.chatModelId,
      vramMb: aiModelsLoaded.chatVramMb,
      tone: 'purple',
    });
  }
  if (aiModelsLoaded.embedLoaded && aiModelsLoaded.embedModelId) {
    residentSegments.push({
      modelId: aiModelsLoaded.embedModelId,
      vramMb: aiModelsLoaded.embedVramMb,
      tone: 'indigo',
    });
  }

  const hasEnrichmentJob = enrichmentProgress && enrichmentProgress.total > 0;
  const hasAutoTaggingJob = autoTaggingProgress && autoTaggingProgress.total > 0;
  const hasClusteringJob = clusteringProgress && clusteringProgress.total > 0;
  const hasSimilarityGroupJob = similarityGroupProgress && similarityGroupProgress.total > 0;
  const hasSemanticIndexJob = semanticIndexProgress && semanticIndexProgress.total > 0;
  const hasIndexingJob = indexingProgress && indexingProgress.total > 0;
  const hasAnyProgressJob = hasEnrichmentJob || hasAutoTaggingJob || hasClusteringJob || hasSimilarityGroupJob || hasSemanticIndexJob || hasIndexingJob || pipelinePhase !== null;

  return (
    <footer className={`sticky bottom-0 px-6 flex items-center gap-4 bg-gray-900/90 backdrop-blur-md border-t border-gray-800/60 transition-all duration-300 shadow-footer-up ${hasAnyProgressJob ? 'h-14 md:h-16' : 'h-12 md:h-14'}`}>
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
            {children && <div className="w-px h-4 bg-gray-700/50 mx-1" />}
            {children}
          </>
        )}
        {hasAnyProgressJob && (
          <div className="flex items-center gap-3">
            {hasIndexingJob && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span className="font-medium">
                    Cataloging {indexingProgress!.current}/{indexingProgress!.total}
                    {indexingProgress!.message && (
                      <span className="text-gray-500 ml-1 font-normal truncate max-w-[200px] inline-block align-bottom">
                        — {indexingProgress!.message}
                      </span>
                    )}
                  </span>
                </div>
                <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 transition-all duration-500 ease-out" style={{ width: `${(indexingProgress!.current / indexingProgress!.total) * 100}%` }} />
                </div>
              </div>
            )}
            {/* Unified pipeline phase indicator — shows the active post-indexing phase */}
            {pipelinePhase && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                </span>
                <span className="font-medium">
                  {pipelinePhase === 'stacking' ? 'Phase 1/4: Stacking…'
                    : pipelinePhase === 'similarity' ? 'Phase 2/4: Similarity…'
                    : pipelinePhase === 'autoTag' ? 'Phase 3/4: Auto-tagging…'
                    : 'Phase 4/4: Semantic indexing…'}
                </span>
              </div>
            )}
            {hasEnrichmentJob && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                  </span>
                  <span className="font-medium">
                    Enriching {enrichmentProgress!.processed}/{enrichmentProgress!.total}
                    {enrichmentProgress!.message && (
                      <span className="text-gray-500 ml-1 font-normal truncate max-w-[200px] inline-block align-bottom">
                        — {enrichmentProgress!.message}
                      </span>
                    )}
                  </span>
                </div>
                <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all duration-500 ease-out" style={{ width: `${(enrichmentProgress!.processed / enrichmentProgress!.total) * 100}%` }} />
                </div>
              </div>
            )}
            {hasClusteringJob && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                  </span>
                  <span className="font-medium">{clusteringProgress!.current}/{clusteringProgress!.total}</span>
                </div>
                <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all duration-500 ease-out" style={{ width: `${(clusteringProgress!.total > 0 ? (clusteringProgress!.current / clusteringProgress!.total) * 100 : 0)}%` }} />
                </div>
                {onCancelClustering && (
                  <button
                    onClick={onCancelClustering}
                    className="ml-0.5 p-0.5 rounded-full hover:bg-blue-500/20 transition-colors"
                    title="Cancel clustering"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
            {hasSimilarityGroupJob && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-green-500/10 border border-green-500/20 text-green-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                  </span>
                  <span className="font-medium">{similarityGroupProgress!.message}</span>
                </div>
                <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                  <div className="h-full bg-green-500 transition-all duration-500 ease-out" style={{ width: `${(similarityGroupProgress!.total > 0 ? (similarityGroupProgress!.current / similarityGroupProgress!.total) * 100 : 0)}%` }} />
                </div>
              </div>
            )}
            {hasSemanticIndexJob && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500"></span>
                  </span>
                  <span className="font-medium">
                    Semantic indexing {semanticIndexProgress!.current}/{semanticIndexProgress!.total}
                    {semanticIndexProgress!.message && (
                      <span className="text-gray-500 ml-1 font-normal truncate max-w-[200px] inline-block align-bottom">
                        — {semanticIndexProgress!.message}
                      </span>
                    )}
                  </span>
                </div>
                <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                  <div className="h-full bg-indigo-500 transition-all duration-500 ease-out" style={{ width: `${(semanticIndexProgress!.total > 0 ? (semanticIndexProgress!.current / semanticIndexProgress!.total) * 100 : 0)}%` }} />
                </div>
                {onCancelSemanticIndex && (
                  <button
                    onClick={onCancelSemanticIndex}
                    className="ml-0.5 p-0.5 rounded-full hover:bg-indigo-500/20 transition-colors"
                    title="Cancel semantic indexing"
                    aria-label="Cancel semantic indexing"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
            {hasAutoTaggingJob && (
              <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-purple-500"></span>
                  </span>
                  <span className="font-medium">
                    Auto-tagging {autoTaggingProgress!.current}/{autoTaggingProgress!.total}
                    {autoTaggingProgress!.message && (
                      <span className="text-gray-500 ml-1 font-normal truncate max-w-[200px] inline-block align-bottom">
                        — {autoTaggingProgress!.message}
                      </span>
                    )}
                  </span>
                </div>
                <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
                  <div className="h-full bg-purple-500 transition-all duration-500 ease-out" style={{ width: `${(autoTaggingProgress!.total > 0 ? (autoTaggingProgress!.current / autoTaggingProgress!.total) * 100 : 0)}%` }} />
                </div>
                {onCancelAutoTag && (
                  <button
                    onClick={onCancelAutoTag}
                    className="ml-0.5 p-0.5 rounded-full hover:bg-purple-500/20 transition-colors"
                    title="Cancel auto-tagging"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 ml-auto">
        <div className="w-px h-4 bg-gray-700/50 mx-2" />
        {/* AI model residency pill (footer eject) — before the stacking toggle */}
        {aiModelsLoaded && residentSegments.length > 0 && (
          <ModelResidencyPill
            segments={residentSegments}
            onEject={handleEjectModels}
            unloading={isUnloading}
          />
        )}
        {/* Stacking Toggle */}
        {aiFeaturesEnabled && showStackingToggle && (
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

        {/* Stacks Actions */}
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
            {modelFeaturesEnabled && (
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
            )}
            <div className="w-px h-5 bg-gray-700/50 mx-1"></div>
          </div>
        )}

        {/* Standalone Auto-Tag button (for Library tab, independent of Smart Actions) */}
        {modelFeaturesEnabled && showAutoTag && !showSmartActions && (
          <div className="flex items-center gap-2 mr-2">
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
          {viewMode === 'grid' ? <List size={18} /> : <Grid3X3 size={18} />}
        </button>

        {/* Preview Sidebar Toggle - Right-most Corner */}
        {onTogglePreview && (
          <button
            onClick={onTogglePreview}
            className={`p-2 rounded-lg transition-all duration-200 ${
              isPreviewOpen
                ? 'text-blue-400 bg-blue-500/10 shadow-[0_0_10px_rgba(59,130,246,0.1)]'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
            }`}
            title={isPreviewOpen ? "Close Preview Pane" : "Open Preview Pane"}
          >
            <PanelRight size={18} className={isPreviewOpen ? 'animate-pulse-slow' : ''} />
          </button>
        )}
      </div>
    </footer>
  );
};

export default Footer;
