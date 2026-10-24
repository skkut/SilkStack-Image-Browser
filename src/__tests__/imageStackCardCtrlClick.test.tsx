/**
 * Ctrl+click on a stack card's selection box.
 *
 * A stack card in the Library grid is one card standing for several images.
 * Its checkbox is that stack's selection control, so Ctrl/Cmd+click there has
 * to select every member — Shift is already range selection, and Ctrl+click on
 * the card's browse badge opens the stack in a new window.
 *
 * The card is rendered directly: cards live inside react-window, which
 * measures zero in jsdom and renders nothing (same approach as
 * imageSelectionShiftClick.test.tsx).
 */
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

// Mirror the scaffolding in imageSelectionShiftClick.test.tsx: importing
// ImageGrid pulls the store, whose dynamic imports must not reach real
// workers in jsdom.
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
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageCard } from '../components/ImageGrid';
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

const seedSelection = (selectedIds: string[] = []) => {
  useImageStore.setState({
    selectedImages: new Set(selectedIds),
    selectionAnchorId: null,
  });
};

interface RenderCardOptions {
  imageId?: string;
  stackImageIds?: readonly string[];
  isSelected?: boolean;
}

const renderCard = ({ imageId = 'img0', stackImageIds, isSelected = false }: RenderCardOptions = {}) => {
  const onImageClick = vi.fn();
  render(
    <ImageCard
      image={makeImage(imageId)}
      onImageClick={onImageClick}
      isSelected={isSelected}
      onImageLoad={vi.fn()}
      baseWidth={200}
      stackImageIds={stackImageIds}
    />,
  );
  return { onImageClick };
};

const checkbox = () => screen.getByTitle(/Select image|Deselect image/);
const selectedIds = () => Array.from(useImageStore.getState().selectedImages).sort();

beforeEach(() => {
  vi.clearAllMocks();
  (global.window as any).electronAPI = {
    // The plain-click path chains .then() onto the result.
    openImageViewer: vi.fn().mockResolvedValue({ success: true, windowId: 1 }),
    isDev: vi.fn().mockResolvedValue(false),
  };
});

describe('Ctrl+click on a stack card’s selection box', () => {
  it('selects every member of the stack', () => {
    seedSelection();
    const stackImageIds = ['img0', 'img1', 'img2'];
    const { onImageClick } = renderCard({ stackImageIds });

    fireEvent.click(checkbox(), { ctrlKey: true });

    expect(selectedIds()).toEqual(['img0', 'img1', 'img2']);
    // The box stops propagation — the card's own click opens the viewer.
    expect(onImageClick).not.toHaveBeenCalled();
    expect((window as any).electronAPI.openImageViewer).not.toHaveBeenCalled();
  });

  it('is additive: a selection made elsewhere survives', () => {
    seedSelection(['other']);
    renderCard({ stackImageIds: ['img0', 'img1'] });

    fireEvent.click(checkbox(), { ctrlKey: true });

    expect(selectedIds()).toEqual(['img0', 'img1', 'other']);
  });

  it('anchors the next Shift+click on the clicked card', () => {
    seedSelection();
    renderCard({ stackImageIds: ['img0', 'img1'] });

    fireEvent.click(checkbox(), { ctrlKey: true });

    expect(useImageStore.getState().selectionAnchorId).toBe('img0');
  });

  it('works with Cmd on macOS', () => {
    seedSelection();
    renderCard({ stackImageIds: ['img0', 'img1'] });

    fireEvent.click(checkbox(), { metaKey: true });

    expect(selectedIds()).toEqual(['img0', 'img1']);
  });

  it('an ordinary card keeps the one-image toggle', () => {
    seedSelection();
    renderCard();

    fireEvent.click(checkbox(), { ctrlKey: true });

    expect(selectedIds()).toEqual(['img0']);
  });

  it('a one-member list is not a stack and falls back to the toggle', () => {
    seedSelection();
    renderCard({ stackImageIds: ['img0'] });

    fireEvent.click(checkbox(), { ctrlKey: true });

    expect(selectedIds()).toEqual(['img0']);
  });

  it('advertises the gesture in the checkbox tooltip', () => {
    seedSelection();
    renderCard({ stackImageIds: ['img0', 'img1', 'img2'] });

    expect(checkbox().getAttribute('title')).toContain('Ctrl+click selects all 3 in stack');
  });
});
