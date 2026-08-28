/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import { ImageStack, StackImage } from '../core/stacking-types';

export interface StackCardProps {
  stack: ImageStack;
  onOpen: () => void;
  /** Right-click handler — receives the currently previewed image (the cover at rest). */
  onContextMenu?: (image: StackImage, event: React.MouseEvent) => void;
}

/**
 * Interactive stack card with hover-based image scrubbing.
 *
 * Thumbnail loading is the parent's responsibility — the wrapper
 * in the main app calls `useThumbnail()` before rendering this component.
 */
const StackCard: React.FC<StackCardProps> = ({ stack, onOpen, onContextMenu }) => {
  const [previewIndex, setPreviewIndex] = useState(0);
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingIndexRef = useRef(0);

  const images = stack.images;
  const previewImage = images[previewIndex] ?? images[0] ?? null;

  useEffect(() => {
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

  const promptLabel = stack.basePrompt || previewImage?.prompt || 'Untitled stack';
  const coverUrl = previewImage?.thumbnailUrl || '';
  const displayCount = stack.count;
  const subGroupCount = stack.subGroups?.length || 0;
  const countLabel = `${displayCount}`;
  const detailLabel = subGroupCount > 1
    ? `${displayCount} images · ${subGroupCount} prompt variations`
    : `${displayCount} images`;

  return (
    <button
      ref={cardRef}
      onClick={onOpen}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onContextMenu={(e) => {
        if (onContextMenu && previewImage) {
          e.preventDefault();
          onContextMenu(previewImage, e);
        }
      }}
      className="group text-left bg-white border border-gray-200 rounded-2xl overflow-hidden shadow-md transition-all hover:shadow-xl hover:shadow-blue-500/10 dark:bg-gray-900/60 dark:border-gray-800 dark:shadow-lg dark:hover:shadow-blue-500/20"
      type="button"
    >
      <div className="relative aspect-[4/5] overflow-hidden">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={promptLabel}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-gray-100 via-gray-200 to-gray-100 flex items-center justify-center text-gray-400 dark:from-gray-800 dark:via-gray-900 dark:to-gray-800 dark:text-gray-400">
            <Layers className="w-8 h-8 opacity-70" />
          </div>
        )}

        <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-gray-100 shadow-sm backdrop-blur-sm dark:bg-black/60 dark:shadow-none">
          <Layers className="w-3.5 h-3.5" />
          {countLabel}
        </div>

        {images.length > 1 && (
          <div className="absolute bottom-3 left-3 right-3 h-1 rounded-full bg-black/20 overflow-hidden dark:bg-black/40">
            <div
              className="h-full bg-blue-400/80 transition-all duration-100"
              style={{
                width: images.length > 1 ? `${(previewIndex / (images.length - 1)) * 100}%` : '0%',
              }}
            />
          </div>
        )}
      </div>
      <div className="p-3">
        <p className="text-sm font-semibold text-gray-100 truncate">{promptLabel}</p>
        <p className="text-xs text-gray-300 mt-1">{detailLabel}</p>
      </div>
    </button>
  );
};

export default StackCard;
