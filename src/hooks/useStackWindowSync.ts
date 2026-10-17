import { useEffect, useRef } from 'react';
import { useImageStore } from '../store/useImageStore';
import {
  buildStackWindowPayload,
  resolveStackForGroupKey,
} from '../services/stackWindowService';

/**
 * Keep popped-out stack windows in step with the library.
 *
 * A stack window holds a one-time snapshot — its renderer has an empty image
 * store and nothing to re-resolve against. This hook is the other half of
 * that contract: it lives in the main window (the only renderer with the
 * library), tracks which stack windows are open, and re-runs the stack
 * resolution whenever the image list changes, handing each window a fresh
 * payload over `update-stack-window`.
 *
 * Membership is recomputed with `resolveStackForGroupKey` — the same
 * expression the grid and drill-down use — so a window that was opened for a
 * group key follows that group as images are indexed, deleted, refavourited
 * or regrouped.
 */

/**
 * Debounce for the push. Auto-watch indexes in bursts, and every batch
 * replaces the images array, so pushing per store change would send a payload
 * per batch instead of one per settled burst. 400ms is below the point where
 * a new generation appearing in an open window feels delayed.
 */
const PUSH_DEBOUNCE_MS = 400;

export function useStackWindowSync(): void {
  const images = useImageStore((state) => state.images);
  const annotations = useImageStore((state) => state.annotations);
  const directories = useImageStore((state) => state.directories);

  // `windowId -> groupKey` for every open stack window. A ref, because
  // membership of this map must never re-render the app.
  const openWindowsRef = useRef<Map<number, string>>(new Map());
  // `windowId -> signature last delivered`, so a store change that does not
  // touch this stack is not redrawn in its window.
  const lastSentRef = useRef<Map<number, string>>(new Map());
  // The label each window was last titled with. Kept so a stack emptied by a
  // deletion still refreshes its window instead of being skipped for having
  // no base prompt to send.
  const lastLabelRef = useRef<Map<number, string>>(new Map());

  // ── Which windows are open ───────────────────────────────────────────
  useEffect(() => {
    if (!window.electronAPI?.onStackWindowOpened) return;
    const api = window.electronAPI;

    const adopt = (windows: { windowId: number; groupKey: string }[]) => {
      for (const { windowId, groupKey } of windows) {
        // A window without a group key cannot be re-resolved. The app never
        // opens one that way; tracking it anyway would let the empty list we
        // compute for "" wipe a window's contents.
        if (groupKey) openWindowsRef.current.set(windowId, groupKey);
      }
    };

    // A renderer reload (HMR in dev) loses the events that opened these
    // windows, so ask the main process for the live list as well. An older
    // preload without the method is not an error — there is then simply
    // nothing to adopt.
    void api
      .getOpenStackWindows?.()
      .then(adopt)
      .catch(() => {});

    const unsubscribeOpened = api.onStackWindowOpened(({ windowId, groupKey }) => {
      if (groupKey) openWindowsRef.current.set(windowId, groupKey);
    });
    const unsubscribeClosed = api.onStackWindowClosed(({ windowId }) => {
      openWindowsRef.current.delete(windowId);
      lastSentRef.current.delete(windowId);
      lastLabelRef.current.delete(windowId);
    });

    return () => {
      unsubscribeOpened();
      unsubscribeClosed();
    };
  }, []);

  // ── Pushing refreshed membership ─────────────────────────────────────
  useEffect(() => {
    if (!window.electronAPI?.updateStackWindow) return;
    // The common case: no popped-out window, so a library change costs one
    // ref check rather than a resolution pass over every image.
    if (openWindowsRef.current.size === 0) return;

    const timer = setTimeout(() => {
      const api = window.electronAPI;
      if (!api?.updateStackWindow) return;

      for (const [windowId, groupKey] of openWindowsRef.current) {
        const stack = resolveStackForGroupKey(groupKey, images, annotations);
        // A dissolved/emptied group sends an empty list rather than nothing:
        // the window must drop images that no longer exist anywhere, and it
        // renders its own empty state for that payload.
        const basePrompt =
          stack?.basePrompt ?? lastLabelRef.current.get(windowId) ?? '';
        const payload = buildStackWindowPayload(
          groupKey,
          basePrompt,
          stack?.images ?? [],
          directories,
        );

        // Enrichment, sorting and filters replace `images` without changing
        // this stack's members — the serialized payload is the honest test of
        // whether the window would draw anything different.
        const signature = JSON.stringify(payload);
        if (lastSentRef.current.get(windowId) === signature) continue;

        lastSentRef.current.set(windowId, signature);
        lastLabelRef.current.set(windowId, basePrompt);
        api.updateStackWindow(windowId, payload);
      }
    }, PUSH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [images, annotations, directories]);
}
