import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import { type IndexedImage, type StackWindowPayload } from '../types';
import SimilarityStackExpandedViewWrapper from './SimilarityStackExpandedViewWrapper';
import { getImageMediaUrl } from '../utils/mediaUrl';
import { compactOpenHint } from '../hooks/useImageSelection';
import { serializeStackImages } from '../services/stackWindowService';
import { useAiFeaturesEnabled } from '../services/aiFeatureAccess';

/**
 * StackWindow — a similarity stack popped out into its own Electron window
 * (`?stackWindow=true`).
 *
 * The window is a separate renderer with an EMPTY image store, so nothing
 * store-driven works here: the stack arrives as a payload snapshot over the
 * `stack-window-ready` handshake, thumbnails are fetched from the on-disk
 * cache (the same `get-thumbnail` IPC the dev testers use) instead of the
 * store-bound `thumbnailManager`, and edits are forwarded back to the main
 * window, which owns the real store.
 *
 * Everything the user can DO here is deliberately read-mostly: browse the
 * stack, favourite an image, open one in the image viewer, change the
 * grouping dimensions (a persisted setting, shared through the settings file).
 */

/** Height of the drag bar — matches the OS title-bar overlay the window uses. */
const DRAG_BAR_HEIGHT = 32;

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];

const isVideoAsset = (image: IndexedImage): boolean => {
  if (image.fileType?.startsWith('video/')) return true;
  const name = (image.name || '').toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
};

/**
 * Rebuild an `IndexedImage` from its wire form.
 *
 * The handle is a stub without `getFile` on purpose: every path that would
 * read the file — the hover preview, the media URL builder — checks for a
 * usable handle and falls back to the absolute path. Giving it a *fake*
 * `getFile` would be worse than giving it none, because the fallback is the
 * working path. The stub does carry `_filePath`, though: that is the field
 * `getImageAbsolutePath` reads first, and it is the only location source that
 * does not depend on the payload's directory map having an entry for this
 * image, so keeping it makes path resolution work even for an image whose
 * directory is not in the map.
 *
 * `thumbnailUrl` and the handle are cleared back to "unknown" rather than
 * inherited. Both are renderer-bound: the URL is a `blob:` minted by the main
 * window (meaningless here) and the handle cannot cross IPC at all — and the
 * card the stack view renders will only draw an image once its status says the
 * bytes are actually in hand, so anything inherited would be a lie this window
 * then has no reason to correct.
 */
const reconstructImage = (raw: any): IndexedImage => {
  const { handlePath, handle: _handle, ...rest } = raw;
  return {
    ...rest,
    thumbnailUrl: undefined,
    thumbnailStatus: 'loading',
    thumbnailHandle: undefined,
    handle: {
      name: raw.name,
      kind: 'file' as const,
      ...(handlePath ? { _filePath: handlePath } : {}),
    } as unknown as FileSystemFileHandle,
  } as IndexedImage;
};

/**
 * Narrow an IPC byte payload to a real `ArrayBuffer`.
 *
 * `BlobPart` accepts only `ArrayBuffer`, never the `SharedArrayBuffer` half of
 * `ArrayBufferLike`, and a view's backing store is the whole (possibly shared,
 * possibly larger) buffer — so the bytes are copied into a fresh one rather
 * than handed over by reference. Same helper the dev testers use for the
 * identical `get-thumbnail` payload.
 */
const toArrayBuffer = (data: ArrayBuffer | ArrayBufferView): ArrayBuffer => {
  if (data instanceof ArrayBuffer) return data;
  const view = data as ArrayBufferView;
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
};

/**
 * Input types that own Escape while they have focus.
 *
 * `<input type="checkbox">` is an `<input>` too, but Escape means nothing to a
 * checkbox — and clicking one is what a user does in this window's header
 * before ever reaching for the keyboard — so treating every INPUT as "the user
 * is typing" would disable the shortcut for exactly those users.
 */
const TEXT_ENTRY_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'password', 'tel', 'number',
]);

const isTextEntryTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (!element || !element.tagName) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  const type = (element as HTMLInputElement).type || 'text';
  return TEXT_ENTRY_INPUT_TYPES.has(type.toLowerCase());
};

const StackWindow: React.FC = () => {
  const aiFeaturesEnabled = useAiFeaturesEnabled();
  const [payload, setPayload] = useState<StackWindowPayload | null>(null);
  const [images, setImages] = useState<IndexedImage[]>([]);
  const [selectedImages, setSelectedImages] = useState<Set<string>>(() => new Set());
  // Every blob URL this window creates, so they are all revoked on unmount and
  // when a new payload replaces the old one (a refreshed stack).
  const objectUrlsRef = useRef<string[]>([]);

  // ── Theme ────────────────────────────────────────────────────────────
  // Same contract as the viewer window: the OS decides, and later changes
  // arrive over `theme-updated`.
  useEffect(() => {
    const applyTheme = (systemShouldUseDark: boolean) => {
      if (systemShouldUseDark) {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme', 'light');
      }
    };

    if (window.electronAPI) {
      window.electronAPI.getTheme().then(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });
      const unsubscribe = window.electronAPI.onThemeUpdated(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });
      return () => {
        if (unsubscribe) unsubscribe();
      };
    }
    applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);

  // ── Payload handshake ────────────────────────────────────────────────
  // The first payload is the snapshot the window opened with; later ones are
  // live refreshes from the main window (see `useStackWindowSync`), which
  // re-resolves this stack whenever the library changes. An empty list is a
  // valid refresh: the group dissolved or every member was deleted, and the
  // window must drop the images rather than keep showing ghosts.
  useEffect(() => {
    if (!window.electronAPI?.onStackWindowUpdate) return;
    const unsubscribe = window.electronAPI.onStackWindowUpdate((data) => {
      if (!data || !Array.isArray(data.imageList)) return;

      setPayload(data);
      setImages((previous) => {
        // Carry a resolved thumbnail across a refresh. A new image joining
        // the stack re-sends the whole member list, and re-resolving every
        // member would mean a cache read and a fresh blob URL for images that
        // are already on screen. The key includes `lastModified` because a
        // replaced file must be re-read, not shown from the old bytes.
        const reusable = new Map<string, string>(
          previous
            .filter((image) => image.thumbnailStatus === 'ready' && image.thumbnailUrl)
            .map((image) => [`${image.id}-${image.lastModified}`, image.thumbnailUrl as string]),
        );
        return data.imageList.map((raw: any) => {
          const rebuilt = reconstructImage(raw);
          const url = reusable.get(`${rebuilt.id}-${rebuilt.lastModified}`);
          return url
            ? { ...rebuilt, thumbnailUrl: url, thumbnailStatus: 'ready' as const }
            : rebuilt;
        });
      });
      // Selection is this window's own state; keep the part of it that still
      // refers to images in the refreshed stack.
      setSelectedImages((previous) => {
        const ids = new Set(data.imageList.map((raw: any) => raw.id));
        return new Set([...previous].filter((id) => ids.has(id)));
      });
    });
    return () => unsubscribe();
  }, []);

  // Ask the main process for the payload. Sent after the listener above is
  // registered — the reply is a `send` back to this window, so a request made
  // during the same tick as the subscription could otherwise be missed.
  useEffect(() => {
    window.electronAPI?.stackWindowReady?.();
  }, []);

  // ── Thumbnails ───────────────────────────────────────────────────────
  // `thumbnailManager` publishes its results into the image store, which is
  // empty here, so this window reads the same on-disk cache directly through
  // the `get-thumbnail` IPC — the key is `${id}-${lastModified}`, exactly what
  // the main window's manager caches under.
  useEffect(() => {
    if (!payload || images.length === 0) return;
    if (!window.electronAPI?.getThumbnail) return;

    let cancelled = false;

    const resolveUrl = async (image: IndexedImage): Promise<string | null> => {
      try {
        const key = `${image.id}-${image.lastModified}`;
        const cached = await window.electronAPI!.getThumbnail(key);
        if (cached?.success && cached.data) {
          const bytes = cached.data as ArrayBuffer | ArrayBufferView;
          // Tracking of the returned URL is the caller's job (see below) —
          // this function owns creation only.
          return URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: 'image/webp' }));
        }
      } catch {
        // Fall through to the full-size fallback below.
      }

      // Cache miss. Stills fall back to the file itself over the app's media
      // protocol — correct, just heavier. Videos do not: a poster has to be a
      // decoded frame, and the card renders its own placeholder rather than
      // pretending a video file is an image.
      if (isVideoAsset(image)) return null;
      return getImageMediaUrl(image, image.directoryId && payload.directoryPaths[image.directoryId]);
    };

    void (async () => {
      // A refresh keeps the ready thumbnails of members that were already on
      // screen (see the payload handler), so only the newcomers need a lookup.
      const pending = images
        .map((image, index) => ({ image, index }))
        .filter(
          ({ image }) => !(image.thumbnailStatus === 'ready' && image.thumbnailUrl),
        );

      const resolved = await Promise.all(
        pending.map(({ image }) => resolveUrl(image)),
      );
      if (cancelled) {
        resolved.forEach((url) => url && URL.revokeObjectURL(url));
        return;
      }

      // Only blob URLs are ours to release; the media-protocol fallback is a
      // URL the main process serves, and revoking it would be meaningless.
      const created = resolved.filter((url): url is string => !!url && url.startsWith('blob:'));
      objectUrlsRef.current.push(...created);

      const byIndex = new Map<number, string | null>(
        pending.map(({ index }, position) => [index, resolved[position]] as const),
      );

      setImages((previous) =>
        previous.map((image, index) => {
          if (!byIndex.has(index)) return image;
          const url = byIndex.get(index);
          // The URL and the status have to land together, because the card
          // draws an <img> for `ready`+URL and its spinner for anything else —
          // there is no third branch. A URL without the status spins forever
          // (the bug this pairing exists to fix); a status without a URL would
          // ask for a picture that is not there. An image nothing could be
          // resolved for is marked `error` rather than left `loading`, so its
          // state is at least final and honest.
          return url
            ? { ...image, thumbnailUrl: url, thumbnailStatus: 'ready' as const }
            : { ...image, thumbnailUrl: undefined, thumbnailStatus: 'error' as const };
        }),
      );
    })();

    return () => {
      cancelled = true;
    };
    // Keyed on the payload identity only: a re-delivered stack re-resolves, and
    // the per-image updates above deliberately do not retrigger it — keying on
    // `images` would re-enter this effect every time it resolved a thumbnail.
  }, [payload]);

  // Revoke every blob URL this window made when it goes away.
  useEffect(() => () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current = [];
  }, []);

  // ── Closing ──────────────────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (window.electronAPI?.stackWindowClose) {
      window.electronAPI.stackWindowClose();
    } else {
      window.close();
    }
  }, []);

  // Escape leaves this window — the same gesture that closes the viewer window
  // and the in-app drill-down. It is registered here rather than on the stack
  // view on purpose: the payload handshake can stall (the listener only asks
  // for the payload once, on mount), and the loading state must not be a room
  // with no door. A key typed into a text field is that field's to handle; this
  // window has none today, so the guard is here for whoever adds one.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isTextEntryTarget(event.target)) return;
      handleClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  // ── Opening an image ─────────────────────────────────────────────────
  // Self-contained, like the viewer's own navigation: this window already
  // holds the stack, so it can build the viewer payload without asking the
  // main window for anything.
  const handleImageClick = useCallback((image: IndexedImage) => {
    if (!window.electronAPI?.openImageViewer || !payload) return;

    const index = images.findIndex((candidate) => candidate.id === image.id);
    const directoryPath = payload.directoryPaths[image.directoryId] || '';

    window.electronAPI
      .openImageViewer({
        imageId: image.id,
        directoryPath,
        currentIndex: index === -1 ? 0 : index,
        totalImages: images.length,
        imageList: serializeStackImages(images),
        ...compactOpenHint(image),
      })
      .catch(() => {
        // A refused viewer window is not worth interrupting the stack for.
      });
  }, [images, payload]);

  // ── Favourites ───────────────────────────────────────────────────────
  // Toggled locally for an instant star, and forwarded so the main window's
  // store — the real one — records it.
  const handleToggleFavorite = useCallback((imageId: string) => {
    setImages((previous) =>
      previous.map((image) =>
        image.id === imageId ? { ...image, isFavorite: !image.isFavorite } : image,
      ),
    );
    window.electronAPI?.stackWindowAction?.({ type: 'toggleFavorite', imageId });
  }, []);

  const handleToggleSelection = useCallback((imageId: string) => {
    setSelectedImages((previous) => {
      const next = new Set(previous);
      if (next.has(imageId)) {
        next.delete(imageId);
      } else {
        next.add(imageId);
      }
      return next;
    });
  }, []);

  // Only the ABSENCE of a payload means "still loading" — an empty image list
  // is a real answer (the stack emptied while the window was open) and has its
  // own state below.
  if (!payload) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm">Loading stack…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-950 flex flex-col">
      {/* Drag bar. The window is frameless with a 32px title-bar overlay, so
          this strip is both the only place the window can be dragged from and
          the spacer that keeps the stack's own header out from under the OS
          window controls. */}
      <div
        className="flex items-center gap-2 px-3 shrink-0 bg-gray-900/60 border-b border-gray-800/60 select-none"
        style={{ height: DRAG_BAR_HEIGHT, WebkitAppRegion: 'drag' } as any}
      >
        <Layers size={14} className="text-blue-400 shrink-0" />
        <span className="text-xs font-semibold text-gray-300 truncate">
          {payload.basePrompt || 'Stack'}
        </span>
        <span className="text-[11px] text-gray-500 shrink-0">
          {images.length} {images.length === 1 ? 'image' : 'images'}
        </span>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {/* A live refresh can empty the stack entirely: the group dissolved,
            or every member was deleted. Saying so is better than the spinner
            the loading state would otherwise show forever. */}
        {images.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
            <Layers size={22} className="text-gray-600" />
            <p className="text-sm text-gray-400">This stack is empty</p>
            <p className="text-xs text-gray-500 max-w-sm">
              Its images were removed from the library or moved to another stack.
            </p>
          </div>
        ) : aiFeaturesEnabled ? (
          /* The stack view itself is an AI feature and renders nothing without
             one (see the gate in SimilarityStackExpandedViewWrapper). Without
             this, a window opened by a user who is not entitled to it would be a
             drag bar over an empty pane, which reads as a broken window rather
             than a feature that is switched off. The drag bar above deliberately
             stays: it carries the label, the count and the close button. */
          <SimilarityStackExpandedViewWrapper
            images={images}
            onImageClick={handleImageClick}
            selectedImages={selectedImages}
            // Nothing in this window draws a "back" affordance — the view drops
            // both of them in standalone mode — so this is inert today and is
            // passed only so the callback can never be undefined. Escape and
            // the drag bar are the ways out.
            onBack={handleClose}
            // No library behind this window: the header's Library button and
            // close X mean nothing here, and the window has its own chrome.
            isStandaloneWindow
            onToggleFavorite={handleToggleFavorite}
            onToggleSelection={handleToggleSelection}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-6">
            <Layers size={22} className="text-gray-600" />
            <p className="text-sm text-gray-400">Stack view is not available</p>
            <p className="text-xs text-gray-500 max-w-sm">
              Viewing a stack needs AI features, which are currently off.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default StackWindow;
