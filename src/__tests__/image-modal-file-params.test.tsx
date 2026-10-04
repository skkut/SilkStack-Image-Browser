import { describe, it, expect, vi } from 'vitest';

// The stores call localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it (and sessionStorage, read by
// ImageModal) before any module import.
vi.hoisted(() => {
  const makeStorage = () => ({
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(() => null),
  } as Storage);
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
import { render, screen } from '@testing-library/react';
import ImageModal from '../components/ImageModal';
import type { IndexedImage } from '../types';

/**
 * ImageModal file-parameter regression.
 *
 * Resolution / megapixels / aspect ratio / file size are FILE properties —
 * they display in the header stat line under the timestamp, and they must
 * show even when the file carries no generation metadata (nMeta undefined) or
 * when the metadata parser left width/height unset (e.g. MP4s whose dimensions
 * come from the tkhd track header, not from embedded generation data). The
 * indexer stores them in image.dimensions.
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

describe('ImageModal file parameters', () => {
  it('shows dimensions/megapixels/aspect ratio/file size without normalized metadata', () => {
    render(
      <ImageModal
        image={makeImage({ dimensions: '1344x768', fileSize: 2048 })}
        onClose={() => {}}
      />,
    );

    // The header stat line renders independently of nMeta. It carries no
    // visible labels, so each value is its own anchor.
    expect(screen.getByText('1344 × 768')).toBeTruthy();
    expect(screen.getByText('1.03 MP')).toBeTruthy();
    expect(screen.getByText('16:9')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    // …and the no-metadata notice still shows for generation data.
    expect(screen.getByText('No normalized metadata available.')).toBeTruthy();
  });

  it('prefers normalized metadata width/height over the stored dimensions string', () => {
    render(
      <ImageModal
        image={makeImage({
          dimensions: '512x512',
          fileSize: 100,
          metadata: {
            normalizedMetadata: {
              width: 1024,
              height: 1024,
              prompt: 'a test prompt',
              model: '',
            } as any,
          },
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('1024 × 1024')).toBeTruthy();
    expect(screen.getByText('1.05 MP')).toBeTruthy();
    expect(screen.getByText('1:1')).toBeTruthy();
    // The stale/fallback dimensions string must not win over metadata.
    expect(screen.queryByText('512 × 512')).toBeNull();
  });
});
