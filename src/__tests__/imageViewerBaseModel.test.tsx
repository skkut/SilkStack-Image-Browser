import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The stores read localStorage at module load, and this jsdom setup ships a
// non-functional one.
vi.hoisted(() => {
  const makeStorage = () =>
    ({
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(() => null),
    }) as unknown as Storage;
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
});

// The bridge has to exist before anything is imported: `baseModelTable.ts`
// decides at module load whether the lookup is available at all, from the mere
// presence of window.electronAPI. Setting it in beforeEach would be a silent
// no-op — `isElectron` would stay false and nothing would be requested.
const ipc = vi.hoisted(() => {
  /** The callbacks `useBaseModelTable` registered, so a test can push one. */
  const changeCallbacks: Array<() => void> = [];
  const unsubscribe = vi.fn();

  const bridge = {
    getBaseModelTable: vi.fn(),
    onBaseModelTableChanged: vi.fn((callback: () => void) => {
      changeCallbacks.push(callback);
      return unsubscribe;
    }),
    // The window's own plumbing. Each listener has to hand back a cleanup
    // function — the component calls it on unmount.
    getTheme: vi.fn().mockResolvedValue({ shouldUseDarkColors: true }),
    onThemeUpdated: vi.fn(() => () => {}),
    // Typed parameters, not just a typed return: an untyped vi.fn() records
    // `calls` as a zero-length tuple, so reading the callback back out of it is
    // a type error even though it is there at runtime.
    onImageViewerUpdate: vi.fn<(callback: (data: any) => void) => () => void>(
      () => () => {},
    ),
    imageViewerReady: vi.fn(),
    imageViewerClose: vi.fn(),
    imageViewerAction: vi.fn(),
  };

  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.electronAPI = bridge;
  return { ...bridge, changeCallbacks, unsubscribe };
});

// The modal is reduced to the props it is handed, then read through the real
// service: what this file tests is the *window* that hosts it — that it adopts
// the checkpoint table and follows it — and ImageModal has test files of its
// own. Reading `baseModelForImage` back is what proves the adoption landed.
const modalProps = vi.hoisted(() => ({ current: null as any }));
vi.mock('../components/ImageModal', () => ({
  default: (props: any) => {
    modalProps.current = props;
    return null;
  },
}));

import React from 'react';
import { render, act, cleanup, waitFor } from '@testing-library/react';
import ImageModalWindow from '../components/ImageModalWindow';
import { baseModelForImage } from '../services/baseModelTable';
import type { BaseModelEntry, IndexedImage } from '../types';

/**
 * The base model in the image viewer window.
 *
 * In Electron the image modal never renders in the main window — App.tsx mounts
 * it only when there is no `electronAPI`, because every click opens a child
 * window instead. That window is a renderer process of its own, and the
 * checkpoint → base model table is module state (`baseModelTable.ts`), so the
 * table the main window resolved does not exist there. It has to be read
 * separately, and this is the file that says so: without the load, "Base Model"
 * is missing from Generation details for every image, in every viewer, always.
 *
 * The second half is the same problem one step later — a viewer opened while
 * the main window is still resolving, or mapping a checkpoint in Settings,
 * would otherwise keep its empty copy for the rest of its life.
 */

const AUTOV2_KEY = 'autov2:6ce0161689';
const PONY = 'Pony';
const SDXL = 'SDXL 1.0';

const image = (extra: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id: 'dir1::dreamshaper.png',
    name: 'dreamshaper.png',
    directoryId: 'dir1',
    handle: { name: 'dreamshaper.png' } as unknown as FileSystemFileHandle,
    metadata: { normalizedMetadata: { model_hash: '6ce0161689' } } as any,
    metadataString: '',
    lastModified: 1000,
    models: ['dreamshaper_8'],
    loras: [],
    scheduler: '',
    ...extra,
  }) as unknown as IndexedImage;

const entry = (baseModel: string): BaseModelEntry => ({
  baseModel,
  source: 'civitai-hash',
  fetchedAt: 1,
});

/** What main answers a table read with. */
const serve = (entries: Record<string, BaseModelEntry>) =>
  ipc.getBaseModelTable.mockResolvedValue({ success: true, entries });

/** The handshake: the window says it is ready, main sends the image list. */
const sendImages = (images: IndexedImage[]) =>
  act(() => {
    ipc.onImageViewerUpdate.mock.calls[0]?.[0]?.({
      imageList: images,
      currentIndex: 0,
      directoryPath: 'C:/test',
    });
  });

/** The image the window is showing, read off the modal it rendered. */
const shownImage = () => modalProps.current?.image as IndexedImage | undefined;

describe('base model in the image viewer window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modalProps.current = null;
    ipc.changeCallbacks.length = 0;
  });

  afterEach(cleanup);

  it('adopts the table its own window never resolved', async () => {
    serve({ [AUTOV2_KEY]: entry(PONY) });

    render(<ImageModalWindow />);

    // Unconditionally on mount, exactly like the main window's load step: the
    // viewer holds no library of its own (its list arrives in the handshake),
    // so anything that gated this on the image store would gate it off
    // permanently — which is how this window ended up with no table at all.
    await waitFor(() => expect(ipc.getBaseModelTable).toHaveBeenCalledTimes(1));

    sendImages([image()]);

    expect(baseModelForImage(shownImage()!)).toBe(PONY);
  });

  it('fills in a base model resolved after the window opened', async () => {
    // Nothing known yet — the state every viewer is in while the main window is
    // still working through the library's checkpoints.
    serve({});

    render(<ImageModalWindow />);
    await waitFor(() => expect(ipc.getBaseModelTable).toHaveBeenCalledTimes(1));

    sendImages([image()]);
    expect(baseModelForImage(shownImage()!)).toBe('');

    // Main finished resolving and told the other windows.
    serve({ [AUTOV2_KEY]: entry(SDXL) });
    act(() => ipc.changeCallbacks.forEach((callback) => callback()));

    await waitFor(() => expect(baseModelForImage(shownImage()!)).toBe(SDXL));
  });

  it('stops following the table once the window closes', async () => {
    serve({});

    const { unmount } = render(<ImageModalWindow />);
    await waitFor(() =>
      expect(ipc.onBaseModelTableChanged).toHaveBeenCalledTimes(1),
    );

    unmount();

    // The listener is what keeps the table current, and a viewer window is
    // opened and closed constantly — a subscription that outlives its window
    // would go on re-reading the table for every window ever opened.
    expect(ipc.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
