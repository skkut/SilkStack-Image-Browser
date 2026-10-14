import { IndexedImage, ImageStack, ImageAnnotations, StackWindowPayload } from '../types';
import { resolveStackGroupKey, collectGroupMembers } from '../utils/stackGroupKey';

/**
 * Popping a similarity stack out into its own Electron window.
 *
 * A stack is identified everywhere else in the app by its `groupKey`
 * (see `resolveStackGroupKey`), never by a snapshot of member ids — that is
 * what lets the drill-down follow the stack as images come and go. The child
 * window is the one place a snapshot IS the right shape: it is a separate
 * renderer with an empty image store and no library to re-resolve against, so
 * membership is resolved here, once, at open time.
 */

/**
 * What the main process gets: an image list the child can actually use.
 *
 * Beyond the image's own fields this carries `handlePath` — the handle's
 * `_filePath` — because that is the ONE source the app trusts for a file's
 * real location (`getImageAbsolutePath` reads it first) and it does not
 * survive being rebuilt from a handle that could not cross IPC.
 */
type SerializedStackImage = Omit<IndexedImage, 'handle' | 'thumbnailHandle'> & {
  handlePath?: string;
};

/**
 * Strip the non-cloneable fields before the payload crosses IPC.
 *
 * `handle` / `thumbnailHandle` are `FileSystemFileHandle`-shaped and the
 * structured clone algorithm refuses them outright, so the IPC call would
 * throw rather than deliver a partial object. The child rebuilds a stub handle
 * from what is left (see `StackWindow`), and `handlePath` is what keeps that
 * stub able to produce a real path.
 *
 * The renderer-bound thumbnail fields go too: `thumbnailUrl` is a `blob:` URL
 * belonging to THIS renderer, and a blob URL minted in one window means nothing
 * in another. Carrying it over would hand the child a URL that cannot resolve.
 */
export function serializeStackImages(images: IndexedImage[]): SerializedStackImage[] {
  return images.map(({ handle, thumbnailHandle, thumbnailUrl, thumbnailStatus, ...rest }) => ({
    ...rest,
    // `_filePath` is where the Electron file handle keeps the absolute path.
    handlePath: (handle as { _filePath?: string } | undefined)?._filePath,
  }) as SerializedStackImage);
}

/** `directoryId -> absolute folder path`, the child's only way to locate files. */
export function collectDirectoryPaths(
  images: IndexedImage[],
  directories: { id: string; path: string }[],
): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const image of images) {
    if (!image.directoryId || paths[image.directoryId] !== undefined) continue;
    const directory = directories.find((dir) => dir.id === image.directoryId);
    if (directory?.path) paths[image.directoryId] = directory.path;
  }
  return paths;
}

export function buildStackWindowPayload(
  groupKey: string,
  basePrompt: string,
  images: IndexedImage[],
  directories: { id: string; path: string }[],
): StackWindowPayload {
  return {
    groupKey,
    basePrompt,
    imageList: serializeStackImages(images),
    directoryPaths: collectDirectoryPaths(images, directories),
  };
}

/** Can this window actually be opened? Browser builds have no child windows. */
export function canOpenStackWindow(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.openStackWindow;
}

/**
 * Open `stack` in a new window. Returns false when this build has no child
 * windows (browser) or the main process refused, so callers can fall back to
 * the in-app drill-down.
 */
export async function openStackInNewWindow(
  stack: ImageStack,
  directories: { id: string; path: string }[],
): Promise<boolean> {
  if (!canOpenStackWindow() || stack.images.length === 0) return false;

  const payload = buildStackWindowPayload(
    stack.groupKey,
    stack.basePrompt || stackLabel(stack.images[0]),
    stack.images,
    directories,
  );

  try {
    const result = await window.electronAPI!.openStackWindow(payload);
    return !!result?.success;
  } catch {
    return false;
  }
}

/** The label a stack falls back to when no base prompt was recorded. */
function stackLabel(image: IndexedImage | undefined): string {
  if (!image) return 'Untitled stack';
  return (
    image.prompt
    || image.metadata?.normalizedMetadata?.prompt
    || image.metadata?.positive_prompt
    || 'Untitled stack'
  );
}

/**
 * Resolve the stack an image belongs to, from the full library.
 *
 * Membership comes from `collectGroupMembers` — the same expression the grid's
 * grouping and the drill-down's live filter use — so the window opened from a
 * right-click always holds exactly the images the stack card shows. Fewer than
 * two members is not a stack: size-1 groups are emitted as bare singletons by
 * the stacking hook, so the menu item stays hidden for them.
 *
 * Ordered newest-first, matching how a stack orders itself internally.
 */
export function resolveStackForImage(
  image: IndexedImage,
  images: IndexedImage[],
  annotations: Map<string, ImageAnnotations>,
): ImageStack | null {
  const groupKey = resolveStackGroupKey(image);
  if (!groupKey) return null;

  const memberIds = collectGroupMembers(images, annotations, groupKey);
  if (memberIds.size < 2) return null;

  const members = images
    .filter((candidate) => memberIds.has(candidate.id))
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));

  return {
    id: `stack-${groupKey}`,
    groupKey,
    coverImage: members[0],
    images: members,
    count: members.length,
    basePrompt: stackLabel(members[0]),
  };
}
