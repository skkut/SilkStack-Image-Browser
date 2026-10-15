import { describe, expect, it } from "vitest";

import { Directory, IndexedImage } from "../types";
import {
  partitionWatchedFiles,
  toRelativeWatchPath,
  watchedFileId,
  type WatchedFile,
} from "../utils/watchedFiles";

/**
 * `new-images-detected` carries both new files and already-indexed ones whose
 * bytes changed, so the renderer's toast has to tell them apart with an id
 * lookup. These pin the id formula and the split: the ids the store holds are
 * the same ones the watcher payload resolves to, or the toast announces files
 * the library already has — the false notification this exists to stop.
 */

function makeDirectory(id: string, path: string): Directory {
  return { id, name: id, path, handle: {} as FileSystemDirectoryHandle };
}

function makeFile(path: string, name = path.split(/[\\/]/).pop() ?? path): WatchedFile {
  return { name, path, lastModified: 1_000, size: 42, type: "png", forceReindex: true };
}

function makeImage(id: string): IndexedImage {
  return { id } as IndexedImage;
}

describe("toRelativeWatchPath", () => {
  it("strips the watched root and normalizes separators", () => {
    expect(toRelativeWatchPath("C:\\lib\\sub\\cat.png", "C:\\lib")).toBe("sub/cat.png");
    expect(toRelativeWatchPath("C:/lib/cat.png", "C:\\lib")).toBe("cat.png");
  });

  it("keeps an outside path whole rather than inventing a relative one", () => {
    // normalizePath lowercases (the app's ids are case-insensitive on Windows).
    expect(toRelativeWatchPath("D:\\other\\cat.png", "C:\\lib")).toBe("d:/other/cat.png");
  });
});

describe("watchedFileId", () => {
  it("matches the loader's id for a subfolder file", () => {
    const directory = makeDirectory("dir-1", "C:\\lib");
    expect(watchedFileId(directory, makeFile("C:\\lib\\sub\\cat.png"))).toBe("dir-1::sub/cat.png");
  });

  it("falls back to the file name when the path sits at the root", () => {
    const directory = makeDirectory("dir-1", "C:\\lib");
    expect(watchedFileId(directory, makeFile("C:\\lib", "cat.png"))).toBe("dir-1::cat.png");
  });
});

describe("partitionWatchedFiles", () => {
  const directory = makeDirectory("dir-1", "C:\\lib");

  it("treats a file the store does not hold as new", () => {
    const file = makeFile("C:\\lib\\fresh.png");
    const { newFiles, knownFiles } = partitionWatchedFiles(directory, [file], []);

    expect(newFiles).toEqual([file]);
    expect(knownFiles).toEqual([]);
  });

  it("treats an already-indexed file as known, even when it re-reports", () => {
    // A re-index report (metadata edit, OneDrive re-hydration, a sidecar JSON):
    // the id is in the store, so nothing should be announced as new.
    const file = makeFile("C:\\lib\\sub\\cat.png");
    const { newFiles, knownFiles } = partitionWatchedFiles(directory, [file], [
      makeImage("dir-1::sub/cat.png"),
    ]);

    expect(newFiles).toEqual([]);
    expect(knownFiles).toEqual([file]);
  });

  it("compares ids case-insensitively, like the loader's dedupe", () => {
    const file = makeFile("C:\\lib\\Cat.PNG");
    const { knownFiles } = partitionWatchedFiles(directory, [file], [
      makeImage("dir-1::cat.png"),
    ]);

    expect(knownFiles).toEqual([file]);
  });

  it("keeps images from other directories from masking a new file", () => {
    const file = makeFile("C:\\lib\\cat.png");
    const { newFiles } = partitionWatchedFiles(directory, [file], [
      makeImage("dir-2::cat.png"),
    ]);

    expect(newFiles).toEqual([file]);
  });

  it("splits a mixed batch", () => {
    const fresh = makeFile("C:\\lib\\fresh.png");
    const known = makeFile("C:\\lib\\old.png");
    const { newFiles, knownFiles } = partitionWatchedFiles(
      directory,
      [fresh, known],
      [makeImage("dir-1::old.png")],
    );

    expect(newFiles).toEqual([fresh]);
    expect(knownFiles).toEqual([known]);
  });
});
