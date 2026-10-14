/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { IncrementalCacheWriter, type CacheImageMetadata } from './cacheManager';

import { type IndexedImage, type ImageMetadata, type BaseMetadata, type VideoMetadata, type VideoInfo, isInvokeAIMetadata, isAutomatic1111Metadata, isComfyUIMetadata, isSwarmUIMetadata, isEasyDiffusionMetadata, isEasyDiffusionJson, isMidjourneyMetadata, isNijiMetadata, isForgeMetadata, isDalleMetadata, isFireflyMetadata, isDreamStudioMetadata, isDrawThingsMetadata, ComfyUIMetadata, InvokeAIMetadata, SwarmUIMetadata, EasyDiffusionMetadata, EasyDiffusionJson, MidjourneyMetadata, NijiMetadata, ForgeMetadata, DalleMetadata, FireflyMetadata, DrawThingsMetadata, FooocusMetadata } from '../types';
import exifr from 'exifr';
import { resolvePromptFromGraph, parseComfyUIMetadataEnhanced } from './parsers/comfyUIParser';
import { parseVideoMetaHubMetadata } from './parsers/videoMetaHubParser';
import { parseInvokeAIMetadata } from './parsers/invokeAIParser';
import { parseA1111Metadata } from './parsers/automatic1111Parser';
import { parseSwarmUIMetadata } from './parsers/swarmUIParser';
import { parseWebPMetadata, extractMp4MdtaTags, extractMp4Dimensions } from './parsers/binaryParsers';

// Simple throttle utility to avoid excessive progress updates
function throttle<T extends (...args: any[]) => any>(func: T, delay: number): T {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastCall = 0;

  return ((...args: any[]) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      func(...args);
    } else {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        lastCall = Date.now();
        func(...args);
      }, delay - (now - lastCall));
    }
  }) as T;
}

// Extended FileSystemFileHandle interface for Electron compatibility
interface ElectronFileHandle extends FileSystemFileHandle {
  _filePath?: string;
}

/**
 * One file on its way into the catalog. Exported because the caller can now
 * hand Phase A a *stream* of these (see `ProcessFilesOptions.fileStream`), so
 * the shape is part of the module's contract rather than an internal detail.
 */
export interface CatalogFileEntry {
  handle: FileSystemFileHandle;
  path: string;
  lastModified: number;
  size?: number;
  type?: string;
  birthtimeMs?: number;
}
import { parseEasyDiffusionMetadata, parseEasyDiffusionJson } from './parsers/easyDiffusionParser';
import { parseMidjourneyMetadata } from './parsers/midjourneyParser';
import { parseNijiMetadata } from './parsers/nijiParser';
import { parseForgeMetadata } from './parsers/forgeParser';
import { parseDalleMetadata } from './parsers/dalleParser';
import { parseFireflyMetadata } from './parsers/fireflyParser';
import { parseDreamStudioMetadata } from './parsers/dreamStudioParser';
import { parseDrawThingsMetadata } from './parsers/drawThingsParser';
import { parseFooocusMetadata } from './parsers/fooocusParser';
import { parseSDNextMetadata } from './parsers/sdNextParser';

function sanitizeJson(jsonString: string): string {
    // Replace NaN with null, as NaN is not valid JSON
    return jsonString.replace(/:\s*NaN/g, ': null');
}

// Electron detection for optimized batch reading
const isElectron = typeof window !== 'undefined' && (window as any).electronAPI;
const isProduction = Boolean(
  (typeof globalThis !== 'undefined' && (globalThis as any)?.process?.env?.NODE_ENV === 'production') ||
  (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.PROD)
);

// ── Metadata Worker Pool (lazy-initialized) ──────────────────────────
// Parses binary metadata off the main thread in parallel.
let _metadataPool: import('./metadataWorkerPool').MetadataWorkerPool | null = null;
let _metadataPoolInitFailed = false;

async function getMetadataPool(): Promise<import('./metadataWorkerPool').MetadataWorkerPool | null> {
  if (_metadataPool) return _metadataPool;
  if (_metadataPoolInitFailed) return null;
  try {
    const { MetadataWorkerPool } = await import('./metadataWorkerPool');
    if (!_metadataPool) {
      _metadataPool = new MetadataWorkerPool();
    }
    return _metadataPool;
  } catch {
    _metadataPoolInitFailed = true;
    return null;
  }
}
const shouldLogPngDebug = Boolean(
  (typeof globalThis !== 'undefined' && (globalThis as any)?.process?.env?.PNG_DEBUG === 'true') ||
  (typeof import.meta !== 'undefined' && (import.meta as any)?.env?.VITE_PNG_DEBUG)
);

// Helper function to chunk array into smaller arrays
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function detectImageType(view: DataView): 'png' | 'jpeg' | 'webp' | null {
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

function inferMimeTypeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.avi')) return 'video/x-msvideo';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mkv', '.mov', '.avi']);

function isVideoFileName(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of VIDEO_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

async function readVideoMetadataFromElectron(
  fileEntry: CatalogFileEntry
): Promise<{ rawMetadata: VideoMetadata | null; videoInfo?: VideoInfo | null }> {
  if (!isElectron || !(window as any).electronAPI?.readVideoMetadata) {
    return { rawMetadata: null };
  }

  const absolutePath = (fileEntry.handle as ElectronFileHandle)?._filePath;
  if (!absolutePath) {
    return { rawMetadata: null };
  }

  try {
    const result = await (window as any).electronAPI.readVideoMetadata({ filePath: absolutePath });
    if (!result?.success) {
      return { rawMetadata: null };
    }

    const rawMetadata: VideoMetadata = {
      description: result.description || '',
      comment: result.comment || '',
      title: result.title || '',
      // ComfyUI embeds workflow/prompt as video tags — pass them through so
      // the normal ComfyUI normalization below can resolve generation data.
      workflow: result.workflow || '',
      prompt: result.prompt || '',
      encoder: result.encoder || '',
    };

    let metaHubData: Record<string, any> | null = null;
    if (result.comment) {
      try {
        metaHubData = JSON.parse(result.comment);
      } catch {
        metaHubData = null;
      }
    }

    if (metaHubData) {
      rawMetadata.videometahub_data = metaHubData;
    }

    return { rawMetadata, videoInfo: result.video || null };
  } catch (error) {
    console.error('[FileIndexer] Failed to read video metadata:', error);
    return { rawMetadata: null };
  }
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

// Decode iTXt text payload (supports uncompressed and deflate-compressed)
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

/**
 * Attempts to read a sidecar JSON file for Easy Diffusion metadata
 * @param imagePath Path to the image file (e.g., /path/to/image.png)
 * @returns Parsed JSON metadata or null if not found/valid
 */
async function tryReadEasyDiffusionSidecarJson(imagePath: string, absolutePath?: string): Promise<EasyDiffusionJson | null> {
  try {
    const preferredPath = absolutePath && (absolutePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(absolutePath))
      ? absolutePath
      : imagePath;
    // Generate JSON path by replacing extension with .json
    const jsonPath = preferredPath.replace(/\.(png|jpg|jpeg|webp)$/i, '.json');
    
    // Check if path is absolute (has drive letter on Windows or starts with / on Unix)
    const isAbsolutePath = /^[a-zA-Z]:[\\/]/.test(jsonPath) || jsonPath.startsWith('/');
    
    if (!isElectron || !jsonPath || jsonPath === preferredPath || !isAbsolutePath) {
      return null; // Only works in Electron environment with absolute paths
    }

    // Try to read the JSON file (silent - no logging)
    const result = await (window as any).electronAPI.readFile(jsonPath);
    if (!result.success || !result.data) {
      return null;
    }

    // Parse the JSON
    const rawData = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data);
    const jsonText = new TextDecoder('utf-8').decode(rawData);
    const parsedJson = JSON.parse(jsonText);
    
    // Validate that it looks like Easy Diffusion JSON
    if (typeof parsedJson === 'object' && parsedJson) {
      const hasPrompt = 'prompt' in parsedJson && typeof parsedJson.prompt === 'string';
      const hasNegativePrompt = 'negative_prompt' in parsedJson && typeof parsedJson.negative_prompt === 'string';
      if (hasPrompt || hasNegativePrompt) {
        return parsedJson as EasyDiffusionJson;
      }
    }
    return null;
  } catch {
    // Silent error - most images won't have sidecar JSON
    return null;
  }
}

// Main parsing function for PNG files
async function parsePNGMetadata(buffer: ArrayBuffer): Promise<ImageMetadata | null> {
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
      
      if (['invokeai_metadata', 'parameters', 'workflow', 'prompt', 'description', 'imagemetahub_data'].includes(keyword.toLowerCase()) && text) {
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

      if (['invokeai_metadata', 'parameters', 'workflow', 'prompt', 'description', 'imagemetahub_data'].includes(keyword.toLowerCase())) {
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

// Main parsing function for JPEG files
async function parseJPEGMetadata(buffer: ArrayBuffer): Promise<ImageMetadata | null> {
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
// (parseWebPMetadata is imported from ./parsers/binaryParsers.ts)

// Extract dimensions without decoding the full image
function extractDimensionsFromBuffer(buffer: ArrayBuffer): { width: number; height: number } | null {
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

// Main image metadata parser
async function parseImageMetadata(file: File): Promise<{ metadata: ImageMetadata | null; buffer: ArrayBuffer }> {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  const detectedType = detectImageType(view);
  
  if (!isProduction) {
    console.log('[FILE DEBUG] Processing file:', {
      name: file.name,
      size: file.size,
      isPNG: detectedType === 'png',
      isJPEG: detectedType === 'jpeg',
      isWebP: detectedType === 'webp',
    });
  }
  
  if (detectedType === 'png') {
    const result = await parsePNGMetadata(buffer);
    if (!isProduction) {
      console.log('[FILE DEBUG] PNG metadata result:', {
        name: file.name,
        hasResult: !!result,
        resultType: result ? Object.keys(result)[0] : 'none',
      });
    }
    return { metadata: result, buffer };
  }
  if (detectedType === 'jpeg') {
    return { metadata: await parseJPEGMetadata(buffer), buffer };
  }
  if (detectedType === 'webp') {
    return { metadata: await parseWebPMetadata(buffer), buffer };
  }
  return { metadata: null, buffer };
}

const buildNormalizedMetadataFromMetaHubChunk = async (
  metaHubData: unknown,
  fallbackDims?: { width?: number; height?: number }
): Promise<BaseMetadata> => {
  const enhancedResult = await parseComfyUIMetadataEnhanced({ imagemetahub_data: metaHubData });
  const width = fallbackDims?.width ?? 0;
  const height = fallbackDims?.height ?? 0;

  return {
    prompt: enhancedResult.prompt || '',
    negativePrompt: enhancedResult.negativePrompt || '',
    model: enhancedResult.model || '',
    models: enhancedResult.model ? [enhancedResult.model] : [],
    width,
    height,
    seed: enhancedResult.seed,
    steps: enhancedResult.steps || 0,
    cfg_scale: enhancedResult.cfg,
    scheduler: enhancedResult.scheduler || '',
    sampler: enhancedResult.sampler_name || '',
    loras: enhancedResult.loras || [],
    tags: enhancedResult.tags || [],
    notes: enhancedResult.notes || '',
    vae: enhancedResult.vae,
    denoise: enhancedResult.denoise,
    _analytics: enhancedResult._analytics || null,
    _metahub_pro: enhancedResult._metahub_pro || null,
    _detection_method: enhancedResult._detection_method,
    generator: 'ComfyUI',
  };
};

/**
 * Processes a single file entry to extract metadata and create an IndexedImage object.
 * Optimized version that accepts pre-loaded file data to avoid redundant IPC calls.
 */
async function processSingleFileOptimized(
  fileEntry: CatalogFileEntry,
  directoryId: string,
  fileData?: ArrayBuffer,
  profile?: PhaseProfileSample
): Promise<IndexedImage | null> {
  try {
    const totalStart = profile ? performance.now() : 0;
    const parseStart = profile ? performance.now() : 0;
    let rawMetadata: ImageMetadata | null;
    let sidecarJson: EasyDiffusionJson | null = null;
    let bufferForDimensions: ArrayBuffer | undefined;
    let workerDims: { width: number; height: number } | null = null;
    let fileSizeValue: number | undefined = fileEntry.size;
    const inferredType = fileEntry.type ?? inferMimeTypeFromName(fileEntry.handle.name);
    const isVideo = isVideoFileName(fileEntry.handle.name) || inferredType.startsWith('video/');
    let videoInfo: VideoInfo | null = null;

    if (isVideo) {
      const videoResult = await readVideoMetadataFromElectron(fileEntry);
      rawMetadata = videoResult.rawMetadata;
      videoInfo = videoResult.videoInfo ?? null;

      // Dependency-free MP4 mdta extraction: ComfyUI save nodes write the
      // workflow/prompt as mdta tags (moov → udta → meta → keys/ilst).
      // ffprobe is optional and often absent (readVideoMetadataFromElectron
      // then returns null) — this walker runs on whatever bytes we already
      // have and the tags flow into the normal ComfyUI normalization below.
      //
      // `fileData` is either the head-read buffer (faststart MP4s keep moov
      // first, so that is enough) or, for everything else, the moov box that
      // the caller fetched by seek. There is deliberately no `getFile()`
      // fallback any more: reading a whole video into the renderer to find a
      // box the main process can seek straight to is what made a library of
      // large videos unopenable.
      const videoBytes: ArrayBuffer | undefined = fileData;
      if (videoBytes) {
        const mdtaTags = extractMp4MdtaTags(new Uint8Array(videoBytes));
        if (Object.keys(mdtaTags).length > 0) {
          rawMetadata = { ...(rawMetadata ?? {}), ...mdtaTags };
        }
        // MP4 dimensions live in moov→trak→tkhd. ffprobe (videoInfo) is
        // often absent, so parse them from the same bytes we already have —
        // otherwise width/height stay 0 and the modal can't show
        // resolution / megapixels / aspect ratio.
        const mp4Dims = extractMp4Dimensions(new Uint8Array(videoBytes));
        if (mp4Dims) {
          workerDims = mp4Dims;
        }
      }
    } else if (fileData) {
      // Try worker pool first for off-thread parsing
      const pool = await getMetadataPool();
      if (pool) {
        const result = await pool.parse(fileData, fileEntry.handle.name);
        rawMetadata = result.metadata;
        workerDims = result.dimensions; // Worker already extracted these
      } else {
        // Fallback: main-thread parsing
        const view = new DataView(fileData);
        const detectedType = detectImageType(view);
        if (detectedType === 'png') {
          rawMetadata = await parsePNGMetadata(fileData);
        } else if (detectedType === 'jpeg') {
          rawMetadata = await parseJPEGMetadata(fileData);
        } else if (detectedType === 'webp') {
          rawMetadata = await parseWebPMetadata(fileData);
        } else {
          rawMetadata = null;
        }
        bufferForDimensions = fileData;
      }
      fileSizeValue = fileSizeValue ?? fileData.byteLength;
    } else {
      // Fallback to individual file read (browser path)
      const file = await fileEntry.handle.getFile();
      const buffer = await file.arrayBuffer();
      const pool = await getMetadataPool();
      if (pool) {
        const result = await pool.parse(buffer, fileEntry.handle.name);
        rawMetadata = result.metadata;
        workerDims = result.dimensions; // Worker already extracted these
      } else {
        const detectedType = detectImageType(new DataView(buffer));
        if (detectedType === 'png') {
          rawMetadata = await parsePNGMetadata(buffer);
        } else if (detectedType === 'jpeg') {
          rawMetadata = await parseJPEGMetadata(buffer);
        } else if (detectedType === 'webp') {
          rawMetadata = await parseWebPMetadata(buffer);
        } else {
          rawMetadata = null;
        }
        bufferForDimensions = buffer;
      }
      fileSizeValue = fileSizeValue ?? file.size;
    }

    // Try to read sidecar JSON for Easy Diffusion (fallback if no embedded metadata)
    let absolutePath = (fileEntry.handle as ElectronFileHandle)?._filePath;
    if (!absolutePath && isElectron && (window as any).electronAPI?.joinPaths) {
      try {
        const joinResult = await (window as any).electronAPI.joinPaths(directoryId, fileEntry.path);
        if (joinResult?.success && joinResult.path) {
          absolutePath = joinResult.path;
        }
      } catch {
        // Ignore join failures and keep existing path.
      }
    }
    if (!rawMetadata) {
      sidecarJson = await tryReadEasyDiffusionSidecarJson(fileEntry.path, absolutePath);
      if (sidecarJson) {
        rawMetadata = sidecarJson;
      }
    }
    if (profile) {
      profile.parseMs = performance.now() - parseStart;
    }

    const normalizeStart = profile ? performance.now() : 0;

// ==============================================================================
// SUBSTITUA o bloco inteiro de parsing (linhas ~304-360) por este código:
// Comece a substituir em: let normalizedMetadata: BaseMetadata | undefined;
// Termine antes de: // Read actual image dimensions
// ==============================================================================

let normalizedMetadata: BaseMetadata | undefined;
if (rawMetadata) {

  // Priority 0: Check for MetaHub Save Node chunk (iTXt imagemetahub_data)
  // This has highest priority as it contains pre-extracted, validated metadata
  if ('imagemetahub_data' in rawMetadata) {
    try {
      const metaHubData = (rawMetadata as { imagemetahub_data: unknown }).imagemetahub_data;
      normalizedMetadata = await buildNormalizedMetadataFromMetaHubChunk(metaHubData);
    } catch (e) {
      console.error('[FileIndexer] Failed to parse MetaHub chunk:', e);
      // Fall through to other parsers
    }
  }

  // Priority 0.5: MetaHub Save Video metadata (container comment JSON)
  if (!normalizedMetadata && 'videometahub_data' in rawMetadata) {
    normalizedMetadata = parseVideoMetaHubMetadata(rawMetadata) ?? undefined;
  }

  // Priority 1: Check for text-based formats (A1111, Forge, Fooocus all use 'parameters' string)
  if (!normalizedMetadata && 'parameters' in rawMetadata && typeof rawMetadata.parameters === 'string') {
    const params = rawMetadata.parameters;
    
    // Sub-priority 2.0: Check if parameters contains SwarmUI JSON format
    // SwarmUI can save metadata as JSON string in parameters field
    if (params.trim().startsWith('{') && params.includes('sui_image_params')) {
      try {
        const parsedParams = JSON.parse(params);
        if (parsedParams.sui_image_params) {
          normalizedMetadata = parseSwarmUIMetadata(parsedParams as SwarmUIMetadata);
        }
      } catch {
        // Not valid SwarmUI JSON, continue with other checks
      }
    }
    
    // Sub-priority 2.1: SD.Next (has "App: SD.Next" indicator)
    if (!normalizedMetadata && params.includes('App: SD.Next')) {
      normalizedMetadata = parseSDNextMetadata(params);
    }
    
    // Sub-priority 2.2: Forge (most specific - has Model hash + Forge/Gradio OR Forge version pattern)
    // Forge versions follow pattern: f2.0.1, f1.10.0, etc.
    else if (!normalizedMetadata &&
        (params.includes('Forge') || params.includes('Gradio') || /Version:\s*f\d+\./i.test(params)) &&
        params.includes('Steps:') && params.includes('Sampler:') && params.includes('Model hash:')) {
      normalizedMetadata = parseForgeMetadata(rawMetadata);
    }
    
    // Sub-priority 2.3: Fooocus (specific indicators but NO Model hash)
    // CRITICAL: Must check for absence of Model hash to avoid capturing Forge/A1111
    else if (!normalizedMetadata && (params.includes('Fooocus') || 
             (params.includes('Sharpness:') && !params.includes('Model hash:')))) {
      normalizedMetadata = parseFooocusMetadata(rawMetadata as FooocusMetadata);
    }
    
    // Sub-priority 2.4: A1111/ComfyUI hybrid (has Model hash or Version indicators, or Civitai resources)
    // This catches: standard A1111, ComfyUI with A1111 format, and A1111 with Civitai resources
    // NOTE: Forge versions (f2.0.1, etc.) are now handled by Forge parser above
    else if (!normalizedMetadata && (params.includes('Model hash:') ||
             params.includes('Version: ComfyUI') ||
             params.includes('Distilled CFG Scale') ||
             /Module\s*\d+:/i.test(params) ||
             params.includes('Civitai resources:'))) {
      normalizedMetadata = parseA1111Metadata(params);
    }
    
    // Sub-priority 2.5: Other parameter-based formats
    else if (!normalizedMetadata && (params.includes('DreamStudio') || params.includes('Stability AI'))) {
      normalizedMetadata = parseDreamStudioMetadata(params);
    }
    else if (!normalizedMetadata && (params.includes('iPhone') || params.includes('iPad') || params.includes('Draw Things')) &&
             !params.includes('Model hash:')) {
      const userComment = 'userComment' in rawMetadata ? String(rawMetadata.userComment) : undefined;
      normalizedMetadata = parseDrawThingsMetadata(params, userComment);
    }
    else if (!normalizedMetadata && params.includes('--niji')) {
      normalizedMetadata = parseNijiMetadata(params);
    }
    else if (!normalizedMetadata && (params.includes('--v') || params.includes('--ar') || params.includes('Midjourney'))) {
      normalizedMetadata = parseMidjourneyMetadata(params);
    }
    else if (!normalizedMetadata && params.includes('Prompt:') && params.includes('Steps:')) {
      // Generic SD-like format - try Easy Diffusion
      normalizedMetadata = parseEasyDiffusionMetadata(params);
    }
    else if (!normalizedMetadata) {
      // Fallback: Try A1111 parser for any other parameter string
      normalizedMetadata = parseA1111Metadata(params);
    }
  }
  
  // Priority 2: Check for ComfyUI (has unique 'workflow' structure)
  if (!normalizedMetadata && isComfyUIMetadata(rawMetadata)) {
    const comfyMetadata = rawMetadata as ComfyUIMetadata;
    let workflow = comfyMetadata.workflow;
    let prompt = comfyMetadata.prompt;
    try {
      if (typeof workflow === 'string') {
        workflow = JSON.parse(sanitizeJson(workflow));
      }
      if (typeof prompt === 'string') {
        prompt = JSON.parse(sanitizeJson(prompt));
      }
    } catch (e) {
      // console.error("Failed to parse ComfyUI workflow/prompt JSON:", e);
    }
    const resolvedParams = resolvePromptFromGraph(workflow, prompt);
    normalizedMetadata = {
      prompt: resolvedParams.prompt || '',
      negativePrompt: resolvedParams.negativePrompt || '',
      model: resolvedParams.model || '',
      models: resolvedParams.model ? [resolvedParams.model] : [],
      width: 0,
      height: 0,
      seed: resolvedParams.seed,
      steps: resolvedParams.steps || 0,
      cfg_scale: resolvedParams.cfg,
      scheduler: resolvedParams.scheduler || '',
      sampler: resolvedParams.sampler_name || '',
      loras: Array.isArray(resolvedParams.lora) ? resolvedParams.lora : (resolvedParams.lora ? [resolvedParams.lora] : []),
      vae: resolvedParams.vae || resolvedParams.vaes?.[0]?.name,
      denoise: resolvedParams.denoise,
    };
  }

  // Priority 2.5: ComfyUI API prompt-only data (no workflow chunk)
  // Some ComfyUI exports only embed the API prompt JSON in the "prompt"
  // text chunk — without a separate "workflow" chunk. Detect this by
  // checking whether the prompt value looks like ComfyUI node data.
  if (!normalizedMetadata && !('workflow' in rawMetadata) && 'prompt' in rawMetadata) {
    const promptVal = (rawMetadata as any).prompt;
    if (typeof promptVal === 'string' &&
        promptVal.includes('"class_type"') &&
        promptVal.includes('"inputs"')) {
      try {
        const promptObj = JSON.parse(promptVal);
        const resolvedParams = resolvePromptFromGraph(undefined, promptObj);
        normalizedMetadata = {
          prompt: resolvedParams.prompt || '',
          negativePrompt: resolvedParams.negativePrompt || '',
          model: resolvedParams.model || '',
          models: resolvedParams.model ? [resolvedParams.model] : [],
          width: 0,
          height: 0,
          seed: resolvedParams.seed,
          steps: resolvedParams.steps || 0,
          cfg_scale: resolvedParams.cfg,
          scheduler: resolvedParams.scheduler || '',
          sampler: resolvedParams.sampler_name || '',
          loras: Array.isArray(resolvedParams.lora) ? resolvedParams.lora : (resolvedParams.lora ? [resolvedParams.lora] : []),
          vae: resolvedParams.vae || resolvedParams.vaes?.[0]?.name,
          denoise: resolvedParams.denoise,
        };
      } catch (e) {
        console.error('[FileIndexer] Failed to parse ComfyUI prompt-only JSON:', e);
      }
    }
  }

  // Priority 3: SwarmUI (has unique 'sui_image_params' structure)
  if (!normalizedMetadata && isSwarmUIMetadata(rawMetadata)) {
    normalizedMetadata = parseSwarmUIMetadata(rawMetadata as SwarmUIMetadata);
  }
  
  // Priority 4: Easy Diffusion JSON (simple JSON with 'prompt' field)
  if (!normalizedMetadata && isEasyDiffusionJson(rawMetadata)) {
    normalizedMetadata = parseEasyDiffusionJson(rawMetadata as EasyDiffusionJson);
  }
  
  // Priority 5: DALL-E (has C2PA manifest)
  if (!normalizedMetadata && isDalleMetadata(rawMetadata)) {
    normalizedMetadata = parseDalleMetadata(rawMetadata);
  }
  
  // Priority 6: Firefly (has C2PA with Adobe signatures)
  if (!normalizedMetadata && isFireflyMetadata(rawMetadata)) {
    normalizedMetadata = parseFireflyMetadata(rawMetadata, fileData!);
  }
  
  // Priority 7: InvokeAI (fallback for remaining metadata)
  if (!normalizedMetadata && isInvokeAIMetadata(rawMetadata)) {
    normalizedMetadata = parseInvokeAIMetadata(rawMetadata as InvokeAIMetadata);
  }
  
  // Priority 8: Unknown format
  if (!normalizedMetadata) {
    // Unknown metadata format, no parser applied
  }
}

  if (!normalizedMetadata && isVideo && videoInfo) {
    normalizedMetadata = {
      prompt: '',
      model: '',
      width: videoInfo.width ?? 0,
      height: videoInfo.height ?? 0,
      steps: 0,
      scheduler: '',
      media_type: 'video',
      video: videoInfo,
    };
  }

  // If we still couldn't normalize, try sidecar JSON as a final fallback.
  if (!normalizedMetadata) {
    if (!sidecarJson) {
      sidecarJson = await tryReadEasyDiffusionSidecarJson(fileEntry.path, absolutePath);
    }
    if (sidecarJson) {
      rawMetadata = sidecarJson;
      normalizedMetadata = parseEasyDiffusionJson(sidecarJson);
    }
  }

// ==============================================================================
// FIM DA SUBSTITUIÇÃO - O código seguinte (Read actual image dimensions) 
// deve permanecer como está
// ==============================================================================
    if (profile) {
      profile.normalizeMs = performance.now() - normalizeStart;
    }
    const fallbackType = inferMimeTypeFromName(fileEntry.handle.name);
    const normalizedFileType = inferredType ?? fallbackType;
    const normalizedFileSize = fileSizeValue ?? 0;

    // Read actual image dimensions — ffprobe (videoInfo) is authoritative for
    // videos, then worker result, then extracting from the (non-detached)
    // buffer. ffprobe dims must win even when the ComfyUI mdta path already
    // produced normalizedMetadata: for videos it knows rotation-aware
    // display dimensions, which the tkhd fallback can't correct.
    const dimensionsStart = profile ? performance.now() : 0;
    const dims =
      videoInfo?.width && videoInfo?.height
        ? { width: videoInfo.width, height: videoInfo.height }
        : workerDims ?? (bufferForDimensions ? extractDimensionsFromBuffer(bufferForDimensions) : null);
    if (dims) {
      if (!normalizedMetadata) {
          normalizedMetadata = {
              prompt: '',
              model: '',
              width: dims.width,
              height: dims.height,
              steps: 0,
              scheduler: ''
          } as BaseMetadata;
      } else if (videoInfo?.width && videoInfo?.height) {
          // For videos, ffprobe's ACTUAL encoded dimensions are the
          // authoritative file parameters — override generation-parameter
          // dims (e.g. metahub) which can drift from the real encode after
          // a resize/re-encode.
          normalizedMetadata.width = dims.width;
          normalizedMetadata.height = dims.height;
      } else {
          normalizedMetadata.width = normalizedMetadata.width || dims.width;
          normalizedMetadata.height = normalizedMetadata.height || dims.height;
      }
    }
    if (profile) {
      profile.dimensionsMs = performance.now() - dimensionsStart;
    }

    // Determine the best date for sorting (generation date vs file date)
    const sortDate = fileEntry.birthtimeMs ?? fileEntry.lastModified ?? Date.now();

    if (profile) {
      profile.totalMs = performance.now() - totalStart;
    }

    return {
      id: `${directoryId}::${fileEntry.path}`,
      name: fileEntry.handle.name,
      handle: fileEntry.handle,
      thumbnailStatus: 'pending',
      thumbnailError: null,
      directoryId,
      metadata: normalizedMetadata ? { normalizedMetadata } : {}, // OPTIMIZED: Drop heavy rawMetadata to save memory
      metadataString: '', // OPTIMIZED: Drop redundant metadataString to save memory
      lastModified: sortDate, // Use the determined sort date
      models: normalizedMetadata?.models || [],
      loras: normalizedMetadata?.loras || [],
      scheduler: normalizedMetadata?.scheduler || '',
      board: normalizedMetadata?.board || '',
      prompt: normalizedMetadata?.prompt || '',
      negativePrompt: normalizedMetadata?.negativePrompt || '',
      cfgScale: normalizedMetadata?.cfgScale || normalizedMetadata?.cfg_scale || null,
      steps: normalizedMetadata?.steps || null,
      seed: normalizedMetadata?.seed || null,
      dimensions: normalizedMetadata?.dimensions || `${normalizedMetadata?.width || 0}x${normalizedMetadata?.height || 0}`,
      fileSize: normalizedFileSize,
      fileType: normalizedFileType,
    } as IndexedImage;
  } catch (error) {
    console.error(`Skipping file ${fileEntry.handle.name} due to an error:`, error);
    return null;
  }
}

/**
 * Processes an array of file entries in batches to avoid blocking the main thread.
 * Invokes a callback with each batch of processed images.
 * OPTIMIZED: Uses batch file reading in Electron to reduce IPC overhead.
 */
interface CatalogEntryState {
  image: IndexedImage;
  chunkIndex: number;
  chunkOffset: number;
  needsEnrichment: boolean;
  source?: CatalogFileEntry;
}

interface PhaseTelemetry {
  startTime: number;
  processed: number;
  bytesWritten: number;
  ipcCalls: number;
  diskWrites: number;
  flushMs: number;
  flushChunks: number;
  headReadMs: number;
  headReadFiles: number;
  tailReadMs: number;
  tailReadFiles: number;
  tailReadHits: number;
  moovReadMs: number;
  moovReadFiles: number;
  fullReadMs: number;
  fullReadFiles: number;
  profileSamples: number;
  profileTotalMs: number;
  profileParseMs: number;
  profileNormalizeMs: number;
  profileDimensionsMs: number;
}

interface PhaseProfileSample {
  totalMs: number;
  parseMs: number;
  normalizeMs: number;
  dimensionsMs: number;
}

interface ProcessFilesOptions {
  cacheWriter?: IncrementalCacheWriter | null;
  concurrency?: number;
  flushChunkSize?: number;
  preloadedImages?: IndexedImage[];
  fileStats?: Map<string, { size?: number; type?: string; birthtimeMs?: number }>;
  onEnrichmentBatch?: (batch: IndexedImage[]) => void;
  enrichmentBatchSize?: number;
  onEnrichmentProgress?: (progress: { processed: number; total: number; message?: string } | null) => void;
  hydratePreloadedImages?: boolean;
  /**
   * Catalog entries as an async stream instead of a finished array.
   *
   * Phase A is a per-file pass with no lookahead — each entry is turned into a
   * stub and registered — so nothing about it needs the whole list. Handing it
   * a stream lets the directory walk and the indexing interleave, which is what
   * puts images on screen while a large folder is still being read rather than
   * minutes later. When omitted, `fileEntries` is processed as one batch, which
   * is byte-for-byte the previous behaviour.
   */
  fileStream?: AsyncIterable<CatalogFileEntry[]>;
  /**
   * Live total when the true one is not known up front (a streamed scan).
   * Returns how many files have been discovered so far; progress is then
   * reported against what is known rather than against a number nobody has.
   */
  liveTotal?: () => number;
}

export interface ProcessFilesResult {
  phaseB: Promise<void>;
}

function mapIndexedImageToCache(image: IndexedImage): CacheImageMetadata {
  return {
    id: image.id,
    name: image.name,
    metadataString: image.metadataString,
    metadata: image.metadata,
    lastModified: image.lastModified,
    models: image.models,
    loras: image.loras,
    scheduler: image.scheduler,
    board: image.board,
    prompt: image.prompt,
    negativePrompt: image.negativePrompt,
    cfgScale: image.cfgScale,
    steps: image.steps,
    seed: image.seed,
    dimensions: image.dimensions,
    enrichmentState: image.enrichmentState,
    fileSize: image.fileSize,
    fileType: image.fileType,
    // Removed: clusterId, clusterPosition
  };
}

export async function processFiles(
  fileEntries: CatalogFileEntry[],
  setProgress: (progress: { current: number; total: number; message?: string }) => void,
  onBatchProcessed: (batch: IndexedImage[]) => void,
  directoryId: string,
  directoryName: string,
  scanSubfolders: boolean,
  _onDeletion: (deletedFileIds: string[]) => void,
  abortSignal?: AbortSignal,
  waitWhilePaused?: () => Promise<void>,
  options: ProcessFilesOptions = {}
): Promise<ProcessFilesResult> {
  if (abortSignal?.aborted) {
    return { phaseB: Promise.resolve() };
  }

  const cacheWriter = options.cacheWriter ?? null;
  const chunkThreshold = options.flushChunkSize ?? cacheWriter?.targetChunkSize ?? 512;
  const concurrencyLimit = options.concurrency ?? 4;
  const enrichmentBatchSize = options.enrichmentBatchSize ?? 384;
  const statsLookup = options.fileStats ?? new Map<string, { size?: number; type?: string; birthtimeMs?: number }>();

  const phaseAStats: PhaseTelemetry = {
    startTime: performance.now(),
    processed: 0,
    bytesWritten: 0,
    ipcCalls: 0,
    diskWrites: 0,
    flushMs: 0,
    flushChunks: 0,
    headReadMs: 0,
    headReadFiles: 0,
    tailReadMs: 0,
    tailReadFiles: 0,
    tailReadHits: 0,
    moovReadMs: 0,
    moovReadFiles: 0,
    fullReadMs: 0,
    fullReadFiles: 0,
    profileSamples: 0,
    profileTotalMs: 0,
    profileParseMs: 0,
    profileNormalizeMs: 0,
    profileDimensionsMs: 0,
  };
  const phaseBStats: PhaseTelemetry = {
    startTime: 0,
    processed: 0,
    bytesWritten: 0,
    ipcCalls: 0,
    diskWrites: 0,
    flushMs: 0,
    flushChunks: 0,
    headReadMs: 0,
    headReadFiles: 0,
    tailReadMs: 0,
    tailReadFiles: 0,
    tailReadHits: 0,
    moovReadMs: 0,
    moovReadFiles: 0,
    fullReadMs: 0,
    fullReadFiles: 0,
    profileSamples: 0,
    profileTotalMs: 0,
    profileParseMs: 0,
    profileNormalizeMs: 0,
    profileDimensionsMs: 0,
  };

  performance.mark('indexing:phaseA:start');

  const catalogState = new Map<string, CatalogEntryState>();
  const chunkRecords: CacheImageMetadata[][] = [];
  const chunkMap = new Map<string, { chunkIndex: number; offset: number }>();
  const enrichmentQueue: CatalogEntryState[] = [];
  const chunkBuffer: IndexedImage[] = [];
  const uiBatch: IndexedImage[] = [];
  const BATCH_SIZE = 50;
  const MAX_CACHE_CHUNK_BYTES = 8_000_000;
  const CACHE_CHUNK_OVERHEAD_BYTES = 512;
  const totalPhaseAFiles = (options.preloadedImages?.length ?? 0) + fileEntries.length;
  const totalNewFiles = fileEntries.length;
  let processedNew = 0;
  let nextPhaseALog = 5000;

  /**
   * Files Phase A will report against. A finished array knows its own length; a
   * streamed scan does not, so the stream tells us how many files have been
   * discovered so far. The percentage then describes what is known rather than
   * a total nobody has — and it is never zero once a file has been registered,
   * because a file cannot be processed before it has been found.
   */
  const getTotal = () => options.liveTotal?.() ?? totalNewFiles;

  const pushUiBatch = async (force = false) => {
    if (uiBatch.length === 0) {
      return;
    }
    if (!force && uiBatch.length < BATCH_SIZE) {
      return;
    }
    onBatchProcessed([...uiBatch]);
    uiBatch.length = 0;
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  const flushChunk = async (force = false) => {
    if (chunkBuffer.length === 0) {
      return;
    }
    if (!force && chunkBuffer.length < chunkThreshold) {
      return;
    }

    const pendingImages = chunkBuffer.splice(0, chunkBuffer.length);
    let cursor = 0;

    const estimateEntryBytes = (entry: CacheImageMetadata): number => {
      const metadataLength = entry.metadataString ? entry.metadataString.length : 0;
      if (metadataLength > 0) {
        return metadataLength + CACHE_CHUNK_OVERHEAD_BYTES;
      }
      try {
        return JSON.stringify(entry).length + CACHE_CHUNK_OVERHEAD_BYTES;
      } catch {
        return CACHE_CHUNK_OVERHEAD_BYTES;
      }
    };

    const buildSizeCappedEntry = (image: IndexedImage, entryBytes: number): CacheImageMetadata => {
      const cacheEntry = mapIndexedImageToCache(image);
      if (entryBytes <= MAX_CACHE_CHUNK_BYTES) {
        return cacheEntry;
      }

      const normalizedMetadata = image.metadata?.normalizedMetadata;
      const safeMetadata = normalizedMetadata ? { normalizedMetadata } : {};
      const safeMetadataString = normalizedMetadata ? JSON.stringify(safeMetadata) : '';

      console.warn(
        '[indexing] Oversized cache entry detected, using stubbed metadata for IPC:',
        image.name,
        `(${entryBytes} bytes)`
      );

      return {
        ...cacheEntry,
        metadata: safeMetadata,
        metadataString: safeMetadataString,
      };
    };

    while (cursor < pendingImages.length) {
      const chunkImages: IndexedImage[] = [];
      let metadataChunk: CacheImageMetadata[] = [];
      let estimatedBytes = 0;

      while (cursor < pendingImages.length) {
        const candidate = pendingImages[cursor];
        const rawEntry = mapIndexedImageToCache(candidate);
        const entryBytes = estimateEntryBytes(rawEntry);
        const cacheEntry = buildSizeCappedEntry(candidate, entryBytes);
        const finalEntryBytes = estimateEntryBytes(cacheEntry);

        if (chunkImages.length > 0) {
          if (chunkImages.length >= chunkThreshold) {
            break;
          }
          if (estimatedBytes + finalEntryBytes > MAX_CACHE_CHUNK_BYTES) {
            break;
          }
        }

        chunkImages.push(candidate);
        metadataChunk.push(cacheEntry);
        estimatedBytes += finalEntryBytes;
        cursor += 1;
      }

      if (chunkImages.length === 0 && cursor < pendingImages.length) {
        const candidate = pendingImages[cursor];
        const rawEntry = mapIndexedImageToCache(candidate);
        const entryBytes = estimateEntryBytes(rawEntry);
        const cacheEntry = buildSizeCappedEntry(candidate, entryBytes);
        chunkImages.push(candidate);
        metadataChunk.push(cacheEntry);
        estimatedBytes = estimateEntryBytes(cacheEntry);
        cursor += 1;
      }

      const chunkIndex = chunkRecords.length;

      if (cacheWriter) {
        const flushStart = performance.now();
        const writtenChunk = await cacheWriter.append(chunkImages, metadataChunk);
        metadataChunk = writtenChunk;
        const duration = performance.now() - flushStart;
        const bytesWritten = JSON.stringify(writtenChunk).length;
        phaseAStats.bytesWritten += bytesWritten;
        phaseAStats.diskWrites += 1;
        phaseAStats.ipcCalls += 1;
        performance.mark('indexing:phaseA:chunk-flush', {
          detail: { chunkIndex, durationMs: duration, bytesWritten }
        });
      }

      chunkRecords.push(metadataChunk);

      chunkImages.forEach((img, offset) => {
        chunkMap.set(img.id, { chunkIndex, offset });
        const entry = catalogState.get(img.id);
        if (entry) {
          entry.chunkIndex = chunkIndex;
          entry.chunkOffset = offset;
        }
      });
    }
  };

  const maybeLogPhaseA = () => {
    if (phaseAStats.processed === 0) {
      return;
    }
    if (phaseAStats.processed >= nextPhaseALog || phaseAStats.processed === totalPhaseAFiles) {
      nextPhaseALog += 5000;
    }
  };

  const registerCatalogImage = async (
    image: IndexedImage,
    source: CatalogFileEntry | undefined,
    needsEnrichment: boolean,
    countTowardsProgress: boolean,
    emitToUi: boolean = true
  ) => {
    if (abortSignal?.aborted) {
      return;
    }

    const entry: CatalogEntryState = {
      image,
      chunkIndex: -1,
      chunkOffset: -1,
      needsEnrichment,
      source,
    };
    catalogState.set(image.id, entry);

    if (needsEnrichment && source) {
      enrichmentQueue.push(entry);
    }

    if (emitToUi) {
      uiBatch.push(image);
    }
    chunkBuffer.push(image);

    phaseAStats.processed += 1;
    maybeLogPhaseA();

    if (countTowardsProgress) {
      processedNew += 1;
      setProgress({ current: processedNew, total: getTotal(), message: image.name });
    }

    if (emitToUi) {
      await pushUiBatch();
    }
    await flushChunk();
  };

  const buildCatalogStub = (
    entry: CatalogFileEntry,
    needsEnrichment: boolean
  ): IndexedImage => {
    const stat = statsLookup.get(entry.path);
    const fileSize = entry.size ?? stat?.size;
    const inferredType = entry.type ?? stat?.type ?? inferMimeTypeFromName(entry.handle.name);
    const sortDate = entry.birthtimeMs ?? stat?.birthtimeMs ?? entry.lastModified;
    const catalogMetadata = {
      phase: 'catalog',
      fileSize,
      fileType: inferredType,
      lastModified: sortDate,
    } as any;

    const metadataString = JSON.stringify({
      phase: 'catalog',
      fileSize,
      fileType: inferredType,
      lastModified: sortDate,
    });

    return {
      id: `${directoryId}::${entry.path}`,
      name: entry.handle.name,
      handle: entry.handle,
      thumbnailStatus: 'pending',
      thumbnailError: null,
      directoryId,
      directoryName,
      metadata: catalogMetadata,
      metadataString,
      lastModified: sortDate,
      models: [],
      loras: [],
      scheduler: '',
      board: undefined,
      prompt: undefined,
      negativePrompt: undefined,
      cfgScale: undefined,
      steps: undefined,
      seed: undefined,
      dimensions: undefined,
      enrichmentState: needsEnrichment ? 'catalog' : 'enriched',
      fileSize,
      fileType: inferredType,
    };
  };

  // Phase A: load any cached images first so they are part of the catalog output
  const preloadedImages = options.preloadedImages ?? [];
  const hydratePreloadedImages = options.hydratePreloadedImages ?? true;
  for (const image of preloadedImages) {
    const stub = {
      ...image,
      directoryId,
      directoryName,
      enrichmentState: image.enrichmentState ?? 'enriched',
      fileSize: image.fileSize ?? statsLookup.get(image.name)?.size,
      fileType: image.fileType ?? statsLookup.get(image.name)?.type,
    } as IndexedImage;
    await registerCatalogImage(stub, undefined, false, false, hydratePreloadedImages);
  }

  if (preloadedImages.length > 0) {
    await flushChunk(true);
    await pushUiBatch(true);
  }

  const imageFiles = fileEntries.filter(entry => /\.(png|jpg|jpeg|webp|mp4|webm|mkv|mov|avi)$/i.test(entry.handle.name));

  const asyncPool = async <T, R>(
    concurrency: number,
    iterable: T[],
    iteratorFn: (item: T) => Promise<R>
  ): Promise<R[]> => {
    const ret: Promise<R>[] = [];
    const executing = new Set<Promise<R>>();

    for (const item of iterable) {
      if (abortSignal?.aborted) {
        break;
      }

      const p = Promise.resolve().then(() => iteratorFn(item));
      ret.push(p);
      executing.add(p);
      const clean = () => executing.delete(p);
      p.then(clean).catch(clean);
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    return Promise.all(ret);
  };

  const useOptimizedPath = isElectron && (window as any).electronAPI?.readFilesBatch;
  const useHeadRead = isElectron && (window as any).electronAPI?.readFilesHeadBatch;
  const useTailRead = isElectron && (window as any).electronAPI?.readFilesTailBatch;
  const FILE_READ_BATCH_SIZE = 64; // Reduced from 128 to avoid IPC clogging
  const HEAD_READ_MAX_BYTES = 64 * 1024; // Reduced from 256KB to 64KB
  const TAIL_READ_MAX_BYTES = 512 * 1024;
  const TAIL_SCAN_SAMPLE_LIMIT = 256;
  let tailScanAttempts = 0;
  let tailScanHits = 0;
  let tailScanEnabled = true;

  const processEnrichmentResult = (entry: CatalogEntryState, enriched: IndexedImage | null) => {
    if (!enriched) {
      return null;
    }

    const merged: IndexedImage = {
      ...entry.image,
      metadata: enriched.metadata,
      metadataString: enriched.metadataString,
      lastModified: enriched.lastModified,
      models: enriched.models,
      loras: enriched.loras,
      scheduler: enriched.scheduler,
      board: enriched.board,
      prompt: enriched.prompt,
      negativePrompt: enriched.negativePrompt,
      cfgScale: enriched.cfgScale,
      steps: enriched.steps,
      seed: enriched.seed,
      dimensions: enriched.dimensions,
      enrichmentState: 'enriched',
    };

    entry.image = merged;
    const loc = chunkMap.get(merged.id);
    if (loc) {
      const cacheRecord = chunkRecords[loc.chunkIndex][loc.offset];
      Object.assign(cacheRecord, mapIndexedImageToCache(merged));
    }

    return merged;
  };

  // Phase A: the catalog pass. `fileStream` lets the walk and the indexing
  // interleave — stubs reach the UI while the directory is still being read —
  // which is the difference between a large library appearing *during* its
  // first scan and appearing only after it.
  // `for await` takes a plain iterable of batches just as happily as a stream,
  // so the collected path needs no wrapper — one element, the whole listing.
  const fileStream: AsyncIterable<CatalogFileEntry[]> | CatalogFileEntry[][] =
    options.fileStream ?? [imageFiles];

  phaseA: for await (const streamBatch of fileStream) {
    for (const entry of streamBatch) {
      if (abortSignal?.aborted) {
        break phaseA;
      }

      if (waitWhilePaused) {
        await waitWhilePaused();
        if (abortSignal?.aborted) {
          break phaseA;
        }
      }

      const stub = buildCatalogStub(entry, true);
      await registerCatalogImage(stub, entry, true, true);
    }
  }

  await flushChunk(true);
  await pushUiBatch(true);

  /**
   * Files Phase A actually handled — the honest denominator for the
   * per-thousand-file invariants below.
   *
   * A streamed scan never materialises an array, so `totalPhaseAFiles` is 0
   * there and those checks would be skipped precisely where the file counts are
   * highest. `max` rather than `phaseAStats.processed` alone keeps the array
   * path byte-identical when an abort cut the loop short: the total stays the
   * denominator instead of collapsing to the handful that were processed.
   */
  const phaseADenominator = Math.max(totalPhaseAFiles, phaseAStats.processed);

  if (cacheWriter) {
    const finalizeStart = performance.now();
    // Await finalize with a timeout — ensures the cache is usually consistent
    // (new images persisted) while never blocking the progress bar indefinitely.
    // On the rare occasion the IPC hangs, we time out after 15 s; the cache
    // will self-heal on the next load via validateCacheAndGetDiff.
    const CACHE_FINALIZE_TIMEOUT_MS = 15_000;
    try {
      await Promise.race([
        cacheWriter.finalize(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Cache finalize timed out')), CACHE_FINALIZE_TIMEOUT_MS)
        ),
      ]);
      const finalizeDuration = performance.now() - finalizeStart;
      const bytesWritten = JSON.stringify({
        id: `${directoryId}-${scanSubfolders ? 'recursive' : 'flat'}`,
        imageCount: phaseADenominator,
      }).length;
      phaseAStats.bytesWritten += bytesWritten;
      phaseAStats.diskWrites += 1;
      phaseAStats.ipcCalls += 1;
      performance.mark('indexing:phaseA:finalize', { detail: { durationMs: finalizeDuration, bytesWritten } });
    } catch (err) {
      console.warn('[indexing] Cache finalize failed or timed out (cache will self-heal on next load):', err?.message || err);
    }
  }

  performance.mark('indexing:phaseA:complete', {
    detail: { elapsedMs: performance.now() - phaseAStats.startTime, files: phaseAStats.processed }
  });

  const finalTotal = getTotal();
  if (finalTotal > 0) {
    setProgress({ current: finalTotal, total: finalTotal });
  }

  const ipcPerThousand = phaseADenominator > 0 ? (phaseAStats.ipcCalls / phaseADenominator) * 1000 : 0;
  performance.mark('indexing:phaseA:ipc-per-1k', { detail: { value: ipcPerThousand } });
  const writesPerThousand = phaseADenominator > 0 ? (phaseAStats.diskWrites / phaseADenominator) * 1000 : 0;

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production' && phaseADenominator > 0) {
    if (ipcPerThousand > 10) {
      throw new Error(`Phase A IPC calls per 1k files exceeded limit: ${ipcPerThousand.toFixed(2)}`);
    }
    if (writesPerThousand > 5) {
      throw new Error(`Phase A disk writes per 1k files exceeded limit: ${writesPerThousand.toFixed(2)}`);
    }
  }

  const needsEnrichment = enrichmentQueue.filter(entry => entry.needsEnrichment && entry.source);
  const totalEnrichment = needsEnrichment.length;

  if (totalEnrichment === 0) {
    performance.mark('indexing:phaseB:start');
    performance.mark('indexing:phaseB:complete', { detail: { elapsedMs: 0, files: 0 } });
    options.onEnrichmentProgress?.(null);
    return { phaseB: Promise.resolve() };
  }

  const nextPhaseBLogInitial = 500;
  const nextPhaseBLogStep = 1000;
  const phaseBLogIntervalMs = 60_000;
  let nextPhaseBLog = nextPhaseBLogInitial;
  let lastPhaseBLogTime = 0;
  const profileSampleRate = 100;
  let profileCounter = 0;

  // Throttle progress updates to every 300ms to avoid excessive re-renders
  const throttledEnrichmentProgress = throttle(
    (progress: { processed: number; total: number; message?: string } | null) => {
      options.onEnrichmentProgress?.(progress);
    },
    300
  );

  const runEnrichmentPhase = async () => {
    phaseBStats.startTime = performance.now();
    lastPhaseBLogTime = phaseBStats.startTime;
    performance.mark('indexing:phaseB:start');

    const queue = [...needsEnrichment];
    throttledEnrichmentProgress({ processed: 0, total: totalEnrichment });
    const resultsBatch: IndexedImage[] = [];
    const touchedChunks = new Set<number>();
    const DIRTY_CHUNK_FLUSH_THRESHOLD = 12;
    const DIRTY_FLUSH_INTERVAL_MS = 350;
    let lastFlushTime = performance.now();
    const canWriteCache = Boolean(cacheWriter);
    const DEFER_CACHE_FLUSH_THRESHOLD = 5000;
    const deferCacheFlush = canWriteCache && totalEnrichment >= DEFER_CACHE_FLUSH_THRESHOLD;

    const logPhaseBProgress = (queueLength: number) => {
      const now = performance.now();
      const elapsed = now - phaseBStats.startTime;
      if (phaseBStats.processed >= nextPhaseBLog) {
        nextPhaseBLog += nextPhaseBLogStep;
      }
      lastPhaseBLogTime = now;
    };

    const commitBatch = async (force = false) => {
      if (resultsBatch.length > 0) {
        options.onEnrichmentBatch?.([...resultsBatch]);
        resultsBatch.length = 0;
      }

      if (
        cacheWriter &&
        touchedChunks.size > 0 &&
        (force || !deferCacheFlush) &&
        (force || touchedChunks.size >= DIRTY_CHUNK_FLUSH_THRESHOLD)
      ) {
        const chunkIndices = Array.from(touchedChunks);
        const start = performance.now();
        await Promise.all(chunkIndices.map(async (chunkIndex) => {
          const metadata = chunkRecords[chunkIndex];
          const rewriteStart = performance.now();
          await cacheWriter.overwrite(chunkIndex, metadata);
          const duration = performance.now() - rewriteStart;
          const bytesWritten = JSON.stringify(metadata).length;
          phaseBStats.bytesWritten += bytesWritten;
          phaseBStats.diskWrites += 1;
          phaseBStats.ipcCalls += 1;
          performance.mark('indexing:phaseB:chunk-flush', {
            detail: { chunkIndex, durationMs: duration, bytesWritten }
          });
        }));
        const batchDuration = performance.now() - start;
        phaseBStats.flushMs += batchDuration;
        phaseBStats.flushChunks += chunkIndices.length;
        performance.mark('indexing:phaseB:chunk-flush-batch', {
          detail: { chunks: chunkIndices.length, durationMs: batchDuration }
        });
        touchedChunks.clear();
      }
    };

    const applyMergedEntry = async (
      entry: CatalogEntryState,
      enriched: IndexedImage | null,
      profile: PhaseProfileSample | undefined,
      queueLength: number
    ) => {
      const merged = processEnrichmentResult(entry, enriched);
      if (!merged) {
        return null;
      }

      entry.needsEnrichment = false;
      resultsBatch.push(merged);
      const loc = chunkMap.get(merged.id);
      if (loc && canWriteCache) {
        touchedChunks.add(loc.chunkIndex);
      }

      phaseBStats.processed += 1;
      if (profile) {
        phaseBStats.profileSamples += 1;
        phaseBStats.profileTotalMs += profile.totalMs;
        phaseBStats.profileParseMs += profile.parseMs;
        phaseBStats.profileNormalizeMs += profile.normalizeMs;
        phaseBStats.profileDimensionsMs += profile.dimensionsMs;
      }

      throttledEnrichmentProgress({ processed: phaseBStats.processed, total: totalEnrichment, message: entry.image.name });
      logPhaseBProgress(queueLength);
      performance.mark('indexing:phaseB:queue-depth', {
        detail: { depth: queueLength - phaseBStats.processed }
      });

      const now = performance.now();
      if (
        resultsBatch.length >= enrichmentBatchSize ||
        (canWriteCache && !deferCacheFlush && touchedChunks.size >= DIRTY_CHUNK_FLUSH_THRESHOLD) ||
        now - lastFlushTime >= DIRTY_FLUSH_INTERVAL_MS
      ) {
        await commitBatch();
        lastFlushTime = now;
      }

      return merged;
    };

    const METAHUB_KEYWORD_BYTES = new TextEncoder().encode('imagemetahub_data');
    // The moov box type as it appears in a file. Used to answer "did the head
    // read already reach the metadata box?" — a four-byte match can in
    // principle occur by chance inside compressed media data, but the cost of
    // that is only a skipped seek, i.e. today's head-read-only behaviour.
    const MOOV_BOX_BYTES = new TextEncoder().encode('moov');
    const metahubTailDecoder = new TextDecoder();
    const bufferContainsBytes = (buffer: ArrayBuffer, needle: Uint8Array) => {
      const haystack = new Uint8Array(buffer);
      if (needle.length === 0 || haystack.length < needle.length) {
        return false;
      }
      outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
        for (let j = 0; j < needle.length; j += 1) {
          if (haystack[i + j] !== needle[j]) {
            continue outer;
          }
        }
        return true;
      }
      return false;
    };

    const tryParseMetaHubFromTail = async (buffer: ArrayBuffer): Promise<unknown | null> => {
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      const typeA = 0x69; // i
      const typeB = 0x54; // T
      const typeC = 0x58; // X
      const typeD = 0x74; // t

      for (let i = 4; i <= bytes.length - 4; i += 1) {
        if (
          bytes[i] !== typeA ||
          bytes[i + 1] !== typeB ||
          bytes[i + 2] !== typeC ||
          bytes[i + 3] !== typeD
        ) {
          continue;
        }

        const lengthOffset = i - 4;
        if (lengthOffset < 0) {
          continue;
        }
        const chunkLength = view.getUint32(lengthOffset);
        const chunkDataStart = i + 4;
        const chunkDataEnd = chunkDataStart + chunkLength;
        if (chunkDataEnd > bytes.length) {
          continue;
        }

        const chunkData = bytes.slice(chunkDataStart, chunkDataEnd);
        const keywordEndIndex = chunkData.indexOf(0);
        if (keywordEndIndex === -1) {
          continue;
        }
        const keyword = metahubTailDecoder.decode(chunkData.slice(0, keywordEndIndex));
        if (keyword !== 'imagemetahub_data') {
          continue;
        }

        const compressionFlag = chunkData[keywordEndIndex + 1];
        let currentIndex = keywordEndIndex + 3;
        const langTagEndIndex = chunkData.indexOf(0, currentIndex);
        if (langTagEndIndex === -1) {
          continue;
        }
        currentIndex = langTagEndIndex + 1;
        const translatedKwEndIndex = chunkData.indexOf(0, currentIndex);
        if (translatedKwEndIndex === -1) {
          continue;
        }
        currentIndex = translatedKwEndIndex + 1;

        const text = await decodeITXtText(chunkData.slice(currentIndex), compressionFlag, metahubTailDecoder);
        if (!text) {
          continue;
        }
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }
      return null;
    };

    const deriveFallbackDims = (image: IndexedImage | null) => {
      if (!image) {
        return undefined;
      }
      const normalized = image.metadata?.normalizedMetadata as BaseMetadata | undefined;
      const width = normalized?.width;
      const height = normalized?.height;
      if (width && height) {
        return { width, height };
      }
      if (image.dimensions) {
        const match = image.dimensions.match(/(\\d+)\\s*x\\s*(\\d+)/i);
        if (match) {
          return { width: Number(match[1]), height: Number(match[2]) };
        }
      }
      return undefined;
    };

    const applyMetaHubOverride = async (image: IndexedImage | null, metaHubData: unknown) => {
      if (!image) {
        return image;
      }
      const fallbackDims = deriveFallbackDims(image);
      const normalizedMetadata = await buildNormalizedMetadataFromMetaHubChunk(metaHubData, fallbackDims);
      const rawMetadata = { ...(image.metadata || {}) } as Record<string, unknown>;
      delete rawMetadata.normalizedMetadata;
      rawMetadata.imagemetahub_data = metaHubData;

      return {
        ...image,
        metadata: { normalizedMetadata }, // OPTIMIZED
        metadataString: '', // OPTIMIZED
        models: normalizedMetadata.models || [],
        loras: normalizedMetadata.loras || [],
        scheduler: normalizedMetadata.scheduler || '',
        board: normalizedMetadata.board || '',
        prompt: normalizedMetadata.prompt || '',
        negativePrompt: normalizedMetadata.negativePrompt || '',
        cfgScale: normalizedMetadata.cfgScale || normalizedMetadata.cfg_scale || null,
        steps: normalizedMetadata.steps || null,
        seed: normalizedMetadata.seed || null,
        dimensions: normalizedMetadata.dimensions || `${normalizedMetadata.width || 0}x${normalizedMetadata.height || 0}`,
      } as IndexedImage;
    };

    const shouldFallbackToFullRead = (
      entry: CatalogEntryState,
      buffer: ArrayBuffer | undefined,
      enriched: IndexedImage | null
    ) => {
      if (!entry.source || !buffer) {
        return false;
      }
      const fileSize = entry.source.size;
      if (!fileSize || fileSize <= buffer.byteLength) {
        return false;
      }
      // Check for MEANINGFUL metadata — not just the dimensions-only stub that gets
      // created when VP8X dimensions are extracted but no AI parameters were found.
      const norm = enriched?.metadata?.normalizedMetadata as Record<string, unknown> | undefined;
      const hasRealMetadata = Boolean(
        enriched?.metadataString ||
        (norm && (norm.prompt || norm.model || norm.seed || norm.steps))
      );
      if (hasRealMetadata) {
        return false;
      }
      const fileType = entry.source.type ?? inferMimeTypeFromName(entry.source.handle.name);
      // Videos are handled by shouldReadMoovForVideo instead: reading one whole
      // to reach a box that can be seeked to is exactly the cost this path was
      // meant to avoid.
      return fileType === 'image/png' || fileType === 'image/webp' || fileType === 'image/jpeg';
    };

    /**
     * A video needs its moov box seeked out when the head buffer did not
     * already contain one.
     *
     * The head read is 64 KB. A faststart MP4 puts moov first and parses from
     * that alone; every other muxer — ComfyUI's included — leaves moov at the
     * end, so the head buffer holds `ftyp` and the first slice of `mdat` and
     * nothing else. Looking for the literal box type is cheaper and more
     * reliable than asking whether the parse "found enough": a video with no
     * ComfyUI metadata is indistinguishable from a video whose moov was missed,
     * and treating the former as the latter would seek on every clip.
     */
    const shouldReadMoovForVideo = (
      entry: CatalogEntryState,
      buffer: ArrayBuffer | undefined,
      enriched: IndexedImage | null
    ) => {
      if (!entry.source) {
        return false;
      }
      const name = entry.source.handle.name.toLowerCase();
      // Only the ISO base media family. webm/mkv/avi are EBML or RIFF — no
      // moov box exists, so the seek would be wasted on every one of them.
      if (!name.endsWith('.mp4') && !name.endsWith('.mov') && !name.endsWith('.m4v')) {
        return false;
      }
      // A moov inside the head buffer already gave up everything it has.
      if (buffer && bufferContainsBytes(buffer, MOOV_BOX_BYTES)) {
        return false;
      }
      // Otherwise seek. A truncated file is included here rather than filtered
      // out: the reader reports TRUNCATED and the entry simply keeps whatever
      // ffprobe found, which is the same outcome as skipping it, minus a
      // stat() to guess at something the box walk determines exactly.
      return true;
    };

    const shouldCheckTailForMetaHub = (
      entry: CatalogEntryState,
      buffer: ArrayBuffer | undefined,
      enriched: IndexedImage | null
    ) => {
      if (!tailScanEnabled) {
        return false;
      }
      if (tailScanHits === 0 && tailScanAttempts >= TAIL_SCAN_SAMPLE_LIMIT) {
        return false;
      }
      if (!entry.source || !buffer || !enriched) {
        return false;
      }
      const fileSize = entry.source.size;
      if (!fileSize || fileSize <= buffer.byteLength) {
        return false;
      }
      const fileType = entry.source.type ?? inferMimeTypeFromName(entry.source.handle.name);
      if (fileType !== 'image/png') {
        return false;
      }
      const metadata = enriched.metadata as Record<string, unknown> | undefined;
      if (!metadata) {
        return false;
      }
      if ('imagemetahub_data' in metadata) {
        return false;
      }
      return 'parameters' in metadata;
    };

    const iterator = async (entry: CatalogEntryState) => {
      if (!entry.source) {
        return null;
      }
      if (abortSignal?.aborted) {
        return null;
      }

      const shouldProfile = (profileCounter++ % profileSampleRate) === 0;
      const profile = shouldProfile
        ? { totalMs: 0, parseMs: 0, normalizeMs: 0, dimensionsMs: 0 }
        : undefined;
      const enriched = await processSingleFileOptimized(entry.source, directoryId, undefined, profile);
      return applyMergedEntry(entry, enriched, profile, queue.length);
    };

    if (useOptimizedPath) {
      const batches = chunkArray(queue, FILE_READ_BATCH_SIZE);
      for (const batch of batches) {
        const filePaths = batch
          .map(entry => (entry.source?.handle as ElectronFileHandle)?._filePath)
          .filter((path): path is string => typeof path === 'string' && path.length > 0);
        if (filePaths.length === 0) {
          await asyncPool(concurrencyLimit, batch, iterator);
          continue;
        }

        const readStart = performance.now();
        const readResult = useHeadRead
          ? await (window as any).electronAPI.readFilesHeadBatch({ filePaths, maxBytes: HEAD_READ_MAX_BYTES })
          : await (window as any).electronAPI.readFilesBatch(filePaths);
        const readDuration = performance.now() - readStart;

        if (useHeadRead) {
          phaseBStats.headReadFiles += filePaths.length;
          phaseBStats.headReadMs += readDuration;
        } else {
          phaseBStats.fullReadFiles += filePaths.length;
          phaseBStats.fullReadMs += readDuration;
        }
        phaseBStats.ipcCalls += 1;

        const dataMap = new Map<string, ArrayBuffer>();
        if (readResult.success && Array.isArray(readResult.files)) {
          for (const file of readResult.files) {
            if (!file.success || !file.data) {
              continue;
            }
            const raw = file.data as ArrayBuffer | ArrayBufferView;
            if (raw instanceof ArrayBuffer) {
              dataMap.set(file.path, raw);
            } else if (ArrayBuffer.isView(raw)) {
              const view = raw as ArrayBufferView;
              const copy = new Uint8Array(view.byteLength);
              copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
              dataMap.set(file.path, copy.buffer);
            }
          }
        }

        const resultsById = new Map<string, { enriched: IndexedImage | null; profile?: PhaseProfileSample }>();
        const fallbackEntries: CatalogEntryState[] = [];
        const tailCheckEntries: CatalogEntryState[] = [];
        const moovEntries: CatalogEntryState[] = [];
        // The head-read result for videos awaiting a moov seek. Kept so a failed
        // seek can fall back to it without re-parsing the file: the head buffer
        // is already in hand, and the parse is the expensive half.
        const headOnlyResults = new Map<string, { enriched: IndexedImage | null; profile?: PhaseProfileSample }>();
        const missingEntries = new Set<string>();

        const headIterator = async (entry: CatalogEntryState) => {
          if (!entry.source) {
            return null;
          }
          const filePath = (entry.source.handle as ElectronFileHandle)?._filePath;
          if (!filePath) {
            missingEntries.add(entry.image.id);
            return null;
          }
          const buffer = dataMap.get(filePath);
          if (!buffer) {
            missingEntries.add(entry.image.id);
            return null;
          }
          const shouldProfile = (profileCounter++ % profileSampleRate) === 0;
          const profile = shouldProfile
            ? { totalMs: 0, parseMs: 0, normalizeMs: 0, dimensionsMs: 0 }
            : undefined;
          const enriched = await processSingleFileOptimized(entry.source, directoryId, buffer, profile);
          if (shouldReadMoovForVideo(entry, buffer, enriched)) {
            // Deferred to one seek per batch rather than one full read per
            // video. The head-read result is parked, not discarded — a moov
            // that turns out not to exist falls back to it below.
            headOnlyResults.set(entry.image.id, { enriched, profile });
            moovEntries.push(entry);
            return null;
          }
          if (shouldFallbackToFullRead(entry, buffer, enriched)) {
            fallbackEntries.push(entry);
            return null;
          }
          if (useTailRead && shouldCheckTailForMetaHub(entry, buffer, enriched)) {
            tailCheckEntries.push(entry);
          }
          resultsById.set(entry.image.id, { enriched, profile });
          return null;
        };

        await asyncPool(concurrencyLimit, batch, headIterator);

        if (moovEntries.length > 0) {
          const moovPaths = moovEntries
            .map(entry => (entry.source?.handle as ElectronFileHandle)?._filePath)
            .filter((path): path is string => typeof path === 'string' && path.length > 0);

          const moovMap = new Map<string, ArrayBuffer>();
          if (moovPaths.length > 0) {
            const moovStart = performance.now();
            const moovResult = await (window as any).electronAPI.readVideoMoovBatch({
              filePaths: moovPaths,
            });
            phaseBStats.moovReadFiles += moovPaths.length;
            phaseBStats.moovReadMs += performance.now() - moovStart;
            phaseBStats.ipcCalls += 1;

            if (moovResult?.success && Array.isArray(moovResult.files)) {
              for (const file of moovResult.files) {
                if (!file.success || !file.data) {
                  continue;
                }
                const raw = file.data as ArrayBuffer | ArrayBufferView;
                if (raw instanceof ArrayBuffer) {
                  moovMap.set(file.path, raw);
                } else if (ArrayBuffer.isView(raw)) {
                  const view = raw as ArrayBufferView;
                  const copy = new Uint8Array(view.byteLength);
                  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
                  moovMap.set(file.path, copy.buffer);
                }
              }
            }
          }

          const moovIterator = async (entry: CatalogEntryState) => {
            const filePath = (entry.source?.handle as ElectronFileHandle)?._filePath;
            const moovBuffer = filePath ? moovMap.get(filePath) : undefined;
            if (!entry.source || !moovBuffer) {
              // No moov to be had: not an MP4, truncated, or over the size cap.
              // Fall back to the head-read parse that was set aside — it is
              // never wrong, just possibly short of tags and dimensions.
              const headOnly = headOnlyResults.get(entry.image.id);
              if (headOnly) {
                resultsById.set(entry.image.id, headOnly);
              } else {
                missingEntries.add(entry.image.id);
              }
              return null;
            }
            const shouldProfile = (profileCounter++ % profileSampleRate) === 0;
            const profile = shouldProfile
              ? { totalMs: 0, parseMs: 0, normalizeMs: 0, dimensionsMs: 0 }
              : undefined;
            const enriched = await processSingleFileOptimized(entry.source, directoryId, moovBuffer, profile);
            resultsById.set(entry.image.id, { enriched, profile });
            return null;
          };

          await asyncPool(concurrencyLimit, moovEntries, moovIterator);
        }

        if (tailCheckEntries.length > 0 && useTailRead) {
          const tailPaths = tailCheckEntries
            .map(entry => (entry.source?.handle as ElectronFileHandle)?._filePath)
            .filter((path): path is string => typeof path === 'string' && path.length > 0);
          if (tailPaths.length > 0) {
            tailScanAttempts += tailPaths.length;
            const tailStart = performance.now();
            const tailResult = await (window as any).electronAPI.readFilesTailBatch({
              filePaths: tailPaths,
              maxBytes: TAIL_READ_MAX_BYTES
            });
            const tailDuration = performance.now() - tailStart;
            phaseBStats.tailReadFiles += tailPaths.length;
            phaseBStats.tailReadMs += tailDuration;
            phaseBStats.ipcCalls += 1;

            const tailMap = new Map<string, ArrayBuffer>();
            if (tailResult.success && Array.isArray(tailResult.files)) {
              for (const file of tailResult.files) {
                if (!file.success || !file.data) {
                  continue;
                }
                const raw = file.data as ArrayBuffer | ArrayBufferView;
                if (raw instanceof ArrayBuffer) {
                  tailMap.set(file.path, raw);
                } else if (ArrayBuffer.isView(raw)) {
                  const view = raw as ArrayBufferView;
                  const copy = new Uint8Array(view.byteLength);
                  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
                  tailMap.set(file.path, copy.buffer);
                }
              }
            }

            for (const entry of tailCheckEntries) {
              const filePath = (entry.source?.handle as ElectronFileHandle)?._filePath;
              if (!filePath) {
                continue;
              }
              const tailBuffer = tailMap.get(filePath);
              if (!tailBuffer || !bufferContainsBytes(tailBuffer, METAHUB_KEYWORD_BYTES)) {
                continue;
              }
              const metaHubData = await tryParseMetaHubFromTail(tailBuffer);
              if (metaHubData) {
                phaseBStats.tailReadHits += 1;
                tailScanHits += 1;
                const existing = resultsById.get(entry.image.id);
                const updated = await applyMetaHubOverride(existing?.enriched ?? null, metaHubData);
                if (updated) {
                  resultsById.set(entry.image.id, { enriched: updated, profile: existing?.profile });
                  continue;
                }
              }
              resultsById.delete(entry.image.id);
              fallbackEntries.push(entry);
            }
            if (tailScanHits === 0 && tailScanAttempts >= TAIL_SCAN_SAMPLE_LIMIT && tailScanEnabled) {
              tailScanEnabled = false;
              console.log('[indexing] Tail scan disabled after sample: no MetaHub iTXt chunks detected.');
            }
          }
        }

        if (fallbackEntries.length > 0) {
          const FALLBACK_BATCH_SIZE = 4;
          const fallbackBatches = chunkArray(fallbackEntries, FALLBACK_BATCH_SIZE);
          
          for (const fallbackBatch of fallbackBatches) {
            const fallbackPaths = fallbackBatch
              .map(entry => (entry.source?.handle as ElectronFileHandle)?._filePath)
              .filter((path): path is string => typeof path === 'string' && path.length > 0);
            if (fallbackPaths.length > 0) {
              const fullReadStart = performance.now();
              const fullReadResult = await (window as any).electronAPI.readFilesBatch(fallbackPaths);
              const fullReadDuration = performance.now() - fullReadStart;
              phaseBStats.fullReadFiles += fallbackPaths.length;
              phaseBStats.fullReadMs += fullReadDuration;
              phaseBStats.ipcCalls += 1;

              const fullDataMap = new Map<string, ArrayBuffer>();
              if (fullReadResult.success && Array.isArray(fullReadResult.files)) {
                for (const file of fullReadResult.files) {
                  if (!file.success || !file.data) {
                    continue;
                  }
                  const raw = file.data as ArrayBuffer | ArrayBufferView;
                  if (raw instanceof ArrayBuffer) {
                    fullDataMap.set(file.path, raw);
                  } else if (ArrayBuffer.isView(raw)) {
                    const view = raw as ArrayBufferView;
                    const copy = new Uint8Array(view.byteLength);
                    copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
                    fullDataMap.set(file.path, copy.buffer);
                  }
                }
              }

              const fallbackIterator = async (entry: CatalogEntryState) => {
                if (!entry.source) {
                  return null;
                }
                const filePath = (entry.source.handle as ElectronFileHandle)?._filePath;
                if (!filePath) {
                  missingEntries.add(entry.image.id);
                  return null;
                }
                const buffer = fullDataMap.get(filePath);
                if (!buffer) {
                  missingEntries.add(entry.image.id);
                  return null;
                }
                const shouldProfile = (profileCounter++ % profileSampleRate) === 0;
                const profile = shouldProfile
                  ? { totalMs: 0, parseMs: 0, normalizeMs: 0, dimensionsMs: 0 }
                  : undefined;
                const enriched = await processSingleFileOptimized(entry.source, directoryId, buffer, profile);
                resultsById.set(entry.image.id, { enriched, profile });
                return null;
              };

              await asyncPool(concurrencyLimit, fallbackBatch, fallbackIterator);
            }
          }
        }

        for (const entry of batch) {
          if (missingEntries.has(entry.image.id)) {
            await iterator(entry);
            continue;
          }
          const result = resultsById.get(entry.image.id);
          if (result) {
            await applyMergedEntry(entry, result.enriched, result.profile, queue.length);
          }
        }
      }
    } else {
      await asyncPool(concurrencyLimit, queue, iterator);
    }

    await commitBatch(true);

    const elapsedMs = performance.now() - phaseBStats.startTime;
    performance.mark('indexing:phaseB:complete', {
      detail: { elapsedMs, files: phaseBStats.processed }
    });

    throttledEnrichmentProgress({ processed: phaseBStats.processed, total: totalEnrichment });
  };

  return { phaseB: runEnrichmentPhase() };
}

export async function extractRawMetadataFromFile(absolutePath: string): Promise<ImageMetadata | null> {
  if (!isElectron || !(window as any).electronAPI?.readFile) return null;
  try {
    const result = await (window as any).electronAPI.readFile(absolutePath);
    if (!result.success || !result.data) return null;
    
    const buffer = result.data.buffer || result.data;
    const arrayBuffer = buffer instanceof ArrayBuffer ? buffer : new Uint8Array(buffer).buffer;
    const view = new DataView(arrayBuffer);
    const type = detectImageType(view);
    
    if (type === 'png') return parsePNGMetadata(arrayBuffer);
    if (type === 'jpeg') return parseJPEGMetadata(arrayBuffer);
    if (type === 'webp') return parseWebPMetadata(arrayBuffer);
  } catch (err) {
    console.warn('[FileIndexer] Failed to load raw metadata for:', absolutePath, err);
  }
  return null;
}
