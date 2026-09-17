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
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverMock as any;
});

import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import ImageModal from '../components/ImageModal';
import {
  COMPACT_MODE_STORAGE_KEY,
  COMPACT_SCALE_STORAGE_KEY,
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

const setViewerCompactMode = vi.fn().mockResolvedValue({ success: true });

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

beforeEach(() => {
  setViewerCompactMode.mockClear();
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
    // The sidebar toggle would be a no-op while compact, so it is gone.
    expect(screen.queryByLabelText('Collapse Sidebar')).toBeNull();
    expect(screen.queryByLabelText('Expand Sidebar')).toBeNull();
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

    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'keep'));
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
    expect(setViewerCompactMode).toHaveBeenLastCalledWith(compactPayload(1000, 540, 'keep'));
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
