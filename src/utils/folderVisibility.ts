import type { Directory, IndexedImage } from '../types';
import { normalizePath } from './pathUtils';

/**
 * Which images the current folder selection shows.
 *
 * This predicate is the single answer to "is this image in the folder context
 * the sidebar is describing?" — the library's own filter (`filterAndSort`)
 * uses it, and so do the surfaces that resolve a stack outside the filtered
 * list: the right-click "Open Stack in New Window" action and the popped-out
 * window's live refresh. Those used to resolve from the whole library, which
 * let a stack window show images from folders the sidebar had deselected, or
 * from a drive that was no longer connected.
 *
 * Kept structural (not tied to `ImageState`) so the same rule can run against
 * any image list.
 */

/** The slice of store state that decides folder visibility. */
export interface FolderVisibilityContext {
  directories: readonly Pick<Directory, 'id' | 'path' | 'visible' | 'isConnected'>[];
  /** Normalized absolute folder paths — see `normalizePath`. */
  selectedFolders: ReadonlySet<string>;
  /** Normalized absolute folder paths; a folder here hides itself and its subtree. */
  excludedFolders: ReadonlySet<string>;
  /** Whether selecting a folder also selects everything beneath it. */
  includeSubfolders: boolean;
}

/**
 * The folder an image lives in, as a normalized absolute path.
 *
 * An image id is `${directoryId}::${relativePath}`; every segment of the
 * relative path except the basename names the subfolder. Ids in any other
 * shape (legacy bare paths, directory-only ids) resolve to the directory
 * itself, which is also what an image sitting at the library root resolves to.
 */
export function getImageFolderPath(image: IndexedImage, directoryPath: string): string {
  const normalizedDirectory = normalizePath(directoryPath);
  const idParts = image.id.split('::');
  if (idParts.length !== 2) {
    return normalizedDirectory;
  }

  const segments = idParts[1].split(/[/\\]/).filter(Boolean);
  if (segments.length <= 1) {
    return normalizedDirectory;
  }

  const folderRelativePath = segments.slice(0, -1).join('/');
  // An empty base stays empty rather than turning into a rooted path.
  return normalizePath(
    normalizedDirectory ? `${normalizedDirectory}/${folderRelativePath}` : folderRelativePath,
  );
}

/** True for the ancestor itself and anything below it. */
const isSameOrDescendant = (path: string, ancestor: string): boolean =>
  path === ancestor ||
  path.startsWith(`${ancestor}/`) ||
  // `normalizePath` collapses separators today, so this branch is belt and
  // braces — it keeps the rule correct if that ever changes.
  path.startsWith(`${ancestor}\\`);

/**
 * Build the visibility predicate for one pass over an image list.
 *
 * Normalizes the selected/excluded folder sets once here rather than per
 * image, and indexes the directories up front, so a library of tens of
 * thousands of images costs one predicate construction and a hash lookup per
 * image.
 */
export function createFolderVisibilityPredicate(
  context: FolderVisibilityContext,
): (image: IndexedImage) => boolean {
  const visibleDirectoryIds = new Set(
    context.directories
      .filter((dir) => (dir.visible ?? true) && (dir.isConnected !== false))
      .map((dir) => dir.id),
  );

  const directoryPathMap = new Map<string, string>();
  for (const dir of context.directories) {
    directoryPathMap.set(dir.id, normalizePath(dir.path));
  }

  const selectedFolders = [...context.selectedFolders].map(normalizePath);
  const excludedFolders = [...context.excludedFolders].map(normalizePath);
  const selectedFolderSet = new Set(selectedFolders);

  return (image) => {
    // An image from a hidden folder or a disconnected drive is never shown.
    if (!visibleDirectoryIds.has(image.directoryId || '')) {
      return false;
    }

    const parentPath = directoryPathMap.get(image.directoryId || '');
    if (!parentPath) {
      return false;
    }

    const folderPath = getImageFolderPath(image, parentPath);

    // EXCLUSION: an excluded folder hides itself and its whole subtree, and
    // exclusion outranks selection.
    for (const excludedFolder of excludedFolders) {
      if (isSameOrDescendant(folderPath, excludedFolder)) {
        return false;
      }
    }

    // No selection means "the whole library" (minus exclusions).
    if (selectedFolders.length === 0) {
      return true;
    }

    if (selectedFolderSet.has(folderPath)) {
      return true;
    }

    if (context.includeSubfolders) {
      for (const selectedFolder of selectedFolders) {
        if (isSameOrDescendant(folderPath, selectedFolder)) {
          return true;
        }
      }
    }

    return false;
  };
}
