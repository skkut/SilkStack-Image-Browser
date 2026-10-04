// @vitest-environment jsdom
//
// The list view's rows had no drag wiring at all — dragging to ComfyUI, to a
// folder in the sidebar, or to Explorer did nothing while the grid cards
// worked. These tests pin the gesture on the row itself: the native file drag
// the OS receives (files + the legacy directoryPath/relativePath pair), the
// internal payload a sidebar folder-drop consumes, and the fact that a drag is
// not a click (the row opens the viewer).
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
import { render, fireEvent } from '@testing-library/react';
import { ImageTableRow } from '../components/ImageTable';
import { useImageStore } from '../store/useImageStore';
import { buildDragPayload, type DraggedItemRef } from '../services/imageRelocation';
import type { IndexedImage } from '../types';

const ROOT = 'C:\\libs\\A';

const makeImage = (id: string, name: string, extra: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id,
    name,
    directoryId: ROOT,
    directoryName: 'A',
    handle: { name } as unknown as FileSystemFileHandle,
    metadata: {} as IndexedImage['metadata'],
    metadataString: '',
    lastModified: 111,
    models: [],
    loras: [],
    scheduler: '',
    ...extra,
  }) as unknown as IndexedImage;

/** Stand-in for the DOM DataTransfer jsdom does not implement. */
const makeDataTransfer = () => ({
  setData: vi.fn(),
  getData: vi.fn(),
  effectAllowed: '',
  dropEffect: '',
  files: [],
});

const renderRow = (
  image: IndexedImage,
  getDragPayload: (image: IndexedImage) => DraggedItemRef[] = (i) => [
    { id: i.id, directoryId: i.directoryId, sourcePath: `${ROOT}\\${i.name}`, name: i.name },
  ],
) => {
  const onImageClick = vi.fn();
  const view = render(
    <ImageTableRow
      image={image}
      onImageClick={onImageClick}
      isSelected={false}
      gridTemplateColumns="96px 280px"
      getDragPayload={getDragPayload}
    />,
  );
  return { row: view.container.firstChild as HTMLElement, onImageClick, ...view };
};

const startFileDrag = vi.fn();

describe('ImageTableRow drag', () => {
  beforeEach(() => {
    (window as any).electronAPI = { startFileDrag };
    useImageStore.setState({
      images: [],
      selectedImages: new Set<string>(),
      draggedItems: [],
      directories: [{ id: ROOT, path: ROOT }] as any,
    });
  });

  afterEach(() => {
    startFileDrag.mockClear();
    delete (window as any).electronAPI;
  });

  it('is draggable and hands the file to the native drag', () => {
    const image = makeImage(`${ROOT}::pic.png`, 'pic.png');
    const { row } = renderRow(image);

    expect(row.getAttribute('draggable')).toBe('true');

    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(row, { dataTransfer });

    expect(startFileDrag).toHaveBeenCalledWith({
      files: [`${ROOT}\\pic.png`],
      directoryPath: ROOT,
      relativePath: 'pic.png',
      id: image.id,
      lastModified: 111,
    });
    // The in-page payload is the fallback the sidebar's folder drop reads
    // when the store state has already been cleared.
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/x-image-metahub-items',
      JSON.stringify([{ id: image.id, directoryId: ROOT, sourcePath: `${ROOT}\\pic.png`, name: 'pic.png' }]),
    );
    expect(useImageStore.getState().draggedItems).toHaveLength(1);
  });

  it('carries a subfolder path as the relative path (recursive scans)', () => {
    const image = makeImage(`${ROOT}::sub/pic.png`, 'sub/pic.png');
    const { row } = renderRow(image, (i) => [
      { id: i.id, directoryId: i.directoryId, sourcePath: `${ROOT}\\sub\\pic.png`, name: i.name },
    ]);

    fireEvent.dragStart(row, { dataTransfer: makeDataTransfer() });

    expect(startFileDrag).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [`${ROOT}\\sub\\pic.png`],
        relativePath: 'sub/pic.png',
      }),
    );
  });

  it('drags the whole selection when the dragged row is selected', () => {
    const first = makeImage(`${ROOT}::a.png`, 'a.png');
    const second = makeImage(`${ROOT}::b.png`, 'b.png');
    useImageStore.setState({ images: [first, second], selectedImages: new Set([first.id, second.id]) });
    // The same builder the table hands the rows (see ImageTable.getDragPayload).
    const getDragPayload = (image: IndexedImage) => {
      const store = useImageStore.getState();
      return buildDragPayload(image, store.images, store.selectedImages);
    };

    const { row } = renderRow(first, getDragPayload);
    fireEvent.dragStart(row, { dataTransfer: makeDataTransfer() });

    expect(startFileDrag).toHaveBeenCalledWith(
      expect.objectContaining({ files: [`${ROOT}\\a.png`, `${ROOT}\\b.png`] }),
    );
    expect(useImageStore.getState().draggedItems.map((item) => item.id)).toEqual([first.id, second.id]);
  });

  it('clears the drag state when the gesture ends', () => {
    const { row } = renderRow(makeImage(`${ROOT}::pic.png`, 'pic.png'));

    fireEvent.dragStart(row, { dataTransfer: makeDataTransfer() });
    expect(useImageStore.getState().draggedItems).toHaveLength(1);

    fireEvent.dragEnd(row);
    expect(useImageStore.getState().draggedItems).toEqual([]);
  });

  it('keeps the browser image drag off the thumbnail so the row owns the gesture', () => {
    const image = makeImage(`${ROOT}::pic.png`, 'pic.png', {
      thumbnailStatus: 'ready',
      thumbnailUrl: 'blob:thumb',
    } as Partial<IndexedImage>);
    const { row } = renderRow(image);

    const thumb = row.querySelector('img');
    expect(thumb?.getAttribute('draggable')).toBe('false');
  });

  it('does not open the viewer when the gesture was a drag', () => {
    const { row, onImageClick } = renderRow(makeImage(`${ROOT}::pic.png`, 'pic.png'));

    fireEvent.mouseDown(row, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(row, { clientX: 140, clientY: 100 });
    fireEvent.click(row, { clientX: 140, clientY: 100 });

    expect(onImageClick).not.toHaveBeenCalled();
  });

  it('still opens the viewer on a plain click', () => {
    const image = makeImage(`${ROOT}::pic.png`, 'pic.png');
    const { row, onImageClick } = renderRow(image);

    fireEvent.mouseDown(row, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(row, { clientX: 101, clientY: 100 });
    fireEvent.click(row, { clientX: 101, clientY: 100 });

    expect(onImageClick).toHaveBeenCalledWith(image, expect.anything());
  });
});
