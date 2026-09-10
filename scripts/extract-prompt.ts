#!/usr/bin/env node
/**
 * extract-prompt.ts
 *
 * Extract the plain generation prompt from EITHER a ComfyUI workflow JSON
 * OR a media file with embedded generation metadata. The input type is
 * detected automatically — no flags required.
 *
 * Supported inputs
 *   • Workflow JSON   — ComfyUI UI graph, { workflow, prompt } wrapper, or
 *                       API-format prompt (nodes keyed with `class_type`).
 *   • Images          — PNG, JPEG, WebP (tEXt/iTXt/zTXt chunks, EXIF,
 *                       XMP, COM segments).
 *   • Video           — MP4/MOV (mdta tags), plus WebM/MKV/AVI via ffprobe
 *                       when it is installed.
 *
 * Every generator the app understands is supported through the shared
 * parser factory: ComfyUI, Automatic1111, Forge, Fooocus, SwarmUI,
 * InvokeAI, Easy Diffusion, Draw Things, DreamStudio, Midjourney, Niji,
 * DALL-E, Adobe Firefly, MetaHub Save Node/Video.
 *
 * Usage
 *   # Auto-detect — workflow or media, same command
 *   npx tsx scripts/extract-prompt.ts workflow.json
 *   npx tsx scripts/extract-prompt.ts render.png
 *   npx tsx scripts/extract-prompt.ts clip.mp4
 *
 *   # Pick which prompt to print
 *   npx tsx scripts/extract-prompt.ts render.png --negative
 *   npx tsx scripts/extract-prompt.ts render.png --json        (all fields)
 *
 *   # From stdin (JSON or raw file bytes)
 *   cat workflow.json | npx tsx scripts/extract-prompt.ts
 *   cat render.png    | npx tsx scripts/extract-prompt.ts
 *
 *   # Via npm scripts:
 *   npm run prompt -- render.png
 *   npm run prompt -- workflow.json --negative
 *
 * Exit codes
 *   0  prompt extracted and printed
 *   1  error (unreadable file, unrecognised format, parse failure)
 *   3  parsed successfully but no prompt was found (only with --require-prompt)
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolve, basename } from 'path';

// Binary byte parsers — pure, no Electron/DOM dependencies.
import {
  detectImageType,
  parseImageBuffer,
  extractMp4MdtaTags,
  extractMp4Dimensions,
} from '../src/services/parsers/binaryParsers';

// Shared factory — maps raw metadata keys to the right generator parser.
import { parseImageMetadata } from '../src/services/parsers/metadataParserFactory';

// Workflow-graph resolver (links a ComfyUI UI graph to its execution prompt).
import { resolvePromptFromGraph } from '../src/services/parsers/comfyUIParser';

import type { ImageMetadata, BaseMetadata } from '../src/types';

const execFileAsync = promisify(execFile);

// ── Debug suppression ─────────────────────────────────────────────────────────
// The parsers emit tracing via console.log (e.g. CLIPTextEncode extractor
// traces, parser-selection notices). This CLI writes the prompt to stdout, so
// those lines would corrupt the output — silence them while parsing and route
// anything useful through stderr instead.
function suppressParserLogs<T>(fn: () => T): T {
  const originalLog = console.log;
  const originalDebug = console.debug;
  console.log = () => {};
  console.debug = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.debug = originalDebug;
  }
}

async function suppressParserLogsAsync<T>(fn: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  const originalDebug = console.debug;
  console.log = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.debug = originalDebug;
  }
}

// ── Input sniffing ────────────────────────────────────────────────────────────

type InputKind = 'json' | 'image' | 'video' | 'unknown';

/** UTF-8 BOM, then any leading ASCII whitespace. */
function skipLeadingWhitespace(buf: Buffer): number {
  let i = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    i = 3;
  }
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) {
    i++;
  }
  return i;
}

/** Matroska / WebM EBML magic. */
function isEbml(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

/** RIFF....AVI (and the AVIX variant). */
function isAvi(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    (buf.toString('latin1', 8, 12) === 'AVI ' || buf.toString('latin1', 8, 12) === 'AVIX')
  );
}

/** ISO-BMFF container (MP4 / MOV / M4V): an `ftyp` box at offset 4. */
function isIsoBmff(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp';
}

/**
 * Classify the input by content, not by extension. Content sniffing means a
 * mislabelled file (a .json that is really a PNG, or a .png holding only a
 * JSON payload) still routes correctly.
 */
function sniffKind(buf: Buffer): InputKind {
  if (buf.length === 0) return 'unknown';

  const start = skipLeadingWhitespace(buf);
  const firstByte = buf[start];

  // A JSON document is decided by its opening brace, then confirmed by the
  // caller actually parsing it — an image never starts with '{' or '['.
  if (firstByte === 0x7b /* { */ || firstByte === 0x5b /* [ */) {
    return 'json';
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (detectImageType(view)) return 'image';

  if (isIsoBmff(buf) || isEbml(buf) || isAvi(buf)) return 'video';

  return 'unknown';
}

// ── Extraction result ─────────────────────────────────────────────────────────

interface ExtractionResult {
  /** Detected input kind, echoed into --json output. */
  kind: InputKind;
  /** Best-effort generator name (ComfyUI, Automatic1111, …). */
  generator: string | null;
  prompt: string;
  negativePrompt: string;
  /** Full structured metadata, when the source carried more than prompts. */
  metadata: Record<string, any> | null;
  /** How the prompt was located — useful for debugging odd files. */
  method: string;
}

// ── Path 1: workflow JSON ─────────────────────────────────────────────────────

/**
 * Normalise parsed JSON into the { workflow, prompt } pair that
 * resolvePromptFromGraph expects. Accepts the three shapes ComfyUI emits:
 * a bare UI graph, a { workflow, prompt } wrapper, and API-format JSON.
 */
function splitWorkflowJson(data: any): { workflow: any; prompt: any } {
  let workflow = data?.workflow;
  let prompt = data?.prompt;

  if (!workflow && !prompt) {
    // API format: top-level keys are node ids, each with a `class_type`.
    const hasClassType =
      data && typeof data === 'object' &&
      Object.values(data).some(
        (v: any) => v && typeof v === 'object' && 'class_type' in v,
      );
    if (hasClassType) {
      return { workflow: { nodes: [] }, prompt: data };
    }
    // A bare UI graph has `nodes` but no wrapper.
    if (data && typeof data === 'object' && Array.isArray(data.nodes)) {
      return { workflow: data, prompt: undefined };
    }
    throw new Error(
      'JSON does not look like a ComfyUI workflow (no "workflow"/"prompt" keys, ' +
        'no API-format nodes, and no "nodes" array).',
    );
  }

  // Either half may be stored as a JSON string.
  if (typeof workflow === 'string') {
    try {
      workflow = JSON.parse(workflow.replace(/:\s*NaN/g, ': null'));
    } catch {
      workflow = { nodes: [] };
    }
  }
  if (typeof prompt === 'string') {
    try {
      prompt = JSON.parse(prompt.replace(/:\s*NaN/g, ': null'));
    } catch {
      throw new Error('Could not parse the "prompt" section as JSON.');
    }
  }

  return { workflow, prompt };
}

function extractFromWorkflowJson(raw: string, sourceName: string, verbose: boolean): ExtractionResult {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON${sourceName !== '<stdin>' ? ` in: ${sourceName}` : ''}`);
  }

  const { workflow, prompt } = splitWorkflowJson(data);
  const resolved = suppressParserLogs(() => resolvePromptFromGraph(workflow, prompt));

  if (verbose) {
    console.error(
      `[extract-prompt] parsed workflow graph: ` +
        `${Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0} node(s)`,
    );
  }

  return {
    kind: 'json',
    generator: resolved.generator || 'ComfyUI',
    prompt: resolved.prompt || '',
    negativePrompt: resolved.negativePrompt || '',
    metadata: resolved as Record<string, any>,
    method: 'workflow-graph',
  };
}

// ── Path 2: images ────────────────────────────────────────────────────────────

/**
 * Run the shared factory, degrading gracefully when a source carries a
 * malformed workflow graph.
 *
 * resolvePromptFromGraph walks the UI graph and dereferences node fields, so a
 * truncated or hand-edited `workflow` chunk throws a bare TypeError. That graph
 * is only ever a *supplement* to the execution `prompt` — so on failure, retry
 * against the prompt alone rather than losing an otherwise-readable file.
 */
async function safeParseMetadata(
  rawMetadata: ImageMetadata,
  buffer: ArrayBuffer | undefined,
): Promise<{ parsed: BaseMetadata | null; warning: string | null }> {
  try {
    const parsed = await suppressParserLogsAsync(() =>
      parseImageMetadata(rawMetadata, buffer),
    );
    return { parsed, warning: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const promptGraph = (rawMetadata as any).prompt;

    if (!promptGraph) {
      return { parsed: null, warning: `parser failed: ${reason}` };
    }

    try {
      const retried = suppressParserLogs(() =>
        resolvePromptFromGraph({ nodes: [] }, promptGraph),
      );
      return {
        parsed: { ...retried, generator: 'ComfyUI' } as BaseMetadata,
        warning: `malformed workflow graph (${reason}); resolved from the prompt graph alone`,
      };
    } catch {
      return { parsed: null, warning: `parser failed: ${reason}` };
    }
  }
}

async function extractFromImage(
  buffer: ArrayBuffer,
  sourceName: string,
  verbose: boolean,
): Promise<ExtractionResult> {
  const rawMetadata = await suppressParserLogsAsync(() => parseImageBuffer(buffer));

  if (!rawMetadata) {
    throw new Error(`No embedded metadata chunks found in image: ${sourceName}`);
  }
  if (verbose) {
    console.error(
      `[extract-prompt] raw image metadata keys: ${Object.keys(rawMetadata).join(', ')}`,
    );
  }

  const { parsed, warning } = await safeParseMetadata(rawMetadata, buffer);
  if (warning && verbose) console.error(`[extract-prompt] ${warning}`);

  if (!parsed) {
    throw new Error(
      `Image has metadata but no known generator matched. Keys: ${Object.keys(rawMetadata).join(', ')}`,
    );
  }

  return {
    kind: 'image',
    generator: (parsed as BaseMetadata).generator || null,
    prompt: parsed.prompt || '',
    negativePrompt: parsed.negativePrompt || '',
    metadata: parsed as Record<string, any>,
    method: 'embedded-metadata',
  };
}

// ── Path 3: video ─────────────────────────────────────────────────────────────

/**
 * Build an ImageMetadata-shaped object from arbitrary string tags.
 *
 * Containers name their tags inconsistently (Apple mdta uses `prompt` /
 * `workflow`; ffprobe may surface `description`, `comment`, or vendor keys).
 * Rather than trust the key name, inspect the value: a tag holding
 * `"class_type"` is a ComfyUI execution prompt, one holding `nodes` is a UI
 * graph. That makes the harvest work across MP4, WebM and MKV alike.
 */
function harvestTagsIntoMetadata(tags: Record<string, string>): ImageMetadata {
  const meta: Record<string, any> = {};

  /**
   * MetaHub payloads must be handed to the factory as *objects*, not strings.
   * The app stores them that way (`rawMetadata.videometahub_data = JSON.parse(comment)`),
   * and parseVideoMetaHubMetadata only unwraps `videometahub_data` when it is
   * an object — a string falls through and yields an empty prompt.
   */
  const coerce = (value: string): any => {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  };

  for (const [rawKey, rawValue] of Object.entries(tags)) {
    if (typeof rawValue !== 'string' || rawValue.length === 0) continue;
    const key = rawKey.toLowerCase();

    // Explicitly named keys win their natural slot.
    if (key === 'prompt' || key === 'workflow' || key === 'parameters' || key === 'invokeai_metadata') {
      meta[key] = rawValue;
      continue;
    }
    if (key === 'imagemetahub_data' || key === 'videometahub_data') {
      meta[key] = coerce(rawValue);
      continue;
    }

    // A JSON blob in a `comment`/`description` tag is a MetaHub Save Video
    // payload (the app stores it under videometahub_data).
    const trimmed = rawValue.trim();
    if (trimmed.startsWith('{')) {
      if (key === 'comment' || key === 'description' || key === 'title') {
        meta[/"imh_pro"|"videometahub"/.test(trimmed) ? 'videometahub_data' : 'workflow'] = coerce(rawValue);
        continue;
      }
      // Unknown key holding a JSON blob — route by what the value actually is.
      if (!meta.prompt && /"class_type"\s*:/.test(trimmed)) {
        meta.prompt = rawValue;
        continue;
      }
      if (!meta.workflow && /"nodes"\s*:/.test(trimmed)) {
        meta.workflow = rawValue;
        continue;
      }
    }
  }

  return meta as ImageMetadata;
}

/**
 * ffprobe fallback. ComfyUI's VideoHelperSuite and MetaHub write tags that
 * vary by container; for WebM/MKV there is no pure-JS reader in this codebase,
 * so use ffprobe when it happens to be installed. Absence is not an error —
 * the caller reports the diagnostic.
 */
async function tryFfprobeTags(
  filePath: string,
  verbose: boolean,
): Promise<Record<string, string> | null> {
  const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe';
  try {
    const { stdout } = await execFileAsync(
      ffprobePath,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed?.format?.tags ?? {})) {
      if (typeof v === 'string') tags[k] = v;
    }
    if (verbose) {
      console.error(`[extract-prompt] ffprobe tags: ${Object.keys(tags).join(', ') || '(none)'}`);
    }
    return tags;
  } catch (err) {
    if (verbose) {
      console.error(
        `[extract-prompt] ffprobe unavailable (${err instanceof Error ? err.message : err})`,
      );
    }
    return null;
  }
}

async function extractFromVideo(
  bytes: Uint8Array,
  filePath: string | null,
  sourceName: string,
  verbose: boolean,
): Promise<ExtractionResult> {
  const tags: Record<string, string> = {};

  // Native mdta walker first — pure byte math, no external tool needed.
  Object.assign(tags, extractMp4MdtaTags(bytes));

  // ffprobe only when native extraction found nothing, and only for real files.
  if (Object.keys(tags).length === 0 && filePath) {
    const probed = await tryFfprobeTags(filePath, verbose);
    if (probed) Object.assign(tags, probed);
  }

  if (Object.keys(tags).length === 0) {
    throw new Error(
      `No metadata tags found in video: ${sourceName}\n` +
        '  MP4/MOV tags are read natively. WebM/MKV/AVI need ffprobe on PATH ' +
        '(or set FFPROBE_PATH).',
    );
  }

  const rawMetadata = harvestTagsIntoMetadata(tags);
  if (verbose) {
    console.error(`[extract-prompt] video tags → ${JSON.stringify(Object.keys(rawMetadata))}`);
  }

  const { parsed, warning } = await safeParseMetadata(rawMetadata, undefined);
  if (warning && verbose) console.error(`[extract-prompt] ${warning}`);

  // A video may carry only an mp4 mdta prompt with no parseable workflow.
  if (!parsed) {
    const fallback = typeof (rawMetadata as any).prompt === 'string' ? (rawMetadata as any).prompt : '';
    if (fallback) {
      return {
        kind: 'video',
        generator: null,
        prompt: fallback,
        negativePrompt: '',
        metadata: { prompt: fallback, tags },
        method: 'raw-tag',
      };
    }
    throw new Error(
      `Video tags present but no generator matched: ${Object.keys(tags).join(', ')}`,
    );
  }

  const dims = extractMp4Dimensions(bytes);
  const metadata = { ...(parsed as Record<string, any>), _tags: tags };
  if (dims && !metadata.width) {
    metadata.width = dims.width;
    metadata.height = dims.height;
  }

  return {
    kind: 'video',
    generator: (parsed as BaseMetadata).generator || null,
    prompt: parsed.prompt || '',
    negativePrompt: parsed.negativePrompt || '',
    metadata,
    method: 'embedded-metadata',
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

async function extract(
  buf: Buffer,
  filePath: string | null,
  sourceName: string,
  verbose: boolean,
): Promise<ExtractionResult> {
  const kind = sniffKind(buf);

  if (verbose) {
    console.error(`[extract-prompt] ${sourceName}: detected ${kind} (${buf.length} bytes)`);
  }

  if (kind === 'json') {
    return extractFromWorkflowJson(buf.toString('utf-8'), sourceName, verbose);
  }

  // parseImageBuffer / detectImageType both build `new DataView(buffer)` at
  // offset 0, so hand them a standalone ArrayBuffer. A Node Buffer read with
  // readFileSync can be a view into a shared pool with a non-zero byteOffset —
  // passing `buf.buffer` directly would make the parsers read the wrong bytes.
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

  if (kind === 'image') {
    return extractFromImage(arrayBuffer, sourceName, verbose);
  }

  if (kind === 'video') {
    return extractFromVideo(new Uint8Array(arrayBuffer), filePath, sourceName, verbose);
  }

  throw new Error(
    `Unrecognised input: ${sourceName}\n` +
      '  Expected a ComfyUI workflow JSON, or a PNG/JPEG/WebP/MP4/MOV/WebM/MKV/AVI file.',
  );
}

// ── stdin ─────────────────────────────────────────────────────────────────────

/** Read all of stdin as raw bytes. Resolves empty when stdin is a TTY. */
async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

interface CliOptions {
  negative: boolean;
  json: boolean;
  requirePrompt: boolean;
  verbose: boolean;
}

function buildJsonOutput(result: ExtractionResult, sourceName: string): Record<string, any> {
  return {
    file: sourceName,
    input_type: result.kind,
    generator: result.generator,
    detection_method: result.method,
    extracted_at: new Date().toISOString(),
    prompt: result.prompt || null,
    negative_prompt: result.negativePrompt || null,
    metadata: result.metadata,
  };
}

const program = new Command();

program
  .name('extract-prompt')
  .description(
    'Extract the plain prompt from a ComfyUI workflow JSON or from a media file\n' +
      'with embedded generation metadata. The input type is auto-detected.\n' +
      'With no file argument, input is read from stdin.',
  )
  .version('1.0.0')
  .argument('[file]', 'Workflow JSON or media file (PNG/JPEG/WebP/MP4/MOV/WebM/MKV/AVI). Use "-" for stdin.')
  .option('--stdin', 'Force reading from stdin even if a file path is given')
  .option('-n, --negative', 'Print the negative prompt instead of the positive one')
  .option('--json', 'Print full structured metadata as JSON instead of the plain prompt')
  .option('--require-prompt', 'Exit with code 3 when no prompt is found (for scripting/CI)')
  .option('-v, --verbose', 'Print detection and parsing diagnostics to stderr')
  .action(async (file: string | undefined, options: CliOptions) => {
    try {
      const useStdin = options.stdin || file === '-' || file === undefined;

      let buf: Buffer;
      let filePath: string | null = null;
      let sourceName: string;

      if (useStdin) {
        buf = await readStdin();
        if (buf.length === 0) {
          console.error('Error: no input received on stdin.');
          console.error('  cat workflow.json | npx tsx scripts/extract-prompt.ts');
          console.error('  cat render.png    | npx tsx scripts/extract-prompt.ts');
          console.error('  npx tsx scripts/extract-prompt.ts render.png');
          process.exit(1);
        }
        sourceName = '<stdin>';
      } else {
        filePath = resolve(file!);
        try {
          buf = readFileSync(filePath);
        } catch {
          console.error(`Error: cannot read file: ${filePath}`);
          process.exit(1);
        }
        sourceName = basename(filePath);
      }

      const result = await extract(buf, filePath, sourceName, options.verbose);

      if (options.json) {
        console.log(JSON.stringify(buildJsonOutput(result, sourceName), null, 2));
      } else {
        const value = options.negative ? result.negativePrompt : result.prompt;
        if (value) {
          console.log(value);
        } else if (options.verbose) {
          console.error(
            `[extract-prompt] no ${options.negative ? 'negative' : 'positive'} prompt found in ${sourceName}`,
          );
        }
      }

      if (options.requirePrompt && !(options.negative ? result.negativePrompt : result.prompt)) {
        process.exit(3);
      }
    } catch (error) {
      console.error(
        'Error extracting prompt:',
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program.parse();
