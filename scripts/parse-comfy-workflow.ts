#!/usr/bin/env node
/**
 * parse-comfy-workflow.ts
 *
 * CLI tool to parse a ComfyUI workflow JSON and output structured metadata.
 * Extracts: model, loras, VAE, scheduler, sampler, steps, cfg, seed, prompts,
 *          dimensions, controlnet, comfyui_version, and more.
 *
 * Accepts a file path OR reads raw JSON from stdin (pipe / paste).
 *
 * Usage:
 *   # From a file
 *   tsx scripts/parse-comfy-workflow.ts workflow.json
 *   tsx scripts/parse-comfy-workflow.ts workflow.json --pretty
 *
 *   # From stdin (pipe)
 *   cat workflow.json | tsx scripts/parse-comfy-workflow.ts
 *   pbpaste | tsx scripts/parse-comfy-workflow.ts          (macOS)
 *   Get-Clipboard | tsx scripts/parse-comfy-workflow.ts    (Windows PS)
 *
 *   # From stdin (explicit)
 *   tsx scripts/parse-comfy-workflow.ts --stdin
 *   tsx scripts/parse-comfy-workflow.ts -                  (shorthand)
 *
 *   # Via npm scripts:
 *   npm run comfy:parse -- workflow.json
 *   cat workflow.json | npm run comfy:parse --
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve, basename } from 'path';

// Import from the app's live ComfyUI parser (src/services is the maintained
// copy; packages/metadata-engine is a stale snapshot that cannot resolve
// links from workflow-only JSON). resolvePromptFromGraph does full extraction
// including advanced seed/model, modifier (ControlNet/LoRA/VAE) detection,
// edit history, and version detection.
import { resolvePromptFromGraph } from '../src/services/parsers/comfyUIParser';

// ── Debug suppression ─────────────────────────────────────────────────────────
// The ComfyUI parser emits debug logs via console.log (e.g. CLIPTextEncode
// extractor traces). Since this CLI writes JSON to stdout, we temporarily
// suppress console.log during parsing so the output is clean JSON.
function suppressDebugLogs<T>(fn: () => T): T {
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

// ── Stdin reader ──────────────────────────────────────────────────────────────
// Reads all data from stdin and returns it as a string.  Times out after 10 s
// so the script doesn't hang forever if stdin is a terminal with no input.
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    // If stdin is a TTY (interactive terminal), resolve with empty string
    // after a short delay — there's nothing being piped.
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      // If we got data, use it; otherwise reject
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks).toString('utf-8'));
      } else {
        reject(new Error('Timed out waiting for stdin input'));
      }
    }, 10_000);

    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    process.stdin.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    // Resume stdin in case it's paused
    process.stdin.resume();
  });
}

// ── Shared parsing logic ──────────────────────────────────────────────────────
// Takes raw JSON text and a display name (filename or "<stdin>").
function parseWorkflowJson(
  raw: string,
  sourceName: string,
): { workflow: any; prompt: any } {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON input${sourceName !== '<stdin>' ? ` in file: ${sourceName}` : ''}`);
  }

  let workflow = data.workflow;
  let prompt = data.prompt;

  if (!workflow && !prompt) {
    // Check if this is an API-format prompt
    const hasClassType = Object.values(data).some(
      (v: any) => v && typeof v === 'object' && 'class_type' in v,
    );
    if (hasClassType) {
      prompt = data;
      workflow = { nodes: [] };
    } else {
      throw new Error(
        'Input does not appear to be a ComfyUI workflow (no "workflow" or "prompt" key, and no API-format prompt object found).',
      );
    }
  }

  // Resolve string-encoded workflow
  if (typeof workflow === 'string') {
    try {
      workflow = JSON.parse(workflow.replace(/: NaN/g, ': null'));
    } catch {
      workflow = { nodes: [] };
    }
  }

  // Resolve string-encoded prompt
  if (typeof prompt === 'string') {
    try {
      prompt = JSON.parse(prompt.replace(/: NaN/g, ': null'));
    } catch {
      throw new Error('Could not parse "prompt" section as JSON.');
    }
  }

  return { workflow, prompt };
}

function buildFactsOutput(
  sourceName: string,
  result: Record<string, any>,
  options: { raw?: boolean; telemetry?: boolean },
): Record<string, any> {
  const output: Record<string, any> = {
    file: sourceName,
    generator: 'ComfyUI',
    parsed_at: new Date().toISOString(),
    prompts: {
      positive: result.prompt || null,
      negative: result.negativePrompt || null,
    },
    model: {
      base: result.model || null,
      vae: result.vae || result.vaes?.[0]?.name || null,
    },
    loras:
      result.loras && result.loras.length > 0
        ? result.loras
        : result.lora && Array.isArray(result.lora)
          ? result.lora.map((n: string) => ({ name: n }))
          : [],
    sampling: {
      seed: result.seed ?? null,
      steps: result.steps ?? null,
      cfg: result.cfg ?? null,
      sampler_name: result.sampler_name ?? null,
      scheduler: result.scheduler ?? null,
      denoise: result.denoise ?? null,
    },
    dimensions: {
      width: result.width ?? null,
      height: result.height ?? null,
    },
    controlnets: result.controlnets || [],
    vaes: result.vaes || [],
    edit_history: result.editHistory || null,
    comfyui_version: result.comfyui_version || null,
  };

  if (options.raw) output._raw = result;
  // Commander's `--no-telemetry` sets `telemetry: false` (default true).
  if (options.telemetry !== false) output._telemetry = result._telemetry || null;

  return output;
}

function buildDefaultOutput(
  sourceName: string,
  result: Record<string, any>,
  options: { raw?: boolean; telemetry?: boolean },
): Record<string, any> {
  const output: Record<string, any> = {
    file: sourceName,
    generator: result.generator || 'ComfyUI',
    parsed_at: new Date().toISOString(),

    // ── Model ──────────────────────────────
    model: result.model || null,
    vae: result.vae || result.vaes?.[0]?.name || null,

    // ── Sampling parameters ────────────────
    seed: result.seed ?? null,
    approximate_seed: result.approximateSeed || false,
    steps: result.steps ?? null,
    cfg: result.cfg ?? null,
    sampler: result.sampler_name ?? null,
    scheduler: result.scheduler ?? null,
    denoise: result.denoise ?? null,

    // ── Prompts ────────────────────────────
    prompt: result.prompt || null,
    negative_prompt: result.negativePrompt || null,

    // ── LoRAs ──────────────────────────────
    loras:
      result.loras && result.loras.length > 0
        ? result.loras
        : result.lora && Array.isArray(result.lora)
          ? result.lora.map((n: string) => ({ name: n }))
          : [],

    // ── ControlNet ─────────────────────────
    controlnets: result.controlnets || [],

    // ── Dimensions ─────────────────────────
    width: result.width ?? null,
    height: result.height ?? null,

    // ── Additional ─────────────────────────
    comfyui_version: result.comfyui_version || null,
    edit_history: result.editHistory || null,
    vaes: result.vaes || [],

    // ── Metadata ───────────────────────────
    _telemetry: options.telemetry === false ? undefined : result._telemetry || null,
  };

  if (options.raw) output._raw = result;

  return output;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('parse-comfy-workflow')
  .description(
    'Parse a ComfyUI workflow JSON and output structured metadata.\n' +
    'Accepts a file path, or reads from stdin when no file is given.\n' +
    'Use "-" to explicitly read from stdin.',
  )
  .version('1.0.0')
  .argument('[file]', 'Path to ComfyUI workflow JSON file. Omit to read from stdin. Use "-" for explicit stdin.')
  .option('--stdin', 'Force reading from stdin even if a file path is provided')
  .option('--pretty', 'Pretty-print JSON output with 2-space indentation')
  .option('--raw', 'Include the raw (pre-cleaning) resolved result under _raw key')
  .option('--facts', 'Output in structured WorkflowFacts format (grouped sections)')
  .option('--no-telemetry', 'Omit telemetry data from output')
  .action(async (file: string | undefined, options: {
    stdin: boolean;
    pretty: boolean;
    raw: boolean;
    facts: boolean;
    telemetry: boolean;
  }) => {
    try {
      let rawJson: string;
      let sourceName: string;

      // Determine input source: stdin vs file
      const useStdin = options.stdin || file === '-' || file === undefined;

      if (useStdin) {
        rawJson = await readStdin();
        if (!rawJson.trim()) {
          console.error('Error: No input received on stdin.');
          console.error('Pipe JSON to this script, or provide a file path:');
          console.error('  cat workflow.json | npx tsx scripts/parse-comfy-workflow.ts');
          console.error('  npx tsx scripts/parse-comfy-workflow.ts workflow.json');
          process.exit(1);
        }
        sourceName = '<stdin>';
      } else {
        const filePath = resolve(file!);
        try {
          rawJson = readFileSync(filePath, 'utf-8');
        } catch {
          console.error(`Error: Cannot read file: ${filePath}`);
          process.exit(1);
        }
        sourceName = basename(filePath);
      }

      // Parse JSON and extract workflow/prompt
      const { workflow, prompt } = parseWorkflowJson(rawJson, sourceName);

      // Parse the graph
      const result = suppressDebugLogs(() =>
        resolvePromptFromGraph(workflow, prompt),
      );

      // Build output
      const output = options.facts
        ? buildFactsOutput(sourceName, result, options)
        : buildDefaultOutput(sourceName, result, options);

      // Write to stdout
      const json = options.pretty
        ? JSON.stringify(output, null, 2)
        : JSON.stringify(output);

      console.log(json);
    } catch (error) {
      console.error(
        'Error parsing workflow:',
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  });

program.parse();
