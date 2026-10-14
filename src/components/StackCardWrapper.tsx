import React, { useCallback } from 'react';
import { ImageStack, IndexedImage } from '../types';
import { useThumbnail } from '../hooks/useThumbnail';
import { safeLazy } from '../utils/safeLazy';
import { useAiFeaturesEnabled } from '../services/aiFeatureAccess';

interface StackCardWrapperProps {
  stack: ImageStack;
  onOpen: () => void;
  /** Right-click handler — receives the stack card's cover (or hovered preview) image. */
  onContextMenu?: (image: IndexedImage, event: React.MouseEvent) => void;
  /** Ctrl/Cmd+click — pop the stack out into its own window instead. */
  onOpenInNewWindow?: () => void;
}

// Lazy-load the package StackCard when AI features are available.
// The compile-time ternary lets Vite/Rolldown tree-shake the import()
// entirely when VITE_AI_FEATURES_AVAILABLE is false.
const StackCardInner = import.meta.env.VITE_AI_FEATURES_AVAILABLE
  ? safeLazy(
      () => import('@ai-images-browser/ai-intelligence'),
      'StackCard',
      (mod) => (mod as any).StackCard,
    )
  : null;

/**
 * Invisible component that triggers thumbnail loading for a single image.
 * Using a dedicated component (rather than calling useThumbnail in a loop)
 * keeps the hooks call count deterministic regardless of stack size.
 */
const ThumbnailPreloader: React.FC<{ image: IndexedImage | null }> = ({ image }) => {
  useThumbnail(image);
  return null;
};

/**
 * Wrapper around the ai-intelligence StackCard that triggers thumbnail
 * loading for ALL images in the stack before rendering the card.
 *
 * We preload every image (not just the cover) so the hover-based image
 * scrubbing slider works immediately — without this, only the cover
 * image's thumbnail is available and scrubbing shows blank frames.
 *
 * Keep in sync with the package's StackCardProps interface.
 *
 * Ctrl/Cmd+click is caught here, on a capture-phase listener, rather than by
 * widening the package's `onOpen()` signature. StackCard is MPL-covered
 * source: the package's own onClick must keep firing unmodified for a plain
 * click, and an edit would have to be mirrored byte-for-byte into
 * `mpl-covered-sources/`. Capturing on the wrapper gets the modifier to the
 * app without touching the card at all — the capture phase runs before the
 * button's own handler, and stopping it there is what keeps the drill-down
 * from ALSO opening in the main window.
 */
const StackCardWrapper: React.FC<StackCardWrapperProps> = ({
  stack,
  onOpen,
  onContextMenu,
  onOpenInNewWindow,
}) => {
  // Trigger thumbnail loading for every image in the stack.
  // StackCard's hover scrubber switches between images[previewIndex]
  // thumbnails — all of them must be available for smooth scrubbing.
  const images = stack.images as IndexedImage[];
  const aiFeaturesEnabled = useAiFeaturesEnabled();

  const handleClickCapture = useCallback(
    (event: React.MouseEvent) => {
      if (!onOpenInNewWindow || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      event.stopPropagation();
      onOpenInNewWindow();
    },
    [onOpenInNewWindow],
  );

  if (!aiFeaturesEnabled || !StackCardInner) {
    return null;
  }

  const Inner = StackCardInner;
  return (
    <>
      {images.map((img) => (
        <ThumbnailPreloader key={img.id} image={img} />
      ))}
      {/* `contents` so this element generates no box: the card's own root must
          stay the grid item it was before, or the grid's default
          `align-items: stretch` would stretch this wrapper instead of the card
          and cards in a row would stop matching each other's height. React
          dispatches through the fiber tree, so a boxless element still gets the
          capture handler. */}
      <div className="contents" onClickCapture={handleClickCapture}>
        <Inner stack={stack as any} onOpen={onOpen} onContextMenu={onContextMenu as any} />
      </div>
    </>
  );
};

export default StackCardWrapper;
