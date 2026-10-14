import { describe, expect, it } from "vitest";

import {
  MEDIA_CONTENT_TYPES,
  MEDIA_HOST,
  MEDIA_SCHEME,
  decodeMediaPath,
  encodeMediaPath,
  getMediaContentType,
  isWithinRoots,
  parseMediaUrl,
  parseRangeHeader,
  toMediaUrl,
} from "../../electron/mediaProtocol.mjs";

import {
  MEDIA_HOST as RENDERER_MEDIA_HOST,
  MEDIA_SCHEME as RENDERER_MEDIA_SCHEME,
  toMediaUrl as rendererToMediaUrl,
} from "../utils/mediaUrl";

/**
 * The scheme is implemented twice on purpose — once in the main process (which
 * serves it) and once in the renderer (which links to it) — because the two run
 * in different realms and neither can import the other's module. These tests
 * are the contract that keeps the halves in agreement: same constants, same
 * codec, same URL shape.
 */
describe("silkstack-media scheme contract", () => {
  it("uses the same scheme and host in main and renderer", () => {
    expect(RENDERER_MEDIA_SCHEME).toBe(MEDIA_SCHEME);
    expect(RENDERER_MEDIA_HOST).toBe(MEDIA_HOST);
  });

  it("decodes in main exactly what the renderer encodes", () => {
    const paths = [
      "C:\\Images\\output\\cat.png",
      "C:\\Users\\a b\\My Images\\nested dir\\shot 001.jpeg",
      "D:\\AI\\ComfyUI\\output\\2026-10\\video.mp4",
      "\\\\nas\\media share\\library\\image.webp",
      "/home/user/pictures/photo.png",
      // Non-ASCII is the case that breaks a naive latin1 btoa().
      "C:\\Images\\café\\naïve — Ω.png",
      "C:\\Images\\アニメ\\猫.png",
    ];

    for (const absolutePath of paths) {
      expect(parseMediaUrl(rendererToMediaUrl(absolutePath)!)).toBe(absolutePath);
    }
  });

  it("round-trips through its own codec", () => {
    const absolutePath = "C:\\Images\\a+b c/d.jpeg";
    expect(decodeMediaPath(encodeMediaPath(absolutePath))).toBe(absolutePath);
  });

  it("produces no padding or non-URL-safe characters", () => {
    // Paths chosen so the base64 contains both `+` and `/` before substitution.
    for (const absolutePath of ["C:\\a\\?>~.png", "C:\\zz\\zz.png"]) {
      const encoded = encodeMediaPath(absolutePath);
      expect(encoded).not.toMatch(/[+/=]/);
      expect(toMediaUrl(absolutePath)).toBe(
        `${MEDIA_SCHEME}://${MEDIA_HOST}/${encoded}`,
      );
    }
  });

  it("rejects foreign URLs and undecodable segments", () => {
    expect(parseMediaUrl("file:///C:/Images/cat.png")).toBeNull();
    expect(parseMediaUrl("silkstack-media://evil/QUJD")).toBeNull();
    expect(parseMediaUrl("silkstack-media://local/")).toBeNull();
    expect(parseMediaUrl("not a url at all")).toBeNull();
    expect(parseMediaUrl(undefined as unknown as string)).toBeNull();
    expect(decodeMediaPath("!!!not base64!!!")).toBeNull();
  });
});

describe("getMediaContentType", () => {
  it("maps the supported extensions case-insensitively", () => {
    expect(getMediaContentType("C:\\a\\b.PNG")).toBe("image/png");
    expect(getMediaContentType("C:\\a\\b.Mp4")).toBe("video/mp4");
    expect(getMediaContentType("C:\\a\\b.mkv")).toBe("video/x-matroska");
  });

  it("refuses anything outside the media allow-list", () => {
    // The scheme must not double as a general-purpose reader for whatever else
    // lives beside the images — sidecar JSON, config, a stray .git directory.
    expect(getMediaContentType("C:\\Images\\cat.png.json")).toBeNull();
    expect(getMediaContentType("C:\\Images\\notes.txt")).toBeNull();
    expect(getMediaContentType("C:\\Images\\noextension")).toBeNull();
    expect(getMediaContentType("C:\\Images\\.git\\config")).toBeNull();
  });

  it("covers every extension the app treats as media", () => {
    // Guard against someone adding a video container to the indexer without
    // adding it here — the file would index fine and then 403 on display.
    for (const ext of [".mp4", ".webm", ".mkv", ".mov", ".avi"]) {
      expect(MEDIA_CONTENT_TYPES[ext]).toBeTruthy();
    }
  });
});

describe("parseRangeHeader", () => {
  const SIZE = 1000;

  it("returns null when no range was requested", () => {
    expect(parseRangeHeader(null, SIZE)).toBeNull();
    expect(parseRangeHeader(undefined, SIZE)).toBeNull();
    expect(parseRangeHeader("", SIZE)).toBeNull();
    // Multi-range needs a multipart/byteranges body; Chromium's media stack
    // never asks, so it is declined rather than half-implemented.
    expect(parseRangeHeader("bytes=0-99,200-299", SIZE)).toBeNull();
    expect(parseRangeHeader("items=0-99", SIZE)).toBeNull();
  });

  it("parses open-ended, bounded and suffix ranges", () => {
    expect(parseRangeHeader("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader("bytes=100-199", SIZE)).toEqual({
      start: 100,
      end: 199,
    });
    expect(parseRangeHeader("bytes=-500", SIZE)).toEqual({
      start: 500,
      end: 999,
    });
    expect(parseRangeHeader("bytes=0-0", SIZE)).toEqual({ start: 0, end: 0 });
  });

  it("clamps an end past EOF instead of rejecting it", () => {
    // RFC 9110 §14.1.2: a last-byte-pos beyond the length is clamped, not
    // unsatisfiable — players routinely ask for more than exists.
    expect(parseRangeHeader("bytes=900-999999", SIZE)).toEqual({
      start: 900,
      end: 999,
    });
    // A suffix longer than the file is the whole file.
    expect(parseRangeHeader("bytes=-5000", SIZE)).toEqual({
      start: 0,
      end: 999,
    });
  });

  it("flags unsatisfiable ranges so the handler can send 416", () => {
    expect(parseRangeHeader("bytes=1000-", SIZE)).toEqual({
      unsatisfiable: true,
    });
    expect(parseRangeHeader("bytes=1000-2000", SIZE)).toEqual({
      unsatisfiable: true,
    });
    expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({ unsatisfiable: true });
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ unsatisfiable: true });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseRangeHeader("  bytes=0-9  ", SIZE)).toEqual({ start: 0, end: 9 });
  });
});

describe("isWithinRoots", () => {
  const windowsRoots = ["C:\\Images", "D:\\AI Output\\"];

  it("accepts paths inside a root", () => {
    expect(isWithinRoots("C:\\Images\\a\\b.png", windowsRoots, "\\")).toBe(true);
    expect(isWithinRoots("C:\\Images", windowsRoots, "\\")).toBe(true);
    // Trailing separator on the root must not create a double-separator miss.
    expect(isWithinRoots("D:\\AI Output\\x.png", windowsRoots, "\\")).toBe(true);
  });

  it("requires a separator boundary, not a bare prefix", () => {
    // The regression this guards: `C:\ImagesBackup\private.png` shares a
    // character prefix with the library `C:\Images` but is a different folder.
    expect(isWithinRoots("C:\\ImagesBackup\\private.png", windowsRoots, "\\")).toBe(
      false,
    );
    expect(isWithinRoots("C:\\Images-old\\x.png", windowsRoots, "\\")).toBe(false);
  });

  it("rejects unrelated, empty and non-string input", () => {
    expect(isWithinRoots("E:\\elsewhere\\x.png", windowsRoots, "\\")).toBe(false);
    expect(isWithinRoots("", windowsRoots, "\\")).toBe(false);
    expect(isWithinRoots(null as unknown as string, windowsRoots, "\\")).toBe(
      false,
    );
    expect(isWithinRoots("C:\\Images\\x.png", [], "\\")).toBe(false);
    expect(isWithinRoots("C:\\Images\\x.png", [""], "\\")).toBe(false);
  });

  it("uses the caller's separator, so POSIX roots work too", () => {
    expect(isWithinRoots("/home/me/pics/a.png", ["/home/me/pics"], "/")).toBe(
      true,
    );
    expect(isWithinRoots("/home/me/pics2/a.png", ["/home/me/pics"], "/")).toBe(
      false,
    );
  });
});
