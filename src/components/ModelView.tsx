import React, { useMemo, useState } from 'react';
import { Box } from 'lucide-react';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { IndexedImage } from '../types';
import { baseModelForImage } from '../services/baseModelTable';
import ModelCard, { type ModelCardKind } from './ModelCard';
import Footer from './Footer';

interface ModelEntry {
  name: string;
  /** Which dimension this entry groups by — see `ModelCardKind`. */
  kind: ModelCardKind;
  images: IndexedImage[];
  count: number;
}

interface ModelViewProps {
  onModelSelect: (modelName: string) => void;
  onBaseModelSelect: (baseModel: string) => void;
}


export const ModelView: React.FC<ModelViewProps> = ({ onModelSelect, onBaseModelSelect }) => {
  const images = useImageStore((state) => state.images); // Use all images, not filtered ones
  const filteredImages = useImageStore((state) => state.filteredImages); // For footer stats
  const selectionTotalImages = useImageStore((state) => state.selectionTotalImages);
  const selectionDirectoryCount = useImageStore((state) => state.selectionDirectoryCount);
  const enrichmentProgress = useImageStore((state) => state.enrichmentProgress);

  // Read, not just subscribed to: the offline checkpoint table is resolved
  // asynchronously and lives outside the store (services/baseModelTable, keyed
  // by checkpoint rather than by image), so the entries memo has to recompute
  // when a resolution lands — its inputs are all unchanged at that point.
  const baseModelTableVersion = useImageStore((state) => state.baseModelTableVersion);

  const imageSize = useSettingsStore((state) => state.viewZoomLevels.model);
  const { viewMode, toggleViewMode } = useSettingsStore();

  const [sortBy] = useState<'count' | 'name'>('count');

  const directories = useImageStore((state) => state.directories);

  // Extract models and group images
  const modelEntries = useMemo(() => {
    const models = new Map<string, IndexedImage[]>();
    const baseModels = new Map<string, IndexedImage[]>();

    // Identify disconnected directories
    const disconnectedDirIds = new Set(
      directories.filter(d => d.isConnected === false).map(d => d.id)
    );

    const noModelImages: IndexedImage[] = [];

    filteredImages.forEach(image => {
      // Skip images from disconnected directories
      if (disconnectedDirIds.has(image.directoryId)) {
        return;
      }

      const validModels = (image.models ?? []).filter(Boolean);
      if (validModels.length > 0) {
        validModels.forEach(modelName => {
          if (!models.has(modelName)) {
            models.set(modelName, []);
          }
          models.get(modelName)?.push(image);
        });
      } else {
        // Images with no model metadata are grouped under the blank entry
        noModelImages.push(image);
      }

      // Resolved per checkpoint, so this reads through the table rather than
      // off the image. A falsy result is the '' sentinel — images whose
      // checkpoint the lookup cannot answer — and those get no card.
      const baseModel = baseModelForImage(image);
      if (baseModel) {
        if (!baseModels.has(baseModel)) {
          baseModels.set(baseModel, []);
        }
        baseModels.get(baseModel)?.push(image);
      }
    });

    // Built from the two maps separately, never by looking the name up again:
    // a checkpoint and a base model may share a name, and inferring the kind
    // from the name would then label both as checkpoints and hand React the
    // same key twice.
    const toEntry = (kind: ModelCardKind) => ([name, groupedImages]: [string, IndexedImage[]]): ModelEntry => ({
      name,
      kind,
      images: groupedImages.sort((a, b) => b.lastModified - a.lastModified), // Sort images by newest first
      count: groupedImages.length
    });

    const entries: ModelEntry[] = [
      ...Array.from(models.entries()).map(toEntry('model')),
      ...Array.from(baseModels.entries()).map(toEntry('baseModel')),
    ];

    // Sort models
    const sorted = entries.sort((a, b) => {
      if (sortBy === 'count') {
        const countDiff = b.count - a.count;
        if (countDiff !== 0) return countDiff;
      }
      return a.name.localeCompare(b.name);
    });

    // Blank-model entry at the end; blank name acts as the 'no model' sentinel
    if (noModelImages.length > 0) {
      sorted.push({
        name: '',
        kind: 'model',
        images: noModelImages.sort((a, b) => b.lastModified - a.lastModified),
        count: noModelImages.length
      });
    }

    // `baseModelTableVersion` is belt-and-braces today: the store's own table
    // subscription re-filters and so hands over a fresh `filteredImages` in the
    // same update. It is listed because the version is the contract the store
    // documents for memoized derivations ("a version bump for anything
    // memoized on it"), so this survives `filterAndSort` ever being optimized
    // to preserve array identity — which would otherwise strand these cards.
    return sorted;
  }, [filteredImages, directories, sortBy, baseModelTableVersion]);

  // The blank entry counts as a checkpoint card, as it always has; base model
  // cards are reported separately so the two dimensions stay legible.
  const checkpointCount = modelEntries.filter((entry) => entry.kind === 'model').length;
  const baseModelCount = modelEntries.length - checkpointCount;

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
                key={`${entry.kind}-${entry.name}`}
                modelName={entry.name}
                images={entry.images}
                imageCount={entry.count}
                kind={entry.kind}
                onClick={() => (
                  entry.kind === 'baseModel'
                    ? onBaseModelSelect(entry.name)
                    : onModelSelect(entry.name)
                )}
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
        customText={
          baseModelCount > 0
            ? `Showing ${checkpointCount} models · ${baseModelCount} base models`
            : `Showing ${checkpointCount} models`
        }
      />
    </section>
  );
};

