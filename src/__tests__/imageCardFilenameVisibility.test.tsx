// @vitest-environment jsdom
//
// The file-name strip on a grid card. Its visibility is a persisted display
// setting: hover-only by default, always visible when the user turns it on —
// and a change must reach cards already on screen, not just newly rendered
// ones. The strip stays in the same place either way; only its opacity class
// changes.
import { describe, expect, it, vi, beforeEach } from 'vitest';

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
import { render, act, cleanup } from '@testing-library/react';
import { ImageCard } from '../components/ImageGrid';
import { useSettingsStore } from '../store/useSettingsStore';
import type { IndexedImage } from '../types';

const makeImage = (name: string): IndexedImage =>
  ({
    id: `dir::${name}`,
    name,
    directoryId: 'dir',
    directoryName: 'lib',
    handle: { name },
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 111,
    fileSize: 64,
    fileType: 'image/png',
    // A ready poster keeps the thumbnail manager and the card's own fallback
    // out of the picture, so the card renders only the image and the strip.
    thumbnailStatus: 'ready',
    thumbnailUrl: 'blob:poster',
    models: [],
    loras: [],
    scheduler: '',
  }) as unknown as IndexedImage;

const renderCard = (name = 'sample.png') =>
  render(
    <ImageCard
      image={makeImage(name)}
      onImageClick={vi.fn()}
      isSelected={false}
      onImageLoad={vi.fn()}
      baseWidth={200}
    />,
  );

/** The element carrying the visibility classes, wrapped around the name text. */
const stripOf = (container: HTMLElement): HTMLElement => {
  const label = container.querySelector('p');
  expect(label).not.toBeNull();
  return label!.parentElement as HTMLElement;
};

beforeEach(() => {
  cleanup();
  useSettingsStore.getState().setAlwaysShowFilenames(false);
});

describe('grid card file-name strip', () => {
  it('shows the base file name, revealed on hover by default', () => {
    const { container } = renderCard();
    const strip = stripOf(container);

    expect(strip.textContent).toBe('sample.png');
    // Tailwind classes are read as exact tokens: `group-hover:opacity-100`
    // contains the substring `opacity-100` too.
    expect(strip.classList.contains('opacity-0')).toBe(true);
    expect(strip.classList.contains('group-hover:opacity-100')).toBe(true);
    expect(strip.classList.contains('opacity-100')).toBe(false);
  });

  it('keeps the name visible when the setting is on', () => {
    useSettingsStore.getState().setAlwaysShowFilenames(true);

    const strip = stripOf(renderCard().container);

    expect(strip.classList.contains('opacity-100')).toBe(true);
    expect(strip.classList.contains('opacity-0')).toBe(false);
    expect(strip.classList.contains('group-hover:opacity-100')).toBe(false);
  });

  it('updates cards already on screen when the setting changes', () => {
    const { container } = renderCard();
    expect(stripOf(container).classList.contains('opacity-0')).toBe(true);

    act(() => useSettingsStore.getState().setAlwaysShowFilenames(true));

    expect(stripOf(container).classList.contains('opacity-100')).toBe(true);
  });
});
