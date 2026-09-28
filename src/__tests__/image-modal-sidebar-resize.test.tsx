import { describe, it, expect, vi, beforeEach } from 'vitest';

// The stores read localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it (and sessionStorage, read by
// ImageModal) before any module import. Same harness as
// image-modal-compact-mode.test.tsx.
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
  // jsdom ships no ResizeObserver — ImageModal observes the zoom container.
  class ResizeObserverMock {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverMock as any;
});

/** The live observer callback — the one the modal's most recent zoom built. */
let resizeObserverCallback: ResizeObserverCallback | null = null;

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import ImageModal from '../components/ImageModal';
import {
  COMPACT_SCALE_STORAGE_KEY,
  DEFAULT_SIDEBAR_SHARE,
  MIN_SIDEBAR_SHARE,
  MAX_SIDEBAR_SHARE,
  SIDEBAR_SHARE_STORAGE_KEY,
  compactSidebarWidth,
  userScaleFromResize,
} from '../utils/windowSizing';
import type { IndexedImage } from '../types';

/**
 * The metadata panel's inner edge, dragged.
 *
 * What this suite is about is the *seam* between the two values a drag produces:
 * the one the panel is laid out at, which follows the pointer, and the one the
 * window is shaped around, which must not. A drag that committed per mousemove
 * would look identical in the ordinary viewer and send a window resize per frame
 * in a compact one, so the assertions that matter most here are the ones about
 * what has *not* happened yet.
 */

function makeImage(overrides: Partial<IndexedImage> = {}): IndexedImage {
  return {
    id: 'dir::test.png',
    name: 'test.png',
    handle: {} as FileSystemFileHandle,
    metadata: {},
    metadataString: '',
    lastModified: Date.now(),
    models: [],
    loras: [],
    scheduler: '',
    ...overrides,
  } as IndexedImage;
}

/** The persisted value, read back from the stub's backing map. */
const stored = (key: string) => (global.localStorage as any).__store.get(key);

/** How many times the viewer has written a given key. */
const writesTo = (key: string) =>
  (global.localStorage.setItem as any).mock.calls.filter(
    ([written]: [string]) => written === key,
  ).length;

const setViewerCompactMode = vi.fn();

const setScreen = (width: number, height: number) => {
  Object.defineProperty(window.screen, 'availWidth', { value: width, configurable: true });
  Object.defineProperty(window.screen, 'availHeight', { value: height, configurable: true });
};

const setWindowSize = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
};

/** The work area both suites below are measured against. */
const WORK_AREA = 1000;

/** The row the picture and the panel divide, in the ordinary viewer. */
const BODY_WIDTH = 1000;

const modalBody = () => screen.getByTestId('image-modal-body');
const panel = () => screen.getByTestId('metadata-panel');
const picture = () => screen.getByAltText('test.png') as HTMLImageElement;
const handle = () => screen.getByLabelText('Resize metadata panel');

/** The share the panel is currently laid out at, as the row was told it. */
const layoutShare = () => modalBody().style.getPropertyValue('--sidebar-share');

/**
 * jsdom lays nothing out, so the width a drag measures itself against is handed
 * over by hand. Done after render and before the mousedown, because the handler
 * reads it once, at the start of the gesture.
 */
const stubBodyWidth = (width: number = BODY_WIDTH) => {
  Object.defineProperty(modalBody(), 'clientWidth', { value: width, configurable: true });
};

const startDrag = (clientX: number) =>
  fireEvent.mouseDown(handle(), { clientX, button: 0 });
const moveDrag = (clientX: number) => fireEvent.mouseMove(document, { clientX });
const endDrag = () => fireEvent.mouseUp(document);

beforeEach(() => {
  setViewerCompactMode.mockReset();
  setViewerCompactMode.mockResolvedValue({ success: true });
  (global.localStorage as any).__store.clear();
  (global.localStorage.setItem as any).mockClear();
  // jsdom reports 0 for the screen's work-area fields, which would fall back to
  // window.innerWidth.
  setScreen(WORK_AREA, WORK_AREA);
  setWindowSize(1024, 768);

  (window as any).electronAPI = {
    setViewerCompactMode,
    toggleFullscreen: vi.fn().mockResolvedValue({ success: true, isFullscreen: true }),
    joinPaths: vi.fn().mockResolvedValue({ success: false }),
    readFile: vi.fn().mockResolvedValue({ success: false }),
    onViewerCompactFillScreen: () => () => {},
  };
});

describe('the metadata panel in the ordinary viewer', () => {
  const openViewer = (overrides: Partial<IndexedImage> = {}) => {
    render(
      <ImageModal
        image={makeImage({ dimensions: '400x300', ...overrides })}
        onClose={() => {}}
      />,
    );
    stubBodyWidth();
  };

  it('gives both halves of the row one share to divide', () => {
    // The split is one number with one edit site. The panel reads it and the
    // pane reads `100% - share`, so the two cannot be typed out of step — which
    // is a layout that overflows the frame rather than one that merely looks
    // wrong.
    openViewer();

    expect(layoutShare()).toBe(`${(DEFAULT_SIDEBAR_SHARE * 100).toFixed(2)}%`);
    expect(panel().className).toContain('var(--sidebar-share');
    expect(
      document.getElementById('image-zoom-container')!.className,
    ).toContain('calc(100%_-_var(--sidebar-share');
  });

  it('follows the pointer while dragging and commits once at the end', () => {
    openViewer();
    const writesBefore = writesTo(SIDEBAR_SHARE_STORAGE_KEY);

    act(() => startDrag(500));
    act(() => moveDrag(400));

    // Live: the layout has already moved, because a CSS width costs nothing to
    // change and a divider that lagged the cursor would feel broken.
    expect(layoutShare()).toBe('40.00%');
    // But nothing is stored yet — a drag is not a decision until it ends, and
    // the share on disk is still the one the panel was opened at.
    expect(writesTo(SIDEBAR_SHARE_STORAGE_KEY)).toBe(writesBefore);
    expect(stored(SIDEBAR_SHARE_STORAGE_KEY)).toBe(String(DEFAULT_SIDEBAR_SHARE));

    act(() => endDrag());

    expect(stored(SIDEBAR_SHARE_STORAGE_KEY)).toBe('0.4');
    // The layout settles on exactly what was dragged, with no jump at the seam:
    // the value committed is the value the pointer was last at.
    expect(layoutShare()).toBe('40.00%');
  });

  it('does not write to storage once per mousemove', () => {
    // The reason the dragged share and the stored share are two values rather
    // than one. Writing per frame is invisible in this mode and is a window
    // resize per frame in the compact one, which is the flicker the mode's
    // whole pacing design exists to prevent.
    openViewer();
    const before = writesTo(SIDEBAR_SHARE_STORAGE_KEY);

    act(() => startDrag(500));
    for (let x = 499; x > 400; x -= 1) {
      act(() => moveDrag(x));
    }

    expect(writesTo(SIDEBAR_SHARE_STORAGE_KEY)).toBe(before);

    act(() => endDrag());
    expect(writesTo(SIDEBAR_SHARE_STORAGE_KEY)).toBe(before + 1);
  });

  it('holds the share inside its range however far the pointer goes', () => {
    openViewer();

    // Well past the right-hand end: the panel may not swallow the picture.
    act(() => startDrag(500));
    act(() => moveDrag(1000));
    expect(layoutShare()).toBe(`${(MIN_SIDEBAR_SHARE * 100).toFixed(2)}%`);
    act(() => endDrag());

    // And well past the left-hand end.
    act(() => startDrag(500));
    act(() => moveDrag(100));
    expect(layoutShare()).toBe(`${(MAX_SIDEBAR_SHARE * 100).toFixed(2)}%`);
    act(() => endDrag());

    // Clamped and kept, not discarded: an over-drag is still a choice.
    expect(stored(SIDEBAR_SHARE_STORAGE_KEY)).toBe(String(MAX_SIDEBAR_SHARE));
  });

  it('puts the panel back to the default on a double click', () => {
    openViewer();
    act(() => startDrag(500));
    act(() => moveDrag(400));
    act(() => endDrag());
    expect(stored(SIDEBAR_SHARE_STORAGE_KEY)).toBe('0.4');

    act(() => {
      fireEvent.doubleClick(handle());
    });

    expect(stored(SIDEBAR_SHARE_STORAGE_KEY)).toBe(String(DEFAULT_SIDEBAR_SHARE));
    expect(layoutShare()).toBe(`${(DEFAULT_SIDEBAR_SHARE * 100).toFixed(2)}%`);
  });

  it('leaves the stored share alone when the handle is only clicked', () => {
    // A press with no travel is not a drag. Committing here would rewrite the
    // user's stored width with whatever rounding the pointer happened to land
    // on, once per stray click.
    openViewer();
    const writesBefore = writesTo(SIDEBAR_SHARE_STORAGE_KEY);

    act(() => startDrag(500));
    act(() => endDrag());

    expect(writesTo(SIDEBAR_SHARE_STORAGE_KEY)).toBe(writesBefore);
    expect(layoutShare()).toBe(`${(DEFAULT_SIDEBAR_SHARE * 100).toFixed(2)}%`);
  });

  it('opens at the share it was left at', () => {
    (global.localStorage as any).__store.set(SIDEBAR_SHARE_STORAGE_KEY, '0.45');

    openViewer();

    expect(layoutShare()).toBe('45.00%');
  });

  it('reads a stored share it cannot use as one it never had', () => {
    // Corruption reads as "never chosen" rather than as a bound — otherwise a
    // bad byte would pin the panel to the minimum and the setting would look
    // ignored rather than broken.
    (global.localStorage as any).__store.set(SIDEBAR_SHARE_STORAGE_KEY, 'not-a-number');

    openViewer();

    expect(layoutShare()).toBe(`${(DEFAULT_SIDEBAR_SHARE * 100).toFixed(2)}%`);
  });
});

describe('the metadata panel in a compact window', () => {
  /** A compact window on `dimensions`, with the panel open and its reply in. */
  const compactWithPanel = async (dimensions: string) => {
    render(
      <ImageModal
        image={makeImage({ dimensions, thumbnailUrl: 'blob:thumb' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );
    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });
    act(() => {
      screen.getByLabelText('Expand sidebar').click();
    });
    await act(async () => {});
  };

  const lastRequest = () =>
    setViewerCompactMode.mock.calls[setViewerCompactMode.mock.calls.length - 1][0] as {
      contentWidth: number;
      contentHeight: number;
      anchor: string;
    };

  it('reshapes the window once, and only once the drag has ended', async () => {
    // The gesture crosses an IPC round trip that cannot be presented for ~50ms,
    // so it is paced the way every other compact resize is: the panel previews
    // under the pointer, and the window takes its new size when the pointer is
    // let go. One commit per gesture.
    await compactWithPanel('400x300');
    const panelBefore = panel().style.width;
    const requestsBefore = setViewerCompactMode.mock.calls.length;

    act(() => startDrag(600));
    act(() => moveDrag(500));

    // The panel has moved under the pointer; the window has not been asked to
    // move at all.
    expect(panel().style.width).not.toBe(panelBefore);
    expect(setViewerCompactMode.mock.calls.length).toBe(requestsBefore);

    act(() => endDrag());

    expect(setViewerCompactMode.mock.calls.length).toBe(requestsBefore + 1);
    // Held by its left edge, as a panel toggle is: the panel hangs off the
    // frame's right, so growing about the centre would slide the picture
    // sideways by half the panel's width.
    expect(lastRequest().anchor).toBe('keep');
  });

  it('measures the panel against the work area, not the frame', async () => {
    // A compact window *is* the picture's size, so a share of it would hand a
    // small file a panel as narrow as the file is small — and the panel holds
    // text, whose needs do not follow the picture beside it. Read against the
    // screen, the same drag gives the same panel for every image.
    await compactWithPanel('400x300');

    act(() => startDrag(600));
    act(() => moveDrag(500));
    act(() => endDrag());

    // Dragged 100px left from the default third: 0.3 + 100/1000 of the screen.
    expect(panel().style.width).toBe(`${compactSidebarWidth(WORK_AREA, 0.4)}px`);
    expect(lastRequest().contentWidth).toBe(400 + 16 + compactSidebarWidth(WORK_AREA, 0.4));
  });

  it('crops the picture rather than rescaling it', async () => {
    // The invariant the mode rests on: a docked panel may narrow the pane the
    // picture is shown in, but it must never change the picture. The pin is
    // measured against the whole work area and is never told the panel exists.
    await compactWithPanel('400x300');

    act(() => startDrag(600));
    act(() => moveDrag(500));
    act(() => endDrag());

    expect(picture().style.width).toBe('400px');
    expect(picture().style.height).toBe('300px');
  });

  it('opens at the share it was left at, and sizes the frame for it', async () => {
    (global.localStorage as any).__store.set(SIDEBAR_SHARE_STORAGE_KEY, '0.5');

    await compactWithPanel('400x300');

    const panelWidth = compactSidebarWidth(WORK_AREA, 0.5);
    expect(panel().style.width).toBe(`${panelWidth}px`);
    expect(lastRequest().contentWidth).toBe(400 + 16 + panelWidth);
  });

  it('ends the drag when the pointer leaves the window', async () => {
    // Not decoration. A compact window is only the picture and the panel wide,
    // so pulling the edge past the picture's far side takes the pointer out of
    // the window entirely — and a drag with no end would keep following the
    // cursor, unseen, until something else happened to end it.
    await compactWithPanel('400x300');

    act(() => startDrag(600));
    act(() => moveDrag(500));
    const requestsDuring = setViewerCompactMode.mock.calls.length;

    act(() => {
      fireEvent.mouseLeave(document);
    });

    expect(setViewerCompactMode.mock.calls.length).toBe(requestsDuring + 1);
    expect(stored(SIDEBAR_SHARE_STORAGE_KEY)).toBe('0.4');
  });

  it('measures a hand-dragged window against the panel the user has now', async () => {
    // The hand-drag reader subtracts the panel from the window it observes and
    // *stores* the factor it derives. If it were listening through a stale
    // panel width, every window that followed would come out wrong by the
    // difference — permanently, and for every image. Here the panel is half the
    // screen; read at the old default third, the remembered size would be out
    // by a fifth of the screen.
    //
    // The picture is deliberately larger than the window dragged over it. The
    // reader decides which of its two readings a frame belongs to by comparing
    // the two, and only the *display fit* reading subtracts the panel: a window
    // drawn larger than the file's own pixels is an enlargement, which is a
    // multiple of the file and has no panel in it to be stale about.
    (global.localStorage as any).__store.set(SIDEBAR_SHARE_STORAGE_KEY, '0.5');
    vi.useFakeTimers();
    try {
      await compactWithPanel('2000x1500');

      const observed = { width: 900, height: 600 };
      setWindowSize(observed.width, observed.height);
      act(() => {
        window.dispatchEvent(new Event('resize'));
        // Past the debounce the reader runs on: it waits for the hand to stop
        // before deciding what the hand said.
        vi.advanceTimersByTime(500);
      });

      const withPanel = userScaleFromResize(
        2000, 1500, WORK_AREA, WORK_AREA, observed.width, observed.height, 1,
        compactSidebarWidth(WORK_AREA, 0.5),
      );
      const withStalePanel = userScaleFromResize(
        2000, 1500, WORK_AREA, WORK_AREA, observed.width, observed.height, 1,
        compactSidebarWidth(WORK_AREA, DEFAULT_SIDEBAR_SHARE),
      );

      // The two readings have to differ, or this test would pass on the bug.
      expect(withPanel).not.toBe(withStalePanel);
      expect(stored(COMPACT_SCALE_STORAGE_KEY)).toBe(String(withPanel));
    } finally {
      vi.useRealTimers();
    }
  });
});
