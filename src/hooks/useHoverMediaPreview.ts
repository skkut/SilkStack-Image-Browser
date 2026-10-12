import { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexedImage } from '../types';
import { hoverPreview, type HoverSession } from '../services/hoverPreviewCoordinator';
import { isVideoFileName } from '../utils/mediaTypes';

/**
 * How the card should present a preview that has arrived: a video needs its
 * own element, an animated GIF just needs its bytes in an <img>.
 */
export type HoverPreviewKind = 'video' | 'image';

export interface HoverMediaPreview {
  /** Blob URL of the preview, or null while only the poster should show. */
  previewUrl: string | null;
  /** Null exactly when previewUrl is null. */
  previewKind: HoverPreviewKind | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  /** Abandon a preview in progress — call when a drag or the viewer opens. */
  cancel: () => void;
}

const IDLE: { previewUrl: null; previewKind: null } = { previewUrl: null, previewKind: null };

/**
 * Hover-to-play preview for animated media in a grid card.
 *
 * All the policy (dwell, cache, single-active, size guard) lives in
 * `hoverPreviewCoordinator`; this is only the React binding around it. Cards
 * render the returned URL over their poster while the pointer rests on them.
 *
 * @param image - The card's image. Videos and GIFs only; anything else is a no-op.
 */
export function useHoverMediaPreview(image: IndexedImage | null | undefined): HoverMediaPreview {
  const [state, setState] = useState<{
    previewUrl: string | null;
    previewKind: HoverPreviewKind | null;
  }>(IDLE);

  const sessionRef = useRef<HoverSession | null>(null);
  const imageId = image?.id ?? null;

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.cancel();
    setState(IDLE);
  }, []);

  // A virtualized card is recycled onto a different image without unmounting,
  // so the preview has to be dropped when the image changes, not only on
  // unmount — otherwise the old media would keep playing on the new card.
  useEffect(() => () => cancel(), [cancel, imageId]);

  const onMouseEnter = useCallback(() => {
    if (!image) return;

    const session = hoverPreview.activate(image);
    sessionRef.current = session;
    const previewKind: HoverPreviewKind = isVideoFileName(image.name, image.fileType)
      ? 'video'
      : 'image';

    void session.url.then((previewUrl) => {
      // Ignore a result that arrived after the pointer left, after another card
      // took the preview over, or for media that turned out to be unreadable.
      if (!previewUrl || sessionRef.current !== session) return;
      setState({ previewUrl, previewKind });
    });
  }, [image]);

  return {
    previewUrl: state.previewUrl,
    previewKind: state.previewKind,
    onMouseEnter,
    onMouseLeave: cancel,
    cancel,
  };
}
