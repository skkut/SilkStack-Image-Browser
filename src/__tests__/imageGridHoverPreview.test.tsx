// @vitest-environment jsdom
//
// The library grid's half of the hover-autoplay wiring. The coordinator's
// policy is covered in hoverPreviewCoordinator.test.ts; what is checked here is
// that ImageCard itself is hooked up — and specifically the badge/motion swap,
// which is the grid's own affordance and has no counterpart in the table.
//
// The card is rendered directly: cards live inside react-window, which measures
// zero in jsdom and renders nothing.
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
import { ImageCard } from '../components/ImageGrid';
import { useSettingsStore } from '../store/useSettingsStore';
import { hoverPreview, HOVER_DWELL_MS } from '../services/hoverPreviewCoordinator';
import type { IndexedImage } from '../types';

const makeImage = (name: string, fileType: string): IndexedImage =>
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
    fileType,
    // A ready poster keeps the thumbnail manager and the card's own fallback out
    // of the picture, so every object URL below comes from the preview.
    thumbnailStatus: 'ready',
    thumbnailUrl: 'blob:poster',
    models: [],
    loras: [],
    scheduler: '',
  }) as unknown as IndexedImage;

const renderCard = (image: IndexedImage) =>
  render(
    <ImageCard
      image={image}
      onImageClick={vi.fn()}
      isSelected={false}
      onImageLoad={vi.fn()}
      baseWidth={200}
    />,
  );

/**
 * The element carrying the enter/leave handlers. Not `firstElementChild`: the
 * card's root is a handler-less layout wrapper, and React's enter/leave plugin
 * fires enter for the event target's *ancestors* only — so aiming at the
 * wrapper never reaches the descendant that owns the handler.
 */
const cardOf = (container: HTMLElement) => container.querySelector('.group') as HTMLElement;

/**
 * Let the dwell elapse and React settle on the result.
 *
 * mouseOver/mouseOut rather than mouseEnter/mouseLeave: React derives its
 * enter/leave synthetic events from the over/out pair, so dispatching
 * `mouseenter` directly never reaches an onMouseEnter handler.
 */
const hoverFor = async (container: HTMLElement) => {
  await act(async () => {
    fireEvent.mouseOver(cardOf(container));
    await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS + 10);
  });
};

const leave = async (container: HTMLElement) => {
  await act(async () => {
    fireEvent.mouseOut(cardOf(container));
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

describe('grid video hover preview', () => {
  it('plays a video while the pointer rests on the card', async () => {
    const { container } = renderCard(makeImage('clip.mp4', 'video/mp4'));
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
    // Every gesture has to keep reaching the card, not the video on top of it.
    expect(video?.className).toContain('pointer-events-none');
  });

  it('swaps the play badge for the motion, and back again', async () => {
    // The badge is the "this is a video" affordance. While the video is
    // actually playing the motion says it better, so the two are exclusive.
    const { container } = renderCard(makeImage('clip.mp4', 'video/mp4'));
    expect(container.querySelector('.lucide-play')).not.toBeNull();

    await hoverFor(container);
    expect(container.querySelector('video')).not.toBeNull();
    expect(container.querySelector('.lucide-play')).toBeNull();

    await leave(container);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('.lucide-play')).not.toBeNull();
  });

  it('animates an animated GIF through an <img>, not a <video>', async () => {
    const { container } = renderCard(makeImage('anim.gif', 'image/gif'));

    await hoverFor(container);

    const preview = container.querySelector('img[src="blob:preview"]');
    expect(preview).not.toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('never reads the file when the setting is off', async () => {
    useSettingsStore.getState().setAutoplayVideoPreviews(false);

    const { container } = renderCard(makeImage('clip.mp4', 'video/mp4'));
    await hoverFor(container);

    expect(container.querySelector('video')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('leaves still images alone', async () => {
    const { container } = renderCard(makeImage('photo.png', 'image/png'));
    await hoverFor(container);

    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img[src="blob:preview"]')).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
