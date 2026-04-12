import React, { useMemo, useState } from 'react';
import { Box } from 'lucide-react';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { IndexedImage } from '../types';
import ModelCard from './ModelCard';
import Footer from './Footer';

interface ModelEntry {
  name: string;
  images: IndexedImage[];
  count: number;
}

interface ModelViewProps {
  onModelSelect: (modelName: string) => void;
}


export const ModelView: React.FC<ModelViewProps> = ({ onModelSelect }) => {
  const images = useImageStore((state) => state.images); // Use all images, not filtered ones
  const filteredImages = useImageStore((state) => state.filteredImages); // For footer stats
  const selectionTotalImages = useImageStore((state) => state.selectionTotalImages);
  const selectionDirectoryCount = useImageStore((state) => state.selectionDirectoryCount);
  const enrichmentProgress = useImageStore((state) => state.enrichmentProgress);
  
  const imageSize = useSettingsStore((state) => state.viewZoomLevels.model);
  const { viewMode, toggleViewMode } = useSettingsStore();

  const [sortBy] = useState<'count' | 'name'>('count');

  const directories = useImageStore((state) => state.directories);

  // Extract models and group images
  const modelEntries = useMemo(() => {
    const models = new Map<string, IndexedImage[]>();

    // Identify disconnected directories
    const disconnectedDirIds = new Set(
      directories.filter(d => d.isConnected === false).map(d => d.id)
    );

    filteredImages.forEach(image => {
      // Skip images from disconnected directories
      if (disconnectedDirIds.has(image.directoryId)) {
        return;
      }

      if (image.models && image.models.length > 0) {
        image.models.forEach(modelName => {
          if (!modelName) return;
          
          if (!models.has(modelName)) {
            models.set(modelName, []);
          }
          models.get(modelName)?.push(image);
        });
      } else {
        // Handle images with no model metadata if needed, or skip
        // For now, skipping un-modeled images in this view
      }
    });

    const entries: ModelEntry[] = Array.from(models.entries()).map(([name, modelImages]) => ({
      name,
      images: modelImages.sort((a, b) => b.lastModified - a.lastModified), // Sort images by newest first // Sort images by newest first
      count: modelImages.length
    }));

    // Sort models
    return entries.sort((a, b) => {
      if (sortBy === 'count') {
        const countDiff = b.count - a.count;
        if (countDiff !== 0) return countDiff;
      }
      return a.name.localeCompare(b.name);
    });
  }, [filteredImages, directories, sortBy]);



  return (
    <section className="flex flex-col h-full min-h-0 pt-3">
      <div className="flex-1 min-h-0 overflow-auto pl-3 pr-2">
        {modelEntries.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <div className="w-14 h-14 rounded-full bg-gray-800/60 flex items-center justify-center mb-3">
              <Box className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-gray-200">No models found</h3>
            <p className="text-xs max-w-md mt-2">
              Index images containing metadata to see models here.
            </p>
          </div>
        ) : (
          <div 
            className="grid gap-4"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${Math.min(350, Math.max(250, imageSize))}px, 1fr))` }}
          >
            {modelEntries.map((entry) => (
              <ModelCard
                key={entry.name}
                modelName={entry.name}
                images={entry.images}
                imageCount={entry.count}
                onClick={() => onModelSelect(entry.name)}
              />
            ))}
          </div>
        )}
      </div>

      <Footer
        viewMode={viewMode}
        onViewModeChange={toggleViewMode}
        filteredCount={filteredImages.length} 
        totalCount={selectionTotalImages}
        enrichmentProgress={enrichmentProgress}
        customText={`Showing ${modelEntries.length} models`}
      />
    </section>
  );
};


