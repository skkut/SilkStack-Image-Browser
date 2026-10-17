import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  // The image store reads localStorage at module load.
  global.localStorage = {
    getItem: vi.fn().mockReturnValue('true'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import { renderHook, act } from '@testing-library/react';
import { useStackWindowSync } from '../hooks/useStackWindowSync';
import { useImageStore } from '../store/useImageStore';
import type { IndexedImage, StackWindowPayload } from '../types';

/**
 * The main window's half of the stack-window refresh.
 *
 * A popped-out stack window holds a snapshot taken at click time and has no
 * library to re-resolve against, so it can only refresh if the main window
 * pushes a new payload whenever the library changes. These tests pin that
 * contract: only open windows are pushed to, membership is recomputed from
 * the live store (not from the open-time snapshot), unrelated store changes
 * do not cause a redraw, and a closed window stops receiving pushes.
 */

const image = (id: string, overrides: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id,
    name: id.split('::').pop() ?? id,
    directoryId: 'dir-1',
    metadata: {},
    metadataString: '',
    lastModified: 1000,
    models: [],
    loras: [],
    scheduler: '',
    dimensions: '512x512',
    handle: {} as FileSystemFileHandle,
    ...overrides,
  }) as IndexedImage;

const DIRECTORY = { id: 'dir-1', path: 'C:\\Images', name: 'Images' } as any;

/** The push lands on a 400ms debounce; long enough to cover any jitter. */
const flushPush = () => act(() => void vi.advanceTimersByTime(400));

let opened: ((data: { windowId: number; groupKey: string }) => void) | null;
let closed: ((data: { windowId: number }) => void) | null;
let updateStackWindow: ReturnType<typeof vi.fn>;
let getOpenStackWindows: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  opened = null;
  closed = null;
  updateStackWindow = vi.fn();
  getOpenStackWindows = vi.fn().mockResolvedValue([]);

  (window as any).electronAPI = {
    onStackWindowOpened: (callback: (data: { windowId: number; groupKey: string }) => void) => {
      opened = callback;
      return () => {};
    },
    onStackWindowClosed: (callback: (data: { windowId: number }) => void) => {
      closed = callback;
      return () => {};
    },
    getOpenStackWindows,
    updateStackWindow,
  };

  useImageStore.setState({
    images: [],
    annotations: new Map(),
    directories: [DIRECTORY],
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as any).electronAPI;
});

/** Render the hook and register one open stack window. */
const mountWithOpenWindow = (windowId = 7, groupKey = 'group-9') => {
  renderHook(() => useStackWindowSync());
  act(() => {
    opened?.({ windowId, groupKey });
  });
  return { windowId, groupKey };
};

const lastPayload = (): StackWindowPayload =>
  updateStackWindow.mock.calls.at(-1)?.[1] as StackWindowPayload;

describe('keeping an open stack window current', () => {
  it('pushes the members the library holds now, including a newcomer', () => {
    const a = image('dir-1::a.png', { similarityGroupId: 'group-9', lastModified: 100 });
    useImageStore.setState({ images: [a] });

    mountWithOpenWindow();

    const b = image('dir-1::b.png', { similarityGroupId: 'group-9', lastModified: 200 });
    act(() => {
      useImageStore.setState({ images: [a, b] });
    });
    flushPush();

    expect(updateStackWindow).toHaveBeenCalledTimes(1);
    const [windowId, payload] = updateStackWindow.mock.calls[0];
    expect(windowId).toBe(7);
    expect(payload.groupKey).toBe('group-9');
    expect(payload.imageList.map((raw: any) => raw.id)).toEqual([
      'dir-1::b.png',
      'dir-1::a.png',
    ]);
    expect(payload.directoryPaths).toEqual({ 'dir-1': 'C:\\Images' });
  });

  it('does not redraw the window when an unrelated image changes', () => {
    const member = image('dir-1::a.png', { similarityGroupId: 'group-9' });
    useImageStore.setState({ images: [member] });

    mountWithOpenWindow();

    // First store change establishes the delivered payload…
    act(() => {
      useImageStore.setState({
        images: [member, image('dir-1::b.png', { similarityGroupId: 'group-9' })],
      });
    });
    flushPush();
    expect(updateStackWindow).toHaveBeenCalledTimes(1);
    updateStackWindow.mockClear();

    // …and a change that cannot alter this stack's payload must not resend it.
    act(() => {
      useImageStore.setState({
        images: [
          member,
          image('dir-1::b.png', { similarityGroupId: 'group-9' }),
          image('dir-1::other.png', { similarityGroupId: 'group-other' }),
        ],
      });
    });
    flushPush();

    expect(updateStackWindow).not.toHaveBeenCalled();
  });

  it('pushes an empty list when the group dissolves', () => {
    const member = image('dir-1::a.png', { stackGroupId: 'hash-prompt' });
    useImageStore.setState({ images: [member] });

    mountWithOpenWindow(7, 'hash-prompt');
    act(() => {
      useImageStore.setState({ images: [member] });
    });
    flushPush();
    updateStackWindow.mockClear();

    act(() => {
      useImageStore.setState({
        images: [image('dir-1::a.png', { stackGroupId: 'hash-other' })],
      });
    });
    flushPush();

    expect(updateStackWindow).toHaveBeenCalledTimes(1);
    expect(lastPayload().imageList).toEqual([]);
    // The window keeps the title it had rather than being blanked.
    expect(lastPayload().basePrompt).toBe('Untitled stack');
  });

  it('stops pushing once the window has closed', () => {
    const member = image('dir-1::a.png', { similarityGroupId: 'group-9' });
    useImageStore.setState({ images: [member] });
    mountWithOpenWindow();

    act(() => {
      closed?.({ windowId: 7 });
    });
    act(() => {
      useImageStore.setState({
        images: [member, image('dir-1::b.png', { similarityGroupId: 'group-9' })],
      });
    });
    flushPush();

    expect(updateStackWindow).not.toHaveBeenCalled();
  });

  it('adopts windows that were already open before this renderer loaded', async () => {
    // HMR (or a dev refresh) loses the open events; the main process is the
    // only place that still knows which windows exist.
    getOpenStackWindows.mockResolvedValue([{ windowId: 3, groupKey: 'group-9' }]);
    const member = image('dir-1::a.png', { similarityGroupId: 'group-9' });
    useImageStore.setState({ images: [member] });

    renderHook(() => useStackWindowSync());
    // Let the adoption promise resolve.
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      useImageStore.setState({
        images: [member, image('dir-1::b.png', { similarityGroupId: 'group-9' })],
      });
    });
    flushPush();

    expect(updateStackWindow).toHaveBeenCalledTimes(1);
    expect(updateStackWindow.mock.calls[0][0]).toBe(3);
  });
});
