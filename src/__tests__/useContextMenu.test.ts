import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  // The image and settings stores read localStorage at module load.
  global.localStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import { renderHook, act } from '@testing-library/react';
import {
  useContextMenu,
  type ContextMenuSelectionItem,
} from '../hooks/useContextMenu';
import { useImageStore } from '../store/useImageStore';
import type { IndexedImage } from '../types';

/**
 * Copy Image Paths, with and without a multi-selection.
 *
 * The rule these tests pin: a right-click *inside* a multi-selection copies
 * every selected path, one quoted path per line; a right-click anywhere else
 * copies only the image that was pointed at. The directory a surface hands
 * over is what makes a handle-less image (the popped-out stack window's
 * payload) resolvable.
 */

/** An image whose handle carries its absolute path — the indexer's shape. */
const imageAt = (absolutePath: string, directoryId = 'dir-1'): IndexedImage => {
  const name = absolutePath.split(/[\\/]/).pop() ?? absolutePath;
  return {
    id: `${directoryId}::${name}`,
    name,
    directoryId,
    metadata: {},
    metadataString: '',
    lastModified: 1000,
    models: [],
    loras: [],
    handle: { _filePath: absolutePath } as unknown as FileSystemFileHandle,
  } as IndexedImage;
};

/** A handle-less image, as serialized stack-window payloads carry them. */
const payloadImage = (id: string, directoryId = 'dir-2'): IndexedImage =>
  ({
    id,
    name: id.split('::').pop() ?? id,
    directoryId,
    metadata: {},
    metadataString: '',
    lastModified: 1000,
    models: [],
    loras: [],
    handle: {} as FileSystemFileHandle,
  }) as IndexedImage;

type ShowContextMenu = ReturnType<typeof useContextMenu>['showContextMenu'];
type MenuEvent = Parameters<ShowContextMenu>[0];

const menuEvent = (): MenuEvent =>
  ({ preventDefault() {}, clientX: 10, clientY: 20 }) as unknown as MenuEvent;

const openMenu = (
  hook: { current: ReturnType<typeof useContextMenu> },
  target: IndexedImage,
  selection?: readonly ContextMenuSelectionItem[],
  directoryPath?: string,
) => {
  act(() => {
    hook.current.showContextMenu(menuEvent(), target, directoryPath, selection);
  });
};

/** Clipboard writes resolve on a microtask; flush it inside act. */
const copyPath = async (hook: { current: ReturnType<typeof useContextMenu> }) => {
  await act(async () => {
    hook.current.copyPath();
  });
};

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  Object.defineProperty(window, 'isSecureContext', {
    configurable: true,
    value: true,
  });
  useImageStore.setState({
    directories: [],
    images: [],
    filteredImages: [],
    annotations: new Map(),
    selectedImages: new Set(),
    selectionAnchorId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Copy Image Paths', () => {
  it('copies every selected path, one quoted path per line, when the click is inside the selection', async () => {
    const a = imageAt('C:\\Images\\a.png');
    const b = imageAt('C:\\Images\\b.png');
    const c = imageAt('C:\\Images\\c.png');

    const { result } = renderHook(() => useContextMenu());
    openMenu(result, b, [
      { image: a },
      { image: b },
      { image: c },
    ]);
    await copyPath(result);

    expect(writeText).toHaveBeenCalledWith(
      '"C:\\Images\\a.png"\n"C:\\Images\\b.png"\n"C:\\Images\\c.png"',
    );
    expect(document.body.textContent).toContain('3 Image Paths copied to clipboard!');
  });

  it('copies only the pointed-at image when the click is outside the selection', async () => {
    // The menu cannot reset the selection the way Explorer does, so acting on
    // files the user did not click would be the bigger surprise.
    const a = imageAt('C:\\Images\\a.png');
    const b = imageAt('C:\\Images\\b.png');
    const c = imageAt('C:\\Images\\c.png');

    const { result } = renderHook(() => useContextMenu());
    openMenu(result, c, [{ image: a }, { image: b }]);
    await copyPath(result);

    expect(writeText).toHaveBeenCalledWith('"C:\\Images\\c.png"');
  });

  it('keeps the single-image behaviour when only the clicked image is selected', async () => {
    const a = imageAt('C:\\Images\\a.png');

    const { result } = renderHook(() => useContextMenu());
    openMenu(result, a, [{ image: a }]);
    await copyPath(result);

    expect(writeText).toHaveBeenCalledWith('"C:\\Images\\a.png"');
    expect(document.body.textContent).toContain('Image Path copied to clipboard!');
  });

  it('resolves handle-less selected images through the directory the surface passes', async () => {
    // The stack window clears the file handle on the way over IPC; the
    // payload's directory map is the only way to locate those files.
    const elsewhere = payloadImage('dir-2::a.png');
    const b = imageAt('C:\\Images\\b.png');

    const { result } = renderHook(() => useContextMenu());
    openMenu(result, b, [
      { image: elsewhere, directoryPath: 'E:\\Elsewhere' },
      { image: b },
    ]);
    await copyPath(result);

    expect(writeText).toHaveBeenCalledWith(
      '"E:\\Elsewhere\\a.png"\n"C:\\Images\\b.png"',
    );
  });

  it('falls back to the store directory map when no directory is handed over', async () => {
    const elsewhere = payloadImage('dir-2::a.png');
    const b = imageAt('C:\\Images\\b.png');
    useImageStore.setState({
      directories: [
        { id: 'dir-2', name: 'Elsewhere', path: 'D:\\Other', handle: {} } as any,
      ],
    });

    const { result } = renderHook(() => useContextMenu());
    openMenu(result, b, [{ image: elsewhere }, { image: b }]);
    await copyPath(result);

    expect(writeText).toHaveBeenCalledWith(
      '"D:\\Other\\a.png"\n"C:\\Images\\b.png"',
    );
  });
});

/**
 * "Select All in Stack".
 *
 * The menu snapshots the stack's membership when it opens (the item's label
 * reports that count), and the action replaces the selection with exactly that
 * set. Membership is intersected with the filtered list, so a stack card whose
 * members are narrowed by a search cannot select images the user cannot see.
 */
describe('Select All in Stack', () => {
  /** A stack member: same stackGroupId as its siblings, whatever its path. */
  const stacked = (id: string, group = 'group-1'): IndexedImage =>
    ({ ...imageAt(`C:\\Images\\${id}.png`), id, stackGroupId: group }) as IndexedImage;

  const openOn = (
    hook: { current: ReturnType<typeof useContextMenu> },
    target: IndexedImage,
  ) => {
    act(() => {
      hook.current.showContextMenu(menuEvent(), target);
    });
  };

  it('selects every visible member of the stack and closes the menu', () => {
    const a = stacked('a');
    const b = stacked('b');
    useImageStore.setState({
      images: [a, b] as any,
      filteredImages: [a, b] as any,
      selectedImages: new Set(['stale']),
    });

    const { result } = renderHook(() => useContextMenu());
    openOn(result, a);
    expect(result.current.contextMenu.stackImageIds).toEqual(['a', 'b']);

    act(() => result.current.selectAllInStack());

    // It replaces, not unions: the menu's bulk action must not drag in a
    // selection the user made somewhere else.
    expect([...useImageStore.getState().selectedImages].sort()).toEqual(['a', 'b']);
    expect(result.current.contextMenu.visible).toBe(false);
  });

  it('does not offer the action when the filter leaves fewer than two members', () => {
    const a = stacked('a');
    const hidden = stacked('hidden');
    useImageStore.setState({
      images: [a, hidden] as any,
      filteredImages: [a] as any,
    });

    const { result } = renderHook(() => useContextMenu());
    openOn(result, a);

    expect(result.current.contextMenu.stackImageIds).toBeUndefined();
  });

  it('does not offer the action for a standalone image', () => {
    const standalone = imageAt('C:\\Images\\solo.png');
    useImageStore.setState({ images: [standalone] as any, filteredImages: [standalone] as any });

    const { result } = renderHook(() => useContextMenu());
    openOn(result, standalone);

    expect(result.current.contextMenu.stackImageIds).toBeUndefined();
  });

  it('honours an explicit membership list (the popped-out stack window)', () => {
    // That renderer's store holds no images, so the hook cannot resolve a
    // stack there; the window that owns the payload supplies the ids.
    const { result } = renderHook(() => useContextMenu());
    act(() => {
      result.current.showContextMenu(
        menuEvent(),
        imageAt('C:\\Images\\a.png'),
        undefined,
        undefined,
        ['x', 'y'],
      );
    });

    expect(result.current.contextMenu.stackImageIds).toEqual(['x', 'y']);
  });
});
