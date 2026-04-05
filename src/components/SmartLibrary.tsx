import React, { useMemo, useEffect, useState } from 'react';
import { Layers, Sparkles } from 'lucide-react';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';

import { ImageCluster, IndexedImage } from '../types';
import StackCard from './StackCard';
import StackExpandedView from './StackExpandedView';
import Footer from './Footer';

const DEFAULT_SIMILARITY_THRESHOLD = 0.88;

interface ClusterEntry {
  cluster: ImageCluster;
  images: IndexedImage[];
}

interface SmartLibraryProps {
}

const SmartLibrary: React.FC<SmartLibraryProps> = () => {
  const filteredImages = useImageStore((state) => state.filteredImages);
  const clusters = useImageStore((state) => state.clusters);
  const directories = useImageStore((state) => state.directories);
  const scanSubfolders = useImageStore((state) => state.scanSubfolders);
  const isClustering = useImageStore((state) => state.isClustering);
  const clusteringProgress = useImageStore((state) => state.clusteringProgress);
  const isAutoTagging = useImageStore((state) => state.isAutoTagging);
  const autoTaggingProgress = useImageStore((state) => state.autoTaggingProgress);
  const startClustering = useImageStore((state) => state.startClustering);
  const startAutoTagging = useImageStore((state) => state.startAutoTagging);
  const setClusterNavigationContext = useImageStore((state) => state.setClusterNavigationContext);
  // const selectedImages = useImageStore((state) => state.selectedImages); // Unused in this file directly
  const selectionTotalImages = useImageStore((state) => state.selectionTotalImages);
  const selectionDirectoryCount = useImageStore((state) => state.selectionDirectoryCount);
  const enrichmentProgress = useImageStore((state) => state.enrichmentProgress);
  const restoreSmartLibraryCache = useImageStore((state) => state.restoreSmartLibraryCache);

  const { viewMode, toggleViewMode, imageSize } = useSettingsStore();
  // const { handleDeleteSelectedImages, clearSelection } = useImageSelection(); // Unused
  const safeFilteredImages = Array.isArray(filteredImages) ? filteredImages : [];

  const [expandedClusterId, setExpandedClusterId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'count' | 'similarity'>('count');

  const imageMap = useMemo(() => {
    return new Map(safeFilteredImages.map((image) => [image.id, image]));
  }, [safeFilteredImages]);

  const clusterEntries = useMemo(() => {
    return clusters
      .map((cluster) => ({
        cluster,
        images: cluster.imageIds
          .map((id) => imageMap.get(id))
          .filter((image): image is IndexedImage => Boolean(image)),
      }))
      .filter((entry) => entry.images.length >= 3); // Minimum 3 images per cluster
  }, [clusters, imageMap]);

  const sortedEntries = useMemo(() => {
    return [...clusterEntries].sort((a, b) => {
      if (sortBy === 'similarity') {
        return b.cluster.similarityThreshold - a.cluster.similarityThreshold;
      } else {
        const imageCountDelta = b.images.length - a.images.length;
        if (imageCountDelta !== 0) {
          return imageCountDelta;
        }
        return b.cluster.size - a.cluster.size;
      }
    });
  }, [clusterEntries, sortBy]);



  useEffect(() => {
    if (expandedClusterId && !clusterEntries.some((entry) => entry.cluster.id === expandedClusterId)) {
      setExpandedClusterId(null);
    }
  }, [expandedClusterId, clusterEntries]);

  const activeCluster = expandedClusterId
    ? clusterEntries.find((entry) => entry.cluster.id === expandedClusterId) ?? null
    : null;

  const activeClusterImages = useMemo(() => {
    if (!activeCluster) {
      return [];
    }
    return [...activeCluster.images].sort((a, b) => (a.lastModified || 0) - (b.lastModified || 0));
  }, [activeCluster]);

  const primaryPath = directories[0]?.path ?? '';
  const hasDirectories = directories.length > 0;

  // Cache restoration is now handled globally in App.tsx
  // to ensure auto-tags and clusters are available before opening Smart Library 

  const handleGenerateClusters = () => {
    if (!primaryPath) return;
    startClustering(primaryPath, scanSubfolders, DEFAULT_SIMILARITY_THRESHOLD);
  };

  const handleGenerateAutoTags = () => {
    if (!primaryPath) return;
    startAutoTagging(primaryPath, scanSubfolders);
  };

  return (
    <section className="flex flex-col h-full min-h-0 pt-3">
      {(clusteringProgress || autoTaggingProgress) && (
        <div className="grid gap-2 mb-3 mt-2">
          {clusteringProgress && (
            <div className="px-3 py-2 rounded-md bg-blue-500/10 border border-blue-500/20 text-xs text-blue-200">
              <div className="flex items-center justify-between mb-1">
                <span>{clusteringProgress.message}</span>
                <span>
                  {clusteringProgress.current}/{clusteringProgress.total}
                </span>
              </div>
              <div className="h-1.5 w-full bg-blue-900/40 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-400 transition-all duration-300"
                  style={{
                    width:
                      clusteringProgress.total > 0
                        ? `${(clusteringProgress.current / clusteringProgress.total) * 100}%`
                        : '0%',
                  }}
                />
              </div>
            </div>
          )}
          {autoTaggingProgress && (
            <div className="px-3 py-2 rounded-md bg-purple-500/10 border border-purple-500/20 text-xs text-purple-200">
              <div className="flex items-center justify-between mb-1">
                <span>{autoTaggingProgress.message}</span>
                <span>
                  {autoTaggingProgress.current}/{autoTaggingProgress.total}
                </span>
              </div>
              <div className="h-1.5 w-full bg-purple-900/40 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-400 transition-all duration-300"
                  style={{
                    width:
                      autoTaggingProgress.total > 0
                        ? `${(autoTaggingProgress.current / autoTaggingProgress.total) * 100}%`
                        : '0%',
                  }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeCluster ? (
          <StackExpandedView
            cluster={activeCluster.cluster}
            images={activeClusterImages}
            allImages={activeClusterImages}
            onBack={() => {
              setClusterNavigationContext(null);
              setExpandedClusterId(null);
            }}
            viewMode={viewMode}
          />
        ) : sortedEntries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <div className="w-14 h-14 rounded-full bg-gray-800/60 flex items-center justify-center mb-3">
              <Layers className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-gray-200">No clusters yet</h3>
            <p className="text-xs max-w-md mt-2">
              Generate clusters to group similar prompts into visual stacks. This is fully virtual and does not move files.
            </p>
          </div>
        ) : (
          <div className="min-h-0 pl-3 pr-2">
            <div 
              className="grid gap-4"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.min(350, Math.max(250, imageSize))}px, 1fr))` }}
            >
              {sortedEntries.map((entry) => {
                return (
                  <StackCard
                    key={entry.cluster.id}
                    cluster={entry.cluster}
                    images={entry.images}
                    onOpen={() => setExpandedClusterId(entry.cluster.id)}
                  />
                );
              })}
            </div>


          </div>
        )}
      </div>

      <Footer
        viewMode={viewMode}
        onViewModeChange={toggleViewMode}
        filteredCount={safeFilteredImages.length}
        totalCount={selectionTotalImages}
        enrichmentProgress={enrichmentProgress}
        showSmartActions={true}
        onCluster={handleGenerateClusters}
        onAutoTag={handleGenerateAutoTags}
        isClustering={isClustering}
        isAutoTagging={isAutoTagging}
        hasDirectories={hasDirectories}
      />
    </section>
  );
};

export default SmartLibrary;
