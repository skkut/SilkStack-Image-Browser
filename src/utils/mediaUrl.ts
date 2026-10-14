import {
  getImageAbsolutePath,
  isAbsolutePath,
  type PathBearingImage,
} from "./pathUtils";

/**
 * Build `silkstack-media://` URLs for library files.
 *
 * Why a URL instead of bytes
 * --------------------------
 * Media used to reach the renderer as whole-file IPC payloads: `readFile()` for
 * a 300 MB video meant 300 MB in the main process, a 300 MB structured clone,
 * and then a 300 MB Blob on the renderer heap — with `<video>` decoding from
 * it. A screenful of large videos was enough to exhaust the renderer.
 *
 * A `silkstack-media://` URL inverts that: `<img>`/`<video>` ask Chromium's own
 * media stack for the byte ranges they need and the main process streams those
 * ranges off disk. Nothing is buffered in the renderer beyond what was decoded.
 *
 * The URL is not a capability — it is just an address. The main process checks
 * every request against the open-library allow-list, the extension allow-list
 * and the filesystem, so a hand-crafted URL for a path outside the library gets
 * a 403, not a file.
 *
 * This module is deliberately free of any Electron import (the renderer never
 * sees one) and of `Buffer`, so it is testable under vitest's jsdom
 * environment. `mediaUrl.test.ts` asserts that the encoding here is byte-for-byte
 * the one `electron/mediaProtocol.mjs` decodes.
 */

/**
 * Must match `MEDIA_SCHEME` in `electron/mediaProtocol.mjs` — a unit test
 * imports both and fails if they drift.
 */
export const MEDIA_SCHEME = "silkstack-media";

/** Must match `MEDIA_HOST` in `electron/mediaProtocol.mjs`. */
export const MEDIA_HOST = "local";

/**
 * base64url encode (RFC 4648 §5, unpadded).
 *
 * base64url rather than percent-encoding because Windows paths mix `:` and `\`
 * and UNC paths add `\\server\share`; encoding the whole path removes every
 * character Chromium's URL parser would otherwise normalise, which keeps the
 * path byte-identical all the way to `fs.stat`.
 *
 * The UTF-8 hop matters: `btoa` takes latin1, so a path containing e.g. Cyrillic
 * or emoji must be converted to bytes first or it throws.
 */
function encodeMediaPathSegment(absolutePath: string): string {
  const bytes = new TextEncoder().encode(absolutePath);
  let latin1 = "";
  for (let i = 0; i < bytes.length; i += 1) {
    latin1 += String.fromCharCode(bytes[i]);
  }
  return btoa(latin1).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * True when the media protocol is available — i.e. this is the Electron build.
 *
 * The browser build has no main process to register a scheme, so callers keep
 * their File-handle + blob-URL path there.
 */
export function isMediaProtocolAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.electronAPI !== "undefined" &&
    window.electronAPI !== null
  );
}

/**
 * URL for an absolute filesystem path, or null when this build cannot serve it.
 *
 * The absoluteness gate is not cosmetic. `getImageAbsolutePath` returns a bare
 * relative candidate when it has no root to join onto, and handing that to the
 * protocol would make the main process `fs.stat` a path relative to *its* cwd —
 * a 404 the card renders as a broken image. Refusing to build the URL keeps the
 * caller on its File-handle path, which is merely slow.
 */
export function toMediaUrl(absolutePath: string | null | undefined): string | null {
  if (!absolutePath || !isAbsolutePath(absolutePath)) return null;
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeMediaPathSegment(absolutePath)}`;
}

/**
 * URL for an indexed image, resolved through the same path logic the
 * copy-path / show-in-folder actions use.
 *
 * Returns null when no *absolute* path can be derived (the browser build, or a
 * stub whose handle has not been hydrated with `_filePath` yet) — callers fall
 * back to reading the File handle. Guessing a path here would be worse than
 * returning null: the request would 403 or 404 and the card would render an
 * error state instead of a picture.
 */
export function getImageMediaUrl(
  image: PathBearingImage | null | undefined,
  directoryPath?: string | null,
): string | null {
  if (!isMediaProtocolAvailable()) return null;
  return toMediaUrl(getImageAbsolutePath(image, directoryPath));
}
