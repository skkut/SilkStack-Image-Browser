import React, { useState, useRef, useEffect } from 'react';
import {
  Star,
  Trash2,
  X
} from 'lucide-react';
import { useImageStore } from '../store/useImageStore';
import { type IndexedImage } from '../types';

import ActiveFilters from './ActiveFilters';

interface GridToolbarProps {

  selectedImages: Set<string>;
  images: IndexedImage[];
  directories: { id: string; path: string }[];
  onDeleteSelected: () => void;
  onClearSelection?: () => void;
}

const showNotification = (message: string, type: 'success' | 'error' = 'success') => {
  const notification = document.createElement('div');
  notification.className = `fixed top-4 right-4 ${type === 'success' ? 'bg-green-600' : 'bg-red-600'} text-white px-4 py-2 rounded-lg shadow-lg z-50`;
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => {
    if (document.body.contains(notification)) {
      document.body.removeChild(notification);
    }
  }, 2000);
};

const GridToolbar: React.FC<GridToolbarProps> = ({
  selectedImages,
  images,
  directories,
  onDeleteSelected,
  onClearSelection,
}) => {
  const toggleFavorite = useImageStore((state) => state.toggleFavorite);



  // ... (rest of the file)

  const selectedCount = selectedImages.size;
  const selectedImagesList = images.filter(img => selectedImages.has(img.id));
  const firstSelectedImage = selectedImagesList[0];
  // Check if all selected images are favorites
  const allFavorites = selectedImagesList.length > 0 && selectedImagesList.every(img => img.isFavorite);





  const handleToggleFavorites = () => {
    selectedImagesList.forEach(img => toggleFavorite(img.id));
  };



  const selectedModels = useImageStore((state) => state.selectedModels);
  const selectedLoras = useImageStore((state) => state.selectedLoras);
  const selectedSchedulers = useImageStore((state) => state.selectedSchedulers);
  const selectedTags = useImageStore((state) => state.selectedTags);
  const searchQuery = useImageStore((state) => state.searchQuery);
  const showFavoritesOnly = useImageStore((state) => state.showFavoritesOnly);

  const advancedFilters = useImageStore((state) => state.advancedFilters);

  const hasActiveFilters = 
      selectedModels.length > 0 ||
      selectedLoras.length > 0 ||
      selectedSchedulers.length > 0 ||
      selectedTags.length > 0 ||
      !!searchQuery ||
      showFavoritesOnly ||
      (advancedFilters && (
        !!advancedFilters.dateRange?.from || 
        !!advancedFilters.dateRange?.to || 
        (advancedFilters.steps && (advancedFilters.steps.min !== 0 || advancedFilters.steps.max !== 150)) || 
        (advancedFilters.cfgScale && (advancedFilters.cfgScale.min !== 0 || advancedFilters.cfgScale.max !== 30)) || 
        (advancedFilters.width && (advancedFilters.width.min !== 64 || advancedFilters.width.max !== 2048)) || 
        (advancedFilters.height && (advancedFilters.height.min !== 64 || advancedFilters.height.max !== 2048)) ||
        advancedFilters.isVerifiedOnly
      ));

  if (selectedCount === 0 && !hasActiveFilters) {
    return null;
  }

  return (
    <div 
      className="flex items-center gap-2 h-full min-w-0"
      style={{ WebkitAppRegion: 'no-drag' } as any}
    >
      {/* Selection Context Toolbar - Centered or justified as needed */}
      <div className="flex items-center gap-1 flex-1 overflow-hidden">
          {selectedCount > 0 && (
            <>
              <div className="flex items-center gap-1.5 mr-2">
                <span className="text-[11px] text-gray-400 whitespace-nowrap">{selectedCount} selected</span>
                <button
                  onClick={onClearSelection}
                  className="p-0.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded-full transition-colors flex-shrink-0"
                  title="Deselect All"
                  aria-label="Deselect All"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>







              {/* Favorites */}
              <button
                onClick={handleToggleFavorites}
                className={`p-1.5 rounded transition-colors ${
                  allFavorites
                    ? 'text-yellow-400 hover:text-yellow-300 hover:bg-gray-700'
                    : 'text-gray-400 hover:text-yellow-400 hover:bg-gray-700'
                }`}
                title={allFavorites ? 'Remove from Favorites' : 'Add to Favorites'}
              >
                <Star className={`w-4 h-4 ${allFavorites ? 'fill-current' : ''}`} />
              </button>



              {/* Divider */}
              <div className="w-px h-4 bg-gray-700 mx-1" />

              {/* Delete */}
              <button
                onClick={onDeleteSelected}
                className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                title="Delete Selected"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              
              {/* Divider between selection tools and filters if both exist */}
              {hasActiveFilters && <div className="w-px h-6 bg-gray-600 mx-2 flex-shrink-0" />}
            </>
          )}

          {/* Active Filters */}
          <div className="flex-1 min-w-0">
             <ActiveFilters />
          </div>
      </div>
    </div>
  );
};

export default GridToolbar;
