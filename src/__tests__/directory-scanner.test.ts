import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  extensionOf,
  getMimeTypeFromName,
  isMediaFileName,
  listDirectoryFiles,
  scanDirectory,
} from "../../electron/directoryScanner.mjs";

/**
 * The scanner is the first thing that happens when a library is added, and the
 * old one was a serial recursive walk whose result arrived as a single IPC
 * reply — so these tests are mostly about the two properties that make it
 * survivable at scale: it emits while it walks, and nothing about a single bad
 * file or folder can stop it.
 */

let root: string;

async function write(relativePath: string, bytes = 8): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, Buffer.alloc(bytes));
}

async function collect(options?: Parameters<typeof scanDirectory>[1]) {
  const batches: {
    files: { name: string }[];
    scanned: number;
    truncated: boolean;
    done: boolean;
  }[] = [];
  for await (const batch of scanDirectory(root, options)) {
    batches.push(batch as never);
  }
  return batches;
}

const namesOf = (batches: { files: { name: string }[] }[]) =>
  batches
    .flatMap((b) => b.files.map((f) => f.name))
    .slice()
    .sort();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "silkstack-scan-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("scanDirectory", () => {
  it("finds media files and reports names relative to the root with forward slashes", async () => {
    await write("a.png");
    await write("nested/b.jpg");
    await write("nested/deeper/c.webp");

    const batches = await collect();

    expect(namesOf(batches)).toEqual(["a.png", "nested/b.jpg", "nested/deeper/c.webp"]);
    // Forward slashes regardless of platform — the cache keys on these names,
    // so a scan and a later diff must agree byte for byte.
    expect(namesOf(batches).every((n) => !n.includes("\\"))).toBe(true);
  });

  it("carries the fields the cache diff compares on", async () => {
    await write("a.mp4", 4096);

    const [batch] = await collect();
    const file = batch.files[0] as unknown as {
      lastModified: number;
      size: number;
      type: string;
      birthtimeMs: number;
    };

    expect(file.size).toBe(4096);
    expect(file.type).toBe("video/mp4");
    expect(file.lastModified).toBeGreaterThan(0);
    expect(file.birthtimeMs).toBe(file.lastModified);
  });

  it("ignores files that are not media, without stat-ing them", async () => {
    await write("a.png");
    await write("workflow.json");
    await write("notes.txt");
    await write("archive.zip");

    expect(namesOf(await collect())).toEqual(["a.png"]);
  });

  it("does not descend when recursive is false, but still matches top-level gifs", async () => {
    // The old non-recursive branch listed png/jpg/jpeg/webp and quietly omitted
    // gif, so a flat-scan folder showed no GIFs at all while a recursive one did.
    await write("top.gif");
    await write("top.png");
    await write("nested/deep.png");

    expect(namesOf(await collect({ recursive: false }))).toEqual(["top.gif", "top.png"]);
  });

  it("emits in batches instead of one final array", async () => {
    for (let i = 1; i <= 5; i += 1) await write(`img-${i}.png`);

    const batches = await collect({ batchSize: 2 });

    expect(batches.map((b) => b.files.length)).toEqual([2, 2, 1]);
    // Cumulative, so a consumer can render "Scanning… N found" from any batch.
    expect(batches.map((b) => b.scanned)).toEqual([2, 4, 5]);
    // Exactly one batch claims to be the end — that is what a pull-based
    // consumer waits for, so two of them would end the scan early.
    expect(batches.map((b) => b.done)).toEqual([false, false, true]);
    expect(batches.at(-1)!.truncated).toBe(false);
  });

  it("always delivers a final batch, even when the folder holds nothing", async () => {
    // A consumer waiting for "the scan is over" must not have to distinguish an
    // empty folder from a walk that has not reached its end yet.
    const batches = await collect();

    expect(batches).toHaveLength(1);
    expect(batches[0].files).toEqual([]);
    expect(batches[0].scanned).toBe(0);
    expect(batches[0].done).toBe(true);
  });

  it("stops at maxEntries and says so", async () => {
    for (let i = 1; i <= 10; i += 1) await write(`img-${i}.png`);

    const batches = await collect({ maxEntries: 4, batchSize: 2 });

    expect(namesOf(batches)).toHaveLength(4);
    expect(batches.at(-1)!.truncated).toBe(true);
  });

  it("reports an unreadable root through onError instead of throwing", async () => {
    const onError = vi.fn();
    const missing = path.join(root, "does-not-exist");

    const batches: unknown[] = [];
    for await (const batch of scanDirectory(missing, { onError })) {
      batches.push(batch);
    }

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(missing);
    expect(batches).toHaveLength(1);
  });

  it("stops early when cancelled", async () => {
    for (let i = 0; i < 6; i += 1) await write(`dir-${i}/img.png`);

    let seen = 0;
    const batches: { files: unknown[] }[] = [];
    for await (const batch of scanDirectory(root, {
      // Cancel after the first batch has been handed over — a library removed
      // mid-scan must stop costing I/O immediately.
      isCancelled: () => seen > 0,
    })) {
      seen += 1;
      batches.push(batch as never);
    }

    expect(batches).toHaveLength(1);
  });

  it("summarises the whole scan through listDirectoryFiles", async () => {
    await write("a.png");
    await write("nested/b.png");

    const { files, truncated } = await listDirectoryFiles(root);

    expect(files.map((f: { name: string }) => f.name).sort()).toEqual(["a.png", "nested/b.png"]);
    expect(truncated).toBe(false);
  });
});

describe("extension helpers", () => {
  it("reads the extension case-insensitively", () => {
    expect(extensionOf("A.PNG")).toBe(".png");
    expect(extensionOf("no-extension")).toBe("");
    // A dot in a directory name must not be mistaken for the file's extension.
    expect(extensionOf("v1.2/photo.jpeg")).toBe(".jpeg");
  });

  it("recognises the media set and nothing else", () => {
    for (const name of ["a.png", "a.JPG", "a.jpeg", "a.webp", "a.gif", "a.mp4", "a.webm", "a.mkv", "a.mov", "a.avi"]) {
      expect(isMediaFileName(name)).toBe(true);
    }
    for (const name of ["a.json", "a.txt", "a.psd", "a", "a.png.bak"]) {
      expect(isMediaFileName(name)).toBe(false);
    }
  });

  it("maps extensions to MIME types and falls back for the rest", () => {
    expect(getMimeTypeFromName("x.jpeg")).toBe("image/jpeg");
    expect(getMimeTypeFromName("x.MKV")).toBe("video/x-matroska");
    expect(getMimeTypeFromName("x.xyz")).toBe("application/octet-stream");
  });
});
