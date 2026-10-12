// @vitest-environment jsdom
//
// End-to-end wiring for hover-autoplay on a grid card: pointer enters → the
// preview is loaded through the coordinator → a <video> appears over the
// poster — and leaving, or turning the setting off, takes it away again.
//
// The row is rendered directly: the table's rows live inside react-window,
// which measures zero in jsdom and renders nothing.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import React from 'react';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { ImageTableRow } from '../components/ImageTable';
import { useSettingsStore } from '../store/useSettingsStore';
import { hoverPreview, HOVER_DWELL_MS } from '../services/hoverPreviewCoordinator';
import type { IndexedImage } from '../types';

const makeVideoImage = (name = 'clip.mp4'): IndexedImage =>
  ({
    id: `dir::${name}`,
    name,
    directoryId: 'dir',
    directoryName: 'lib',
    handle: {
      name,
      // What the Electron mock handle does: reads the file and mislabels it.
      getFile: async () => new File([new Uint8Array(64)], name, { type: 'image/jpeg' }),
    },
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 111,
    fileSize: 64,
    fileType: 'video/mp4',
    // A ready poster keeps the thumbnail manager and the row's own fallback
    // out of the picture, so every object URL below comes from the preview.
    thumbnailStatus: 'ready',
    thumbnailUrl: 'blob:poster',
    models: [],
    loras: [],
    scheduler: '',
  }) as unknown as IndexedImage;

const renderRow = (image: IndexedImage) =>
  render(
    <ImageTableRow
      image={image}
      onImageClick={vi.fn()}
      isSelected={false}
      gridTemplateColumns="1fr"
    />,
  );

/**
 * Let the dwell elapse and React settle on the result.
 *
 * mouseOver/mouseOut rather than mouseEnter/mouseLeave: React derives its
 * enter/leave synthetic events from the over/out pair, so dispatching
 * `mouseenter` directly never reaches an onMouseEnter handler.
 */
const hoverFor = async (container: HTMLElement) => {
  await act(async () => {
    fireEvent.mouseOver(container.firstElementChild as HTMLElement);
    await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS + 10);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  hoverPreview.clear();
  useSettingsStore.getState().setAutoplayVideoPreviews(true);
  (URL as any).createObjectURL = vi.fn(() => 'blob:preview');
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  hoverPreview.clear();
  vi.useRealTimers();
});

describe('table row video hover preview', () => {
  it('plays a video while the pointer rests on the card', async () => {
    const { container } = renderRow(makeVideoImage());
    expect(container.querySelector('video')).toBeNull();

    await hoverFor(container);

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:preview');
    // Muted + looping is what makes a hover preview acceptable rather than
    // obnoxious, and is also what lets it autoplay without a user gesture.
    // `muted` is read as a property: React treats it as must-use-property
    // (alongside checked/value/selected), so it is never written as an
    // attribute and hasAttribute('muted') is always false.
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect(video?.hasAttribute('loop')).toBe(true);
  });

  it('stops the preview when the pointer leaves', async () => {
    const { container } = renderRow(makeVideoImage());
    await hoverFor(container);
    expect(container.querySelector('video')).not.toBeNull();

    await act(async () => {
      fireEvent.mouseOut(container.firstElementChild as HTMLElement);
    });

    expect(container.querySelector('video')).toBeNull();
  });

  it('never reads the file when the setting is off', async () => {
    useSettingsStore.getState().setAutoplayVideoPreviews(false);

    const { container } = renderRow(makeVideoImage());
    await hoverFor(container);

    expect(container.querySelector('video')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('leaves still images alone', async () => {
    const image = { ...makeVideoImage('photo.png'), fileType: 'image/png' } as IndexedImage;

    const { container } = renderRow(image);
    await hoverFor(container);

    expect(container.querySelector('video')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
