import { IndexedImage, Directory } from "../types";
import { normalizePath } from "./pathUtils";

/**
 * One watcher channel, two different events.
 *
 * `new-images-detected` carries genuinely new files AND files the library
 * already holds whose bytes changed on disk. The main process cannot tell them
 * apart — it has no index — so the renderer splits them here, against the only
 * authority on "do I already have this?": the store. Only the genuinely new
 * ones are announced; a changed file is re-indexed silently.
 */

export interface WatchedFile {
  name: string;
  path: string;
  lastModified: number;
  size: number;
  type: string;
  /**
   * Watcher-set when the file at an existing id changed on disk (a 'change'
   * event, a replace inside the batch window, or a sidecar JSON) — see
   * electron/fileWatcher.mjs.
   */
  forceReindex?: boolean;
}

/** `filePath` relative to the watched root, in the app's `/` form. */
export const toRelativeWatchPath = (filePath: string, rootPath: string): string => {
  const normalizedFilePath = normalizePath(filePath);
  const normalizedRootPath = normalizePath(rootPath);
  if (!normalizedFilePath) return "";
  if (!normalizedRootPath) return normalizedFilePath;
  if (normalizedFilePath === normalizedRootPath) return "";
  const prefix = `${normalizedRootPath}/`;
  if (normalizedFilePath.startsWith(prefix)) {
    return normalizedFilePath.slice(prefix.length);
  }
  return normalizedFilePath;
};

/**
 * The id the loader indexes this file under. Defined once so the toast's
 * "already have it" lookup and the indexer can never disagree about which
 * image a path names.
 */
export const watchedFileId = (directory: Directory, file: WatchedFile): string =>
  `${directory.id}::${toRelativeWatchPath(file.path, directory.path) || file.name}`;

/**
 * Split a watcher payload into files the library does not hold yet and files
 * it does. Ids are compared case-insensitively, like the loader's own dedupe.
 */
export function partitionWatchedFiles(
  directory: Directory,
  files: WatchedFile[],
  images: IndexedImage[],
): { newFiles: WatchedFile[]; knownFiles: WatchedFile[] } {
  const knownIds = new Set(images.map((img) => img.id.toLowerCase()));
  const newFiles: WatchedFile[] = [];
  const knownFiles: WatchedFile[] = [];

  for (const file of files) {
    if (knownIds.has(watchedFileId(directory, file).toLowerCase())) {
      knownFiles.push(file);
    } else {
      newFiles.push(file);
    }
  }

  return { newFiles, knownFiles };
}
