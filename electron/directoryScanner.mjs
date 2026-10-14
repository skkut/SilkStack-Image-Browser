/**
 * Streaming directory scan.
 *
 * Background — why this exists
 * ----------------------------
 * The previous walk (`getFilesRecursively`) was a recursive function that
 * `await`ed an `fs.stat` for every matched file, one at a time, accumulated
 * everything into a single array (via `files.push(...subFiles)`, which is a
 * spread over a growing array and can throw RangeError at a few hundred
 * thousand entries), and returned that array as ONE IPC reply.
 *
 * For a library of a hundred thousand images that is the whole first-run
 * experience: the renderer asked for a listing, the main process spent minutes
 * doing sequential stats, and the renderer received nothing at all until the
 * last one finished — no images, no progress, nothing to paint. On a network
 * share it is worse, because every one of those stat calls is a round trip and
 * none of them overlap.
 *
 * This module fixes all three parts:
 *   - the directory recursion is an explicit stack, so depth cannot overflow
 *     the JS stack and no array is spread;
 *   - stats run through a small concurrency pool, so latency overlaps instead
 *     of adding up (this is the single biggest win on network storage);
 *   - results are emitted in batches as they are found, so the caller can show
 *     images while the walk is still running.
 *
 * It is a generator rather than a callback API so the caller controls the pace:
 * a slow consumer simply pauses the walk at the next `yield` instead of letting
 * a queue grow without bound.
 *
 * Free of any `electron` import so it can be unit-tested under vitest.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Still images the app can index. `.gif` is animated-media, but it is a still-image container. */
export const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);

/** Video containers the app can index, play, and thumbnail. */
export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".mkv",
  ".mov",
  ".avi",
]);

export const MEDIA_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
]);

/** Entries per emitted batch. ~750 keeps each IPC reply in the low tens of KB. */
export const DEFAULT_SCAN_BATCH_SIZE = 750;

/**
 * Ceiling on matched files in a single scan. A folder this large is almost
 * certainly a mistake (a drive root, a downloads folder), and the point of the
 * cap is that the app stays usable and says so rather than dying quietly.
 */
export const DEFAULT_SCAN_MAX_ENTRIES = 500_000;

/**
 * Concurrent `fs.stat` calls. Directory listings are latency-bound, not
 * CPU-bound: on a spinning disk or an SMB share, 16 in flight turns minutes of
 * serial round trips into seconds. Past this the queue depth costs more than it
 * saves and starts starving the file watcher's own I/O.
 */
export const DEFAULT_STAT_CONCURRENCY = 16;

/**
 * MIME type for a media file name, or `application/octet-stream` for anything
 * else. Extension-based on purpose: the scan only ever sees names, and the
 * type is a display hint — the real parsing reads the bytes.
 */
export function getMimeTypeFromName(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  return "application/octet-stream";
}

/** Lower-cased extension including the dot, or "" when the name has none. */
export function extensionOf(name) {
  const dot = String(name).lastIndexOf(".");
  return dot < 0 ? "" : String(name).slice(dot).toLowerCase();
}

export function isMediaFileName(name) {
  return MEDIA_EXTENSIONS.has(extensionOf(name));
}

/**
 * One scanned file, in the shape the renderer's cache diffing expects —
 * `name` is relative to the scan root and always uses forward slashes, so a
 * Windows scan and a macOS scan produce identical keys.
 *
 * @typedef {Object} ScannedFile
 * @property {string} name Relative path, forward slashes.
 * @property {number} lastModified Birth time in ms (the cache compares on this).
 * @property {number} size Bytes.
 * @property {string} type MIME type.
 * @property {number} birthtimeMs Birth time in ms (kept separately for the watcher).
 */

/**
 * @typedef {Object} ScanBatch
 * @property {ScannedFile[]} files Files found since the previous batch.
 * @property {number} scanned Total matched files so far, across all batches.
 * @property {boolean} truncated True once `maxEntries` was hit and the walk stopped early.
 * @property {boolean} done True on the last batch only.
 */

/**
 * Walk `root`, yielding matched media files in batches.
 *
 * The final batch always arrives — carrying `done: true` — even when it is
 * empty. A consumer that needs "the scan ended" as a distinct event would
 * otherwise have to guess whether an empty iteration meant an empty folder or a
 * walk still in progress, and `truncated` would have nowhere to live.
 *
 * Unreadable directories are reported through `onError` and skipped; a folder
 * that disappears mid-scan, or one the user cannot read, must not abort the
 * whole library.
 *
 * @param {string} root Directory to scan.
 * @param {Object} [options]
 * @param {boolean} [options.recursive] Descend into subdirectories.
 * @param {Set<string>} [options.extensions] Extensions to match, dotted and lower-case.
 * @param {number} [options.batchSize] Files per emitted batch.
 * @param {number} [options.maxEntries] Stop after this many matched files.
 * @param {number} [options.statConcurrency] Concurrent `fs.stat` calls.
 * @param {() => boolean} [options.isCancelled] Polled between directories and stat waves.
 * @param {(directory: string, error: Error) => void} [options.onError]
 * @returns {AsyncGenerator<ScanBatch>}
 */
export async function* scanDirectory(root, options = {}) {
  const {
    recursive = true,
    extensions = MEDIA_EXTENSIONS,
    batchSize = DEFAULT_SCAN_BATCH_SIZE,
    maxEntries = DEFAULT_SCAN_MAX_ENTRIES,
    statConcurrency = DEFAULT_STAT_CONCURRENCY,
    isCancelled = () => false,
    onError = () => {},
  } = options;

  /** @type {string[]} */
  const stack = [root];
  /** @type {ScannedFile[]} */
  let batch = [];
  let scanned = 0;
  let truncated = false;

  // Reading `batch` at call time (rather than holding the array) is what lets
  // the caller keep the yielded array while the walk builds the next one.
  const flush = (done) => ({
    files: batch,
    scanned,
    truncated: done ? truncated : false,
    done,
  });

  while (stack.length > 0) {
    if (isCancelled()) {
      return;
    }

    const directory = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (err) {
      // Permissions, a deleted folder, a disconnected share. Skipping is right:
      // one unreadable subfolder must not cost the user the rest of the library.
      onError(directory, err);
      continue;
    }

    /** @type {string[]} */
    const mediaPaths = [];
    for (const entry of entries) {
      // Symlinks are deliberately not followed — a link loop would walk forever,
      // and the old walker made the same choice by only testing isFile/isDirectory.
      if (entry.isDirectory()) {
        if (recursive) {
          stack.push(path.join(directory, entry.name));
        }
      } else if (entry.isFile() && extensions.has(extensionOf(entry.name))) {
        mediaPaths.push(path.join(directory, entry.name));
      }
    }

    // Bounded-concurrency stat. `fs.stat` is called rather than trusting the
    // Dirent because size and birth time are not available from readdir, and
    // the cache diff compares on both.
    for (let i = 0; i < mediaPaths.length; i += statConcurrency) {
      if (isCancelled()) {
        return;
      }

      const slice = mediaPaths.slice(i, i + statConcurrency);
      const stats = await Promise.all(
        slice.map((filePath) =>
          fs.stat(filePath).then(
            (stat) => stat,
            // Vanished between readdir and stat — normal in an output folder
            // that is being written to while it is scanned.
            () => null,
          ),
        ),
      );

      for (let j = 0; j < slice.length; j += 1) {
        const stat = stats[j];
        if (!stat || !stat.isFile()) {
          continue;
        }
        if (scanned >= maxEntries) {
          truncated = true;
          yield flush(true);
          return;
        }

        const filePath = slice[j];
        scanned += 1;
        batch.push({
          name: path.relative(root, filePath).replace(/\\/g, "/"),
          lastModified: stat.birthtimeMs,
          size: stat.size,
          type: getMimeTypeFromName(filePath),
          birthtimeMs: stat.birthtimeMs,
        });

        // Flushed per file, not per stat wave: a single flat folder of 50,000
        // images is the worst case for the old walker, and it must emit every
        // `batchSize` files rather than once at the end of the folder.
        if (batch.length >= batchSize) {
          yield flush(false);
          batch = [];
        }
      }
    }
  }

  yield flush(true);
}

/**
 * Collect a whole scan into one array.
 *
 * This is what `list-directory-files` uses, so the dev testers and any caller
 * that wants the old "give me everything" behaviour keep working while sharing
 * the one walking implementation.
 *
 * @param {string} root
 * @param {Parameters<typeof scanDirectory>[1]} [options]
 * @returns {Promise<{files: ScannedFile[], truncated: boolean}>}
 */
export async function listDirectoryFiles(root, options = {}) {
  /** @type {ScannedFile[]} */
  const files = [];
  let truncated = false;
  for await (const scanBatch of scanDirectory(root, options)) {
    if (scanBatch.files.length > 0) {
      // One push per batch rather than one per file — the spread that the old
      // recursive walker used is what could throw on a very large folder.
      files.push(...scanBatch.files);
    }
    truncated = scanBatch.truncated;
  }
  return { files, truncated };
}
