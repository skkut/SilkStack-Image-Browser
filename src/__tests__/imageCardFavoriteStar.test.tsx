// @vitest-environment jsdom
//
// The favourite star on a library grid card. A starred image fills its star
// glyph, and `fill-current` covers the whole silhouette — at the outline's
// size it reads bigger and heavier than the card's other controls. The filled
// glyph is therefore rendered one size down. The stack views draw the same
// badge from SimilarityStackExpandedView (in-app drill-down and popped-out
// stack window), covered by that package's own test.
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
import { render, cleanup } from '@testing-library/react';
import { ImageCard } from '../components/ImageGrid';
import type { IndexedImage } from '../types';

const makeImage = (isFavorite: boolean): IndexedImage =>
  ({
    id: `dir::${isFavorite ? 'starred.png' : 'plain.png'}`,
    name: isFavorite ? 'starred.png' : 'plain.png',
    directoryId: 'dir',
    directoryName: 'lib',
    handle: { name: isFavorite ? 'starred.png' : 'plain.png' },
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 111,
    fileSize: 64,
    fileType: 'image/png',
    // A ready poster keeps the thumbnail manager and the card's own fallback
    // out of the picture, so the card renders only the image and the badge.
    thumbnailStatus: 'ready',
    thumbnailUrl: 'blob:poster',
    models: [],
    loras: [],
    scheduler: '',
    isFavorite,
  }) as unknown as IndexedImage;

const renderCard = (isFavorite: boolean) =>
  render(
    <ImageCard
      image={makeImage(isFavorite)}
      onImageClick={vi.fn()}
      isSelected={false}
      onImageLoad={vi.fn()}
      baseWidth={200}
    />,
  );

/** The star SVG inside the badge carrying the given tooltip. */
const starOf = (container: HTMLElement, title: string): SVGElement => {
  const button = container.querySelector(`[title="${title}"]`);
  expect(button).not.toBeNull();
  const star = button!.querySelector('svg');
  expect(star).not.toBeNull();
  return star as SVGElement;
};

beforeEach(() => {
  cleanup();
});

describe('grid card favourite star', () => {
  it('keeps the outlined star compact', () => {
    const star = starOf(renderCard(false).container, 'Add to favorites');

    expect(star.classList.contains('h-3.5')).toBe(true);
    expect(star.classList.contains('w-3.5')).toBe(true);
    expect(star.classList.contains('fill-current')).toBe(false);
  });

  it('renders the filled star smaller than the outline', () => {
    const star = starOf(renderCard(true).container, 'Remove from favorites');

    expect(star.classList.contains('h-3')).toBe(true);
    expect(star.classList.contains('w-3')).toBe(true);
    expect(star.classList.contains('fill-current')).toBe(true);
  });
});
