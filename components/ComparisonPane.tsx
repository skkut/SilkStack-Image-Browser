import React, { useState, useEffect, useRef, FC } from 'react';
import { TransformWrapper, TransformComponent, ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import { ZoomIn, ZoomOut, RotateCcw, AlertCircle } from 'lucide-react';
import { ComparisonPaneProps } from '../types';
import useComparisonImageSource from '../hooks/useComparisonImageSource';

const ComparisonPane: FC<ComparisonPaneProps> = ({
  image,
  directoryPath,
  position,
  syncEnabled,
  externalZoom,
  onZoomChange
}) => {
  const transformRef = useRef<ReactZoomPanPinchRef>(null);
  const { imageUrl, loadError } = useComparisonImageSource(image, directoryPath);

  // Apply external zoom when sync enabled
  useEffect(() => {
    if (syncEnabled && externalZoom && transformRef.current) {
      const { setTransform } = transformRef.current;
      setTransform(externalZoom.x, externalZoom.y, externalZoom.zoom, 0);
    }
  }, [syncEnabled, externalZoom]);

  if (loadError) {
    return (
      <div className="w-full md:w-1/2 flex items-center justify-center bg-gray-900/50 border-r border-gray-700">
        <div className="text-center p-8">
          <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <p className="text-red-300 font-semibold">Failed to load image</p>
          <p className="text-gray-400 text-sm mt-2">{image.name}</p>
          <p className="text-gray-500 text-xs mt-1">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`w-full md:w-1/2 h-[50vh] md:h-full relative group bg-black ${position === 'left' ? 'md:border-r' : 'md:border-l'} border-gray-700`}>
      <TransformWrapper
        ref={transformRef}
        initialScale={1}
        minScale={0.5}
        maxScale={5}
        centerOnInit
        wheel={{ step: 0.1 }}
        onTransformed={(ref) => {
          if (onZoomChange) {
            const { positionX, positionY, scale } = ref.state;
            onZoomChange(scale, positionX, positionY);
          }
        }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent
              wrapperClass="w-full h-full"
              contentClass="w-full h-full flex items-center justify-center"
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt={image.name}
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full border-4 border-gray-700 border-t-blue-500 animate-spin" />
                </div>
              )}
            </TransformComponent>

            {/* Zoom Controls - Always visible on mobile, hover on desktop */}
            <div className="absolute top-4 right-4 flex flex-col gap-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity z-10">
              <button
                onClick={() => zoomIn()}
                className="p-2 bg-black/60 hover:bg-black/80 rounded-lg backdrop-blur-sm transition-colors"
                title="Zoom In"
              >
                <ZoomIn className="w-5 h-5 text-white" />
              </button>
              <button
                onClick={() => zoomOut()}
                className="p-2 bg-black/60 hover:bg-black/80 rounded-lg backdrop-blur-sm transition-colors"
                title="Zoom Out"
              >
                <ZoomOut className="w-5 h-5 text-white" />
              </button>
              <button
                onClick={() => resetTransform()}
                className="p-2 bg-black/60 hover:bg-black/80 rounded-lg backdrop-blur-sm transition-colors"
                title="Reset Zoom"
              >
                <RotateCcw className="w-5 h-5 text-white" />
              </button>
            </div>

            {/* Image Name Label */}
            <div className="absolute bottom-4 left-4 right-4 bg-black/60 backdrop-blur-sm rounded-lg p-2">
              <p className="text-white text-sm font-medium truncate" title={image.name}>
                {image.name}
              </p>
            </div>
          </>
        )}
      </TransformWrapper>

    </div>
  );
};

export default React.memo(ComparisonPane, (prev, next) => {
  return (
    prev.image.id === next.image.id &&
    prev.syncEnabled === next.syncEnabled &&
    prev.externalZoom?.zoom === next.externalZoom?.zoom &&
    prev.externalZoom?.x === next.externalZoom?.x &&
    prev.externalZoom?.y === next.externalZoom?.y
  );
});
