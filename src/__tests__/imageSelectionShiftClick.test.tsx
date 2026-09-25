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

// The store lazy-loads the coordinator and the AI module through dynamic
// imports; both are mocked so importing the store in jsdom never reaches for a
// real worker. Mirrors the scaffolding in semanticSearchUi.test.tsx.
vi.mock('../services/semanticSearchEngine', () => ({
  SemanticSearchCoordinator: vi.fn(function SemanticSearchCoordinator() {
    return {
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
      indexImages: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0 }),
      search: vi.fn().mockResolvedValue([]),
      clearIndex: vi.fn().mockResolvedValue(undefined),
      cancelIndexing: vi.fn(),
      getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
      unloadModels: vi.fn().mockResolvedValue(undefined),
      getModelsStatus: vi.fn(() => ({
        chatLoaded: false,
        embedLoaded: false,
        chatModelId: null,
        embedModelId: null,
        chatVramMb: null,
        embedVramMb: null,
      })),
      dispose: vi.fn(),
    };
  }),
  getEmbeddingModelOptions: vi.fn().mockResolvedValue([]),
  getTagModelOptions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

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
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ImageCard } from '../components/ImageGrid';
import { useImageSelection } from '../hooks/useImageSelection';
import { useImageStore } from '../store/useImageStore';
import type { IndexedImage } from '../types';

const makeImage = (id: string): IndexedImage => ({
  id,
  name: `${id}.png`,
  metadataString: '',
  lastModified: Date.now(),
  models: [],
  loras: [],
  scheduler: '',
} as unknown as IndexedImage);

/**
 * Stands in for App.tsx: the grid's cards hand every click to the selection
 * hook. This is the path under test — Shift+click on a card must run through
 * ImageCard's onClick (not the checkbox) and reach the store.
 */
const Harness = ({ images }: { images: IndexedImage[] }) => {
  const { handleImageSelection } = useImageSelection();
  const selectedImages = useImageStore((state) => state.selectedImages);

  return (
    <>
      {images.map((image) => (
        <div key={image.id} data-testid={`wrap-${image.id}`}>
          <ImageCard
            image={image}
            onImageClick={handleImageSelection}
            isSelected={selectedImages.has(image.id)}
            onImageLoad={vi.fn()}
            baseWidth={200}
          />
        </div>
      ))}
    </>
  );
};

/** The clickable card box — ImageCard wraps it in a flex column (the element
 *  carrying onClick is the card's inner box, not the wrapper). */
const cardOf = (id: string) => {
  const wrap = screen.getByTestId(`wrap-${id}`);
  return wrap.firstElementChild!.firstElementChild as HTMLElement;
};

/** The hover checkbox — the "pick" gesture that sets the Shift anchor. */
const checkboxOf = (id: string) =>
  within(screen.getByTestId(`wrap-${id}`)).getByTitle(/Select image|Deselect image/);

const fiveImages = () => Array.from({ length: 5 }, (_, i) => makeImage(`img${i}`));
const sevenImages = () => Array.from({ length: 7 }, (_, i) => makeImage(`img${i}`));
const selectedIds = () => Array.from(useImageStore.getState().selectedImages).sort();

const seed = (images: IndexedImage[]) => {
  useImageStore.setState({
    images,
    filteredImages: images,
    directories: [],
    selectedImage: null,
    selectedImages: new Set<string>(),
    selectionAnchorId: null,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  (global.window as any).electronAPI = {
    // The plain-click path chains .then() onto the result.
    openImageViewer: vi.fn().mockResolvedValue({ success: true, windowId: 1 }),
    isDev: vi.fn().mockResolvedValue(false),
  };
});

describe('image grid Shift+click selection', () => {
  it('fills the run from the last picked image to the clicked one', () => {
    const images = fiveImages();
    seed(images);
    render(<Harness images={images} />);

    fireEvent.click(checkboxOf('img1'));
    fireEvent.click(cardOf('img3'), { shiftKey: true });

    expect(selectedIds()).toEqual(['img1', 'img2', 'img3']);
  });

  it('measures from the LAST pick when several images are already selected', () => {
    const images = fiveImages();
    seed(images);
    render(<Harness images={images} />);

    fireEvent.click(checkboxOf('img0'));
    fireEvent.click(checkboxOf('img4')); // last pick → the anchor
    fireEvent.click(cardOf('img2'), { shiftKey: true });

    // img2..img4 — an img0 anchor would have swept img1 in as well.
    expect(selectedIds()).toEqual(['img0', 'img2', 'img3', 'img4']);
  });

  it('clicking before the selection fills up to it without dropping anything', () => {
    const images = fiveImages();
    seed(images);
    render(<Harness images={images} />);

    fireEvent.click(checkboxOf('img3'));
    fireEvent.click(cardOf('img0'), { shiftKey: true });

    expect(selectedIds()).toEqual(['img0', 'img1', 'img2', 'img3']);
  });

  it('keeps every earlier pick when the run is extended further', () => {
    const images = fiveImages();
    seed(images);
    render(<Harness images={images} />);

    fireEvent.click(checkboxOf('img1'));
    fireEvent.click(cardOf('img3'), { shiftKey: true }); // {1,2,3}
    fireEvent.click(checkboxOf('img4')); // checkbox pick → {1,2,3,4}, anchor img4
    fireEvent.click(cardOf('img2'), { shiftKey: true }); // re-anchored on img4 → run 2..4

    expect(selectedIds()).toEqual(['img1', 'img2', 'img3', 'img4']);
  });

  it('never opens the viewer from a Shift+click', () => {
    const images = fiveImages();
    seed(images);
    render(<Harness images={images} />);

    fireEvent.click(checkboxOf('img1'));
    fireEvent.click(cardOf('img3'), { shiftKey: true });

    expect((window as any).electronAPI.openImageViewer).not.toHaveBeenCalled();
  });

  it('a plain click still opens the viewer and replaces the selection', () => {
    const images = fiveImages();
    seed(images);
    render(<Harness images={images} />);

    fireEvent.click(checkboxOf('img1'));
    fireEvent.click(cardOf('img3'));

    expect((window as any).electronAPI.openImageViewer).toHaveBeenCalledTimes(1);
    expect(selectedIds()).toEqual(['img3']);
    expect(useImageStore.getState().selectedImage?.id).toBe('img3');
  });

  // The checkbox is a separate affordance from the card, with a handler that
  // has to stop propagation to keep the card's click (which opens the viewer)
  // from firing twice. Stopping it also hid Shift from the selection hook, so
  // Shift+click on the box used to toggle one image and nothing else.
  describe('Shift+click on the checkbox', () => {
    it('fills the run from the last picked image, exactly like the card does', () => {
      const images = fiveImages();
      seed(images);
      render(<Harness images={images} />);

      fireEvent.click(checkboxOf('img1'));
      fireEvent.click(checkboxOf('img3'), { shiftKey: true });

      expect(selectedIds()).toEqual(['img1', 'img2', 'img3']);
    });

    it('measures from the LAST pick and never drops an existing one', () => {
      const images = fiveImages();
      seed(images);
      render(<Harness images={images} />);

      fireEvent.click(checkboxOf('img0'));
      fireEvent.click(checkboxOf('img4')); // last pick → the anchor
      fireEvent.click(checkboxOf('img2'), { shiftKey: true });

      expect(selectedIds()).toEqual(['img0', 'img2', 'img3', 'img4']);
    });

    it('does not deselect an image the run already covers', () => {
      const images = fiveImages();
      seed(images);
      render(<Harness images={images} />);

      fireEvent.click(checkboxOf('img0'));
      fireEvent.click(checkboxOf('img2'), { shiftKey: true }); // {img0,img1,img2}
      fireEvent.click(checkboxOf('img1'), { shiftKey: true }); // covers img1 already

      expect(selectedIds()).toEqual(['img0', 'img1', 'img2']);
    });

    it('with nothing selected just picks that image and opens no viewer', () => {
      const images = fiveImages();
      seed(images);
      render(<Harness images={images} />);

      fireEvent.click(checkboxOf('img2'), { shiftKey: true });

      expect(selectedIds()).toEqual(['img2']);
      expect((window as any).electronAPI.openImageViewer).not.toHaveBeenCalled();
    });

    it('stops at the first part when the selection was built part by part', () => {
      const images = sevenImages();
      seed(images);
      render(<Harness images={images} />);

      fireEvent.click(checkboxOf('img2'));
      fireEvent.click(checkboxOf('img3'), { shiftKey: true }); // part one: {2,3}
      fireEvent.click(checkboxOf('img5'));
      fireEvent.click(checkboxOf('img6'), { shiftKey: true }); // part two: {5,6}

      fireEvent.click(checkboxOf('img0'), { shiftKey: true });

      // Up to the selection's first image — img4, the gap between the parts,
      // stays out. Reaching for the anchor (img6) would have taken the lot.
      expect(selectedIds()).toEqual(['img0', 'img1', 'img2', 'img3', 'img5', 'img6']);
    });

    it('a plain checkbox click after one is still a toggle, not a run', () => {
      const images = fiveImages();
      seed(images);
      render(<Harness images={images} />);

      fireEvent.click(checkboxOf('img0'));
      fireEvent.click(checkboxOf('img4'));

      // The two picks only — a mis-routed modifier would have swept in between.
      expect(selectedIds()).toEqual(['img0', 'img4']);
      expect((window as any).electronAPI.openImageViewer).not.toHaveBeenCalled();
    });
  });
});
