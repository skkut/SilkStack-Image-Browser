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
// presence of window.electronAPI.
const ipc = vi.hoisted(() => {
  const bridge = {
    getBaseModelTable: vi.fn(),
    onBaseModelTableChanged: vi.fn(() => () => {}),
    // The window's own plumbing. Each listener has to hand back a cleanup
    // function — the component calls it on unmount.
    getTheme: vi.fn().mockResolvedValue({ shouldUseDarkColors: true }),
    onThemeUpdated: vi.fn(() => () => {}),
    onImageViewerUpdate: vi.fn<(callback: (data: any) => void) => () => void>(
      () => () => {},
    ),
    imageViewerReady: vi.fn(),
    imageViewerClose: vi.fn(),
    imageViewerAction: vi.fn(),
  };

  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.electronAPI = bridge;
  return bridge;
});

// ImageModal is reduced to the props the window hands it: this file is about
// the title the window publishes, not the modal's own rendering.
const modalProps = vi.hoisted(() => ({ current: null as any }));
vi.mock('../components/ImageModal', () => ({
  default: (props: any) => {
    modalProps.current = props;
    return null;
  },
}));

import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import ImageModalWindow from '../components/ImageModalWindow';
import type { IndexedImage } from '../types';

/**
 * The image viewer window's title.
 *
 * The title bar is hidden, so the OS taskbar / Alt+Tab entry is the only place
 * this window's title is visible. Main names the image at open time, from the
 * payload it is handed, but navigation is local to the renderer — the main
 * process never learns which image is on screen. This window therefore owns
 * the title from the moment the list arrives, and publishes it through
 * `document.title`, which Electron mirrors to the window title unless the
 * generic index.html title is refused (see main.mjs).
 */

const image = (id: string, name: string): IndexedImage =>
  ({
    id,
    name,
    directoryId: 'dir1',
    handle: { name } as unknown as FileSystemFileHandle,
    metadata: {} as any,
    metadataString: '',
    lastModified: 1000,
    models: [],
    loras: [],
    scheduler: '',
  }) as unknown as IndexedImage;

/** The handshake: the window says it is ready, main sends the image list. */
const sendImages = (images: IndexedImage[], currentIndex = 0) =>
  act(() => {
    ipc.onImageViewerUpdate.mock.calls[0]?.[0]?.({
      imageList: images,
      currentIndex,
      directoryPath: 'C:/test',
    });
  });

describe('image viewer window title', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    modalProps.current = null;
    document.title = '';
  });

  afterEach(cleanup);

  it('names the image it opens', () => {
    render(<ImageModalWindow />);

    sendImages([image('dir1::first.png', 'first.png')]);

    expect(document.title).toBe('Image: first.png');
  });

  it('follows navigation to the next image', () => {
    render(<ImageModalWindow />);

    sendImages([
      image('dir1::first.png', 'first.png'),
      image('dir1::second.png', 'second.png'),
    ]);
    expect(document.title).toBe('Image: first.png');

    act(() => modalProps.current.onNavigateNext());

    expect(document.title).toBe('Image: second.png');
  });

  it('leaves the initial title alone until an image arrives', () => {
    // What main sets before the renderer has received anything — including
    // the name it derived from the open payload.
    document.title = 'Image: first.png';

    render(<ImageModalWindow />);

    expect(document.title).toBe('Image: first.png');
  });

  it('follows a rename sent back by the main window', () => {
    render(<ImageModalWindow />);

    sendImages([image('dir1::first.png', 'first.png')]);

    act(() => {
      ipc.onImageViewerUpdate.mock.calls[0]?.[0]?.({
        image: image('dir1::first.png', 'renamed.png'),
      });
    });

    expect(document.title).toBe('Image: renamed.png');
  });
});
