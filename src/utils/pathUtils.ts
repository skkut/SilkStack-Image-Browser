/**
 * Normalizes a file system path for consistent use as keys in Maps and Sets.
 * 
 * - Replaces backslashes with forward slashes
 * - Removes trailing slashes
 * - Handles empty/null paths
 * - Converts to lowercase for case-insensitive comparison (recommended for Windows paths)
 */
export function normalizePath(path: string | null | undefined): string {
  if (!path) return '';
  
  // Replace all backslashes with forward slashes
  let normalized = path.replace(/\\/g, '/');
  
  // Remove trailing slash if it's not the root
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  
  // For Windows, paths are mostly case-insensitive.
  // We use lowercase for the Map keys to ensure consistency.
  return normalized.toLowerCase();
}

/**
 * The narrow slice of an image this module needs. Deliberately structural
 * rather than `IndexedImage` so the helper stays dependency-free and testable.
 */
export interface PathBearingImage {
  /** `${directoryId}::${relativePath}` — see fileIndexer's IndexedImage builder. */
  id?: string;
  /** Basename, though a recursive scan may fold a relative path in here. */
  name?: string;
  /** Electron mock handle, which carries the real path as `_filePath`. */
  handle?: unknown;
}

/** Drive-letter (`C:\`), UNC (`\\server\share`), or POSIX-rooted (`/home`). */
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const UNC_PREFIX = /^\\\\/;

/** True when the value is already rooted in the filesystem. */
export function isAbsolutePath(value: string): boolean {
  if (!value) return false;
  return UNC_PREFIX.test(value) || WINDOWS_DRIVE.test(value) || value.startsWith('/');
}

/** Match the separator style already present in the base path. */
const detectSeparator = (base: string): string => (base.includes('\\') ? '\\' : '/');

/**
 * Joins a relative path onto a base directory, keeping the base's separator
 * style and — unlike `normalizePath` — its original casing. `normalizePath`
 * lowercases because it exists to build case-insensitive Map keys; a path that
 * is going onto the clipboard or to the shell must not be mangled that way.
 */
const joinPathPreservingCase = (base: string, relative: string): string => {
  const separator = detectSeparator(base);
  const strippedBase = base.replace(/[\\/]+$/, '');
  // A base of nothing but separators is a filesystem root ("/") — keep one.
  const head = strippedBase || separator;
  const normalizedRelative = relative
    .split(/[/\\]+/)
    .filter((segment) => segment.length > 0)
    .join(separator);

  if (!normalizedRelative) {
    return strippedBase || base;
  }
  return head.endsWith(separator)
    ? `${head}${normalizedRelative}`
    : `${head}${separator}${normalizedRelative}`;
};

/**
 * Resolves an image to its absolute path on disk, for actions that hand the
 * path to the user or to the OS ("Copy Image Path", "Show in Folder", "Open in
 * Native Viewer").
 *
 * Sources are tried most-authoritative first:
 *
 * 1. `handle._filePath` — the real path. The Electron indexer's mock handle
 *    carries it, joined by the main process, so it is correctly cased and
 *    already absolute. Not persisted, but re-derived on every startup.
 * 2. `id` (or `name`) joined onto `directoryPath`. `id` is
 *    `${directoryId}::${relativePath}`, so the part after `::` is relative to
 *    the directory. An absolute tail is returned as-is — the codebase has
 *    recorded ids in both shapes (see DevSemanticSearchTester's
 *    `filePathFromImageId`, which documents all three variants in the wild).
 * 3. `name` alone, when there is no directory to join onto. Callers treat an
 *    unusable result as a failure rather than guessing.
 */
export function getImageAbsolutePath(
  image: PathBearingImage | null | undefined,
  directoryPath?: string | null
): string {
  if (!image) return '';

  // 1. The handle's own path wins: it is the only source that reflects what the
  //    OS actually returned for this file.
  const handlePath = (image.handle as { _filePath?: unknown } | null | undefined)?._filePath;
  if (typeof handlePath === 'string' && handlePath.length > 0) {
    return handlePath;
  }

  // 2. Fall back to the id's path segment. A `::`-less id is a legacy bare
  //    path, so the id itself is the candidate rather than just the name.
  const id = image.id ?? '';
  const separatorIndex = id.indexOf('::');
  const candidate = separatorIndex === -1
    ? id || image.name || ''
    : id.slice(separatorIndex + 2) || image.name || '';

  if (!candidate) return '';
  if (isAbsolutePath(candidate)) return candidate;

  const base = directoryPath ?? '';
  if (!base) return candidate;

  return joinPathPreservingCase(base, candidate);
}

/**
 * Wraps a path in double quotes for the clipboard — the form Windows
 * Explorer's "Copy as path" produces, so a pasted path survives spaces in a
 * terminal or a shell command.
 *
 * This is for clipboard text only. Paths handed to an OS call
 * (`showItemInFolder`, `openPath`) must stay unquoted, or the shell looks for a
 * file whose name literally begins with a quote.
 */
export const quotePathForClipboard = (path: string): string => `"${path}"`;
