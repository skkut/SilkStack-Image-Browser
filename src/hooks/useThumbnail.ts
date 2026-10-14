import { useEffect, useRef } from 'react';
import { IndexedImage } from '../types';

import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
// Static on purpose: useImageStore imports this module statically, so it is
// already in the entry chunk. A dynamic import here cannot split anything and
// only earns an INEFFECTIVE_DYNAMIC_IMPORT warning.
import { thumbnailManager } from '../services/thumbnailManager';

/**
 * Request a thumbnail for one mounted card.
 *
 * Called once per rendered cell. react-window mounts only the visible rows plus
 * overscan, so "ask for the thumbnail" is already scoped to what is plausibly
 * on screen — this hook never walks the library.
 *
 * Thumbnails are requested *during* indexing too. Suppressing them for the
 * whole indexing window was the main reason a large library looked broken on
 * first run: a video's only poster source is its thumbnail, so a video-heavy
 * folder stayed a wall of blank cards for the length of the run, however well
 * the catalog itself streamed in. The contention that suppression was guarding
 * against is real but belongs in the manager — `thumbnailManager` lowers its
 * concurrency while indexing instead of refusing the work outright.
 *
 * Note there is deliberately no `indexingState` subscription here: it existed
 * only to gate the suppression, and every mounted card re-rendering each time
 * indexing started or stopped is a cost with no remaining purpose.
 */
export function useThumbnail(image: IndexedImage | null): void {
  const disableThumbnails = useSettingsStore((state) => state.disableThumbnails);
  const loadingRef = useRef<Set<string>>(new Set());
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const imageId = image?.id ?? null;

  useEffect(() => {
    if (disableThumbnails || !imageId) {
      return;
    }

    // Check CURRENT store state (not the possibly stale prop) before starting.
    // A card can be handed a stub from a render that predates the image's
    // enrichment, and the fresh record carries the up-to-date handle.
    const storeState = useImageStore.getState();
    const currentImage = storeState.images.find((img) => img.id === imageId);

    if (
      currentImage?.thumbnailStatus === 'ready' ||
      currentImage?.thumbnailStatus === 'loading'
    ) {
      return;
    }

    // Prevent duplicate loads from the same hook instance
    if (loadingRef.current.has(imageId)) {
      return;
    }

    // Debounce one React frame. A card scrolled past at speed mounts and
    // unmounts inside this window, so the job is never created at all.
    timeoutRef.current = setTimeout(() => {
      loadingRef.current.add(imageId);

      void (async () => {
        try {
          await thumbnailManager.ensureThumbnail(currentImage ?? image!);
        } catch (error) {
          console.error('Failed to ensure thumbnail:', error);
        } finally {
          loadingRef.current.delete(imageId);
        }
      })();
    }, 16);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      loadingRef.current.delete(imageId);
      // Drop work that has not started yet. A fast scroll unmounts cards as
      // quickly as it mounts them, and a queued job for a card that is no
      // longer on screen competes for a slot with one that is. A load already
      // in flight is deliberately left alone — it caches its result, so coming
      // back to the card is instant and the decode is not thrown away.
      thumbnailManager.cancel(imageId);
    };
  }, [imageId, disableThumbnails]);
}
