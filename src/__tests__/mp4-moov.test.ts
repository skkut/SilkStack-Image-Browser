import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";

import { MAX_MOOV_BYTES, readMoovBox } from "../../electron/mp4Moov.mjs";
import {
  extractMp4Dimensions,
  extractMp4MdtaTags,
} from "../services/parsers/binaryParsers";

/**
 * The `moov` box walker exists so the indexer can read an MP4's metadata
 * without reading the MP4. These tests cover both halves of that claim: that
 * the walk finds the box wherever the muxer put it, and — the one that actually
 * matters — that the bytes it returns parse exactly like the whole file did.
 */

// ---- Synthetic MP4 builders (same shapes as mp4-mdta.test.ts) ----
const enc = new TextEncoder();
const str = (s: string) => enc.encode(s);

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  for (let i = 0; i < 4; i++) out[i + 4] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32b(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

/** A box whose size is written as the 64-bit escape (size == 1). */
function box64(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1, false);
  for (let i = 0; i < 4; i++) out[i + 4] = type.charCodeAt(i);
  // 64-bit size, high word 0 — small enough to fit, but on the long path.
  view.setUint32(8, 0, false);
  view.setUint32(12, out.length, false);
  out.set(payload, 16);
  return out;
}

/** A box that declares "extends to end of file" (size == 0). */
function boxToEof(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, 0, false);
  for (let i = 0; i < 4; i++) out[i + 4] = type.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

function keyEntry(name: string): Uint8Array {
  const payload = concat(str("mdta"), str(name + "\0"));
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(payload, 4);
  return out;
}

function ilstEntry(index: number, value: string): Uint8Array {
  const dataBox = box("data", concat(u32b(1), new Uint8Array(4), str(value)));
  const payload = concat(u32b(index), dataBox);
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(payload, 4);
  return out;
}

/**
 * tkhd version 0 — the last 8 bytes of the payload are display width/height as
 * 16.16 fixed-point. Copied from mp4-mdta.test.ts so the two suites agree on
 * what a real file looks like.
 */
function tkhdBox(width: number, height: number): Uint8Array {
  const fixed = (n: number) => (n << 16) >>> 0;
  return box(
    "tkhd",
    concat(
      new Uint8Array([0, 0, 0, 0]), // version + flags
      u32b(0),
      u32b(0), // creation_time, modification_time
      u32b(1),
      u32b(0), // track_ID, reserved
      u32b(0), // duration
      new Uint8Array(8), // reserved
      new Uint8Array(8), // layer / alternate_group / volume / reserved
      new Uint8Array(36), // matrix
      u32b(fixed(width)),
      u32b(fixed(height)),
    ),
  );
}

const TAG_VALUE = '{"prompt": "a cat on a skateboard"}';

/**
 * moov carrying both an mdta tag and a tkhd track with real dimensions.
 * Layout matters: the parsers look for `moov → udta → meta` and
 * `moov → trak → tkhd`, both as direct children.
 */
function buildMoov(width = 1344, height = 768): Uint8Array {
  const keysBox = box(
    "keys",
    concat(new Uint8Array(4), u32b(1), keyEntry("prompt")),
  );
  const ilstBox = box("ilst", ilstEntry(1, TAG_VALUE));
  const metaBox = box("meta", concat(new Uint8Array(4), keysBox, ilstBox));
  const udtaBox = box("udta", metaBox);
  return box("moov", concat(udtaBox, box("trak", tkhdBox(width, height))));
}

const FTYP = box("ftyp", str("isom"));

/** In-memory stand-in for the main process's file-handle reader. */
function memoryReader(bytes: Uint8Array) {
  const stats = { bytesRead: 0, reads: 0 };
  return {
    stats,
    reader: {
      size: bytes.length,
      read: async (offset: number, length: number): Promise<Buffer> => {
        const end = Math.min(offset + length, bytes.length);
        stats.reads += 1;
        stats.bytesRead += end - offset;
        return Buffer.from(bytes.subarray(offset, end));
      },
    },
  };
}

describe("readMoovBox", () => {
  it("finds moov placed after the media data (the non-faststart case)", async () => {
    // This is the layout ComfyUI's muxer produces, and the reason a 64 KB head
    // read is not enough: everything the app wants sits past the payload.
    const mdat = box("mdat", new Uint8Array(2 * 1024 * 1024));
    const moov = buildMoov();
    const file = concat(FTYP, mdat, moov);

    const { reader } = memoryReader(file);
    const result = await readMoovBox(reader);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(FTYP.length + mdat.length);
    expect(Buffer.from(result.bytes)).toEqual(Buffer.from(moov));
  });

  it("finds moov placed first (faststart), without reading the payload", async () => {
    const moov = buildMoov();
    const file = concat(FTYP, moov, box("mdat", new Uint8Array(1024 * 1024)));

    const { reader } = memoryReader(file);
    const result = await readMoovBox(reader);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(FTYP.length);
  });

  it("reads a tiny fraction of the file, not the file", async () => {
    // The whole point. Walking to a moov after a 4 MB mdat must cost header
    // reads, not a 4 MB read.
    const mdat = box("mdat", new Uint8Array(4 * 1024 * 1024));
    const moov = buildMoov();
    const file = concat(FTYP, mdat, moov);

    const { reader, stats } = memoryReader(file);
    const result = await readMoovBox(reader);

    expect(result.ok).toBe(true);
    expect(stats.bytesRead).toBeLessThan(file.length / 100);
    // One header read per top-level box, plus one read for the moov itself.
    expect(stats.reads).toBeLessThanOrEqual(8);
  });

  it("steps over a box using the 64-bit size escape", async () => {
    const mdat = box64("mdat", new Uint8Array(1024));
    const moov = buildMoov();
    const file = concat(FTYP, mdat, moov);

    const { reader } = memoryReader(file);
    const result = await readMoovBox(reader);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offset).toBe(FTYP.length + mdat.length);
  });

  it("handles a box that declares 'to end of file'", async () => {
    const moov = buildMoov();
    const mdat = boxToEof("mdat", new Uint8Array(512));
    const file = concat(FTYP, mdat, moov);

    const { reader } = memoryReader(file);
    // mdat swallowing the rest of the file means there is genuinely no moov to
    // find — the walk must terminate rather than walk past the end.
    expect(await readMoovBox(reader)).toEqual({ ok: false, reason: "NO_MOOV" });
  });

  it("reports TRUNCATED when a box claims more bytes than the file has", async () => {
    const moov = buildMoov();
    const file = concat(FTYP, moov);
    // Chop the last 4 bytes so the declared moov size overruns the file — the
    // shape of an interrupted download.
    const { reader } = memoryReader(file.subarray(0, file.length - 4));

    expect(await readMoovBox(reader)).toEqual({ ok: false, reason: "TRUNCATED" });
  });

  it("reports NO_MOOV for a file that simply has none", async () => {
    // A webm/mkv reaching this path — the walk should decline cleanly rather
    // than guess, so the caller keeps whatever ffprobe found.
    const { reader } = memoryReader(concat(FTYP, box("mdat", new Uint8Array(64))));
    expect(await readMoovBox(reader)).toEqual({ ok: false, reason: "NO_MOOV" });
  });

  it("refuses a moov larger than the cap", async () => {
    const moov = buildMoov();
    const file = concat(FTYP, moov);
    const { reader } = memoryReader(file);

    expect(await readMoovBox(reader, 8)).toEqual({
      ok: false,
      reason: "MOOV_TOO_LARGE",
    });
  });

  it("declines rather than throwing on a non-MP4 byte stream", async () => {
    const garbage = enc.encode("this is not a container format at all".repeat(4));
    const { reader } = memoryReader(garbage);
    const result = await readMoovBox(reader);

    expect(result.ok).toBe(false);
  });

  it("declines on an empty file", async () => {
    const { reader } = memoryReader(new Uint8Array(0));
    const result = await readMoovBox(reader);

    expect(result.ok).toBe(false);
  });
});

describe("moov bytes are a drop-in for the whole file", () => {
  /**
   * The load-bearing claim in mp4Moov.mjs: both renderer parsers walk boxes
   * from offset 0, so a buffer that *starts* at the moov header parses exactly
   * like a buffer that contains it deeper in. If this ever stops being true,
   * the bounded read silently loses tags and dimensions instead of failing.
   */
  it("yields identical tags and dimensions from a moov-only buffer", async () => {
    const moov = buildMoov(1344, 768);
    const wholeFile = concat(
      FTYP,
      box("mdat", new Uint8Array(1024 * 1024)),
      moov,
    );

    const fromWholeFileTags = extractMp4MdtaTags(wholeFile);
    const fromWholeFileDims = extractMp4Dimensions(wholeFile);

    const { reader } = memoryReader(wholeFile);
    const result = await readMoovBox(reader);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fromMoovOnly = new Uint8Array(result.bytes);
    expect(extractMp4MdtaTags(fromMoovOnly)).toEqual(fromWholeFileTags);
    expect(extractMp4Dimensions(fromMoovOnly)).toEqual(fromWholeFileDims);
  });

  it("actually recovered something worth having", async () => {
    // Guards against the previous test passing vacuously on two empty results.
    const { reader } = memoryReader(concat(FTYP, buildMoov(1344, 768)));
    const result = await readMoovBox(reader);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bytes = new Uint8Array(result.bytes);
    expect(extractMp4MdtaTags(bytes)).toEqual({ prompt: TAG_VALUE });
    expect(extractMp4Dimensions(bytes)).toEqual({ width: 1344, height: 768 });
  });
});

describe("MAX_MOOV_BYTES", () => {
  it("is large enough for a metadata-rich moov and small enough to be safe", () => {
    // The failure it prevents on the low side is real metadata being refused;
    // on the high side, a buffer large enough to matter. A workflow JSON with
    // an embedded prompt runs to a few hundred KB.
    expect(MAX_MOOV_BYTES).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    expect(MAX_MOOV_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});
