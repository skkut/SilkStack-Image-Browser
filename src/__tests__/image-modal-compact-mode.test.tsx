import { describe, it, expect, vi, beforeEach } from 'vitest';

// The stores read localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it (and sessionStorage, read by
// ImageModal) before any module import. Same harness as
// image-modal-file-params.test.tsx.
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
  // The callback is kept so a test can replay the resize the real one reports:
  // jsdom lays nothing out, so the sizes the modal measures are stubbed by hand
  // and no real resize ever arrives to trigger the observer on its own.
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
  COMPACT_MODE_STORAGE_KEY,
  COMPACT_SCALE_STORAGE_KEY,
  COMPACT_GROW_SETTLE_MS,
  COMPACT_GROW_MAX_STEP,
  COMPACT_GROW_STEP_MS,
  COMPACT_MIN_WINDOW_WIDTH,
  COMPACT_MIN_WINDOW_HEIGHT,
} from '../utils/windowSizing';
import type { IndexedImage } from '../types';

/**
 * Compact ("frame the image") window mode.
 *
 * The viewer must ask the main process to reshape its window to the image, hide
 * the metadata panel while doing so, and remember both the preference and any
 * size the user dragged it down to — without disturbing the user's own
 * sidebar-collapse setting.
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

// Reset and re-armed in beforeEach: a test that overrides the reply must not
// leave that override standing for the next one.
const setViewerCompactMode = vi.fn();

/** The viewer's subscription to the main process's fill-screen request. */
let fillScreenCallback: (() => void) | null = null;

/** Stand-in for the work area the renderer reads off `window.screen`. */
const setScreen = (width: number, height: number) => {
  Object.defineProperty(window.screen, 'availWidth', {
    value: width,
    configurable: true,
  });
  Object.defineProperty(window.screen, 'availHeight', {
    value: height,
    configurable: true,
  });
};

/** Stand-in for the content area the OS hands back after a resize. */
const setWindowSize = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
};

/**
 * The payload the viewer sends for an image area of `contentWidth` x
 * `contentHeight` at the remembered scale. The window's ceiling — the fit at
 * scale 1 — is a separate number rather than something the helper derives, and
 * it defaults to the size itself because the two coincide whenever the window is
 * at its fit. Tests where the user has reduced the window pass it explicitly.
 */
const compactPayload = (
  contentWidth: number,
  contentHeight: number,
  anchor: 'center' | 'keep',
  ceiling: [number, number] = [contentWidth, contentHeight],
) => ({
  enabled: true,
  contentWidth,
  contentHeight,
  maxContentWidth: ceiling[0],
  maxContentHeight: ceiling[1],
  anchor,
});

/**
 * Skip the wait a *growth* of the frame serves before it is sent.
 *
 * A magnification that would enlarge the frame waits COMPACT_GROW_SETTLE_MS for
 * the zoom to stop, so that a flick's dozen steps become one window resize
 * rather than a dozen of them (a resize cannot be presented for ~50ms, which is
 * longer than the steps are apart, so the picture would never settle). Tests
 * that zoom and then assert the reshape are past the gesture, so they run the
 * clock out rather than sitting through it. Needs fake timers.
 */
const settleGrow = () => {
  act(() => {
    vi.advanceTimersByTime(COMPACT_GROW_SETTLE_MS);
  });
  // A growth more than COMPACT_GROW_MAX_STEP away is not sent in one go: each
  // step waits for the one before it to reach the screen, so a coalesced flick
  // lands as several resizes no larger than the ones the gesture was making.
  // The wait is over once a step's interval passes with nothing further to send.
  for (let step = 0; step < 40; step += 1) {
    const sent = setViewerCompactMode.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(COMPACT_GROW_STEP_MS);
    });
    if (setViewerCompactMode.mock.calls.length === sent) break;
  }
};

/** The picture the viewer magnifies. */
const picture = () => screen.getByAltText('test.png') as HTMLImageElement;

/**
 * Stub the two sizes the modal measures off the DOM.
 *
 * jsdom lays nothing out, so both are handed over by hand: the *pane* the pan is
 * clamped against is the zoom container — which is the frame's image area plus
 * the padding each side, the drag bar being outside it — and the picture reports
 * the size it is *laid out* at, the pin, because the magnification is a
 * transform and a transform does not move `clientWidth`.
 */
const stubPaintedSizes = (
  paneWidth: number,
  paneHeight: number,
  pinnedWidth: number,
  pinnedHeight: number,
) => {
  const elements: [Element, number, number][] = [
    [document.getElementById('image-zoom-container')!, paneWidth, paneHeight],
    [picture(), pinnedWidth, pinnedHeight],
  ];
  for (const [element, width, height] of elements) {
    Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
  }
};

/**
 * One wheel detent, at a point in the container. jsdom reports the container's
 * rect as all zeros, so the offsets below are the pointer's own coordinates —
 * which is all the anchoring needs, since it exists to magnify about wherever
 * the cursor is.
 *
 * `deltaY` defaults to a detent upwards, which is a magnification; pass a
 * positive value for the scroll that takes the frame back down.
 */
const wheelStep = (clientX: number, clientY: number, deltaY = -100) => {
  act(() => {
    document.getElementById('image-zoom-container')!.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

/** The last payload the viewer sent the main process. */
const lastCompactRequest = () =>
  setViewerCompactMode.mock.calls[setViewerCompactMode.mock.calls.length - 1][0] as {
    contentWidth?: number;
    contentHeight?: number;
  };

const zoomOutButton = () => screen.getByTitle('Zoom Out') as HTMLButtonElement;
const resetButton = () => screen.getByTitle('Reset Zoom') as HTMLButtonElement;
const zoomSlider = () => screen.getByTitle('Adjust zoom') as HTMLInputElement;

beforeEach(() => {
  setViewerCompactMode.mockReset();
  setViewerCompactMode.mockResolvedValue({ success: true });
  fillScreenCallback = null;
  (global.localStorage as any).__store.clear();

  // Pin the work area so the expected window size is deterministic. jsdom
  // reports 0 for the screen's work-area fields, which would fall back to
  // window.innerWidth.
  setScreen(1000, 1000);
  setWindowSize(1024, 768);

  (window as any).electronAPI = {
    setViewerCompactMode,
    toggleFullscreen: vi.fn().mockResolvedValue({ success: true, isFullscreen: true }),
    joinPaths: vi.fn().mockResolvedValue({ success: false }),
    readFile: vi.fn().mockResolvedValue({ success: false }),
    // Same subscribe-and-return-a-cleanup shape as the real preload, so the
    // component's effect registers and unregisters exactly as it would there.
    onViewerCompactFillScreen: (callback: () => void) => {
      fillScreenCallback = callback;
      return () => {
        fillScreenCallback = null;
      };
    },
  };
});

describe('ImageModal compact mode', () => {
  it('offers the compact toggle only in the standalone viewer window', () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    expect(screen.queryByLabelText('Fit window to image')).toBeNull();
    // …and never calls the IPC from the browser-hosted modal.
    expect(setViewerCompactMode).not.toHaveBeenCalled();
  });

  it('reshapes the window to the image and hides the metadata panel', () => {
    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    const panel = screen.getByTestId('metadata-panel');
    expect(panel.className).not.toContain('hidden');

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });

    // 1000x500 in a 1000x1000 work area: scale 0.984 → 984x492 image area,
    // plus 8px padding each side and the 32px drag bar.
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));
    expect(screen.getByTestId('metadata-panel').className).toContain('hidden');
    // The bar keeps every button in both modes, and the sidebar one reads
    // "Expand" because that is the state the hidden panel is in.
    expect(screen.getByLabelText('Expand sidebar')).toBeTruthy();
    expect(screen.queryByLabelText('Collapse sidebar')).toBeNull();
  });

  it('reads as collapsed while compact without rewriting the preference', () => {
    // Seeded expanded: the button must show collapsed *because of the mode*,
    // not by flipping the user's own setting underneath them.
    (global.localStorage as any).__store.set('image_modal_sidebar_collapsed', 'false');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });

    expect(screen.getByLabelText('Expand sidebar')).toBeTruthy();
    expect(stored('image_modal_sidebar_collapsed')).toBe('false');
  });

  it('leaves compact mode when the sidebar is expanded from the compact bar', () => {
    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });
    expect(screen.getByTestId('metadata-panel').className).toContain('hidden');

    act(() => {
      screen.getByLabelText('Expand sidebar').click();
    });

    // One press: the window hands the image back to the desktop and the panel
    // comes with it, rather than leaving a window that is still shaped to the
    // image with its metadata hidden.
    expect(setViewerCompactMode).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByTestId('metadata-panel').className).not.toContain('hidden');
    expect(screen.getByLabelText('Collapse sidebar')).toBeTruthy();
  });

  it('expands the panel even when the sidebar was collapsed before compact', () => {
    // Compact hides the panel regardless of this flag, so the button shows
    // "Expand" either way — and pressing it has to deliver the panel the
    // button promises, not merely leave the mode.
    (global.localStorage as any).__store.set('image_modal_sidebar_collapsed', 'true');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
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

    expect(setViewerCompactMode).toHaveBeenLastCalledWith({ enabled: false });
    expect(stored('image_modal_sidebar_collapsed')).toBe('false');
    expect(screen.getByTestId('metadata-panel').className).not.toContain('hidden');
  });

  it('restores the previous window size when toggled back off', () => {
    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });
    act(() => {
      screen.getByLabelText('Exit compact mode').click();
    });

    expect(setViewerCompactMode).toHaveBeenLastCalledWith({ enabled: false });
    expect(screen.getByTestId('metadata-panel').className).not.toContain('hidden');
  });

  it('remembers the preference and starts in compact mode next time', () => {
    (global.localStorage as any).__store.set(COMPACT_MODE_STORAGE_KEY, 'true');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    // A remembered-compact window resizes on mount, before any user gesture.
    expect(setViewerCompactMode).toHaveBeenCalledWith(compactPayload(1000, 540, 'center'));
    expect(screen.getByTestId('metadata-panel').className).toContain('hidden');
  });

  it('writes the preference through for the next window', () => {
    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });

    expect(global.localStorage.setItem).toHaveBeenCalledWith(
      COMPACT_MODE_STORAGE_KEY,
      'true',
    );
  });

  it('ignores the preference in the browser modal, which has no toggle', () => {
    // The browser-hosted modal shares a localStorage origin with the Electron
    // viewer (both load localhost:5173 in dev). Inheriting the flag there would
    // hide the sidebar with no button to bring it back.
    (global.localStorage as any).__store.set(COMPACT_MODE_STORAGE_KEY, 'true');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
      />,
    );

    expect(setViewerCompactMode).not.toHaveBeenCalled();
    expect(screen.getByTestId('metadata-panel').className).not.toContain('hidden');
  });

  it('re-fits the window to the next image on navigation', () => {
    const { rerender } = render(
      <ImageModal
        image={makeImage({ id: 'dir::a.png', dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
        currentIndex={0}
        totalImages={2}
        onNavigateNext={() => {}}
        onNavigatePrevious={() => {}}
      />,
    );

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));

    // Arrow to a portrait image: the window must reshape to the new aspect
    // ratio, not stay at the previous image's shape.
    rerender(
      <ImageModal
        image={makeImage({ id: 'dir::b.png', dimensions: '500x1000' })}
        onClose={() => {}}
        isStandaloneWindow={true}
        currentIndex={1}
        totalImages={2}
        onNavigateNext={() => {}}
        onNavigatePrevious={() => {}}
      />,
    );

    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(492, 1000, 'center'));
  });

  it('does not size the window from the 512px-capped thumbnail', () => {
    render(
      <ImageModal
        image={makeImage({
          dimensions: '1000x500',
          thumbnailUrl: 'blob:thumb',
        })}
        onClose={() => {}}
        isStandaloneWindow={true}
        directoryPath=""
      />,
    );

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));

    // The <img> shows the thumbnail first; learning its size would reshape the
    // window down to 512px and then back up once the real file decoded.
    const img = screen.getByAltText('test.png') as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 512, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 512, configurable: true });
    act(() => {
      fireEvent.load(img);
    });

    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));
  });
});

describe('ImageModal compact mode — user-resized windows', () => {
  it('applies a remembered reduction to a freshly opened window', () => {
    (global.localStorage as any).__store.set(COMPACT_MODE_STORAGE_KEY, 'true');
    (global.localStorage as any).__store.set(COMPACT_SCALE_STORAGE_KEY, '0.5');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    // Half of the 984x492 fit, with the chrome left at full size.
    expect(setViewerCompactMode).toHaveBeenCalledWith(compactPayload(508, 294, 'center', [1000, 540]));
  });

  it('learns the reduction from a hand-dragged window', () => {
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: '1000x500' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));

      // The user drags the window down to 70% of the picture. We gave them a
      // 984x492 image area, so 70% is 689x344 — content 705x392.
      setWindowSize(705, 392);
      act(() => {
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(500);
      });

      expect(Number(stored(COMPACT_SCALE_STORAGE_KEY))).toBeCloseTo(0.7, 2);
      // …and the window is re-fitted to the image at that size, so the aspect
      // ratio stays exact rather than being whatever the drag produced — while
      // being left where the user put it, since re-centring here would yank the
      // window out from under the hand that just resized it.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(704, 392, 'keep', [1000, 540]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('heals a factor left behind by a maximised window', () => {
    vi.useFakeTimers();
    try {
      // A window maximised by a double-click on the drag bar used to be read as
      // "several times the fit", saturating the remembered factor at its
      // ceiling. From there every drag was multiplied into an already-too-big
      // number, the re-fit put the window straight back to full size, and the
      // window could not be made smaller at all. The factor is read against the
      // fit now, so one honest drag states the truth again.
      // Through the storage API — the mock writes to the same map, and this is
      // the write the app itself makes.
      global.localStorage.setItem(COMPACT_MODE_STORAGE_KEY, 'true');
      global.localStorage.setItem(COMPACT_SCALE_STORAGE_KEY, '4');

      render(
        <ImageModal
          image={makeImage({ dimensions: '1000x500' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );

      // The ceiling is inert on the way in — the work area caps the size — so
      // the window still opens at the fit.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));

      // …and dragging it to half of that picture stores half, not 4 x 0.5.
      setWindowSize(508, 294);
      act(() => {
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(500);
      });

      expect(Number(stored(COMPACT_SCALE_STORAGE_KEY))).toBeCloseTo(0.5, 2);
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(508, 294, 'keep', [1000, 540]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a reduction when the next image is loaded', () => {
    (global.localStorage as any).__store.set(COMPACT_MODE_STORAGE_KEY, 'true');
    (global.localStorage as any).__store.set(COMPACT_SCALE_STORAGE_KEY, '0.5');

    const { rerender } = render(
      <ImageModal
        image={makeImage({ id: 'dir::a.png', dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
        currentIndex={0}
        totalImages={2}
        onNavigateNext={() => {}}
        onNavigatePrevious={() => {}}
      />,
    );
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(508, 294, 'center', [1000, 540]));

    // 500x1000 at half of its 0.952 fit → 476x952 becomes 238x476.
    rerender(
      <ImageModal
        image={makeImage({ id: 'dir::b.png', dimensions: '500x1000' })}
        onClose={() => {}}
        isStandaloneWindow={true}
        currentIndex={1}
        totalImages={2}
        onNavigateNext={() => {}}
        onNavigatePrevious={() => {}}
      />,
    );

    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(254, 524, 'center', [492, 1000]));
  });

  it('does not mistake its own resize for a user drag', () => {
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: '1000x500' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });

      // The main process applies our requested size; under display scaling the
      // content area lands a couple of DIPs off it.
      setWindowSize(1002, 538);
      act(() => {
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(500);
      });

      expect(stored(COMPACT_SCALE_STORAGE_KEY)).toBe('1');
      expect(setViewerCompactMode).toHaveBeenCalledTimes(2); // toggle + apply
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read the window manager overruling the fit as a hand-drag', async () => {
    vi.useFakeTimers();
    try {
      // A 1:4 portrait asks for a 254px-wide window. The compact window's floor
      // is 272 so the top bar's buttons stay clear of the OS window controls,
      // so the window commits wider than the fit — which is not evidence of
      // anything the user did, and must not be remembered as a preference.
      setViewerCompactMode.mockImplementation(
        async (payload: { enabled?: boolean }) =>
          payload?.enabled
            ? {
                success: true,
                isCompact: true,
                contentWidth: 272,
                contentHeight: 1000,
              }
            : { success: true, isCompact: false },
      );

      render(
        <ImageModal
          image={makeImage({ dimensions: '512x2048' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(254, 1000, 'center'),
      );

      // Let the reply land — it carries the size the window actually took —
      // then have the OS report exactly that size back.
      await act(async () => {});
      setWindowSize(272, 1000);
      act(() => {
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(500);
      });

      expect(stored(COMPACT_SCALE_STORAGE_KEY)).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ImageModal compact mode — the maximise gesture', () => {
  it('takes it as "as large as this image can be"', () => {
    global.localStorage.setItem(COMPACT_MODE_STORAGE_KEY, 'true');
    global.localStorage.setItem(COMPACT_SCALE_STORAGE_KEY, '0.5');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    // Opens at the remembered half size.
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(508, 294, 'center', [1000, 540]));

    // The main process converts the OS's fill-the-screen gesture into this,
    // because a window shaped to its image has no screen-filling shape to be
    // given: the largest it can honestly be is the fit at scale 1.
    act(() => {
      fillScreenCallback?.();
    });

    // Re-centred rather than held by its corner: Windows parks a maximised window
    // at the work area's top-left, and a frame told to keep its position would
    // settle into that corner instead of coming back where it was.
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));
    // The reduction is forgotten, not multiplied — so the next image opens at
    // its own maximum rather than at half of it.
    expect(stored(COMPACT_SCALE_STORAGE_KEY)).toBe('1');
  });

  it('re-applies the fit even when the preference is already 1', () => {
    global.localStorage.setItem(COMPACT_MODE_STORAGE_KEY, 'true');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );
    expect(setViewerCompactMode).toHaveBeenCalledTimes(1);

    act(() => {
      fillScreenCallback?.();
    });

    // Setting a scale that is already 1 changes no state, so React would bail
    // out of the update and the window would sit maximised until the main
    // process's backstop unmaximised it. The request counter is what forces the
    // re-apply that unmaximises *and* restores the image's shape in one step.
    expect(setViewerCompactMode).toHaveBeenCalledTimes(2);
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'center'));
  });

  it('takes a zoomed frame back to 1x, where the maximum is defined', () => {
    global.localStorage.setItem(COMPACT_MODE_STORAGE_KEY, 'true');
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: '200x100' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );

      act(() => {
        screen.getByTitle('Zoom In').click();
      });
      settleGrow();
      // Magnified, the frame followed the picture out to 1.5x of the fit.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(316, 198, 'center', [216, 148]),
      );

      act(() => {
        fillScreenCallback?.();
      });

      // The gesture lands the window on its maximum, which is the fit at scale 1 —
      // so the magnification goes with it. Left in force it would ask for a frame
      // the main process has just refused, and the two would trade the window back
      // and forth.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(216, 148, 'center'));

      // A growth still waiting when the gesture arrives would do the same thing
      // by the back door, a moment later.
      const afterFill = setViewerCompactMode.mock.calls.length;
      settleGrow();
      expect(setViewerCompactMode).toHaveBeenCalledTimes(afterFill);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes only while compact, and only in the viewer window', () => {
    const subscribe = vi.fn(() => () => {});
    window.electronAPI!.onViewerCompactFillScreen = subscribe;

    // The browser-hosted modal has no compact toggle and no window to fill.
    const browserModal = render(
      <ImageModal image={makeImage({ dimensions: '1000x500' })} onClose={() => {}} />,
    );
    expect(subscribe).not.toHaveBeenCalled();
    browserModal.unmount();

    const { rerender } = render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );
    // Not compact yet, so there is nothing the gesture could apply to.
    expect(subscribe).not.toHaveBeenCalled();

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });
    expect(subscribe).toHaveBeenCalledTimes(1);

    rerender(
      <ImageModal
        image={makeImage({ id: 'dir::b.png', dimensions: '500x1000' })}
        onClose={() => {}}
        isStandaloneWindow={true}
        currentIndex={1}
        totalImages={2}
        onNavigateNext={() => {}}
        onNavigatePrevious={() => {}}
      />,
    );
    // Navigating re-shapes the window but does not touch the subscription, so
    // the listener survives rather than being torn down and rebuilt per image.
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});

describe('ImageModal compact mode — zooming inside the frame', () => {
  // A 200x100 file is the case where the frame has room to grow: nothing is
  // upscaled by the fit, so it is 200x100 of picture (content 216x148) and the
  // work area only stops it at 4.92x of that.
  const SMALL = '200x100';

  it('grows the window with the magnification', () => {
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: SMALL })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );

      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(216, 148, 'center'));

      act(() => {
        screen.getByTitle('Zoom In').click();
      });

      // Nothing yet. The frame is about to be asked to grow, and a growth waits
      // for the magnification to stop changing — one resize when the gesture
      // ends, instead of one per step of it.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(216, 148, 'center'));

      settleGrow();

      // 1.5x of the picture: 300x150 of it plus the same fixed chrome, so the
      // window took the image's aspect ratio with it. The ceiling stays the fit
      // at 1x — it is the largest the window may ever *be*, which the OS's
      // maximise gesture also lands on.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(316, 198, 'center', [216, 148]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('grows a coalesced flick in steps, not in one jump', () => {
    // The flash this answers. A resize is drawn by rescaling the previous frame
    // into the new rectangle — the window manager commits the size at once, but
    // the compositor has nothing to put in it for another 40-60ms, and what is
    // on the glass in between is that rescaled frame. So the cost of a resize is
    // how far it moved: one wheel step moves the frame by 1.11-1.24 of itself
    // and reads as a flicker, while the six steps of a flick coalesce into one
    // resize of 2.4 and read as a flash.
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: SMALL })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });

      // Straight to 2x, which is the shape a flick arrives in: the gesture's
      // steps coalesce, and what the frame is finally asked for is the whole
      // distance at once.
      act(() => {
        fireEvent.change(screen.getByTitle('Adjust zoom') as HTMLInputElement, {
          target: { value: '2' },
        });
      });
      settleGrow();

      const widths = setViewerCompactMode.mock.calls
        .map(([payload]) => payload.contentWidth)
        .filter((width): width is number => typeof width === 'number');
      // From the fit it was showing to the size 2x asks for, in more than one
      // step — which is the whole point: the jump it replaces is 416/216.
      expect(widths[0]).toBe(216);
      expect(widths[widths.length - 1]).toBe(416);
      expect(widths.length).toBeGreaterThan(2);
      for (let i = 1; i < widths.length; i += 1) {
        // A hair of slack for the whole-pixel rounding of each step.
        expect(widths[i] / widths[i - 1]).toBeLessThanOrEqual(
          COMPACT_GROW_MAX_STEP + 0.01,
        );
      }
      expect(416 / 216).toBeGreaterThan(COMPACT_GROW_MAX_STEP);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grows a portrait frame into the width a wide display still has', () => {
    // The report this change answers: on a 2048x1104 work area a portrait file
    // is out of height at 1x with most of the width free, and clamping both axes
    // by the zoom's own factor held the frame at its opening size for every step
    // of the zoom — "the window does not grow with the zoom". The width is what
    // follows the magnification, until the display runs out of that too.
    setScreen(2048, 1104);
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: '832x1216' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(739, 1104, 'center'),
      );

      act(() => {
        fireEvent.change(screen.getByTitle('Adjust zoom') as HTMLInputElement, {
          target: { value: '2' },
        });
      });
      // The slider is the same kind of gesture as the wheel — a drag is a run of
      // steps a few milliseconds apart — so its growth waits with it.
      settleGrow();

      // 1446x1056 of picture: every pixel of width the display has, and the same
      // height, which is bound at 1x and stays bound.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(1462, 1104, 'center', [739, 1104]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops growing at the work area — and stops asking', () => {
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: SMALL })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });

      const slider = () => screen.getByTitle('Adjust zoom') as HTMLInputElement;

      act(() => {
        fireEvent.change(slider(), { target: { value: '10' } });
      });
      settleGrow();
      // 10x of a 200x100 picture is 2000x1000, and the display holds 984x952 of
      // it: the frame is the display. (At 8x it is not — the width is bound but
      // the height is still growing, which is the point of clamping the axes
      // apart.)
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(1000, 1000, 'center', [216, 148]),
      );

      const atTheCap = setViewerCompactMode.mock.calls.length;
      act(() => {
        fireEvent.change(slider(), { target: { value: '9.9' } });
      });
      // Run the clock out too: the second step computes the same size, so it is
      // dropped before a wait is even started — and this proves it stays dropped
      // rather than arriving late.
      settleGrow();

      // Still magnified, still the same frame: every further step would ask the
      // main process for the window it is already showing, once per wheel tick,
      // across an IPC round trip. The picture keeps magnifying inside the frame
      // instead — the crop and pan the viewer already has.
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(1000, 1000, 'center', [216, 148]),
      );
      expect(setViewerCompactMode).toHaveBeenCalledTimes(atTheCap);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frames the next image at 1x, whatever the zoom was', () => {
    const navigation = {
      onClose: () => {},
      isStandaloneWindow: true,
      totalImages: 2,
      onNavigateNext: () => {},
      onNavigatePrevious: () => {},
    } as const;

    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ImageModal
          image={makeImage({ id: 'dir::a.png', dimensions: SMALL })}
          currentIndex={0}
          {...navigation}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
      act(() => {
        screen.getByTitle('Zoom In').click();
      });
      settleGrow();
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(316, 198, 'center', [216, 148]),
      );

      const beforeNavigation = setViewerCompactMode.mock.calls.length;

      rerender(
        <ImageModal
          image={makeImage({ id: 'dir::b.png', dimensions: SMALL })}
          currentIndex={1}
          {...navigation}
        />,
      );

      // One reshape, to the new image's fit at 1x. The outgoing image's 1.5x is
      // not carried into it: the reset that follows the navigation cannot change
      // the zoom before this effect has run, so the size it would be read from is
      // the one it has to ignore. And the reset's own re-run says nothing new, so
      // it does not send a second request.
      expect(setViewerCompactMode).toHaveBeenCalledTimes(beforeNavigation + 1);
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(216, 148, 'center'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a growth the user has already navigated away from', () => {
    // The growth waits for the gesture to settle, and a navigation can land
    // inside that wait. The pane is the same size for both images here, so the
    // only thing that can put the old size back on the window is the wait
    // outliving the magnification that asked for it.
    vi.useFakeTimers();
    try {
      const navigation = {
        onClose: () => {},
        isStandaloneWindow: true,
        totalImages: 2,
        onNavigateNext: () => {},
        onNavigatePrevious: () => {},
      } as const;

      const { rerender } = render(
        <ImageModal
          image={makeImage({ id: 'dir::a.png', dimensions: SMALL })}
          currentIndex={0}
          {...navigation}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });

      // Magnified but not yet grown: the request is still waiting.
      act(() => {
        screen.getByTitle('Zoom In').click();
      });
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(216, 148, 'center'));

      rerender(
        <ImageModal
          image={makeImage({ id: 'dir::b.png', dimensions: SMALL })}
          currentIndex={1}
          {...navigation}
        />,
      );
      const afterNavigation = setViewerCompactMode.mock.calls.length;

      settleGrow();

      // The growth belonged to the image that is gone. Left to fire it would
      // resize the window for a 1.5x that is no longer on screen.
      expect(setViewerCompactMode).toHaveBeenCalledTimes(afterNavigation);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not remember a zoomed frame as a size the user chose', () => {
    vi.useFakeTimers();
    try {
      render(
        <ImageModal
          image={makeImage({ dimensions: SMALL })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
      act(() => {
        screen.getByTitle('Zoom In').click();
      });
      settleGrow();
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(316, 198, 'center', [216, 148]),
      );

      const beforeDrag = setViewerCompactMode.mock.calls.length;

      // Dragged to 70% of the 1.5x frame: 210x105 of picture, content 226x153.
      // Read raw that is 1.05x of the file — a number that says nothing about
      // the user's window, and one that would open the next image at 1.05 times
      // its own fit *and* its own zoom on top. With the magnification taken out
      // it is 0.7 of the file's own pixels — but this file is drawn at 4.92 times
      // them on this display, so the share of the screen the drag leaves is
      // 0.1423: under the smallest share whose frame the window manager will
      // make (256/984, the file's fit being the display's width). A size no next
      // image could be opened at without showing background is not one to
      // remember, and refusing it beats clamping it: the factor stays where it
      // was, so nothing re-fits the window and the hand that dragged it keeps
      // the size it gave.
      setWindowSize(226, 153);
      act(() => {
        window.dispatchEvent(new Event('resize'));
        vi.advanceTimersByTime(500);
      });

      expect(Number(stored(COMPACT_SCALE_STORAGE_KEY))).toBe(1);
      expect(setViewerCompactMode).toHaveBeenCalledTimes(beforeDrag);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins the picture to the fit and drops the easing, only while compact', () => {
    render(
      <ImageModal
        image={makeImage({ dimensions: SMALL, thumbnailUrl: 'blob:thumb' })}
        onClose={() => {}}
        isStandaloneWindow={true}
        directoryPath=""
      />,
    );

    const picture = () => screen.getByAltText('test.png') as HTMLImageElement;
    // The ordinary modal sizes the image from its container and eases the jumps.
    expect(picture().style.transition).toBe('transform 0.1s ease-out');
    expect(picture().style.width).toBe('');

    act(() => {
      screen.getByLabelText('Fit window to image').click();
    });

    // Compact: the layout is pinned to the fit the frame was built around, so
    // that a container growing with the zoom cannot re-lay the picture out *and*
    // have the transform scale it, multiplying the two. The easing goes for the
    // same reason — an eased picture would trail the window it was just sized
    // for, showing the background the mode exists to keep out of sight.
    expect(picture().style.width).toBe('200px');
    expect(picture().style.height).toBe('100px');
    expect(picture().style.maxWidth).toBe('none');
    expect(picture().style.maxHeight).toBe('none');
    expect(picture().style.transition).toBe('none');
  });

  // The two halves of the pan rule, as one wheel step each — 1x to 1.25x with
  // the cursor up and to the right of the middle. What differs is whether the
  // frame the window is about to take still has room for the picture: where it
  // does, the window will hold the whole of it and the middle is the only place
  // the picture can end up, so anchoring it on the cursor would shift it and the
  // resize would shift it back — two motions, in opposite directions, for one
  // step of the wheel. Where the display has stopped the frame there is no
  // resize to undo anything, and the anchor is the magnification about the point
  // the user is pointing at, which is the whole reason the wheel has one.

  it('leaves the pan alone while the frame still has room to grow', () => {
    vi.useFakeTimers();
    try {
      // 200x100 of picture that nothing is upscaling, on the 1000x1000 work
      // area: the frame can follow the zoom until 4.92x.
      // The thumbnail stands in for a decoded picture — without one there is no
      // <img> to magnify, only the loading skeleton.
      render(
        <ImageModal
          image={makeImage({ dimensions: SMALL, thumbnailUrl: 'blob:thumb' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });

      // The frame at 1x and the pointer 200,100 from the middle of it. Anchored,
      // this step comes to 50px of slide, of which the pane as it is now allows
      // 17 — so the picture would jump 17px and the growth would take it back.
      stubPaintedSizes(216, 116, 200, 100);
      wheelStep(200, 100);
      expect(picture().style.transform).toBe('translate(0px, 0px) scale(1.25)');

      // The window lands at 266x141 of pane, holding the magnified picture
      // whole, and the re-clamp it triggers has nothing to correct — the pan is
      // where the frame it was measured against will leave it.
      stubPaintedSizes(266, 141, 200, 100);
      act(() => {
        resizeObserverCallback?.([], {} as ResizeObserver);
      });
      expect(picture().style.transform).toBe('translate(0px, 0px) scale(1.25)');

      settleGrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('anchors on the cursor once the display has stopped the frame', () => {
    vi.useFakeTimers();
    try {
      // Twice the width of the work area: the fit is the display's own width, so
      // the frame is against the cap on that axis from the moment it opens, and
      // the pane the pan is measured against is one it is going to keep.
      render(
        <ImageModal
          image={makeImage({ dimensions: '2000x1000', thumbnailUrl: 'blob:thumb' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });

      // 984x492 of picture across a 1000x508 pane. One step is 1230x615 of
      // picture: 246px of it cropped by the width, which is the axis that can be
      // panned, and nothing cropped by the height, which the frame is still free
      // to grow into.
      stubPaintedSizes(1000, 508, 984, 492);
      wheelStep(200, 100);
      expect(picture().style.transform).toBe('translate(-50px, 0px) scale(1.25)');

      // The frame grows to hold the magnification on the free axis. The pan
      // taken on the bound one is still exactly where it was — the picture moved
      // once, and the resize does not move it again.
      stubPaintedSizes(1000, 631, 984, 492);
      act(() => {
        resizeObserverCallback?.([], {} as ResizeObserver);
      });
      expect(picture().style.transform).toBe('translate(-50px, 0px) scale(1.25)');

      settleGrow();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('shrinking the window at the fit', () => {
    // Everything here uses a 1000x500 file on the 1000x1000 work area the
    // harness pins. Its display fit is 984x492 of picture — 0.984 of the file's
    // own pixels, the width being what runs out — and its floor is 0.4: 40% of
    // the display on the axis this file fills, with the window manager's own
    // minimum well below that at 0.26 x 0.23 of it. So the gesture has room, and
    // every frame it asks for is 984u x 492u plus the same fixed chrome.
    const open = () => {
      render(
        <ImageModal
          image={makeImage({ dimensions: '1000x500' })}
          onClose={() => {}}
          isStandaloneWindow={true}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
    };

    it('takes the window down with the gesture', () => {
      open();
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(1000, 540, 'center'),
      );

      // One detent back from the fit: ÷1.2, not the absolute 0.25 the growth
      // side subtracts — 0.25 off 1x would ask for a ÷1.33 in one commit, past
      // the ceiling the paced growth keeps. The step writes the *size factor*,
      // which the next image will open at, so it is 984x492 of picture at 0.8333
      // — 820x410 — plus the same fixed chrome. Anchored "center", not "keep":
      // the step is the viewer's own doing, so the frame shrinks about its centre
      // — a corner held here would walk the window towards the top-left on every
      // detent — and "center" still respects a window the user moved by hand.
      wheelStep(200, 100, 100);
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(836, 458, 'center', [1000, 540]),
      );

      // …and every step after it is the same proportion, so the gesture keeps
      // its shape as it descends. 0.6944: 683x342 of picture.
      wheelStep(200, 100, 100);
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(699, 390, 'center', [1000, 540]),
      );
    });

    it('shrinks as one resize per step, never as a coalesced jump', () => {
      // A growth is allowed to arrive late — the frame catching up a moment
      // after the picture is invisible, because an oversized frame is only ever
      // a frame with room to spare. A shrink cannot be deferred at all: until
      // the window follows, the frame is larger than the picture meant to fill
      // it, which is the band. So every step of the wheel is sent at once, and
      // the thing that has to bound the flash is the size of a single step.
      vi.useFakeTimers();
      try {
        open();
        for (let step = 0; step < 12; step += 1) {
          wheelStep(200, 100, 100);
        }

        const widths = setViewerCompactMode.mock.calls
          .map(([payload]) => payload.contentWidth)
          .filter((width): width is number => typeof width === 'number');
        // One request per detent, none of them held back.
        expect(widths[0]).toBe(1000);
        expect(widths.length).toBeGreaterThan(2);
        for (let i = 1; i < widths.length; i += 1) {
          // Each step is a shrink, and a small one — never further than the
          // ceiling the paced growth keeps, with a hair of slack for the
          // whole-pixel rounding of a frame.
          expect(widths[i]).toBeLessThan(widths[i - 1]);
          expect(widths[i - 1] / widths[i]).toBeLessThan(
            COMPACT_GROW_MAX_STEP + 0.02,
          );
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops at the floor, and stops asking', () => {
      open();
      // Far past any floor a 1000x1000 work area can have.
      for (let step = 0; step < 30; step += 1) {
        wheelStep(200, 100, 100);
      }

      // The floor is COMPACT_MIN_FRACTION of the display on the axis this file
      // fills: 40% of the 984px it fits at is 394x197 of picture, and 410x245 of
      // window once the padding and the drag bar are paid for. A quarter — where
      // this used to stop — was 505x284, which is what the report called "25% of
      // 25%".
      const stopped = lastCompactRequest();
      expect(stopped).toEqual(compactPayload(410, 245, 'center', [1000, 540]));
      wheelStep(200, 100, 100);
      // Not one pixel further: the size factor is on the floor, so the step is a
      // no-op and nothing is sent.
      expect(lastCompactRequest()).toEqual(stopped);
      expect(zoomOutButton().disabled).toBe(true);
    });

    it('keeps the frame at a size the window manager will actually make', () => {
      // The floor's last two terms are main.mjs's own window minimums: below
      // them Electron takes the request and the window manager quietly widens
      // the frame instead, which is the band again. So the frame the gesture
      // stops at is never smaller than the window can be.
      open();
      for (let step = 0; step < 30; step += 1) {
        wheelStep(200, 100, 100);
      }

      const stopped = lastCompactRequest();
      expect(stopped.contentWidth).toBeGreaterThanOrEqual(COMPACT_MIN_WINDOW_WIDTH);
      expect(stopped.contentHeight).toBeGreaterThanOrEqual(COMPACT_MIN_WINDOW_HEIGHT);
    });

    it('offers the way back up from below the fit', () => {
      vi.useFakeTimers();
      try {
        open();
        expect(resetButton().disabled).toBe(true);

        wheelStep(200, 100, 100);
        // Reset goes back *to* the fit rather than being governed by the floor,
        // so it is live exactly when it is the only control that can get there.
        expect(resetButton().disabled).toBe(false);

        act(() => {
          resetButton().click();
        });
        // Going back up is a growth, so it waits for the gesture to settle — and
        // it is one step, since the whole way back is under the ceiling.
        settleGrow();
        expect(setViewerCompactMode).toHaveBeenLastCalledWith(
          compactPayload(1000, 540, 'center', [1000, 540]),
        );
        expect(resetButton().disabled).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets the zoom buttons shrink the frame, while the slider magnifies', () => {
      // The slider is the magnification and nothing else, in every mode: a
      // compact window's *size* is not a zoom, it is the factor the wheel and the
      // window's own edge write, and a slider that reached below the fit would be
      // setting a number the mode no longer keeps its size in. The buttons are
      // gestures, so at the fit they shrink the window — one press is one detent,
      // which is why the frame lands where a single wheel step lands.
      open();
      expect(Number(zoomSlider().min)).toBe(1);
      expect(zoomOutButton().disabled).toBe(false);

      act(() => {
        zoomOutButton().click();
      });
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(836, 458, 'center', [1000, 540]),
      );
    });

    it('leaves the ordinary modal floored at 1x', () => {
      // No window to shrink: the pane is whatever the layout gives it, and
      // zooming out of it would only shrink the picture inside the same box. The
      // slider's own `min` is the floor in both modes — 1 outside, the frame's
      // floor inside — so this is the same control everywhere else.
      render(<ImageModal image={makeImage({ dimensions: '1000x500' })} onClose={() => {}} />);

      expect(Number(zoomSlider().min)).toBe(1);
      expect(zoomOutButton().disabled).toBe(true);
    });

    it('comes back up through the fit without overshooting it', () => {
      vi.useFakeTimers();
      try {
        open();
        wheelStep(200, 100, 100);
        expect(Number(lastCompactRequest().contentWidth)).toBe(836);

        // And back. The step up from below the fit is the same proportion, so it
        // lands on the fit rather than near it, and the frame is the fit's own
        // size again — the window the mode opened with.
        wheelStep(200, 100);
        settleGrow();
        expect(setViewerCompactMode).toHaveBeenLastCalledWith(
          compactPayload(1000, 540, 'center', [1000, 540]),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('opens the next image at the window the gesture left', () => {
      // The reason the shrink writes a size factor rather than lowering the zoom:
      // the factor outlives the image it was made for, so the window the user
      // left is the window the next image opens in. And below 1 the factor is a
      // share of the display, which is what makes it the same *window* for a file
      // of any shape instead of the same multiple of a fit that differs per file.
      const navigation = {
        onClose: () => {},
        isStandaloneWindow: true,
        totalImages: 2,
        onNavigateNext: () => {},
        onNavigatePrevious: () => {},
      } as const;

      const { rerender } = render(
        <ImageModal
          image={makeImage({ id: 'dir::a.png', dimensions: '1000x500' })}
          currentIndex={0}
          {...navigation}
        />,
      );
      act(() => {
        screen.getByLabelText('Fit window to image').click();
      });
      wheelStep(200, 100, 100);
      wheelStep(200, 100, 100);
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(699, 390, 'center', [1000, 540]),
      );
      // Written through as the user's own preference, which is what makes it the
      // next window's size rather than this one's alone.
      expect(Number(stored(COMPACT_SCALE_STORAGE_KEY))).toBeCloseTo(0.6944, 3);

      // A portrait file next, whose own fit is 476x952 of picture: the same 0.6944
      // opens it at 331x661 of picture — 347x709 of window — rather than at its
      // own 100%, and rather than the 505x284 that a quarter of the *fit* would
      // have made of it.
      rerender(
        <ImageModal
          image={makeImage({ id: 'dir::b.png', dimensions: '500x1000' })}
          currentIndex={1}
          {...navigation}
        />,
      );
      expect(setViewerCompactMode).toHaveBeenLastCalledWith(
        compactPayload(347, 709, 'center', [492, 1000]),
      );
    });
  });

});
