import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  serializeStackImages,
  collectDirectoryPaths,
  buildStackWindowPayload,
  canOpenStackWindow,
  openStackInNewWindow,
  resolveStackForGroupKey,
  resolveStackForImage,
} from '../services/stackWindowService';
import type { ImageAnnotations, IndexedImage, ImageStack, StackWindowPayload } from '../types';

/**
 * Popping a similarity stack out into its own window.
 *
 * Two things are worth pinning here, and neither is visible from the UI:
 *
 *  - the payload has to be *cloneable*. `FileSystemFileHandle` is refused by the
 *    structured clone algorithm, so a payload that still carried the handles
 *    would throw at the IPC call rather than open a window with missing fields.
 *  - the stack has to be resolved by the SAME expression the grid groups by
 *    (`resolveStackGroupKey`), or the window opened from a right-click holds a
 *    different set of images than the card that was right-clicked.
 */

/**
 * A handle shaped like the real thing — and that matters.
 *
 * `FileSystemFileHandle` is an object with METHODS, and a function is not
 * cloneable. A plain `{ name, kind }` stub would sail through
 * `structuredClone()` and the cloneability test below would pass while proving
 * nothing about the code that strips it.
 */
const handle = (name: string, filePath?: string) =>
  ({
    name,
    kind: 'file' as const,
    getFile: async () => new File([], name),
    // The Electron indexer's mock handle carries the absolute path here; it is
    // the first source `getImageAbsolutePath` consults.
    ...(filePath ? { _filePath: filePath } : {}),
  }) as unknown as FileSystemFileHandle;

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
    handle: handle(id),
    ...overrides,
  }) as IndexedImage;

const annotationsOf = (
  entries: Record<string, Partial<ImageAnnotations>>,
): Map<string, ImageAnnotations> =>
  new Map(Object.entries(entries)) as unknown as Map<string, ImageAnnotations>;

const DIRECTORY = { id: 'dir-1', path: 'C:\\Images' };

let openStackWindow: ReturnType<typeof vi.fn>;

beforeEach(() => {
  openStackWindow = vi.fn().mockResolvedValue({ success: true, windowId: 7 });
  (window as any).electronAPI = { openStackWindow };
});

afterEach(() => {
  delete (window as any).electronAPI;
});

describe('the payload a stack window opens with', () => {
  it('strips the handles that cannot cross IPC', () => {
    const source = image('dir-1::a.png', {
      thumbnailHandle: handle('thumb-a'),
    });

    const [serialized] = serializeStackImages([source]);

    expect(serialized).not.toHaveProperty('handle');
    expect(serialized).not.toHaveProperty('thumbnailHandle');
    // Everything else survives — the child rebuilds the image from this object
    // and reads its dimensions, timestamps and metadata off it.
    expect(serialized).toMatchObject({
      id: 'dir-1::a.png',
      directoryId: 'dir-1',
      lastModified: 1000,
      dimensions: '512x512',
    });
  });

  it('carries the handle path across, since the handle itself cannot go', () => {
    // `_filePath` lives ON the handle, and the handle is precisely the thing
    // that cannot cross IPC — so without lifting it into the payload the child
    // has no absolute path for a file unless its directory happens to be in the
    // map, and an image it cannot locate is one it cannot display.
    const source = image('dir-1::a.png', {
      handle: handle('a.png', 'C:\\Images\\a.png'),
    });

    const [serialized] = serializeStackImages([source]);

    expect(serialized).toMatchObject({ handlePath: 'C:\\Images\\a.png' });
  });

  it('drops the thumbnail fields, which only mean anything in this window', () => {
    // `thumbnailUrl` is a blob URL minted by the renderer doing the
    // serializing. Passing it on would hand the child a URL that cannot
    // resolve — and, worse, a status claiming those bytes were in hand.
    const source = image('dir-1::a.png', {
      thumbnailUrl: 'blob:from-the-main-window',
      thumbnailStatus: 'ready',
    });

    const [serialized] = serializeStackImages([source]);

    expect(serialized).not.toHaveProperty('thumbnailUrl');
    expect(serialized).not.toHaveProperty('thumbnailStatus');
  });

  it('makes the list cloneable, which it is not before stripping', () => {
    // The failure this guards against is an exception thrown inside the IPC
    // call, so assert against the algorithm itself rather than against the key
    // names above: a future field that is also a handle would be caught here
    // even though nothing in the test names it.
    const source = [image('dir-1::a.png')];

    expect(() => structuredClone(source)).toThrow();
    expect(() => structuredClone(serializeStackImages(source))).not.toThrow();
  });

  it('resolves each member directory once, for the child to locate files', () => {
    const paths = collectDirectoryPaths(
      [
        image('dir-1::a.png'),
        image('dir-1::b.png'),
        image('dir-2::c.png', { directoryId: 'dir-2' }),
      ],
      [DIRECTORY, { id: 'dir-2', path: 'D:\\More' }],
    );

    expect(paths).toEqual({ 'dir-1': 'C:\\Images', 'dir-2': 'D:\\More' });
  });

  it('omits a directory it cannot resolve a path for', () => {
    // A folder removed from the library while its images are still cached. The
    // child falls back to the thumbnail cache for these, so a missing entry is
    // survivable — what is not survivable is an entry holding `undefined` and
    // being concatenated into a path.
    const paths = collectDirectoryPaths(
      [image('dir-1::a.png'), image('gone::b.png', { directoryId: 'gone' })],
      [DIRECTORY],
    );

    expect(paths).toEqual({ 'dir-1': 'C:\\Images' });
    expect(Object.keys(paths)).not.toContain('gone');
  });

  it('builds the payload the child window is handed', () => {
    const members = [image('dir-1::a.png'), image('dir-1::b.png')];

    const payload = buildStackWindowPayload('group-9', 'a blue cat', members, [DIRECTORY]);

    expect(payload).toMatchObject({
      groupKey: 'group-9',
      basePrompt: 'a blue cat',
      directoryPaths: { 'dir-1': 'C:\\Images' },
    });
    expect(payload.imageList).toHaveLength(2);
    expect(payload.imageList[0]).not.toHaveProperty('handle');
  });
});

describe('resolving the stack behind a right-click', () => {
  it('finds nothing for an image in no group at all', () => {
    const solo = image('dir-1::a.png');

    expect(resolveStackForImage(solo, [solo], annotationsOf({}))).toBeNull();
  });

  it('finds nothing for a group of one', () => {
    // A group key alone is not a stack. The stacking hook emits size-1 groups as
    // bare singletons, so offering the menu item here would open a "stack"
    // window holding the same single image the user right-clicked.
    const only = image('dir-1::a.png', { similarityGroupId: 'group-9' });

    expect(resolveStackForImage(only, [only], annotationsOf({}))).toBeNull();
  });

  it('returns every member, newest first', () => {
    const older = image('dir-1::older.png', { similarityGroupId: 'group-9', lastModified: 100 });
    const newest = image('dir-1::newest.png', { similarityGroupId: 'group-9', lastModified: 900 });
    const middle = image('dir-1::middle.png', { similarityGroupId: 'group-9', lastModified: 500 });
    const stranger = image('dir-1::other.png', { similarityGroupId: 'group-other' });

    const stack = resolveStackForImage(
      middle,
      [older, newest, middle, stranger],
      annotationsOf({}),
    )!;

    expect(stack.images.map((i) => i.id)).toEqual([
      'dir-1::newest.png',
      'dir-1::middle.png',
      'dir-1::older.png',
    ]);
    expect(stack.count).toBe(3);
    expect(stack.coverImage.id).toBe('dir-1::newest.png');
  });

  it('names the stack by its group key, not by whatever is on the cover', () => {
    // The id is what keeps a window's identity stable as the stack grows: a
    // newer image joining takes over the cover, and an id derived from it would
    // change underneath anything keyed by it.
    const first = image('dir-1::a.png', { similarityGroupId: 'group-9', lastModified: 100 });
    const second = image('dir-1::b.png', { similarityGroupId: 'group-9', lastModified: 200 });

    const before = resolveStackForImage(first, [first, second], annotationsOf({}))!;

    const third = image('dir-1::c.png', { similarityGroupId: 'group-9', lastModified: 300 });
    const after = resolveStackForImage(first, [first, second, third], annotationsOf({}))!;

    expect(after.coverImage.id).not.toBe(before.coverImage.id);
    expect(after.id).toBe(before.id);
    expect(after.id).toBe('stack-group-9');
  });

  it('follows the similarity group when an image is in both kinds of group', () => {
    // `resolveStackGroupKey` prefers `similarityGroupId`, and this is the case
    // that proves which way the resolution went: the exact-prompt neighbour
    // shares only the prompt hash, so it must NOT be in the window.
    const target = image('dir-1::a.png', {
      similarityGroupId: 'group-sim',
      stackGroupId: 'hash-prompt',
    });
    const similar = image('dir-1::b.png', { similarityGroupId: 'group-sim' });
    const samePrompt = image('dir-1::c.png', { stackGroupId: 'hash-prompt' });

    const stack = resolveStackForImage(
      target,
      [target, similar, samePrompt],
      annotationsOf({}),
    )!;

    expect(stack.groupKey).toBe('group-sim');
    expect(stack.images.map((i) => i.id)).toEqual(['dir-1::a.png', 'dir-1::b.png']);
  });

  it('accepts a member whose group is only in the annotation map', () => {
    // Images that have been grouped but not yet merged back into the image
    // objects — the annotation map is the persisted source of truth, and
    // `collectGroupMembers` reads it as the fallback for exactly this reason.
    const target = image('dir-1::a.png', { similarityGroupId: 'group-9' });
    const notYetMerged = image('dir-1::b.png');

    const stack = resolveStackForImage(
      target,
      [target, notYetMerged],
      annotationsOf({ 'dir-1::b.png': { similarityGroupId: 'group-9' } }),
    )!;

    expect(stack.images.map((i) => i.id)).toContain('dir-1::b.png');
  });

  it('falls back to the exact-prompt group when there is no similarity group', () => {
    const target = image('dir-1::a.png', { stackGroupId: 'hash-prompt' });
    const twin = image('dir-1::b.png', { stackGroupId: 'hash-prompt' });

    const stack = resolveStackForImage(target, [target, twin], annotationsOf({}))!;

    expect(stack.groupKey).toBe('hash-prompt');
    expect(stack.count).toBe(2);
  });
});

describe('resolving a stack by its key (the live-refresh path)', () => {
  it('returns a group of one, which the menu deliberately hides', () => {
    // The window's refresh path must answer with what is actually left. A
    // group that shrank to one member is still a stack the open window has to
    // render; only the CONTEXT MENU refuses to offer it.
    const only = image('dir-1::a.png', { stackGroupId: 'hash-prompt' });

    const stack = resolveStackForGroupKey('hash-prompt', [only], annotationsOf({}));

    expect(stack?.count).toBe(1);
    expect(stack?.images.map((i) => i.id)).toEqual(['dir-1::a.png']);
  });

  it('picks up an image that joined after the window was opened', () => {
    // The whole point of the refresh: membership is resolved from the live
    // library, never from the snapshot the window was handed at open time.
    const first = image('dir-1::first.png', { stackGroupId: 'hash-prompt', lastModified: 100 });
    const second = image('dir-1::second.png', { stackGroupId: 'hash-prompt', lastModified: 200 });

    const before = resolveStackForGroupKey('hash-prompt', [first], annotationsOf({}))!;
    expect(before.images.map((i) => i.id)).toEqual(['dir-1::first.png']);

    const after = resolveStackForGroupKey(
      'hash-prompt',
      [first, second],
      annotationsOf({}),
    )!;

    // Newest first, same order the stack card uses.
    expect(after.images.map((i) => i.id)).toEqual(['dir-1::second.png', 'dir-1::first.png']);
    expect(after.count).toBe(2);
  });

  it('reports an emptied group as nothing, not as a stack of one', () => {
    // Null is the signal the sync hook turns into an empty image list; a
    // non-null answer here would leave deleted images on screen.
    const stray = image('dir-1::other.png', { stackGroupId: 'hash-other' });

    expect(resolveStackForGroupKey('hash-prompt', [stray], annotationsOf({}))).toBeNull();
    expect(resolveStackForGroupKey('', [stray], annotationsOf({}))).toBeNull();
  });

  it('honours grouping that lives only in the annotation map', () => {
    // Same fallback `collectGroupMembers` provides everywhere else: an image
    // may be grouped in the persisted annotations before its object is patched.
    const target = image('dir-1::a.png', { stackGroupId: 'hash-prompt' });
    const notYetMerged = image('dir-1::b.png');

    const stack = resolveStackForGroupKey(
      'hash-prompt',
      [target, notYetMerged],
      annotationsOf({ 'dir-1::b.png': { stackGroupId: 'hash-prompt' } }),
    )!;

    expect(stack.images.map((i) => i.id)).toContain('dir-1::b.png');
  });
});

describe('opening the window', () => {
  it('reports that this build has no child windows', () => {
    delete (window as any).electronAPI;

    expect(canOpenStackWindow()).toBe(false);
  });

  it('hands the built payload to the main process', () => {
    const stack: ImageStack = {
      id: 'stack-group-9',
      groupKey: 'group-9',
      coverImage: image('dir-1::a.png'),
      images: [image('dir-1::a.png'), image('dir-1::b.png')],
      count: 2,
      basePrompt: 'a blue cat',
    };

    return expect(openStackInNewWindow(stack, [DIRECTORY])).resolves.toBe(true).then(() => {
      expect(openStackWindow).toHaveBeenCalledTimes(1);
      const payload = openStackWindow.mock.calls[0][0] as StackWindowPayload;
      expect(payload).toMatchObject({ groupKey: 'group-9', basePrompt: 'a blue cat' });
      expect(payload.imageList).toHaveLength(2);
    });
  });

  it('opens nothing in a browser build, rather than throwing', () => {
    // The grid's ctrl+click calls this unconditionally; in the browser build
    // there is no bridge and nothing to open.
    delete (window as any).electronAPI;

    const stack: ImageStack = {
      id: 'stack-group-9',
      groupKey: 'group-9',
      coverImage: image('dir-1::a.png'),
      images: [image('dir-1::a.png')],
      count: 1,
    };

    return expect(openStackInNewWindow(stack, [DIRECTORY])).resolves.toBe(false).then(() => {
      expect(openStackWindow).not.toHaveBeenCalled();
    });
  });

  it('reports a refusal from the main process', async () => {
    openStackWindow.mockResolvedValue({ success: false, error: 'nope' });

    const stack: ImageStack = {
      id: 'stack-group-9',
      groupKey: 'group-9',
      coverImage: image('dir-1::a.png'),
      images: [image('dir-1::a.png')],
      count: 1,
    };

    await expect(openStackInNewWindow(stack, [DIRECTORY])).resolves.toBe(false);
  });

  it('reports a failed IPC call instead of rejecting into the click handler', async () => {
    openStackWindow.mockRejectedValue(new Error('no handler registered'));

    const stack: ImageStack = {
      id: 'stack-group-9',
      groupKey: 'group-9',
      coverImage: image('dir-1::a.png'),
      images: [image('dir-1::a.png')],
      count: 1,
    };

    await expect(openStackInNewWindow(stack, [DIRECTORY])).resolves.toBe(false);
  });

  it('opens nothing for a stack with no images', async () => {
    const stack: ImageStack = {
      id: 'stack-group-9',
      groupKey: 'group-9',
      coverImage: undefined as unknown as IndexedImage,
      images: [],
      count: 0,
    };

    await expect(openStackInNewWindow(stack, [DIRECTORY])).resolves.toBe(false);
    expect(openStackWindow).not.toHaveBeenCalled();
  });

  it('falls back to the cover image prompt when the stack carries no label', async () => {
    const cover = image('dir-1::a.png', { prompt: 'a red fox' });

    const stack: ImageStack = {
      id: 'stack-group-9',
      groupKey: 'group-9',
      coverImage: cover,
      images: [cover, image('dir-1::b.png')],
      count: 2,
    };

    await openStackInNewWindow(stack, [DIRECTORY]);

    expect(openStackWindow.mock.calls[0][0]).toMatchObject({ basePrompt: 'a red fox' });
  });
});
