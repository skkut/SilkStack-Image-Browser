/**
 * Pure helpers for the `silkstack-media://` streaming scheme.
 *
 * Background — why this exists
 * ----------------------------
 * Library media used to reach the renderer as whole-file IPC payloads
 * (`read-file` → `fs.readFile`). That is fine for a 3 MB PNG and ruinous for a
 * 400 MB MP4: the buffer exists in the main process, is structured-cloned into
 * the renderer, and is then held again as a Blob while `<video>` decodes it. A
 * handful of videos on screen at once is enough to exhaust a renderer.
 *
 * Serving the same bytes over a privileged custom scheme instead lets Chromium's
 * own media stack issue HTTP Range requests and read only the spans it needs —
 * the moov atom, the first frame, the ranges a seek touches. Nothing here is
 * Electron-specific: this module is deliberately free of any `electron` import
 * so it can be unit-tested directly under vitest, with the scheme registration
 * and request handler living in `main.mjs`.
 */

export const MEDIA_SCHEME = "silkstack-media";

/** Fixed host component — `standard: true` schemes require one. */
export const MEDIA_HOST = "local";

/**
 * Extensions this scheme will serve, mapped to their content type. This is an
 * allow-list rather than "whatever is inside a library folder": the renderer
 * can mint a URL for any path it likes, so without it the scheme would be a
 * general-purpose file reader for the whole library directory (including
 * sidecar JSON, config files, anything else that lives alongside the images).
 */
export const MEDIA_CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
};

/**
 * Content type for a path, or null when the extension is not on the allow-list.
 * @param {string} filePath
 * @returns {string|null}
 */
export function getMediaContentType(filePath) {
  if (typeof filePath !== "string") return null;
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  return MEDIA_CONTENT_TYPES[lower.slice(dot)] ?? null;
}

/**
 * Encode an absolute path for use as a URL path segment.
 *
 * base64url rather than percent-encoding because Windows paths mix `:` and `\`
 * (and UNC paths add `\\server\share`), and because base64 keeps the case of
 * the path intact through Chromium's URL normalisation — which matters on
 * case-sensitive filesystems and is merely tidy on Windows.
 * @param {string} absolutePath
 * @returns {string}
 */
export function encodeMediaPath(absolutePath) {
  return Buffer.from(String(absolutePath), "utf8").toString("base64url");
}

/**
 * @param {string} encoded
 * @returns {string|null} null when the segment is not decodable
 */
export function decodeMediaPath(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) return null;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    // A wrong alphabet decodes to replacement characters rather than throwing,
    // so sanity-check that something path-shaped came back.
    return decoded.length > 0 && !decoded.includes("�") ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} absolutePath
 * @returns {string} e.g. `silkstack-media://local/<base64url>`
 */
export function toMediaUrl(absolutePath) {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/${encodeMediaPath(absolutePath)}`;
}

/**
 * Parse a `silkstack-media://` URL back into a filesystem path.
 * @param {string} url
 * @returns {string|null} null for anything that is not one of our URLs
 */
export function parseMediaUrl(url) {
  if (typeof url !== "string" || !url.startsWith(`${MEDIA_SCHEME}://`)) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== MEDIA_HOST) return null;
  const encoded = parsed.pathname.replace(/^\//, "");
  return decodeMediaPath(encoded);
}

/**
 * Parse a single-range `Range` header against a known file size.
 *
 * Only one range is supported: multi-range responses need `multipart/byteranges`
 * bodies, and Chromium's media stack never asks for them.
 *
 * @param {string|null|undefined} headerValue Raw `Range` header.
 * @param {number} fileSize Total file size in bytes.
 * @returns {{start:number,end:number}|{unsatisfiable:true}|null}
 *   null when no (usable) range was requested — the caller should send 200
 *   with the whole file. `unsatisfiable` means 416.
 */
export function parseRangeHeader(headerValue, fileSize) {
  if (typeof headerValue !== "string" || headerValue.length === 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(headerValue.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  if (!Number.isFinite(fileSize) || fileSize <= 0) return { unsatisfiable: true };

  let start;
  let end;

  if (rawStart === "") {
    // Suffix range: the LAST n bytes. `bytes=-0` asks for nothing.
    const suffixLength = Number(rawEnd);
    if (suffixLength === 0) return { unsatisfiable: true };
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? fileSize - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start >= fileSize) return { unsatisfiable: true };
  if (start < 0) start = 0;
  if (end >= fileSize) end = fileSize - 1;
  if (end < start) return { unsatisfiable: true };

  return { start, end };
}

/**
 * Path-traversal / containment test shared by the protocol handler.
 *
 * Kept separate from the IPC allow-list so the scheme can additionally demand
 * that the request came from inside a *library* folder rather than from the
 * app's own userData (the internal paths the cache IPC is allowed to touch).
 *
 * @param {string} filePath
 * @param {Iterable<string>} allowedRoots
 * @param {string} [sep] Path separator, injectable for tests.
 * @returns {boolean}
 */
export function isWithinRoots(filePath, allowedRoots, sep = "/") {
  if (typeof filePath !== "string" || filePath.length === 0) return false;

  const stripTrailing = (value) => {
    let out = value;
    while (out.length > 1 && (out.endsWith("/") || out.endsWith("\\"))) {
      out = out.slice(0, -1);
    }
    return out;
  };

  const needle = stripTrailing(filePath);
  for (const root of allowedRoots) {
    if (typeof root !== "string" || root.length === 0) continue;
    const normalizedRoot = stripTrailing(root);
    if (needle === normalizedRoot) return true;
    if (needle.startsWith(normalizedRoot + sep)) return true;
  }
  return false;
}
