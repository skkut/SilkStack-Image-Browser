import { describe, expect, it, vi, afterEach } from 'vitest';

// The stores read localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it (and sessionStorage, read by
// ImageModal) before any module import.
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
      // Reachable from tests to seed a remembered preference before render.
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
import { render, screen, cleanup } from '@testing-library/react';
import ImageModal from '../components/ImageModal';
import { COMPACT_MODE_STORAGE_KEY } from '../utils/windowSizing';
import type { IndexedImage } from '../types';

/**
 * The viewer window's own title bar.
 *
 * Both child windows are frameless with a title-bar overlay, so this 32px strip
 * is the window's title bar — the OS never draws one. It carries the same
 * "Image: <name>" the window title does, which is what the user sees at the top
 * of the window, and it follows navigation because the window re-renders with
 * the image it is showing.
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

const renderWindow = (image: IndexedImage) => (
  <ImageModal image={image} onClose={() => {}} isStandaloneWindow={true} />
);

describe('the image viewer title bar', () => {
  afterEach(cleanup);

  it('names the image it is showing', () => {
    render(renderWindow(makeImage()));

    expect(screen.getByText('Image: test.png')).toBeTruthy();
  });

  it('follows navigation to the next image', () => {
    const { rerender } = render(renderWindow(makeImage()));

    rerender(
      renderWindow(makeImage({ id: 'dir::next.png', name: 'next.png' })),
    );

    expect(screen.getByText('Image: next.png')).toBeTruthy();
    expect(screen.queryByText('Image: test.png')).toBeNull();
  });

  it('keeps the title in a remembered compact window', () => {
    // Compact mode used to drop the label entirely, which left the viewer with
    // no title at all for anyone who had ever used the mode. It now renders
    // unconditionally and only its CSS hides it in windows too narrow to fit
    // it beside the buttons and the OS control reserve — and jsdom does not
    // apply Tailwind, so presence here is exactly what the fix guarantees.
    (global.localStorage as any).__store.set(COMPACT_MODE_STORAGE_KEY, 'true');

    render(
      <ImageModal
        image={makeImage({ dimensions: '1000x500' })}
        onClose={() => {}}
        isStandaloneWindow={true}
      />,
    );

    // The panel is hidden only when compact mode actually engaged, so this
    // guards the assertion below from passing on a non-compact render.
    expect(screen.getByTestId('metadata-panel').className).toContain('hidden');
    expect(screen.getByText('Image: test.png')).toBeTruthy();
  });

  it('has no title bar in the in-app modal', () => {
    // The browser-hosted modal has no window to title; the strip exists only
    // for the standalone window.
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    expect(screen.queryByText('Image: test.png')).toBeNull();
  });
});
