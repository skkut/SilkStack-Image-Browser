import React, { useRef, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { ZoomIn, ZoomOut } from 'lucide-react';

const ImageSizeSlider: React.FC = () => {
  const activeView = useImageStore((state) => state.activeView);
  const { viewZoomLevels, setViewZoomLevel } = useSettingsStore();
  
  // Current view might be 'library', 'smart', or 'model'
  // If it's something else (unlikely), default to library
  const currentView = useMemo(() => {
    if (activeView === 'smart' || activeView === 'model') return activeView;
    return 'library';
  }, [activeView]);

  const imageSize = viewZoomLevels[currentView] ?? 320;
  
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSizeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setViewZoomLevel(currentView, Number(event.target.value));
  };

  const handleWheel = (event: WheelEvent) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -10 : 10; // Scroll down = zoom out, scroll up = zoom in
    const newSize = Math.max(150, Math.min(500, imageSize + delta));
    setViewZoomLevel(currentView, newSize);
  };

  useEffect(() => {
    const inputElement = inputRef.current;
    if (inputElement) {
      inputElement.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
        inputElement.removeEventListener('wheel', handleWheel);
      };
    }
  }, [imageSize, currentView]);

  const handleZoomOut = () => {
    const newSize = Math.max(150, imageSize - 10);
    setViewZoomLevel(currentView, newSize);
  };

  const handleZoomIn = () => {
    const newSize = Math.min(500, imageSize + 20);
    setViewZoomLevel(currentView, newSize);
  };

  return (
    <div className="flex items-center gap-2">
      <button 
        onClick={handleZoomOut}
        className="p-1 hover:bg-gray-700 rounded transition-colors"
        title="Zoom Out"
      >
        <ZoomOut className="h-5 w-5 text-gray-400" />
      </button>
      <input
        ref={inputRef}
        type="range"
        min="150"
        max="500"
        step="10"
        value={imageSize}
        onChange={handleSizeChange}
        className="w-32 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
        title="Scroll to adjust zoom"
      />
      <button 
        onClick={handleZoomIn}
        className="p-1 hover:bg-gray-700 rounded transition-colors"
        title="Zoom In"
      >
        <ZoomIn className="h-5 w-5 text-gray-400" />
      </button>
    </div>
  );
};

export default ImageSizeSlider;