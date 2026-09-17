import { describe, it, expect, vi, beforeEach } from 'vitest';

// The stores read localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it (and sessionStorage, read by ImageModal)
// before any module import. Same harness as image-modal-file-params.test.tsx.
vi.hoisted(() => {
  const store = new Map<string, string>();
  const makeStorage = () =>
    ({
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => store.clear()),
      length: 0,
      key: vi.fn(() => null),
      __store: store,
    }) as unknown as Storage;
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
  // jsdom ships no ResizeObserver — ImageModal observes the zoom container. The
  // minimap does not depend on it firing: the modal also measures in a layout
  // effect, which is what these tests rely on.
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverMock as any;
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ImageModal from '../components/ImageModal';
import type { IndexedImage } from '../types';

/**
 * The minimap as the viewer actually wires it: shown only once the image is
 * zoomed past its fit, driven by measurements of the real pane and image
 * elements, and — the part worth guarding — never a way to start the pane's own
 * pan or its window-edge file drag.
 */

function makeImage(overrides: Partial<IndexedImage> = {}): IndexedImage {
  return {
    // The thumbnail URL is what puts a real <img> on screen without a directory
    // to load the full-resolution file from.
    id: 'dir::test.png',
    name: 'test.png',
    handle: {} as FileSystemFileHandle,
    metadata: {},
    metadataString: '',
    lastModified: Date.now(),
    models: [],
    loras: [],
    scheduler: '',
    thumbnailUrl: 'blob:thumb',
    ...overrides,
  } as IndexedImage;
}

const startFileDrag = vi.fn();

/** jsdom lays nothing out; these are the sizes the modal would have measured. */
const stubSizes = (
  imageWidth: number,
  imageHeight: number,
  viewportWidth = 800,
  viewportHeight = 600,
) => {
  const container = document.getElementById('image-zoom-container')!;
  const image = screen.getByAltText('test.png');
  for (const [element, values] of [
    [container, [viewportWidth, viewportHeight]],
    [image, [imageWidth, imageHeight]],
  ] as const) {
    Object.defineProperty(element, 'clientWidth', {
      value: values[0],
      configurable: true,
    });
    Object.defineProperty(element, 'clientHeight', {
      value: values[1],
      configurable: true,
    });
  }
};

const minimap = () => screen.queryByTestId('image-minimap');
const viewBox = () => minimap()!.querySelector('div') as HTMLDivElement;

/** The pane's image, whose transform is what panning actually moves. */
const paneImage = () => screen.getByAltText('test.png') as HTMLImageElement;

const imageTransform = () => {
  const match = paneImage().style.transform.match(
    /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
  )!;
  return {
    x: parseFloat(match[1]),
    y: parseFloat(match[2]),
    zoom: parseFloat(match[3]),
  };
};

/** Zoom in one step and let the modal measure the pane and image. */
const zoomIn = (step = 1) => {
  for (let i = 0; i < step; i++) {
    fireEvent.click(screen.getByTitle('Zoom In'));
  }
};

beforeEach(() => {
  startFileDrag.mockClear();
  (global.localStorage as any).__store.clear();
  (window as any).electronAPI = { startFileDrag };
});

describe('ImageModal minimap', () => {
  it('stays out of the way at 100% and appears once the image is zoomed', () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    stubSizes(800, 400);

    // Nothing to navigate at the fit: the whole image is already on screen.
    expect(minimap()).toBeNull();

    zoomIn();
    expect(minimap()).not.toBeNull();

    // 800x400 into the 180x140 box is a 0.225 fit → a 180x90 map.
    expect(minimap()!.style.width).toBe('180px');
    expect(minimap()!.style.height).toBe('90px');
  });

  it('disappears again when the view returns to 100%', () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    stubSizes(800, 400);
    zoomIn();
    expect(minimap()).not.toBeNull();

    fireEvent.click(screen.getByTitle('Reset Zoom'));
    expect(minimap()).toBeNull();
  });

  it('drops the image easing while the box is being dragged', () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    stubSizes(800, 400);
    zoomIn();
    expect(paneImage().style.transition).toBe('transform 0.1s ease-out');

    fireEvent.mouseDown(minimap()!, { button: 0, clientX: 90, clientY: 45 });
    expect(paneImage().style.transition).toBe('none');

    // Aimed at the map, as a browser would: the release usually lands where the
    // pointer is, and this is the path that has to survive the pane beneath it.
    fireEvent.mouseUp(minimap()!);
    expect(paneImage().style.transition).toBe('transform 0.1s ease-out');
  });

  it('pans the image when the box is dragged', () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    stubSizes(800, 400);
    zoomIn();
    expect(imageTransform()).toMatchObject({ x: 0, y: 0, zoom: 1.5 });

    // The box sits at (30,0) 120x90 in an 180x90 map — its middle is (90,45), and
    // jsdom's zero-sized rect makes those the client coordinates too.
    fireEvent.mouseDown(minimap()!, { button: 0, clientX: 90, clientY: 45 });

    // +30 map px is +133.33 display px of centre, which at 1.5x is -200 px of pan
    // — exactly this zoom's travel limit.
    fireEvent.mouseMove(minimap()!, { clientX: 120, clientY: 45 });
    expect(imageTransform().x).toBeCloseTo(-200, 6);
    expect(imageTransform().y).toBeCloseTo(0, 6);

    // The box followed the pointer: it is now flush with the map's right edge.
    expect(parseFloat(viewBox().style.left)).toBeCloseTo(60, 6);
  });

  it('does not start the pane panning underneath it', () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    stubSizes(800, 400);
    zoomIn();
    const container = document.getElementById('image-zoom-container')!;

    fireEvent.mouseDown(minimap()!, { button: 0, clientX: 90, clientY: 45 });

    // The pane shows its grabbing cursor only while its own drag is live.
    expect(container.style.cursor).toBe('grab');
  });

  it('never triggers an OS file drag, even from the window edge', () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 300, configurable: true });
    render(
      <ImageModal
        image={makeImage()}
        onClose={() => {}}
        directoryPath="C:\\images"
      />,
    );
    stubSizes(800, 400);
    zoomIn();
    const container = document.getElementById('image-zoom-container')!;

    // Drag the box, then sweep the pane near the window border — the gesture that
    // hands the file to the OS when the pane itself is being dragged. Off the map,
    // so these land on the page body and reach the window listener by bubbling.
    fireEvent.mouseDown(minimap()!, { button: 0, clientX: 90, clientY: 45 });
    fireEvent.mouseMove(document.body, { clientX: 1, clientY: 1 });
    fireEvent.mouseMove(container, { clientX: 1, clientY: 1 });
    fireEvent.mouseUp(document.body);

    expect(startFileDrag).not.toHaveBeenCalled();
  });

  it('is not offered for video, which cannot be zoomed', () => {
    // No sizes stubbed: a video renders a player rather than an <img>, so there is
    // no image element for the modal to measure in the first place.
    render(
      <ImageModal
        image={makeImage({ name: 'clip.mp4', fileType: 'video/mp4', thumbnailUrl: undefined })}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTitle('Zoom In')).toBeNull();
    expect(minimap()).toBeNull();
  });

  it('waits for a decoded image before drawing a map', () => {
    // No thumbnail and no directory: the modal shows its skeleton, so there is
    // nothing measured to map from however far the user zooms.
    render(<ImageModal image={makeImage({ thumbnailUrl: undefined })} onClose={() => {}} />);
    zoomIn();
    expect(minimap()).toBeNull();
  });
});
