import React, { useRef, useState } from 'react';
import { Box, Boxes } from 'lucide-react';
import { IndexedImage } from '../types';
import { useThumbnail } from '../hooks/useThumbnail';

/**
 * The two families the Models view groups by. They are kept apart rather than
 * merged into one concept because they are different dimensions of the same
 * image — a base model is resolved *from* a checkpoint — and because a
 * checkpoint and a base model could in principle share a name.
 */
export type ModelCardKind = 'model' | 'baseModel';

interface ModelCardProps {
  modelName: string;
  images: IndexedImage[];
  imageCount: number;
  /** Presentation only; the parent supplies the click handler for each kind. */
  kind?: ModelCardKind;
  onClick: () => void;
}

const ModelCard: React.FC<ModelCardProps> = ({ modelName, images, imageCount, kind = 'model', onClick }) => {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const rafRef = useRef<number | null>(null);
  const pendingIndexRef = useRef(0);

  const previewImage = images[previewIndex] ?? images[0] ?? null;

  // Base model cards borrow the Base Model readout's icon (ImageModal) and the
  // footer pill's indigo, so the three places that name a base model agree.
  const isBaseModel = kind === 'baseModel';
  const CountIcon = isBaseModel ? Boxes : Box;
  
  // Use the hook to load the thumbnail handling changes in previewImage
  useThumbnail(previewImage);

  React.useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  const updatePreviewIndex = (nextIndex: number) => {
    pendingIndexRef.current = nextIndex;
    if (rafRef.current !== null) {
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      setPreviewIndex(pendingIndexRef.current);
      rafRef.current = null;
    });
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!cardRef.current || images.length < 2) return;
    const rect = cardRef.current.getBoundingClientRect();
    const relativeX = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const ratio = rect.width > 0 ? relativeX / rect.width : 0;
    const index = Math.floor(ratio * (images.length - 1));
    updatePreviewIndex(index);
  };

  const handlePointerLeave = () => {
    updatePreviewIndex(0);
  };

  const coverUrl = previewImage?.thumbnailUrl || '';
  const displayName = modelName || '(no model)';

  return (
    <button
      ref={cardRef}
      onClick={onClick}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      className={`group text-left bg-gray-900/60 border border-gray-800 rounded-2xl overflow-hidden shadow-lg transition-all hover:shadow-xl cursor-pointer ${
        isBaseModel
          ? 'hover:shadow-indigo-500/20 hover:border-indigo-500/30'
          : 'hover:shadow-blue-500/20 hover:border-blue-500/30'
      }`}
      type="button"
    >
      <div className="relative aspect-[4/5] overflow-hidden">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={displayName}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-gray-800 via-gray-900 to-gray-800 flex items-center justify-center text-gray-400">
            <CountIcon className="w-8 h-8 opacity-70" />
          </div>
        )}

        <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-semibold text-gray-100">
          <CountIcon className="w-3.5 h-3.5" />
          {imageCount}
        </div>
        
        {/* Overlay gradient for text readability */}
        <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />

        {/* Hover Progress Bar */}
        {images.length > 1 && (
          <div className="absolute bottom-3 left-3 right-3 h-1 rounded-full bg-black/40 overflow-hidden z-10">
            <div
              className="h-full bg-blue-400/80 transition-all duration-100"
              style={{
                width: `${(previewIndex / (images.length - 1)) * 100}%`,
              }}
            />
          </div>
        )}
      </div>
      
      <div className="p-3">
        <p className="text-sm font-semibold text-gray-100 truncate" title={displayName}>
          {displayName}
        </p>
        {isBaseModel && (
          <span className="mt-1.5 inline-flex items-center rounded border border-indigo-700/50 bg-indigo-900/40 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-200">
            Base model
          </span>
        )}
        <p className="text-xs text-gray-400 mt-1">
          {imageCount} image{imageCount !== 1 ? 's' : ''}
        </p>
      </div>
    </button>
  );
};

export default ModelCard;
