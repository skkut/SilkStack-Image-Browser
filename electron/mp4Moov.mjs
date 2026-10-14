/**
 * Locate and read an MP4/MOV `moov` atom without reading the video.
 *
 * Background — why this exists
 * ----------------------------
 * MP4 is a flat sequence of length-prefixed boxes. Everything the app wants
 * from a video — the mdta tags ComfyUI writes, the track dimensions in
 * `moov→trak→tkhd` — lives in `moov`. The media samples live in `mdat`, which
 * in an AI-generated clip is three orders of magnitude larger.
 *
 * The catch is that `moov` has no fixed position. Faststart muxers (ffmpeg
 * `-movflags +faststart`, most streaming tools) put it first, so a 64 KB head
 * read finds it. Most encoders — ComfyUI's included — leave it last, and then
 * a head read finds only `ftyp` and the first bytes of `mdat`.
 *
 * The old answer was to read the entire file. That is what made a library of
 * large videos unopenable: four concurrent full reads, structured-cloned into
 * the renderer, each held as an ArrayBuffer while it was parsed.
 *
 * The fix is that `moov`'s position is pure arithmetic. Walk the *top-level*
 * boxes: each declares its own size in the first four bytes, so `mdat` can be
 * stepped over without touching it, and the next header read lands on whatever
 * follows. A handful of 16-byte reads locates `moov`; only `moov` itself —
 * typically a few hundred KB — is then read.
 *
 * The bytes returned start exactly at the `moov` box header, and both renderer
 * parsers (`extractMp4MdtaTags`, `extractMp4Dimensions`) walk boxes from offset
 * 0, so they consume this buffer unchanged. That is what makes the bounded read
 * a drop-in replacement rather than a parser rewrite.
 *
 * Free of any `electron` import so it can be unit-tested under vitest.
 */

/** Refuse anything larger — a moov this big is pathological, not a metadata box. */
export const MAX_MOOV_BYTES = 12 * 1024 * 1024;

/**
 * The largest box header: 4-byte size + 4-byte type, plus 8 more when the size
 * is the 64-bit escape value.
 */
const MAX_HEADER_BYTES = 16;

/**
 * Ceiling on top-level boxes to inspect. A well-formed file has a handful
 * (ftyp, mdat, moov, maybe free/wide). The bound exists so a malformed or
 * hostile file full of tiny boxes cannot spin the walk.
 */
const MAX_TOP_LEVEL_BOXES = 1024;

/**
 * @typedef {Object} BoxReader
 * @property {number} size Total file size in bytes.
 * @property {(offset: number, length: number) => Promise<Buffer>} read
 *   Read up to `length` bytes at `offset`. May return fewer at EOF.
 */

/**
 * @typedef {{ok: true, bytes: Buffer, offset: number}
 *   | {ok: false, reason: 'NO_MOOV' | 'MOOV_TOO_LARGE' | 'TRUNCATED' | 'READ_FAILED'}} MoovResult
 */

/**
 * Parse one box header at `offset`.
 * @param {BoxReader} reader
 * @param {number} offset
 * @returns {Promise<{type: string, size: number, headerSize: number} | null>}
 */
async function readBoxHeader(reader, offset) {
  const available = Math.min(MAX_HEADER_BYTES, reader.size - offset);
  if (available < 8) return null;

  const header = await reader.read(offset, available);
  if (header.length < 8) return null;

  let size = header.readUInt32BE(0);
  const type = header.toString("latin1", 4, 8);
  let headerSize = 8;

  if (size === 1) {
    // 64-bit size: the real value is the 8 bytes after the type.
    if (header.length < 16) return null;
    size = header.readUInt32BE(8) * 0x100000000 + header.readUInt32BE(12);
    headerSize = 16;
  } else if (size === 0) {
    // "extends to end of file" — legal, and mdat uses it in some writers.
    size = reader.size - offset;
  }

  if (!Number.isFinite(size) || size < headerSize) return null;
  return { type, size, headerSize };
}

/**
 * Walk the top-level boxes and return the `moov` box's bytes.
 *
 * @param {BoxReader} reader
 * @param {number} [maxMoovBytes]
 * @returns {Promise<MoovResult>}
 */
export async function readMoovBox(reader, maxMoovBytes = MAX_MOOV_BYTES) {
  let offset = 0;

  for (let inspected = 0; inspected < MAX_TOP_LEVEL_BOXES; inspected += 1) {
    if (offset + 8 > reader.size) break;

    const box = await readBoxHeader(reader, offset);
    if (!box) return { ok: false, reason: "READ_FAILED" };

    const end = offset + box.size;
    if (end > reader.size) {
      // The box claims more bytes than the file has. For a truncated download
      // that is exactly the interesting case — there is no complete moov in it.
      return { ok: false, reason: "TRUNCATED" };
    }

    if (box.type === "moov") {
      if (box.size > maxMoovBytes) {
        return { ok: false, reason: "MOOV_TOO_LARGE" };
      }
      const bytes = await reader.read(offset, box.size);
      if (bytes.length !== box.size) {
        return { ok: false, reason: "READ_FAILED" };
      }
      return { ok: true, bytes, offset };
    }

    // Everything else is skipped by arithmetic. `mdat` is the box that matters:
    // its declared size is what lets us jump over the gigabytes.
    offset = end;
  }

  return { ok: false, reason: "NO_MOOV" };
}
