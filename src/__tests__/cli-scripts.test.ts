/**
 * Regression tests for CLI script fixes (2026-09-10).
 *
 * These exec the real scripts as subprocesses, matching the existing pattern in
 * cli.test.ts. Each test targets a bug that was silent from the outside:
 *   1. `cli.ts index` silently skipped .webp files
 *   2. `cli.ts index` always exited 0, hiding unparseable files
 *   3. `parse-comfy-workflow --no-telemetry` did nothing
 */
import { exec } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { test, expect, beforeAll, afterAll } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const TIMEOUT = 60_000;

let base: string;
let webpDir: string;
let brokenDir: string;

/** Minimal RIFF/WEBP container. Only the magic matters for extension scanning. */
function makeWebp(): Buffer {
  const riffBody = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8X', 'latin1'),
    Buffer.from([10, 0, 0, 0]),
    Buffer.alloc(10),
  ]);
  const riffSize = Buffer.alloc(4);
  riffSize.writeUInt32LE(riffBody.length, 0);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), riffSize, riffBody]);
}

/** SOI + COM + EOI: a JPEG with no SOF marker, so the dimension reader runs
 *  off the end of the buffer and throws. */
function makeBrokenJpeg(): Buffer {
  const comment = Buffer.from('Steps: 20, Sampler: Euler a', 'utf-8');
  const comLen = Buffer.alloc(2);
  comLen.writeUInt16BE(comment.length + 2, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xfe]), comLen, comment,
    Buffer.from([0xff, 0xd9]),
  ]);
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'silkstack-cli-test-'));
  // Separate directories so each test's file count is unambiguous.
  webpDir = join(base, 'webp-only');
  brokenDir = join(base, 'broken-only');
  mkdirSync(webpDir);
  mkdirSync(brokenDir);

  writeFileSync(join(webpDir, 'sample.webp'), makeWebp());
  writeFileSync(join(brokenDir, 'broken.jpg'), makeBrokenJpeg());

  writeFileSync(join(base, 'workflow.json'), JSON.stringify({
    '1': { inputs: { ckpt_name: 'model.safetensors' }, class_type: 'CheckpointLoaderSimple' },
    '2': { inputs: { text: 'a serene mountain lake at dawn' }, class_type: 'CLIPTextEncode' },
  }, null, 2));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function run(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    exec(command, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolvePromise({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test(
  'index detects .webp files',
  async () => {
    const { stdout } = await run(
      `npx tsx scripts/cli.ts index "${webpDir}" --out "${join(webpDir, 'out.jsonl')}"`,
    );
    // Regression: .webp was absent from the scanner's extension list, so the file
    // was not even counted. Exactly one image must be found in a webp-only dir.
    expect(stdout).toContain('Images found: 1');
  },
  TIMEOUT,
);

test(
  'index exits non-zero when a file cannot be parsed',
  async () => {
    const { code, stdout } = await run(
      `npx tsx scripts/cli.ts index "${brokenDir}" --out "${join(brokenDir, 'out.jsonl')}"`,
    );

    expect(stdout).toContain('Failed: 1');
    // Regression: this used to be 0, making partial failures invisible to scripts.
    expect(code).toBe(1);
  },
  TIMEOUT,
);

test(
  '--no-telemetry omits _telemetry, and telemetry is included by default',
  async () => {
    const workflow = join(base, 'workflow.json');

    const withTelemetry = await run(`npx tsx scripts/parse-comfy-workflow.ts "${workflow}"`);
    expect(withTelemetry.stdout).toContain('_telemetry');

    const without = await run(`npx tsx scripts/parse-comfy-workflow.ts "${workflow}" --no-telemetry`);
    // Regression: the flag set `telemetry: false` while the script read
    // `noTelemetry`, so the field was emitted either way.
    expect(without.stdout).not.toContain('_telemetry');
    expect(without.stdout).toContain('a serene mountain lake at dawn');
  },
  TIMEOUT,
);
