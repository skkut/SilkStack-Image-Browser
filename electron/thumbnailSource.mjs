/**
 * Was the image behind a cached thumbnail deleted?
 *
 * The thumbnail cache names every file `${image.id}-${image.lastModified}`, and
 * an image id is `${directoryPath}::${relativePath}` — so the cache key is the
 * only record of which file a thumbnail was made from. Deleting an image in the
 * app removes its thumbnail (see `cacheManager.deleteImageCaches`), but a file
 * deleted outside the app leaves the `.webp` behind, and the metadata record
 * can outlive the file too: the grid is hydrated from the metadata cache and
 * only reconciled by a background scan, so a folder whose scan is skipped
 * (offline drive, unreachable share, an empty listing returned by a failed
 * read) keeps the image row forever. The grid then paints a deleted image from
 * its orphaned thumbnail — a ghost card that survives restarts.
 *
 * `classifyThumbnailSource` answers the one question the `get-thumbnail` IPC
 * handler needs: does the source file this cached thumbnail was made from still
 * exist? The verdict is deliberately conservative:
 *
 *   present  — the file is there; serve the cached bytes as always.
 *   missing  — the library folder was readable, its parent directory listed
 *              without the file, and a final stat still found nothing; withhold
 *              the bytes so the renderer can drop the image and purge its
 *              caches.
 *   unknown  — anything else: an unparseable (legacy) key, an offline drive, a
 *              permission error, or a directory that could not be listed.
 *              Serve the cached bytes. An offline library must keep rendering
 *              from cache, so "could not check" may never be read as
 *              "deleted" — a transient ENOENT from a network share must not
 *              purge a library's rows and re-parse them on the next scan.
 *
 * The filesystem is injected as an IO port so the module is testable without
 * Electron or a real disk.
 */

import path from "node:path";

/** @typedef {"yes" | "no" | "unknown"} PathProbeResult */
/**
 * The filesystem the classification needs.
 *
 * @typedef {object} ThumbnailSourceIo
 * @property {(filePath: string) => PathProbeResult | Promise<PathProbeResult>} stat
 *   Whether one absolute path exists. `unknown` is for failures that are not a
 *   clean "not there" (EACCES, EBUSY, EIO, a dropped network share).
 * @property {(directoryPath: string) => string[] | null | Promise<string[] | null>} list
 *   The directory's entry names, or null when it could not be listed.
 */

/** @typedef {"present" | "missing" | "unknown"} ThumbnailSourceVerdict */

/**
 * How long to wait before confirming a negative stat, in milliseconds.
 *
 * One ENOENT is not proof of deletion: writers commonly replace a file by
 * delete-then-create, and a rename passes through a moment where the old path
 * is gone. The listing that follows is the real evidence; the delay only keeps
 * an in-progress replacement from even reaching it.
 */
const DEFAULT_CONFIRM_DELAY_MS = 120;

/**
 * `lastModified` is a numeric timestamp. Requiring it is also what keeps a
 * legacy or malformed key from being parsed into a path that could be probed:
 * an id with no timestamp produces `-undefined`, which fails here.
 */
const TIMESTAMP_PATTERN = /^\d+(?:\.\d+)?$/;

/** True when `file` sits strictly inside `root` (after resolving `..`). */
const isWithin = (file, root) => {
  const normalizedRoot = path.normalize(root);
  const prefix = normalizedRoot.endsWith(path.sep)
    ? normalizedRoot
    : `${normalizedRoot}${path.sep}`;
  return path.normalize(file).startsWith(prefix);
};

/** Windows paths are case-insensitive; compare entries there. */
const foldEntryName = (value) =>
  process.platform === "win32" ? value.toLowerCase() : value;

/**
 * Read the source path back out of a thumbnail cache key.
 *
 * @param {unknown} thumbnailKey
 * @returns {{ imageId: string, root: string, relativePath: string, file: string } | null}
 *   Null when the key does not follow the app's id convention — the caller then
 *   serves the thumbnail without checking anything.
 */
export function parseThumbnailKey(thumbnailKey) {
  if (typeof thumbnailKey !== "string") return null;

  // The key is `${id}-${lastModified}`. The timestamp never contains a dash,
  // so the LAST dash separates it from an id that may contain many of its own.
  const separator = thumbnailKey.lastIndexOf("-");
  if (separator <= 1) return null;

  const imageId = thumbnailKey.slice(0, separator);
  const timestamp = thumbnailKey.slice(separator + 1);
  if (!TIMESTAMP_PATTERN.test(timestamp)) return null;

  // The id is `${directoryPath}::${relativePath}`. Splitting on the FIRST
  // occurrence is correct for Windows roots (a `:` cannot appear in a path
  // component). A POSIX root that itself contains `::` would parse to a prefix
  // that is not on the open-library allow-list, so the handler falls back to
  // "unknown" rather than purging anything.
  const idSeparator = imageId.indexOf("::");
  if (idSeparator <= 0 || idSeparator + 2 >= imageId.length) return null;

  const root = imageId.slice(0, idSeparator);
  const relativePath = imageId.slice(idSeparator + 2);
  if (!path.isAbsolute(root)) return null;
  if (path.isAbsolute(relativePath)) return null;

  const file = path.resolve(root, relativePath);
  if (!isWithin(file, root)) return null;

  return { imageId, root, relativePath, file };
}

const delay = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Decide whether a cached thumbnail's source file still exists.
 *
 * @param {string} thumbnailKey
 * @param {ThumbnailSourceIo} io
 * @param {{ confirmDelayMs?: number }} [options]
 * @returns {Promise<ThumbnailSourceVerdict>}
 */
export async function classifyThumbnailSource(
  thumbnailKey,
  io,
  options = {},
) {
  const source = parseThumbnailKey(thumbnailKey);
  if (!source) return "unknown";

  // The library root gates the verdict: on an offline drive or a removed
  // folder every file looks deleted, and purging the library from cache would
  // be far worse than showing a ghost. Only a folder that can be read makes a
  // missing file meaningful.
  if ((await io.stat(source.root)) !== "yes") return "unknown";

  const first = await io.stat(source.file);
  if (first === "yes") return "present";
  if (first !== "no") return "unknown";

  // A single ENOENT is not proof — see DEFAULT_CONFIRM_DELAY_MS.
  await delay(options.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS);

  // A successful listing of the parent directory is the evidence that makes a
  // "missing" verdict safe: unlike a stat, it cannot be fooled by a path-level
  // glitch on a network share (that either lists or fails, and failure is
  // "unknown"). If the file is not among the entries, it was deleted.
  const entries = await io.list(path.dirname(source.file));
  if (entries === null) return "unknown";

  const fileName = foldEntryName(path.basename(source.file));
  if (entries.some((entry) => foldEntryName(String(entry)) === fileName)) {
    // Listed but not stat-able is not deletion (a just-created file, or a
    // permission quirk); keep serving its cached thumbnail.
    return "present";
  }

  // The listing is a snapshot. Close the creation race with a final stat: a
  // writer can create the file between the listing and the verdict, and that
  // row must not be dropped.
  const last = await io.stat(source.file);
  if (last === "yes") return "present";
  return last === "no" ? "missing" : "unknown";
}
