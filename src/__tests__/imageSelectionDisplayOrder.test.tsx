import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue('true'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

// ImageGrid (imported for toDisplayOrder, the mapping the grid itself uses)
// pulls its stack UI from the module; the grouping under test lives in
// src/hooks/useImageStacking and is unaffected by this mock.
vi.mock('@ai-images-browser/ai-intelligence', () => ({
  createStackingEngine: vi.fn(),
  createAutoTaggingEngine: vi.fn(),
  createSemanticSearchEngine: vi.fn(),
  createRerankEngine: vi.fn(),
  createEmbeddingEngine: vi.fn(),
  StackCard: () => null,
  SimilarityStackExpandedView: () => null,
}));

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useImageStacking } from '../hooks/useImageStacking';
import { useImageSelection } from '../hooks/useImageSelection';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';
import { toDisplayOrder } from '../components/ImageGrid';
import type { IndexedImage } from '../types';

/**
 * Shift+click must be measured in the order the cards are DRAWN, which with
 * stacking on is not `filteredImages`: a stack is one card, and the stacking
 * hook re-sorts the items. When the two lists disagree — most visibly in
 * semantic mode, where the store hands over score order and the stacking hook
 * keeps its own grouped order — a run measured over the library order lights
 * up images the user cannot see and leaves the cards between the two clicks
 * unselected.
 *
 * These tests stand in for ImageGrid: one button per laid-out card, in layout
 * order, with the layout order handed to the selection hook exactly as the grid
 * hands it over.
 */

/** Mirrors the stacking suite's fixture: enough shape for the grouping code. */
const createImage = (
  id: string,
  lastModified: number,
  stackGroupId?: string,
): IndexedImage => ({
  id,
  name: `${id}.png`,
  handle: {} as FileSystemFileHandle,
  metadata: { normalizedMetadata: { prompt: id, negativePrompt: '' } } as any,
  metadataString: '',
  lastModified,
  models: [],
  loras: [],
  scheduler: '',
  prompt: id,
  stackGroupId,
} as unknown as IndexedImage);

const Harness = ({ images }: { images: IndexedImage[] }) => {
  const { stackedItems } = useImageStacking(images, true);
  const { handleImageSelection } = useImageSelection();
  const order = toDisplayOrder(stackedItems);

  return (
    <>
      {order.map((id, index) => {
        const image = images.find(candidate => candidate.id === id)!;
        return (
          <button
            key={id}
            data-testid={`card-${index}`}
            data-image-id={id}
            onClick={(event) => handleImageSelection(image, event, order)}
          >
            {image.name}
          </button>
        );
      })}
    </>
  );
};

const clickCard = (index: number, modifiers: { shiftKey?: boolean; ctrlKey?: boolean } = {}) =>
  fireEvent.click(screen.getByTestId(`card-${index}`), modifiers);

/** The ids of the laid-out cards, in the order they were drawn. */
const drawnIds = () =>
  screen.getAllByTestId(/^card-/).map(element => element.getAttribute('data-image-id')!);

const selectedIds = () => Array.from(useImageStore.getState().selectedImages).sort();

/**
 * Six images; img1/img2/img4 share a stack, so the grid draws four cards. The
 * library order deliberately disagrees with the drawn order — what semantic
 * mode's score order looks like next to the stacking hook's stacks-first order.
 */
const stackedLibrary = () => [
  createImage('img0', 6000),
  createImage('img1', 5000, 'group-a'),
  createImage('img2', 4000, 'group-a'),
  createImage('img3', 3000),
  createImage('img4', 2000, 'group-a'),
  createImage('img5', 1000),
];

/** The `filteredImages` order the store would hand over mid-semantic-search. */
const libraryOrder = (images: IndexedImage[]) =>
  [images[0], images[3], images[5], images[1], images[2], images[4]];

const seed = (images: IndexedImage[]) => {
  useImageStore.setState({
    images,
    filteredImages: libraryOrder(images),
    sortOrder: 'relevance',
    selectedImages: new Set<string>(),
    selectionAnchorId: null,
    focusedImageIndex: 0,
  });
};

const licenseState = () => {
  // Capture once: the stamp is bound to the exact timestamp it was made for.
  const validatedAt = Date.now();
  return {
    licenseStatus: 'valid',
    licenseKey: 'TEST-KEY',
    licenseLastValidated: validatedAt,
    licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', validatedAt),
  };
};

// Stacking is premium-gated: the hook only groups with an active license and
// the AI module present — the same guard the other stacking suites use.
describe.skipIf(!import.meta.env.VITE_AI_FEATURES_AVAILABLE)('Shift+click over stacked cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState(licenseState() as any);
    (global.window as any).electronAPI = {
      openImageViewer: vi.fn().mockResolvedValue({ success: true, windowId: 1 }),
      isDev: vi.fn().mockResolvedValue(false),
    };
  });

  it('fills the run between the drawn cards, not the library order', () => {
    const images = stackedLibrary();
    seed(images);
    render(<Harness images={images} />);

    const drawn = drawnIds();
    // Precondition: the drawn order is a different order, and shorter — a run
    // measured over the library order cannot match it.
    expect(drawn).toHaveLength(4);
    expect(drawn).not.toEqual(images.map(image => image.id));

    clickCard(0, { ctrlKey: true });
    clickCard(3, { shiftKey: true });

    expect(selectedIds()).toEqual([...drawn].sort());
  });

  it('fills backwards from the drawn cards, keeping every earlier pick', () => {
    const images = stackedLibrary();
    seed(images);
    render(<Harness images={images} />);

    const drawn = drawnIds();
    clickCard(3, { ctrlKey: true });
    clickCard(1, { shiftKey: true });

    // Drawn order 1..3: the drawn-card form of "Shift+click before the
    // selection fills up to it and drops nothing".
    expect(selectedIds()).toEqual([...drawn.slice(1, 4)].sort());
  });

  it('draws no run from a hidden stack member, and still keeps it selected', () => {
    const images = stackedLibrary();
    seed(images);
    // img2 sits inside the collapsed stack: selected, but with no card of its
    // own to measure a run from.
    useImageStore.setState({
      selectedImages: new Set(['img2']),
      selectionAnchorId: 'img2',
    });
    render(<Harness images={images} />);
    expect(drawnIds()).not.toContain('img2');

    clickCard(1, { shiftKey: true });

    // No run to draw → the Shift+click is an additive pick: img2 survives and
    // the viewer is not opened (the plain-click path would replace everything).
    expect(selectedIds()).toEqual(['img0', 'img2']);
    expect((window as any).electronAPI.openImageViewer).not.toHaveBeenCalled();
  });
});
