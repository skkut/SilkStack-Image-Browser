// @vitest-environment jsdom
//
// The "AI tag" badge marks a search result that is only on screen because of
// the hidden AI vocabulary (synonyms/categories). The grid and the list each
// render it themselves, and the list row is a React.memo whose hand-written
// comparator has to list the prop — otherwise the badge is missed for every
// row that was already mounted when a query changed.
//
// Cards/rows are rendered directly: they live inside react-window, which
// measures zero in jsdom and renders nothing.
import { describe, expect, it, vi, afterEach } from 'vitest';

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
import { render, cleanup, screen } from '@testing-library/react';
import { ImageCard } from '../components/ImageGrid';
import { ImageTableRow } from '../components/ImageTable';
import type { IndexedImage } from '../types';

const image = (): IndexedImage =>
  ({
    id: 'dir::fox.png',
    name: 'fox.png',
    directoryId: 'dir',
    directoryName: 'lib',
    handle: { name: 'fox.png' } as unknown as FileSystemFileHandle,
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 1000,
    fileSize: 64,
    // A ready poster keeps the thumbnail manager and the card's own fallback
    // timer out of the picture.
    thumbnailStatus: 'ready',
    thumbnailUrl: 'blob:poster',
    models: [],
    loras: [],
    scheduler: '',
  }) as unknown as IndexedImage;

const cardProps = (isAiTagMatch?: boolean) => ({
  image: image(),
  onImageClick: vi.fn(),
  isSelected: false,
  onImageLoad: vi.fn(),
  baseWidth: 200,
  isAiTagMatch,
});

const rowProps = (isAiTagMatch?: boolean) => ({
  image: image(),
  onImageClick: vi.fn(),
  isSelected: false,
  gridTemplateColumns: '1fr',
  isAiTagMatch,
});

afterEach(cleanup);

describe('AI tag badge', () => {
  it('appears on a grid card whose match came from the hidden AI vocabulary', () => {
    render(<ImageCard {...cardProps(true)} />);
    expect(screen.getByTitle('AI tag')).toBeTruthy();
  });

  it('is absent from an ordinary keyword match', () => {
    render(<ImageCard {...cardProps(false)} />);
    expect(screen.queryByTitle('AI tag')).toBeNull();
  });

  it('appears on a table row', () => {
    render(<ImageTableRow {...rowProps(true)} />);
    expect(screen.getByTitle('AI tag')).toBeTruthy();
  });

  it('reaches an already-mounted table row when the match flag changes', () => {
    const { rerender } = render(<ImageTableRow {...rowProps(false)} />);
    expect(screen.queryByTitle('AI tag')).toBeNull();

    // The row is memoized with a custom comparator; without the isAiTagMatch
    // line in it, this rerender would be skipped and the badge would never
    // appear.
    rerender(<ImageTableRow {...rowProps(true)} />);
    expect(screen.getByTitle('AI tag')).toBeTruthy();
  });
});
