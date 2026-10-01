/**
 * Binary metadata parsers for PNG, JPEG, and WebP images.
 *
 * Extracted from fileIndexer.ts for sharing between the main thread and
 * the metadata Web Worker. All functions are PURE — no Electron, window,
 * or DOM dependencies. Works exclusively with ArrayBuffer / DataView.
 */

import exifr from 'exifr';
import {
  type ImageMetadata,
  type ComfyUIMetadata,
  isInvokeAIMetadata,
  isComfyUIMetadata,
} from '../../types';

// Debug flag — worker-compatible (no window reference)
const shouldLogPngDebug = Boolean(
  (typeof globalThis !== 'undefined' && (globalThis as any)?.process?.env?.PNG_DEBUG === 'true') ||
  (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.VITE_PNG_DEBUG)
);

// ═══════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════

function sanitizeJson(jsonString: string): string {
    // Replace NaN with null, as NaN is not valid JSON
    return jsonString.replace(/:\s*NaN/g, ': null');
}

/**
 * Minimal TIFF IFD walker that reads the Make (0x010F) and Model (0x0110)
 * ASCII tags. ComfyUI SaveWebP (VideoHelperSuite) stores its metadata there:
 *   Make  = "workflow:{...}"  (UI graph JSON)
 *   Model = "prompt:{...}"    (execution prompt JSON)
 * Pure byte math — no dependencies, so it also works when exifr rejects the
 * input (ArrayBuffer/Buffer realm mismatches make exifr throw "Invalid input
 * argument", which previously killed the whole WebP extraction).
 */
function extractComfyFromTiffMakeModel(tiff: Uint8Array): ImageMetadata | null {
    if (tiff.length < 8) return null;
    const isBE = tiff[0] === 0x4d;
    const readU16 = (o: number): number =>
        isBE ? (tiff[o] << 8) | tiff[o + 1] : tiff[o] | (tiff[o + 1] << 8);
    const readU32 = (o: number): number =>
        (isBE
            ? (tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]
            : tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0;

    if (readU16(2) !== 0x2a) return null;
    const ifd0 = readU32(4);
    if (ifd0 + 2 > tiff.length) return null;
    const count = readU16(ifd0);
    if (ifd0 + 2 + count * 12 > tiff.length) return null;

    const tagValues = new Map<number, Uint8Array>();
    for (let i = 0; i < count; i++) {
        const entry = ifd0 + 2 + i * 12;
        const tag = readU16(entry);
        const type = readU16(entry + 2);
        const valueCount = readU32(entry + 4);
        if (type === 2 && valueCount > 0) {
            // ASCII — inline when ≤ 4 bytes, otherwise at the given offset
            let bytes: Uint8Array;
            if (valueCount <= 4) {
                bytes = tiff.slice(entry + 8, entry + 8 + valueCount);
            } else {
                const off = readU32(entry + 8);
                bytes = off + valueCount <= tiff.length
                    ? tiff.slice(off, off + valueCount)
                    : new Uint8Array();
            }
            tagValues.set(tag, bytes);
        }
    }

    const stripPrefix = (bytes: Uint8Array | undefined): string | null => {
        if (!bytes || bytes.length === 0) return null;
        const text = new TextDecoder().decode(bytes).replace(/\0+$/, '').trim();
        const match = text.match(/^(workflow|prompt)\s*:(.*)$/is);
        return match ? match[2] : null;
    };

    let workflow: any;
    let prompt: any;
    try {
        const workflowText = stripPrefix(tagValues.get(0x010f));
        const promptText = stripPrefix(tagValues.get(0x0110));
        if (workflowText === null && promptText === null) return null;
        if (workflowText !== null) workflow = JSON.parse(sanitizeJson(workflowText));
        if (promptText !== null) prompt = JSON.parse(sanitizeJson(promptText));
    } catch {
        // Malformed tag — let downstream parsing try
        return null;
    }

    if (workflow === undefined && prompt === undefined) return null;
    const result: ImageMetadata = {
        ...(workflow !== undefined ? { workflow } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
    };
    return result;
}

/**
 * Minimal MP4 metadata (mdta) walker: reads the Apple-style keys/ilst pair
 * inside moov → udta → meta. ComfyUI save nodes write their metadata there:
 *   keys:   mdta "workflow", mdta "prompt", mdta "encoder", ...
 *   ilst:   1 → workflow JSON (UI graph), 2 → prompt JSON (execution prompt), ...
 * ffprobe surfaces the same tags (format.tags.*) but is not guaranteed to be
 * installed — this is pure byte math over the boxes, so it also works on the
 * 64 KB head-read buffers the indexer already has in memory (faststart MP4s
 * put moov first). Returns every string tag found, keyed by its mdta name.
 */
export function extractMp4MdtaTags(bytes: Uint8Array): Record<string, string> {
    const tags: Record<string, string> = {};
    const len = bytes.length;
    if (len < 24) return tags;

    const readU32 = (o: number): number =>
        o + 4 <= len
            ? ((bytes[o] * 0x1000000 + bytes[o + 1] * 0x10000 + bytes[o + 2] * 0x100 + bytes[o + 3]) >>> 0)
            : 0;
    const fourccAt = (o: number): string =>
        o + 4 <= len
            ? String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
            : '';
    const decode = (start: number, end: number): string =>
        new TextDecoder().decode(bytes.subarray(start, end));

    // Box byte range at `off`, or null when truncated/invalid.
    // Handles 64-bit extended sizes (size == 1) and size == 0 (to end of buffer).
    const boxRange = (off: number): [number, number] | null => {
        if (off + 8 > len) return null;
        let size = readU32(off);
        if (size === 1) {
            if (off + 16 > len) return null;
            size = readU32(off + 8) * 0x100000000 + readU32(off + 12);
        } else if (size === 0) {
            size = len - off;
        }
        if (size < 8 || off + size > len) return null;
        return [off, off + size];
    };

    const walkBoxes = (
        start: number,
        end: number,
        visitor: (fourcc: string, boxStart: number, boxEnd: number) => void,
    ): void => {
        let off = start;
        while (off + 8 <= end) {
            const range = boxRange(off);
            if (!range) break;
            visitor(fourccAt(off + 4), range[0], range[1]);
            off = range[1];
        }
    };

    // Locate moov → (udta →) meta
    let metaStart = -1;
    let metaEnd = -1;
    walkBoxes(0, len, (fourcc, bs, be) => {
        if (fourcc !== 'moov' || metaStart >= 0) return;
        walkBoxes(bs + 8, be, (sub, sbs, sbe) => {
            if (sub === 'meta') {
                metaStart = sbs;
                metaEnd = sbe;
            } else if (sub === 'udta') {
                walkBoxes(sbs + 8, sbe, (sub2, tbs, tbe) => {
                    if (sub2 === 'meta') {
                        metaStart = tbs;
                        metaEnd = tbe;
                    }
                });
            }
        });
    });
    if (metaStart < 0) return tags;

    // meta is a full box (version/flags before the children)
    const contentStart = metaStart + 12;

    // keys: [count u32][entry: size u32, "mdta", name\0]
    const keyNames: string[] = [];
    walkBoxes(contentStart, metaEnd, (fourcc, bs, be) => {
        if (fourcc !== 'keys') return;
        let o = bs + 12;
        const count = o + 4 <= be ? readU32(o) : 0;
        o += 4;
        for (let i = 0; i < count && o + 8 <= be; i++) {
            const esize = readU32(o);
            if (esize < 8 || o + esize > be) break;
            let nameEnd = o + 8;
            while (nameEnd < o + esize && bytes[nameEnd] !== 0) nameEnd++;
            keyNames.push(decode(o + 8, nameEnd));
            o += esize;
        }
    });

    // ilst: [entry: size u32, index u32, data box...]
    const values: Record<number, string> = {};
    walkBoxes(contentStart, metaEnd, (fourcc, bs, be) => {
        if (fourcc !== 'ilst') return;
        let o = bs + 8;
        while (o + 8 <= be) {
            const esize = readU32(o);
            if (esize < 8 || o + esize > be) break;
            const index = readU32(o + 4);
            let d = o + 8;
            while (d + 8 <= o + esize) {
                const dsize = readU32(d);
                if (dsize < 8 || d + dsize > o + esize) break;
                if (fourccAt(d + 4) === 'data' && dsize >= 16 && readU32(d + 8) === 1) {
                    // kind == 1 → UTF-8 string payload
                    values[index] = decode(d + 16, d + dsize);
                }
                d += dsize;
            }
            o += esize;
        }
    });

    keyNames.forEach((name, i) => {
        const value = values[i + 1];
        if (value !== undefined) tags[name] = value;
    });
    return tags;
}

/**
 * MP4 track-header (tkhd) dimension reader: moov → trak → tkhd.
 * The last 8 bytes of a tkhd payload are the display width/height as
 * 16.16 fixed-point values (video track). Audio tracks have 0x0 there,
 * so we take the first track with non-zero dimensions.
 *
 * Same box-walking strategy as extractMp4MdtaTags — pure byte math, no
 * ffprobe. Needed because ffprobe is not guaranteed to be installed: the
 * indexer already holds these bytes (faststart MP4s put moov at the front
 * of the 64 KB head read), so dimensions can be resolved dependency-free.
 */
export function extractMp4Dimensions(bytes: Uint8Array): { width: number; height: number } | null {
    const len = bytes.length;
    if (len < 24) return null;

    const readU32 = (o: number): number =>
        o + 4 <= len
            ? ((bytes[o] * 0x1000000 + bytes[o + 1] * 0x10000 + bytes[o + 2] * 0x100 + bytes[o + 3]) >>> 0)
            : 0;
    const fourccAt = (o: number): string =>
        o + 4 <= len
            ? String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3])
            : '';

    const boxRange = (off: number): [number, number] | null => {
        if (off + 8 > len) return null;
        let size = readU32(off);
        if (size === 1) {
            if (off + 16 > len) return null;
            size = readU32(off + 8) * 0x100000000 + readU32(off + 12);
        } else if (size === 0) {
            size = len - off;
        }
        if (size < 8 || off + size > len) return null;
        return [off, off + size];
    };

    const walkBoxes = (
        start: number,
        end: number,
        visitor: (fourcc: string, boxStart: number, boxEnd: number) => void,
    ): void => {
        let off = start;
        while (off + 8 <= end) {
            const range = boxRange(off);
            if (!range) break;
            visitor(fourccAt(off + 4), range[0], range[1]);
            off = range[1];
        }
    };

    // moov → trak → tkhd. tkhd is a full box (version/flags first).
    let result: { width: number; height: number } | null = null;
    walkBoxes(0, len, (fourcc, bs, be) => {
        if (fourcc !== 'moov' || result) return;
        walkBoxes(bs + 8, be, (sub, sbs, sbe) => {
            if (sub !== 'trak' || result) return;
            walkBoxes(sbs + 8, sbe, (sub2, tbs, tbe) => {
                if (sub2 !== 'tkhd' || result) return;
                const version = tbs + 8 < len ? bytes[tbs + 8] : 0;
                // Version 0: width at payload+72, version 1: payload+84
                const widthOff = tbs + 12 + (version === 1 ? 84 : 72);
                const heightOff = widthOff + 4;
                if (widthOff + 8 > tbe) return;
                const width = readU32(widthOff) >> 16;
                const height = readU32(heightOff) >> 16;
                if (width > 0 && height > 0) {
                    result = { width, height };
                }
            });
        });
    });
    return result;
}

export function detectImageType(view: DataView): 'png' | 'jpeg' | 'webp' | null {
  if (view.byteLength < 12) {
    return null;
  }

  if (view.getUint32(0) === 0x89504E47 && view.getUint32(4) === 0x0D0A1A0A) {
    return 'png';
  }

  if (view.getUint16(0) === 0xFFD8) {
    return 'jpeg';
  }

  if (view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    return 'webp';
  }

  return null;
}

function extractJpegComment(buffer: ArrayBuffer): string | null {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) {
    return null;
  }

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xFF) {
      offset += 1;
      continue;
    }

    let marker = view.getUint8(offset + 1);
    while (marker === 0xFF && offset + 2 < view.byteLength) {
      offset += 1;
      marker = view.getUint8(offset + 1);
    }

    if (marker === 0xDA || marker === 0xD9) {
      break;
    }

    // Standalone markers without length
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      offset += 2;
      continue;
    }

    const size = view.getUint16(offset + 2, false);
    if (size < 2 || offset + 2 + size > view.byteLength) {
      break;
    }

    if (marker === 0xFE) {
      const start = offset + 4;
      const end = offset + 2 + size;
      const bytes = new Uint8Array(buffer.slice(start, end));
      const utf8 = new TextDecoder('utf-8').decode(bytes).trim();
      if (utf8.includes('\uFFFD')) {
        return new TextDecoder('latin1').decode(bytes).trim();
      }
      return utf8;
    }

    offset += 2 + size;
  }

  return null;
}

function isMetaHubSaveNodePayload(payload: any): payload is Record<string, any> {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const data = payload as Record<string, any>;
  const generator = data.generator ?? data.Generator;

  // CRITICAL: Use only MetaHub-SPECIFIC markers — do NOT include `workflow`
  // (a standard ComfyUI field that would false-match any ComfyUI JSON).
  const hasMetaHubSpecificMarkers = Boolean(
    data.imh_pro ||
    data._metahub_pro ||
    data.prompt_api
  );
  // analytics / _analytics are strong indicators of MetaHub but occasionally appear
  // in other ComfyUI extensions; require them to be combined with core fields.
  const hasMetaHubAnalytics = Boolean(
    data.analytics || data._analytics
  );
  const hasStrongMetaHubSignal = hasMetaHubSpecificMarkers || hasMetaHubAnalytics;

  const hasCoreFields = Boolean(
    data.prompt ||
    data.negativePrompt ||
    data.seed !== undefined ||
    data.steps !== undefined ||
    data.sampler_name ||
    data.model
  );

  // Only match as MetaHub when there's a MetaHub-specific signal present.
  // Generic ComfyUI workflows (without imh_pro / _metahub_pro / prompt_api / analytics)
  // must NOT match — they go through the standard ComfyUI normalization instead.
  return (generator === 'ComfyUI' && hasStrongMetaHubSignal && hasCoreFields) ||
         (hasStrongMetaHubSignal && hasCoreFields);
}

function wrapMetaHubData(payload: any): ImageMetadata | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = payload as Record<string, any>;
  if (data.imagemetahub_data) {
    return { imagemetahub_data: data.imagemetahub_data };
  }

  if (isMetaHubSaveNodePayload(data)) {
    return { imagemetahub_data: data };
  }

  return null;
}

function tryParseMetaHubJson(text: string): ImageMetadata | null {
  try {
    const parsed = JSON.parse(text);
    return wrapMetaHubData(parsed);
  } catch {
    return null;
  }
}

async function decodeITXtText(
  data: Uint8Array,
  compressionFlag: number,
  decoder: TextDecoder
): Promise<string> {
  if (compressionFlag === 0) {
    return decoder.decode(data);
  }

  if (compressionFlag === 1) {
    // Deflate-compressed (zlib) text
    try {
      // Prefer browser-native DecompressionStream (Chromium/Electron)
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('deflate');
        // Ensure we pass a real ArrayBuffer (not SharedArrayBuffer) to Blob to satisfy TS/DOM types
        const arrayCopy = new Uint8Array(data.byteLength);
        arrayCopy.set(data);
        const arrayBuf = arrayCopy.buffer;
        const decompressedStream = new Blob([arrayBuf]).stream().pipeThrough(ds);
        const decompressedBuffer = await new Response(decompressedStream).arrayBuffer();
        return decoder.decode(decompressedBuffer);
      }
      // Fallback for Node.js (should rarely be needed in renderer)
      if (typeof require !== 'undefined') {
        const zlib = await import('zlib');
        const inflated = zlib.inflateSync(Buffer.from(data));
        return decoder.decode(inflated);
      }
    } catch (err) {
      if (shouldLogPngDebug) {
        console.warn('[PNG DEBUG] Failed to decompress iTXt chunk', err);
      }
      return '';
    }
  }

  return '';
}

export async function parsePNGMetadata(buffer: ArrayBuffer): Promise<ImageMetadata | null> {
  const view = new DataView(buffer);
  let offset = 8;
  const decoder = new TextDecoder();
  const chunks: { [key: string]: string } = {};
  let shouldTryExif = false;
  
  // OPTIMIZATION: Stop early if we found all needed chunks
  let foundChunks = 0;
  const maxChunks = 5; // invokeai_metadata, parameters, workflow, prompt, Description

  while (offset < view.byteLength && foundChunks < maxChunks) {
    if (offset + 8 > view.byteLength) {
      break;
    }
    const length = view.getUint32(offset);
    const type = decoder.decode(buffer.slice(offset + 4, offset + 8));
    if (offset + 12 + length > view.byteLength) {
      break;
    }
    
    if (type === 'tEXt') {
      const chunkData = buffer.slice(offset + 8, offset + 8 + length);
      const chunkString = decoder.decode(chunkData);
      const [keyword, text] = chunkString.split('\0');
      if (keyword.toLowerCase() === 'xml:com.adobe.xmp') {
        shouldTryExif = true;
      }
      
      if (['invokeai_metadata', 'parameters', 'Parameters', 'workflow', 'prompt', 'Description'].includes(keyword) && text) {
        chunks[keyword.toLowerCase()] = text;
        foundChunks++;
      }
    } else if (type === 'iTXt') {
      const chunkData = new Uint8Array(buffer.slice(offset + 8, offset + 8 + length));
      const keywordEndIndex = chunkData.indexOf(0);
      if (keywordEndIndex === -1) {
        offset += 12 + length;
        continue;
      }
      const keyword = decoder.decode(chunkData.slice(0, keywordEndIndex));
      if (keyword.toLowerCase() === 'xml:com.adobe.xmp') {
        shouldTryExif = true;
      }

      if (['invokeai_metadata', 'parameters', 'Parameters', 'workflow', 'prompt', 'Description', 'imagemetahub_data'].includes(keyword)) {
        const compressionFlag = chunkData[keywordEndIndex + 1];
        let currentIndex = keywordEndIndex + 3; // Skip null separator, compression flag, and method

        const langTagEndIndex = chunkData.indexOf(0, currentIndex);
        if (langTagEndIndex === -1) {
          offset += 12 + length;
          continue;
        }
        currentIndex = langTagEndIndex + 1;

        const translatedKwEndIndex = chunkData.indexOf(0, currentIndex);
        if (translatedKwEndIndex === -1) {
          offset += 12 + length;
          continue;
        }
        currentIndex = translatedKwEndIndex + 1;

        const text = await decodeITXtText(chunkData.slice(currentIndex), compressionFlag, decoder);
        if (text) {
          chunks[keyword.toLowerCase()] = text;
          foundChunks++;
        }
      }
    } else if (type === 'eXIf') {
      shouldTryExif = true;
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }

  // PRIORITY 0: MetaHub Save Node chunk (highest priority)
  if (chunks.imagemetahub_data) {
    try {
      const metahubData = JSON.parse(chunks.imagemetahub_data);
      return { imagemetahub_data: metahubData };
    } catch (e) {
      console.warn('[PNG Parser] Failed to parse imagemetahub_data chunk:', e);
      // Fall through to other parsers
    }
  }

  // PRIORITY 1: Prioritize workflow for ComfyUI, then parameters for A1111, then InvokeAI
  if (chunks.workflow) {
    const comfyMetadata: ComfyUIMetadata = {};
    if (chunks.workflow) comfyMetadata.workflow = chunks.workflow;
    if (chunks.prompt) comfyMetadata.prompt = chunks.prompt;
    return comfyMetadata;
  } else if (chunks.parameters || chunks.description) {
    const paramsValue = chunks.parameters || chunks.description;
    if (shouldLogPngDebug) {
      console.log('[PNG DEBUG] Found parameters chunk:', {
        length: paramsValue.length,
        preview: paramsValue.substring(0, 150),
        hasSuiImageParams: paramsValue.includes('sui_image_params')
      });
    }
    return { parameters: paramsValue };
  } else if (chunks.invokeai_metadata) {
    return JSON.parse(chunks.invokeai_metadata);
  } else if (chunks.prompt) {
    return { prompt: chunks.prompt };
  }

  // Try EXIF/XMP extraction only when PNG has XMP or EXIF chunks present.
  if (shouldTryExif) {
    try {
      const exifResult = await parseJPEGMetadata(buffer);
      if (exifResult) {
        return exifResult;
      }
    } catch {
      // Silent error - EXIF extraction may fail
    }
  }

  // If no EXIF found, try PNG chunks as fallback
  // ...existing code...
}

export async function parseJPEGMetadata(buffer: ArrayBuffer): Promise<ImageMetadata | null> {
  try {
    // Extract EXIF data with UserComment and XMP support
    const exifData = await exifr.parse(buffer, {
      userComment: true,
      xmp: true,
      mergeOutput: true,
      sanitize: false,
      reviveValues: true
    });

    const commentText = extractJpegComment(buffer);

    if (!exifData) {
      if (commentText) {
        const metaHubFromComment = tryParseMetaHubJson(commentText);
        if (metaHubFromComment) {
          return metaHubFromComment;
        }
        return { parameters: commentText };
      }
      return null;
    }

    // PRIORITY 0: Check for MetaHub Save Node JSON in ImageDescription (JPEG/WebP save format)
    // MetaHub Save Node stores the IMH metadata as JSON in EXIF ImageDescription for JPEG/WebP
    if (exifData.ImageDescription) {
      try {
        const imageDesc = typeof exifData.ImageDescription === 'string'
          ? exifData.ImageDescription
          : new TextDecoder('utf-8').decode(exifData.ImageDescription);

        const metaHubData = tryParseMetaHubJson(imageDesc);
        if (metaHubData) {
          return metaHubData;
        }

        // Check if ImageDescription contains a ComfyUI workflow JSON
        // (strong indicators: class_type, last_node_id, nodes array, or workflow/prompt objects)
        if (imageDesc.includes('"class_type"') ||
            imageDesc.includes('"last_node_id"') ||
            (imageDesc.includes('"nodes"') && imageDesc.includes('"links"')) ||
            (imageDesc.includes('"workflow"') && imageDesc.includes('"inputs"'))) {
          try {
            // Strip known prefixes (e.g. "Workflow:{...}")
            let jsonText = imageDesc;
            if (!jsonText.startsWith('{')) {
              const firstBrace = jsonText.indexOf('{');
              if (firstBrace > 0) jsonText = jsonText.substring(firstBrace);
            }
            const parsed = JSON.parse(jsonText);
            if (typeof parsed.workflow === 'string') {
              parsed.workflow = JSON.parse(sanitizeJson(parsed.workflow));
            }
            if (typeof parsed.prompt === 'string') {
              parsed.prompt = JSON.parse(sanitizeJson(parsed.prompt));
            }
            // If this is a raw workflow graph (has nodes/links/last_node_id but no
            // workflow/prompt wrapper), wrap it so downstream normalization detects it.
            if (!parsed.workflow && !parsed.prompt &&
                (parsed.last_node_id !== undefined || Array.isArray(parsed.nodes))) {
              return { workflow: parsed } as ImageMetadata;
            }
            return parsed as ImageMetadata;
          } catch {
            // JSON parse failed; fall through to text-based detection below
          }
        }
      } catch {
        // Not JSON or not parseable, continue with normal parsing
      }
    }

    // Check all possible field names for UserComment (A1111 and SwarmUI store metadata here in JPEGs)
    // Also check XMP Description for Draw Things and other XMP-based metadata
    let metadataText: string | Uint8Array | undefined =
      exifData.UserComment ||
      exifData.userComment ||
      exifData['User Comment'] ||
      exifData.ImageDescription ||
      exifData.Parameters ||
      exifData.Description || // XMP Description
      commentText ||
      null;

    if (!metadataText) {
      if (exifData.imagemetahub_data) {
        try {
          const parsed = typeof exifData.imagemetahub_data === 'string'
            ? JSON.parse(exifData.imagemetahub_data)
            : exifData.imagemetahub_data;
          return { imagemetahub_data: parsed };
        } catch {
          return { imagemetahub_data: exifData.imagemetahub_data };
        }
      }

      const comfyMetadata: Partial<ComfyUIMetadata> = {};
      if (exifData.workflow) {
        comfyMetadata.workflow = exifData.workflow;
      }
      if (exifData.prompt) {
        comfyMetadata.prompt = exifData.prompt;
      }
      if (comfyMetadata.workflow || comfyMetadata.prompt) {
        return comfyMetadata;
      }

      return null;
    }
    
    // Convert Uint8Array to string if needed (exifr returns UserComment as Uint8Array)
    if (metadataText instanceof Uint8Array) {
      // UserComment in EXIF has 8-byte character code prefix (e.g., "ASCII\0\0\0", "UNICODE\0")
      // Find where the actual data starts (look for '{' character for JSON data)
      let startOffset = 0;
      for (let i = 0; i < Math.min(20, metadataText.length); i++) {
        if (metadataText[i] === 0x7B) { // '{' character
          startOffset = i;
          break;
        }
      }
      
      // If no JSON found at start, skip the standard 8-byte prefix
      if (startOffset === 0 && metadataText.length > 8) {
        startOffset = 8;
      }
      
      // Remove null bytes (0x00) that can interfere with decoding
      const cleanedData = Array.from(metadataText.slice(startOffset)).filter(byte => byte !== 0x00);
      metadataText = new TextDecoder('utf-8').decode(new Uint8Array(cleanedData));
    } else if (typeof metadataText !== 'string') {
      // Convert other types to string
      metadataText = typeof metadataText === 'object' ? JSON.stringify(metadataText) : String(metadataText);
    }

    if (!metadataText) {
      return null;
    }

    const metaHubFromText = tryParseMetaHubJson(metadataText);
    if (metaHubFromText) {
      return metaHubFromText;
    }

    // ========== CRITICAL FIX: Check for ComfyUI FIRST (before other patterns) ==========
    // ComfyUI images stored as JPEG with A1111-style parameters in EXIF
    if (metadataText.includes('Version: ComfyUI')) {
      return { parameters: metadataText };
    }

    // No ComfyUI detected, checking other patterns...

    // ========== DRAW THINGS XMP FORMAT DETECTION ==========
    // Draw Things stores metadata in XMP format: {"lang":"x-default","value":"{JSON}"}
    if (metadataText.includes('"lang":"x-default"') && metadataText.includes('"value":')) {
      try {
        const xmpData = JSON.parse(metadataText);
        if (xmpData.value && typeof xmpData.value === 'string') {
          const innerJson = xmpData.value;
          // Check if the inner JSON contains Draw Things characteristics
          if (innerJson.includes('"c":') && (innerJson.includes('"model":') || innerJson.includes('"sampler":') || innerJson.includes('"scale":'))) {
            // Return in the expected format with Draw Things indicators so it gets routed to Draw Things parser
            return { parameters: 'Draw Things ' + innerJson, userComment: innerJson };
          }
        }
      } catch {
        // Not valid JSON, continue with other checks
      }
    }

    // A1111-style data is often not valid JSON, so we check for its characteristic pattern first.
    // Check for Civitai resources format first (A1111 without Model hash but with Civitai resources)
    if (metadataText.includes('Civitai resources:') && metadataText.includes('Steps:')) {
      return { parameters: metadataText };
    }
    if (metadataText.includes('Steps:') && metadataText.includes('Sampler:') && metadataText.includes('Model hash:')) {
      return { parameters: metadataText };
    }

    // Easy Diffusion uses similar format but without Model hash
    if (metadataText.includes('Prompt:') && metadataText.includes('Steps:') && metadataText.includes('Sampler:') && !metadataText.includes('Model hash:')) {
      return { parameters: metadataText };
    }

    // Midjourney uses parameter flags like --v, --ar, --q, --s
    if (metadataText.includes('--v') || metadataText.includes('--ar') || metadataText.includes('--q') || metadataText.includes('--s') || metadataText.includes('Midjourney')) {
      return { parameters: metadataText };
    }

    // Forge uses A1111-style parameters but includes "Forge" or "Gradio" indicators
    if ((metadataText.includes('Forge') || metadataText.includes('Gradio')) && 
        metadataText.includes('Steps:') && metadataText.includes('Sampler:') && metadataText.includes('Model hash:')) {
      return { parameters: metadataText };
    }

    // Draw Things (iOS/Mac AI app) - SIMPLIFIED: If it has Guidance Scale + Steps + Sampler, it's Draw Things
    if (metadataText.includes('Guidance Scale:') && metadataText.includes('Steps:') && metadataText.includes('Sampler:') &&
        !metadataText.includes('Model hash:') && !metadataText.includes('Forge') && !metadataText.includes('Gradio') &&
        !metadataText.includes('DreamStudio') && !metadataText.includes('Stability AI') && !metadataText.includes('--niji')) {
      // Extract UserComment JSON if available
      let userComment: string | undefined;
      if (exifData.UserComment || exifData.userComment || exifData['User Comment']) {
        const comment = exifData.UserComment || exifData.userComment || exifData['User Comment'];
        if (typeof comment === 'string' && comment.includes('{')) {
          userComment = comment;
        }
      }
      return { parameters: metadataText, userComment };
    }

    // Try to parse as JSON for other formats like SwarmUI, InvokeAI, ComfyUI, or DALL-E
    try {
      const parsedMetadata = JSON.parse(metadataText);

      const wrappedMetaHub = wrapMetaHubData(parsedMetadata);
      if (wrappedMetaHub) {
        return wrappedMetaHub;
      }

      // Check for DALL-E C2PA manifest
      if (parsedMetadata.c2pa_manifest ||
          (parsedMetadata.exif_data && (parsedMetadata.exif_data['openai:dalle'] ||
                                        parsedMetadata.exif_data.Software?.includes('DALL-E')))) {
        return parsedMetadata;
      }

      // Check for SwarmUI format (sui_image_params)
      if (parsedMetadata.sui_image_params) {
        return parsedMetadata;
      }

      if (isInvokeAIMetadata(parsedMetadata)) {
        return parsedMetadata;
      } else if (isComfyUIMetadata(parsedMetadata)) {
        return parsedMetadata;
      } else {
        return parsedMetadata;
      }
    } catch {
      // JSON parsing failed - check for ComfyUI patterns in raw text
      // ComfyUI sometimes stores workflow/prompt as JSON strings in EXIF
      if (metadataText.includes('"workflow"') || metadataText.includes('"prompt"') ||
          metadataText.includes('last_node_id') || metadataText.includes('class_type') ||
          metadataText.includes('Version: ComfyUI')) {
        // Try to extract workflow and prompt from the text
        try {
          // Look for workflow JSON
          const workflowMatch = metadataText.match(/"workflow"\s*:\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*")/);
          const promptMatch = metadataText.match(/"prompt"\s*:\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*")/);

          const comfyMetadata: Partial<ComfyUIMetadata> = {};

          if (workflowMatch) {
            try {
              comfyMetadata.workflow = JSON.parse(workflowMatch[1]);
            } catch {
              comfyMetadata.workflow = workflowMatch[1];
            }
          }

          if (promptMatch) {
            try {
              comfyMetadata.prompt = JSON.parse(promptMatch[1]);
            } catch {
              comfyMetadata.prompt = promptMatch[1];
            }
          }

          // If we found either workflow or prompt, return as ComfyUI metadata
          if (comfyMetadata.workflow || comfyMetadata.prompt) {
            return comfyMetadata;
          }

          // Special case: If we detected "Version: ComfyUI" but couldn't extract workflow/prompt,
          // this might be a ComfyUI image with parameters stored in A1111-style format
          // Return it as parameters so it gets parsed by A1111 parser which can handle ComfyUI format
          if (metadataText.includes('Version: ComfyUI')) {
            return { parameters: metadataText };
          }
        } catch {
          // Silent error - pattern matching failed
        }
      }

      // Silent error - JSON parsing may fail
      return null;
    }
  } catch {
    // Silent error - EXIF parsing may fail
    return null;
  }
}

/**
 * Decode XML character entities (&amp;lt;, &amp;gt;, &amp;amp;, &amp;quot;, &amp;apos;)
 * and numeric character references (&#xNNNN;, &#NNNN;) back to plain text.
 */
function decodeXmlEntities(xml: string): string {
  // `&amp;` is decoded LAST on purpose. Decoding it earlier would let an
  // entity that was escaped in the source be decoded twice: `&amp;#60;`
  // (the literal text "&#60;") would become `&#60;` here and then `<` in
  // the numeric pass below. Going last keeps every entity at exactly one
  // decode. The numeric quantifiers are bounded so a long run of digits
  // with no closing `;` can't backtrack quadratically.
  return xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]{1,16});/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,10});/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * Extract text content from an XML element that may contain rdf:Alt/rdf:li wrappers
 * or have rdf:parseType="Literal" for direct text content.
 */
function extractRdfText(xmlContent: string): string | null {
  // Case 1: rdf:Alt → rdf:li wrappers (XMP standard for multi-language text)
  const liRegex = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/gi;
  const liTexts: string[] = [];
  let liMatch: RegExpExecArray | null;
  while ((liMatch = liRegex.exec(xmlContent)) !== null) {
    const text = liMatch[1].trim();
    if (text) liTexts.push(decodeXmlEntities(text));
  }
  if (liTexts.length > 0) {
    return liTexts.join('\n');
  }

  // Case 2: rdf:parseType="Literal" — text directly inside element
  const literalMatch = xmlContent.match(/rdf:parseType\s*=\s*["']Literal["']/i);
  if (literalMatch) {
    const plainText = xmlContent.replace(/<[^>]+>/g, '').trim();
    if (plainText) return decodeXmlEntities(plainText);
  }

  // Case 3: Plain text content (no rdf wrappers)
  const plainText = xmlContent.replace(/<[^>]+>/g, '').trim();
  if (plainText) return decodeXmlEntities(plainText);

  return null;
}

/**
 * Extract human-readable text from an XMP XML string.
 * Looks for dc:description → rdf:Alt → rdf:li content, which is where
 * most AI image generators store their generation parameters in XMP.
 * Also checks exif:UserComment, xmp:Description, dc:title, and
 * photoshop:Headline as fallbacks.
 */
function extractTextFromXmp(xmpXml: string): string | null {
  // Strip BOM if present
  const cleanXml = xmpXml.replace(/^﻿/, '');

  // Priority 1: dc:description (most common for AI generation parameters)
  const dcDescRegex = /<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i;
  const dcDescMatch = cleanXml.match(dcDescRegex);
  if (dcDescMatch) {
    const text = extractRdfText(dcDescMatch[1]);
    if (text) return text;
  }

  // Priority 2: exif:UserComment (some tools store AI params here in XMP)
  const exifUcRegex = /<exif:UserComment[^>]*>([\s\S]*?)<\/exif:UserComment>/i;
  const exifUcMatch = cleanXml.match(exifUcRegex);
  if (exifUcMatch) {
    const text = extractRdfText(exifUcMatch[1]);
    if (text) return text;
  }

  // Priority 3: xmp:Description (used by some tools)
  const xmpDescRegex = /<xmp:Description[^>]*>([\s\S]*?)<\/xmp:Description>/i;
  const xmpDescMatch = cleanXml.match(xmpDescRegex);
  if (xmpDescMatch) {
    const text = extractRdfText(xmpDescMatch[1]);
    if (text) return text;
  }

  // Priority 4: dc:title
  const dcTitleRegex = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i;
  const dcTitleMatch = cleanXml.match(dcTitleRegex);
  if (dcTitleMatch) {
    const text = extractRdfText(dcTitleMatch[1]);
    if (text) return text;
  }

  // Priority 5: photoshop:Headline or photoshop:Caption (Adobe tools)
  const psRegex = /<photoshop:(?:Headline|Caption)[^>]*>([\s\S]*?)<\/photoshop:(?:Headline|Caption)>/i;
  const psMatch = cleanXml.match(psRegex);
  if (psMatch) {
    const text = extractRdfText(psMatch[1]);
    if (text) return text;
  }

  return null;
}

/**
 * Check if an XMP text block contains a raw JSON payload (e.g. MetaHub Save Node
 * storing its metadata as JSON inside an XMP description field).
 * Uses balanced-brace scanning for reliable JSON extraction.
 */
function tryExtractJsonFromXmpText(text: string): ImageMetadata | null {
  // Find the first '{' that looks like a JSON object start
  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) return null;

  // Balanced brace scan to find the matching closing brace
  let braceCount = 0;
  let jsonEnd = -1;
  for (let i = firstBrace; i < text.length; i++) {
    if (text[i] === '{') braceCount++;
    else if (text[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonEnd === -1) return null;

  const jsonCandidate = text.substring(firstBrace, jsonEnd);
  try {
    const parsed = JSON.parse(jsonCandidate);
    const metaHubData = wrapMetaHubData(parsed);
    if (metaHubData) return metaHubData;
    // Check for ComfyUI workflow/prompt in JSON form
    if (parsed.workflow || parsed.prompt || parsed.last_node_id) {
      return parsed as ImageMetadata;
    }
    // Check for other known JSON metadata formats
    if (parsed.sui_image_params || parsed.c2pa_manifest ||
        isInvokeAIMetadata(parsed) || isComfyUIMetadata(parsed)) {
      return parsed as ImageMetadata;
    }
  } catch {
    // Not valid JSON, continue
  }
  return null;
}

export async function parseWebPMetadata(buffer: ArrayBuffer): Promise<ImageMetadata | null> {
  try {
    const view = new DataView(buffer);
    const decoder = new TextDecoder();

    const findExifTiffHeaderOffset = (bytes: Uint8Array): number => {
      if (bytes.length < 4) {
        return -1;
      }

      // JPEG-style EXIF header ("Exif\0\0") prefix
      if (bytes.length >= 6 &&
          bytes[0] === 0x45 && bytes[1] === 0x78 && bytes[2] === 0x69 && bytes[3] === 0x66 &&
          bytes[4] === 0x00 && bytes[5] === 0x00) {
        return 6;
      }

      // TIFF header at start
      if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
        return 0;
      }

      // Scan for TIFF header within the first 64 bytes (handles extra padding)
      const limit = Math.min(64, bytes.length - 4);
      for (let i = 0; i <= limit; i++) {
        if (bytes[i] === 0x49 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x2a && bytes[i + 3] === 0x00) {
          return i;
        }
        if (bytes[i] === 0x4d && bytes[i + 1] === 0x4d && bytes[i + 2] === 0x00 && bytes[i + 3] === 0x2a) {
          return i;
        }
      }

      // Fallback: find II/MM without the 0x2a marker (last resort)
      const fallbackLimit = Math.min(64, bytes.length - 2);
      for (let i = 0; i <= fallbackLimit; i++) {
        if ((bytes[i] === 0x49 && bytes[i + 1] === 0x49) || (bytes[i] === 0x4d && bytes[i + 1] === 0x4d)) {
          return i;
        }
      }

      return -1;
    };

    // Verify RIFF header
    if (decoder.decode(buffer.slice(0, 4)) !== 'RIFF') {
      return null;
    }

    // Verify WEBP format
    if (decoder.decode(buffer.slice(8, 12)) !== 'WEBP') {
      return null;
    }

    // Walk all RIFF chunks, collecting EXIF and XMP data
    let offset = 12; // Skip RIFF header and WEBP signature
    let exifChunkData: ArrayBuffer | null = null;
    let xmpText: string | null = null;

    while (offset + 8 <= view.byteLength) {
      const chunkType = decoder.decode(buffer.slice(offset, offset + 4));
      const chunkSize = view.getUint32(offset + 4, true); // Little-endian

      if (offset + 8 + chunkSize > view.byteLength) {
        break;
      }

      if (chunkType === 'EXIF') {
        // Found EXIF chunk
        const exifStart = offset + 8;
        const rawExifData = buffer.slice(exifStart, exifStart + chunkSize);
        const rawBytes = new Uint8Array(rawExifData);
        const tiffHeaderOffset = findExifTiffHeaderOffset(rawBytes);

        if (tiffHeaderOffset >= 0) {
          exifChunkData = rawExifData.slice(tiffHeaderOffset);
        } else {
          // No TIFF header detected; try JSON extraction (MetaHub Save Node payloads)
          let jsonStartOffset = -1;
          for (let i = 0; i < rawBytes.length - 1; i++) {
            if (rawBytes[i] === 0x7b && rawBytes[i + 1] === 0x22) { // '{"'
              jsonStartOffset = i;
              break;
            }
          }

          if (jsonStartOffset >= 0) {
            const jsonBytes = rawExifData.slice(jsonStartOffset);
            const jsonString = decoder.decode(jsonBytes).trim();
            let braceCount = 0;
            let jsonEnd = -1;
            for (let i = 0; i < jsonString.length; i++) {
              if (jsonString[i] === '{') braceCount++;
              if (jsonString[i] === '}') braceCount--;
              if (braceCount === 0) {
                jsonEnd = i + 1;
                break;
              }
            }

            if (jsonEnd > 0) {
              const completeJson = jsonString.substring(0, jsonEnd);
              try {
                const parsed = JSON.parse(completeJson);
                const metaHubData = wrapMetaHubData(parsed);
                if (metaHubData) {
                  return metaHubData;
                }
              } catch {
                // Failed to parse JSON, continue
              }
            }
          }

          exifChunkData = rawExifData; // Try exifr anyway as fallback
        }
      } else if (chunkType === 'XMP ') {
        // Found XMP chunk — extract the raw XML text
        const xmpStart = offset + 8;
        const xmpBytes = buffer.slice(xmpStart, xmpStart + chunkSize);
        xmpText = decoder.decode(xmpBytes).trim();
      }

      // Continue to next chunk — don't break early, we want both EXIF and XMP
      offset += 8 + chunkSize;
      if (chunkSize % 2 !== 0) offset += 1;
    }

    // ── Process XMP data first (highest priority for AI generation params) ──
    let xmpMetadataText: string | null = null;
    if (xmpText) {
      // First check for raw JSON embedded in XMP (MetaHub Save Node, ComfyUI, etc.)
      const jsonFromXmp = tryExtractJsonFromXmpText(xmpText);
      if (jsonFromXmp) {
        return jsonFromXmp;
      }

      // Extract human-readable description text from XMP XML
      xmpMetadataText = extractTextFromXmp(xmpText);

      // If XMP contains recognizable AI metadata, return it directly
      if (xmpMetadataText) {
        const metaHubFromXmp = tryParseMetaHubJson(xmpMetadataText);
        if (metaHubFromXmp) {
          return metaHubFromXmp;
        }

        // Check for ComfyUI, A1111, and other known patterns in XMP text
        if (xmpMetadataText.includes('Version: ComfyUI') ||
            (xmpMetadataText.includes('Steps:') && xmpMetadataText.includes('Sampler:')) ||
            xmpMetadataText.includes('Prompt:') ||
            xmpMetadataText.includes('Negative prompt:') ||
            xmpMetadataText.includes('--v') || xmpMetadataText.includes('--ar') ||
            xmpMetadataText.includes('Midjourney') ||
            xmpMetadataText.includes('Guidance Scale:') ||
            xmpMetadataText.includes('sui_image_params')) {
          return { parameters: xmpMetadataText };
        }
      }
    }

    // ── Process EXIF data ──
    if (!exifChunkData) {
      // No EXIF chunk found. If we have XMP text that didn't match known patterns,
      // return it as a fallback parameters blob so downstream parsers can try.
      if (xmpMetadataText) {
        return { parameters: xmpMetadataText };
      }
      return null;
    }

    // ComfyUI SaveWebP keeps workflow/prompt in the Make/Model tags — read
    // them straight from the TIFF bytes (see extractComfyFromTiffMakeModel).
    const comfyFromTiff = extractComfyFromTiffMakeModel(new Uint8Array(exifChunkData));
    if (comfyFromTiff) {
      return comfyFromTiff;
    }

    // Parse the EXIF data with exifr (coerce to Uint8Array first — exifr's
    // instanceof checks fail across realms, e.g. Node Buffer vs jsdom/worker).
    const exifData = await exifr.parse(new Uint8Array(exifChunkData), {
      userComment: true,
      xmp: true,
      mergeOutput: true,
      sanitize: false,
      reviveValues: true
    });

    if (!exifData) {
      // EXIF parsing failed; fall back to XMP text if available
      if (xmpMetadataText) {
        return { parameters: xmpMetadataText };
      }
      return null;
    }

    // Check for imagemetahub_data in EXIF
    if ((exifData as any).imagemetahub_data) {
      try {
        const parsed = typeof (exifData as any).imagemetahub_data === 'string'
          ? JSON.parse((exifData as any).imagemetahub_data)
          : (exifData as any).imagemetahub_data;
        const wrapped = wrapMetaHubData({ imagemetahub_data: parsed });
        if (wrapped) {
          return wrapped;
        }
      } catch {
        const wrapped = wrapMetaHubData({ imagemetahub_data: (exifData as any).imagemetahub_data });
        if (wrapped) {
          return wrapped;
        }
      }
    }

    // PRIORITY 0: Check for MetaHub Save Node JSON in ImageDescription
    if (exifData.ImageDescription) {
      try {
        const imageDesc = typeof exifData.ImageDescription === 'string'
          ? exifData.ImageDescription
          : new TextDecoder('utf-8').decode(exifData.ImageDescription);

        // Check for MetaHub Save Node JSON first (has specific markers)
        const metaHubData = tryParseMetaHubJson(imageDesc);
        if (metaHubData) {
          return metaHubData;
        }

        // Check if ImageDescription contains a ComfyUI workflow JSON
        // (strong indicators: class_type, last_node_id, nodes array, or workflow/prompt objects)
        // This handles the case where ComfyUI stores its workflow directly in EXIF ImageDescription.
        if (imageDesc.includes('"class_type"') ||
            imageDesc.includes('"last_node_id"') ||
            (imageDesc.includes('"nodes"') && imageDesc.includes('"links"')) ||
            (imageDesc.includes('"workflow"') && imageDesc.includes('"inputs"'))) {
          try {
            // Strip known prefixes (e.g. "Workflow:{...}")
            let jsonText = imageDesc;
            if (!jsonText.startsWith('{')) {
              const firstBrace = jsonText.indexOf('{');
              if (firstBrace > 0) jsonText = jsonText.substring(firstBrace);
            }
            const parsed = JSON.parse(jsonText);
            // Sanitize any NaN values that ComfyUI sometimes emits
            if (typeof parsed.workflow === 'string') {
              parsed.workflow = JSON.parse(sanitizeJson(parsed.workflow));
            }
            if (typeof parsed.prompt === 'string') {
              parsed.prompt = JSON.parse(sanitizeJson(parsed.prompt));
            }
            // If this is a raw workflow graph (has nodes/links/last_node_id but no
            // workflow/prompt wrapper), wrap it so downstream normalization detects it.
            if (!parsed.workflow && !parsed.prompt &&
                (parsed.last_node_id !== undefined || Array.isArray(parsed.nodes))) {
              return { workflow: parsed } as ImageMetadata;
            }
            return parsed as ImageMetadata;
          } catch {
            // JSON parse failed; fall through to text-based detection below
          }
        }
      } catch {
        // Not JSON or not parseable, continue with normal parsing
      }
    }

    // PRIORITY 1: Use XMP dc:description text if it contains richer AI metadata than EXIF
    // XMP often has the full generation parameters while EXIF may have truncated versions
    if (xmpMetadataText && (
        xmpMetadataText.includes('Steps:') ||
        xmpMetadataText.includes('Prompt:') ||
        xmpMetadataText.includes('Negative prompt:') ||
        xmpMetadataText.includes('Version: ComfyUI') ||
        xmpMetadataText.includes('--v') ||
        xmpMetadataText.includes('Guidance Scale:')
    )) {
      const metaHubFromXmp = tryParseMetaHubJson(xmpMetadataText);
      if (metaHubFromXmp) {
        return metaHubFromXmp;
      }
      if (xmpMetadataText.includes('Version: ComfyUI')) {
        return { parameters: xmpMetadataText };
      }
      return { parameters: xmpMetadataText };
    }

    // Extract metadata text from EXIF fields
    let metadataText: string | Uint8Array | undefined =
      exifData.UserComment ||
      exifData.userComment ||
      exifData['User Comment'] ||
      exifData.ImageDescription ||
      exifData.Parameters ||
      exifData.Description ||
      null;

    // If EXIF has no metadata text but we have XMP text, use XMP
    if (!metadataText && xmpMetadataText) {
      metadataText = xmpMetadataText;
    }

    if (!metadataText) {
      return null;
    }

    // Convert Uint8Array to string if needed
    if (metadataText instanceof Uint8Array) {
      let startOffset = 0;
      for (let i = 0; i < Math.min(20, metadataText.length); i++) {
        if (metadataText[i] === 0x7B) { // '{' character
          startOffset = i;
          break;
        }
      }
      if (startOffset === 0 && metadataText.length > 8) {
        startOffset = 8;
      }
      const cleanedData = Array.from(metadataText.slice(startOffset)).filter(byte => byte !== 0x00);
      metadataText = new TextDecoder('utf-8').decode(new Uint8Array(cleanedData));
    } else if (typeof metadataText !== 'string') {
      metadataText = typeof metadataText === 'object' ? JSON.stringify(metadataText) : String(metadataText);
    }

    if (!metadataText) {
      return null;
    }

    const metaHubFromText = tryParseMetaHubJson(metadataText);
    if (metaHubFromText) {
      return metaHubFromText;
    }

    // ── Apply same detection logic as JPEG parser ──

    // Check for ComfyUI first
    if (metadataText.includes('Version: ComfyUI')) {
      return { parameters: metadataText };
    }

    // Draw Things XMP format detection
    if (metadataText.includes('"lang":"x-default"') && metadataText.includes('"value":')) {
      try {
        const xmpData = JSON.parse(metadataText);
        if (xmpData.value && typeof xmpData.value === 'string') {
          const innerJson = xmpData.value;
          if (innerJson.includes('"c":') && (innerJson.includes('"model":') || innerJson.includes('"sampler":') || innerJson.includes('"scale":'))) {
            return { parameters: 'Draw Things ' + innerJson, userComment: innerJson };
          }
        }
      } catch {
        // Not valid JSON, continue
      }
    }

    // A1111-style format detection
    if (metadataText.includes('Civitai resources:') && metadataText.includes('Steps:')) {
      return { parameters: metadataText };
    }
    if (metadataText.includes('Steps:') && metadataText.includes('Sampler:') && metadataText.includes('Model hash:')) {
      return { parameters: metadataText };
    }
    if (metadataText.includes('Prompt:') && metadataText.includes('Steps:') && metadataText.includes('Sampler:') && !metadataText.includes('Model hash:')) {
      return { parameters: metadataText };
    }

    // Midjourney
    if (metadataText.includes('--v') || metadataText.includes('--ar') || metadataText.includes('--q') || metadataText.includes('--s') || metadataText.includes('Midjourney')) {
      return { parameters: metadataText };
    }

    // Forge
    if ((metadataText.includes('Forge') || metadataText.includes('Gradio')) &&
        metadataText.includes('Steps:') && metadataText.includes('Sampler:') && metadataText.includes('Model hash:')) {
      return { parameters: metadataText };
    }

    // Draw Things (iOS/Mac)
    if (metadataText.includes('Guidance Scale:') && metadataText.includes('Steps:') && metadataText.includes('Sampler:') &&
        !metadataText.includes('Model hash:') && !metadataText.includes('Forge') && !metadataText.includes('Gradio') &&
        !metadataText.includes('DreamStudio') && !metadataText.includes('Stability AI') && !metadataText.includes('--niji')) {
      const userComment: string | undefined =
        typeof exifData.UserComment === 'string' && exifData.UserComment.includes('{')
          ? exifData.UserComment
          : undefined;
      return { parameters: metadataText, userComment };
    }

    // Try to parse as JSON for SwarmUI, InvokeAI, ComfyUI, DALL-E, etc.
    try {
      const parsedMetadata = JSON.parse(metadataText);

      const wrappedMetaHub = wrapMetaHubData(parsedMetadata);
      if (wrappedMetaHub) {
        return wrappedMetaHub;
      }

      if (parsedMetadata.c2pa_manifest ||
          (parsedMetadata.exif_data && (parsedMetadata.exif_data['openai:dalle'] ||
                                        parsedMetadata.exif_data.Software?.includes('DALL-E')))) {
        return parsedMetadata;
      }

      if (parsedMetadata.sui_image_params) {
        return parsedMetadata;
      }

      if (isInvokeAIMetadata(parsedMetadata)) {
        return parsedMetadata;
      } else if (isComfyUIMetadata(parsedMetadata)) {
        return parsedMetadata;
      } else {
        return parsedMetadata;
      }
    } catch {
      // JSON parsing failed - check for ComfyUI patterns in raw text
      if (metadataText.includes('"workflow"') || metadataText.includes('"prompt"') ||
          metadataText.includes('last_node_id') || metadataText.includes('class_type') ||
          metadataText.includes('Version: ComfyUI')) {
        try {
          const workflowMatch = metadataText.match(/"workflow"\s*:\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*")/);
          const promptMatch = metadataText.match(/"prompt"\s*:\s*(\{[^}]*\}|\[[^\]]*\]|"[^"]*")/);

          const comfyMetadata: Partial<ComfyUIMetadata> = {};

          if (workflowMatch) {
            try {
              comfyMetadata.workflow = JSON.parse(workflowMatch[1]);
            } catch {
              comfyMetadata.workflow = workflowMatch[1];
            }
          }

          if (promptMatch) {
            try {
              comfyMetadata.prompt = JSON.parse(promptMatch[1]);
            } catch {
              comfyMetadata.prompt = promptMatch[1];
            }
          }

          if (comfyMetadata.workflow || comfyMetadata.prompt) {
            return comfyMetadata;
          }

          if (metadataText.includes('Version: ComfyUI')) {
            return { parameters: metadataText };
          }
        } catch {
          // Silent error - pattern matching failed
        }
      }

      return null;
    }
  } catch (e) {
    console.error('[WebP DEBUG] Error in parseWebPMetadata:', e);
    return null;
  }
}

export function extractDimensionsFromBuffer(buffer: ArrayBuffer): { width: number; height: number } | null {
  const view = new DataView(buffer);
  const type = detectImageType(view);

  // PNG signature + IHDR
  if (type === 'png') {
    // IHDR chunk starts at byte 16, big-endian
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return null;
  }

  // JPEG SOF markers
  if (type === 'jpeg') {
    let offset = 2;
    const length = view.byteLength;
    while (offset < length) {
      if (view.getUint8(offset) !== 0xFF) {
        break;
      }
      const marker = view.getUint8(offset + 1);
      const size = view.getUint16(offset + 2, false);

      // SOF0 - SOF15 (except padding markers)
      if (marker >= 0xC0 && marker <= 0xC3 || marker >= 0xC5 && marker <= 0xC7 || marker >= 0xC9 && marker <= 0xCB || marker >= 0xCD && marker <= 0xCF) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width > 0 && height > 0) {
          return { width, height };
        }
        break;
      }

      // Prevent infinite loop
      if (size < 2) {
        break;
      }
      offset += 2 + size;
    }
    return null;
  }

  // WebP RIFF container
  if (type === 'webp') {
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
      const chunkType = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkDataOffset = offset + 8;
      const chunkDataEnd = chunkDataOffset + chunkSize;

      if (chunkDataEnd > view.byteLength) {
        break;
      }

      if (chunkType === 'VP8X' && chunkDataOffset + 10 <= view.byteLength) {
        const widthMinusOne = view.getUint8(chunkDataOffset + 4) |
          (view.getUint8(chunkDataOffset + 5) << 8) |
          (view.getUint8(chunkDataOffset + 6) << 16);
        const heightMinusOne = view.getUint8(chunkDataOffset + 7) |
          (view.getUint8(chunkDataOffset + 8) << 8) |
          (view.getUint8(chunkDataOffset + 9) << 16);
        return { width: widthMinusOne + 1, height: heightMinusOne + 1 };
      }

      if (chunkType === 'VP8 ' && chunkDataOffset + 10 <= view.byteLength) {
        const width = (view.getUint8(chunkDataOffset + 6) | (view.getUint8(chunkDataOffset + 7) << 8)) & 0x3FFF;
        const height = (view.getUint8(chunkDataOffset + 8) | (view.getUint8(chunkDataOffset + 9) << 8)) & 0x3FFF;
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }

      if (chunkType === 'VP8L' && chunkDataOffset + 5 <= view.byteLength) {
        const signature = view.getUint8(chunkDataOffset);
        if (signature === 0x2f) {
          const b1 = view.getUint8(chunkDataOffset + 1);
          const b2 = view.getUint8(chunkDataOffset + 2);
          const b3 = view.getUint8(chunkDataOffset + 3);
          const b4 = view.getUint8(chunkDataOffset + 4);
          const width = 1 + (b1 | ((b2 & 0x3F) << 8));
          const height = 1 + (((b2 & 0xC0) >> 6) | (b3 << 2) | ((b4 & 0x0F) << 10));
          if (width > 0 && height > 0) {
            return { width, height };
          }
        }
      }

      offset = chunkDataEnd + (chunkSize % 2);
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Worker-friendly entry point
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse image metadata from an ArrayBuffer.
 * Drop-in for the original parseImageMetadata() but works with raw buffers
 * instead of File objects — suitable for Web Worker use.
 */
export async function parseImageBuffer(
  buffer: ArrayBuffer,
): Promise<ImageMetadata | null> {
  const view = new DataView(buffer);
  const detectedType = detectImageType(view);

  if (detectedType === 'png') {
    return parsePNGMetadata(buffer);
  }
  if (detectedType === 'jpeg') {
    return parseJPEGMetadata(buffer);
  }
  if (detectedType === 'webp') {
    return parseWebPMetadata(buffer);
  }
  return null;
}
