// @vitest-environment node
//
// Covers the checkpoint → base model resolver (electron/checkpointLookup.mjs).
//
// Two tests here are guard rails rather than feature tests:
//   - "sends only the checkpoint hash" pins down exactly what may leave the
//     machine, the same way usage-ping.test.ts pins the ping payload. Widening
//     it means widening the README's privacy section in the same change.
//   - the offline-table tests are what make the whole design worth having: a
//     second resolve of a known checkpoint must issue *zero* requests.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildCheckpointRef,
  checkpointKey,
  clearTable,
  isEntryFresh,
  normalizeModelName,
  readBaseModelTag,
  readTable,
  resolveCheckpoints,
  resolveCheckpoint,
  tablePathFor,
  writeTable,
  NEGATIVE_TTL_MS,
} from '../../electron/checkpointLookup.mjs';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A Civitai by-hash payload, trimmed to the fields the resolver reads. */
const civitaiHashPayload = (baseModel: string, name = 'v1-5-pruned-emaonly') => ({
  id: 66991,
  modelId: 62437,
  name,
  baseModel,
  model: { name, type: 'Checkpoint' },
});

describe('checkpointLookup', () => {
  let dir: string;
  let tablePath: string;
  let realFetch: typeof fetch;

  beforeEach(async () => {
    // Guard rail: resolveCheckpoints defaults fetchImpl to global fetch, so a
    // test that forgets to inject one would hit the live APIs. Make that loud.
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('real network is disabled in tests')),
    ) as unknown as typeof fetch;

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silkstack-base-model-'));
    tablePath = tablePathFor(dir);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** Routes requests by URL substring; records every URL and init it saw. */
  const installFetch = (routes: Array<{ match: string; status?: number; body?: unknown; headers?: Record<string, string> }>) => {
    const calls: Array<{ url: string; init: { headers?: Record<string, string> } | undefined }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), init });
      const route = routes.find((candidate) => String(url).includes(candidate.match));
      if (!route) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => null },
          json: async () => ({}),
        };
      }
      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => route.headers?.[name.toLowerCase()] ?? null },
        json: async () => route.body ?? {},
      };
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, mock: fetchImpl };
  };

  /** A sleep that records its durations instead of actually waiting. */
  const recordingSleep = () => {
    const slept: number[] = [];
    return { slept, sleep: async (ms: number) => { slept.push(ms); } };
  };

  describe('normalizeModelName', () => {
    it('strips directory prefixes, extensions and case', () => {
      expect(normalizeModelName('SDXL/juggernautXL_v9.safetensors')).toBe('juggernautxl v9');
      expect(normalizeModelName('C:\\models\\Pony_Diffusion_V6_XL.ckpt')).toBe('pony diffusion v6 xl');
    });

    it('preserves version numbers, which distinguish different checkpoints', () => {
      // Erasing these would merge unrelated checkpoints with different base
      // models — the one normalisation that would actively corrupt the column.
      expect(normalizeModelName('juggernautXL_v9')).not.toBe(normalizeModelName('juggernautXL_v10'));
      expect(normalizeModelName('ponyDiffusionV6XL')).not.toBe(normalizeModelName('ponyDiffusionV5XL'));
    });

    it('returns an empty string for non-strings', () => {
      expect(normalizeModelName(undefined)).toBe('');
      expect(normalizeModelName(null)).toBe('');
    });
  });

  describe('buildCheckpointRef', () => {
    it('reads the A1111 last-resort "Model hash:" name shape as a hash', () => {
      const ref = buildCheckpointRef({ name: 'Model hash: 6ce0161689' });
      expect(ref.hash).toBe('6ce0161689');
      expect(ref.name).toBeNull();
    });

    it('reads the ComfyUI "unknown (hash: ...)" shape as a hash', () => {
      // comfyUIParser truncates to 8 chars, so this must survive at AutoV1 length.
      const ref = buildCheckpointRef({ name: 'unknown (hash: 36fab8f3)' });
      expect(ref.hash).toBe('36fab8f3');
    });

    it('prefers an explicit hash field over the name', () => {
      // forgeParser / videoMetaHubParser stash the real hash in an extra key.
      const ref = buildCheckpointRef({ name: 'juggernautXL_v9', hash: 'A1B2C3D4E5' });
      expect(ref.hash).toBe('a1b2c3d4e5');
      expect(ref.name).toBe('juggernautxl v9');
    });

    it('treats an unlabelled hex name as a hash, not a name to search for', () => {
      const ref = buildCheckpointRef({ name: '36fab8f31a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5' });
      expect(ref.hash).not.toBeNull();
      expect(ref.name).toBeNull();
    });

    it('falls back to a name when there is no hash of any kind', () => {
      const ref = buildCheckpointRef({ name: 'SDXL/juggernautXL_v9.safetensors' });
      expect(ref.hash).toBeNull();
      expect(ref.name).toBe('juggernautxl v9');
      expect(ref.key).toBe('name:juggernautxl v9');
    });

    it('flags LoRA-shaped names', () => {
      expect(buildCheckpointRef({ name: 'detail_slider_lora' }).isLora).toBe(true);
      expect(buildCheckpointRef({ name: 'juggernautXL_v9' }).isLora).toBe(false);
    });

    it('produces no key when there is nothing identifiable', () => {
      expect(buildCheckpointRef({}).key).toBeNull();
      expect(buildCheckpointRef({ name: '   ' }).key).toBeNull();
    });
  });

  describe('checkpointKey', () => {
    it('tags the key with the hash scheme implied by its length', () => {
      // An 8-char CRC32 and an 8-char AutoV1 are indistinguishable in-band, so
      // they share a prefix rather than being guessed apart.
      expect(checkpointKey({ hash: 'a'.repeat(64) })).toBe(`sha256:${'a'.repeat(64)}`);
      expect(checkpointKey({ hash: '6ce0161689' })).toBe('autov2:6ce0161689');
      expect(checkpointKey({ hash: '36fab8f3' })).toBe('autov1:36fab8f3');
    });

    it('prefers a hash key over a name key', () => {
      expect(checkpointKey({ hash: '6ce0161689', name: 'anything' })).toBe('autov2:6ce0161689');
    });
  });

  describe('readBaseModelTag', () => {
    it('reads a plain base_model relation', () => {
      expect(readBaseModelTag(['diffusers', 'base_model:stabilityai/stable-diffusion-xl-base-1.0']))
        .toBe('stabilityai/stable-diffusion-xl-base-1.0');
    });

    it('skips adapter and quantized relations, which name an intermediate repo', () => {
      // LyliaEngine/Pony_Diffusion_V6_XL reports both forms; taking the adapter
      // one would report a fine-tune as the architecture.
      expect(readBaseModelTag([
        'base_model:adapter:Bakanayatsu/Pony-Diffusion-V6-XL-for-Anime',
        'base_model:Bakanayatsu/Pony-Diffusion-V6-XL-for-Anime',
      ])).toBe('Bakanayatsu/Pony-Diffusion-V6-XL-for-Anime');
    });

    it('returns null when there is no relation or no tags', () => {
      expect(readBaseModelTag(['diffusers', 'text-to-image'])).toBeNull();
      expect(readBaseModelTag(undefined)).toBeNull();
    });
  });

  describe('resolveCheckpoints — the offline table', () => {
    it('resolves a checkpoint over the network once, then never again', async () => {
      const first = installFetch([
        { match: 'by-hash', body: civitaiHashPayload('SD 1.5') },
      ]);

      const refs = [buildCheckpointRef({ name: 'Model hash: 6ce0161689' })];

      const run1 = await resolveCheckpoints({
        tablePath, refs, fetchImpl: first.fetchImpl, now: () => NOW,
      });
      expect(run1.results[0]?.baseModel).toBe('SD 1.5');
      expect(first.calls).toHaveLength(1);
      expect(run1.stats).toMatchObject({ total: 1, fromTable: 0, fetched: 1 });

      // The point of the whole design: the second run is fully offline.
      const second = installFetch([]);
      const run2 = await resolveCheckpoints({
        tablePath, refs, fetchImpl: second.fetchImpl, now: () => NOW + DAY,
      });
      expect(run2.results[0]?.baseModel).toBe('SD 1.5');
      expect(second.calls).toHaveLength(0);
      expect(run2.stats).toMatchObject({ total: 1, fromTable: 1, fetched: 0 });
    });

    it('aligned results let the caller zip by index, with null for unknowns', async () => {
      const { fetchImpl } = installFetch([
        { match: 'by-hash', body: civitaiHashPayload('Pony') },
      ]);
      const refs = [
        buildCheckpointRef({ name: 'other.safetensors' }),
        buildCheckpointRef({ name: 'Model hash: 6ce0161689' }),
        null,
      ];

      const { results } = await resolveCheckpoints({
        tablePath, refs: refs as never, fetchImpl, now: () => NOW,
      });

      expect(results).toHaveLength(3);
      expect(results[0]).toBeNull();
      expect(results[1]?.baseModel).toBe('Pony');
      expect(results[2]).toBeNull();
    });

    it('caches a miss, and expires it after the negative TTL', async () => {
      const refs = [buildCheckpointRef({ name: 'Model hash: 0000000000' })];

      const miss = installFetch([{ match: 'by-hash', status: 404 }]);
      await resolveCheckpoints({ tablePath, refs, fetchImpl: miss.fetchImpl, now: () => NOW });
      expect(miss.calls).toHaveLength(1);

      // Inside the TTL: served from the table, no request.
      const fresh = installFetch([]);
      await resolveCheckpoints({ tablePath, refs, fetchImpl: fresh.fetchImpl, now: () => NOW + DAY });
      expect(fresh.calls).toHaveLength(0);

      // Past the TTL: retried, because Civitai's coverage grows over time.
      const stale = installFetch([{ match: 'by-hash', body: civitaiHashPayload('Illustrious') }]);
      const run = await resolveCheckpoints({
        tablePath, refs, fetchImpl: stale.fetchImpl, now: () => NOW + NEGATIVE_TTL_MS + DAY,
      });
      expect(stale.calls).toHaveLength(1);
      expect(run.results[0]?.baseModel).toBe('Illustrious');
    });

    it('does not cache a network failure, so an offline run is not remembered as a miss', async () => {
      const refs = [buildCheckpointRef({ name: 'Model hash: 6ce0161689' })];
      const failing = installFetch([]); // every route 404s, but we want a hard failure

      // Simulate a transport error rather than a clean 404.
      const throwing = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
      const run = await resolveCheckpoints({
        tablePath, refs, fetchImpl: throwing, now: () => NOW, sleep: async () => {},
      });
      expect(run.results[0]).toBeNull();

      const table = await readTable(tablePath);
      expect(Object.keys(table.entries)).toHaveLength(0);

      // Next run, back online: the checkpoint resolves normally.
      const online = installFetch([{ match: 'by-hash', body: civitaiHashPayload('SDXL 1.0') }]);
      const retry = await resolveCheckpoints({
        tablePath, refs, fetchImpl: online.fetchImpl, now: () => NOW + DAY,
      });
      expect(retry.results[0]?.baseModel).toBe('SDXL 1.0');
      expect(failing.calls).toHaveLength(0);
    });

    it('answers a hash-less ComfyUI checkpoint from a name the table already learned', async () => {
      // The mixed-library case: Forge/A1111 images carry a hash and resolve
      // first; ComfyUI images of the same checkpoint carry only a filename.
      // Once the hash row lands, the ComfyUI name must cost nothing.
      const civitai = installFetch([
        {
          match: 'by-hash',
          body: {
            ...civitaiHashPayload('SDXL 1.0', 'juggernautXL_v9Rundiffusion'),
            files: [{ name: 'juggernautXL_v9Rundiffusion.safetensors' }],
          },
        },
      ]);

      const forgeRef = buildCheckpointRef({ name: 'Model hash: 6ce0161689' });
      const first = await resolveCheckpoints({
        tablePath, refs: [forgeRef], fetchImpl: civitai.fetchImpl, now: () => NOW,
      });
      expect(first.results[0]?.baseModel).toBe('SDXL 1.0');

      // ComfyUI: no hash, only the filename — and no network this time.
      const comfyRef = buildCheckpointRef({ name: 'SDXL/juggernautXL_v9Rundiffusion.safetensors' });
      expect(comfyRef.hash).toBeNull();

      const offline = installFetch([]);
      const second = await resolveCheckpoints({
        tablePath, refs: [comfyRef], fetchImpl: offline.fetchImpl, now: () => NOW + DAY,
      });

      expect(offline.calls).toHaveLength(0);
      expect(second.results[0]?.baseModel).toBe('SDXL 1.0');
      expect(second.stats).toMatchObject({ fromTable: 1, fetched: 0 });
    });

    it('does not let the alias index widen a hash lookup', async () => {
      // A ref that has a hash must be answered by that hash or not at all: a
      // matching *name* must never override a different file's identity.
      await writeTable(tablePath, {
        entries: {
          'autov2:aaaaaaaaaa': {
            baseModel: 'SD 1.5',
            source: 'civitai-hash',
            fetchedAt: NOW,
            checkpointName: 'shared-name',
          },
        },
      });

      const { fetchImpl, calls } = installFetch([{ match: 'by-hash', status: 404 }]);
      const ref = buildCheckpointRef({ name: 'shared-name.safetensors', hash: 'bbbbbbbbbb' });
      const { results } = await resolveCheckpoints({
        tablePath, refs: [ref], fetchImpl, now: () => NOW,
      });

      expect(calls[0].url).toContain('bbbbbbbbbb');
      expect(results[0]).toBeNull();
    });

    it('makes no requests at all when network access is disabled', async () => {
      const { fetchImpl, calls } = installFetch([
        { match: 'by-hash', body: civitaiHashPayload('SD 1.5') },
      ]);
      const refs = [buildCheckpointRef({ name: 'Model hash: 6ce0161689' })];

      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, allowNetwork: false, now: () => NOW,
      });

      expect(results[0]).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });

  describe('resolveCheckpoints — the lookup cascade', () => {
    it('falls through Civitai-by-hash → Civitai-by-name → HuggingFace', async () => {
      const { fetchImpl, calls } = installFetch([
        { match: 'by-hash', status: 404 },
        { match: 'civitai.com/api/v1/models', body: { items: [] } },
        {
          match: 'huggingface.co/api/models',
          body: [{ id: 'LyliaEngine/Pony_Diffusion_V6_XL', tags: ['base_model:stabilityai/stable-diffusion-xl-base-1.0'] }],
        },
      ]);

      const refs = [buildCheckpointRef({ name: 'Pony_Diffusion_V6_XL', hash: '6ce0161689' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW,
      });

      expect(calls.map((call) => call.url.split('?')[0])).toEqual([
        'https://civitai.com/api/v1/model-versions/by-hash/6ce0161689',
        'https://civitai.com/api/v1/models',
        'https://huggingface.co/api/models',
      ]);
      expect(results[0]?.baseModel).toBe('SDXL 1.0');
      expect(results[0]?.source).toBe('huggingface');
    });

    it('rejects a bare model-name match, which would be a guess about the version', async () => {
      // Civitai's search is fuzzy and returns the model's *current* version.
      // Matching "DreamShaper" against a `dreamshaper_8` file would name some
      // other release's base model, so only the file/version may match.
      const { fetchImpl } = installFetch([
        { match: 'by-hash', status: 404 },
        {
          match: 'civitai.com/api/v1/models',
          body: {
            items: [{
              id: 4384,
              name: 'DreamShaper',
              modelVersions: [{ id: 999, name: 'Ragnarok', baseModel: 'SDXL 1.0' }],
            }],
          },
        },
      ]);

      const refs = [buildCheckpointRef({ name: 'dreamshaper_8.safetensors' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW,
      });

      expect(results[0]).toBeNull();
    });

    it('matches an exact shipped filename, which identifies the file the user has', async () => {
      // The real Civitai shape: searching "dreamshaper_8" returns the model
      // "DreamShaper" whose version "8" ships "dreamshaper_8.safetensors".
      const { fetchImpl, calls } = installFetch([
        {
          match: 'civitai.com/api/v1/models',
          body: {
            items: [{
              id: 4384,
              name: 'DreamShaper',
              modelVersions: [
                {
                  id: 10222,
                  name: '8',
                  baseModel: 'SD 1.5',
                  files: [{ name: 'dreamshaper_8.safetensors' }, { name: 'dreamshaper_8.ckpt' }],
                },
                { id: 1, name: 'Ragnarok', baseModel: 'SDXL 1.0', files: [{ name: 'dreamshaperXL.safetensors' }] },
              ],
            }],
          },
        },
      ]);

      const refs = [buildCheckpointRef({ name: 'models/dreamshaper_8.safetensors' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW,
      });

      // The query keeps the human spelling; only the comparison is normalized.
      expect(calls[0].url).toContain('query=dreamshaper_8');
      expect(results[0]?.baseModel).toBe('SD 1.5');
      expect(results[0]?.civitaiVersionId).toBe(10222);
    });

    it('accepts a Civitai model-version name, which is what people actually download', async () => {
      const { fetchImpl } = installFetch([
        {
          match: 'civitai.com/api/v1/models',
          body: {
            items: [{
              id: 133005,
              name: 'Juggernaut XL',
              modelVersions: [{ id: 252415, name: 'juggernautXL_v9', baseModel: 'SDXL 1.0' }],
            }],
          },
        },
      ]);

      const refs = [buildCheckpointRef({ name: 'SDXL/juggernautXL_v9.safetensors' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW,
      });

      expect(results[0]?.baseModel).toBe('SDXL 1.0');
      expect(results[0]?.civitaiModelId).toBe(133005);
      expect(results[0]?.civitaiVersionId).toBe(252415);
    });

    it('names a canonical HuggingFace base repo that carries no tag of its own', async () => {
      const { fetchImpl } = installFetch([
        { match: 'civitai.com/api/v1/models', body: { items: [] } },
        { match: 'huggingface.co/api/models', body: [{ id: 'stabilityai/stable-diffusion-xl-base-1.0', tags: ['diffusers'] }] },
      ]);

      const refs = [buildCheckpointRef({ name: 'stable-diffusion-xl-base-1.0' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW,
      });

      expect(results[0]?.baseModel).toBe('SDXL 1.0');
    });

    it('rejects a HuggingFace base relation it cannot name', async () => {
      // HF mirrors declare each other as `base_model`, so an unrecognised
      // target is far more likely to be another copy of the same checkpoint
      // than an architecture. Blank beats a confidently wrong label.
      const { fetchImpl } = installFetch([
        { match: 'civitai.com/api/v1/models', body: { items: [] } },
        { match: 'huggingface.co/api/models', body: [{ id: 'someone/my-checkpoint', tags: ['base_model:SomeOrg/Unknown-Base-9'] }] },
      ]);

      const refs = [buildCheckpointRef({ name: 'my-checkpoint' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW,
      });

      expect(results[0]).toBeNull();
    });

    it('rejects a checkpoint mirror that declares a sibling mirror as its base', async () => {
      // The real HuggingFace shape for Pony v6: a dozen repos named after the
      // checkpoint, declaring each other. The tag normalizes to the same model
      // as the checkpoint itself, so accepting it would report the checkpoint
      // as its own base model.
      const { fetchImpl } = installFetch([
        { match: 'civitai.com/api/v1/models', body: { items: [] } },
        {
          match: 'huggingface.co/api/models',
          body: [{
            id: 'Naska223/ponyDiffusionV6XL_v6StartWithThisOne',
            tags: ['base_model:Artguy32/ponyDiffusionV6XL_v6StartWithThisOne'],
          }],
        },
      ]);

      const refs = [buildCheckpointRef({ name: 'ponyDiffusionV6XL_v6StartWithThisOne.safetensors' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW,
      });

      expect(results[0]).toBeNull();
    });
  });

  describe('rate limiting', () => {
    it('honours Retry-After on a 429 and then succeeds', async () => {
      const { slept, sleep } = recordingSleep();
      let attempt = 0;

      const fetchImpl = vi.fn(async () => {
        attempt++;
        if (attempt === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '7' : null) },
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => civitaiHashPayload('Pony'),
        };
      }) as unknown as typeof fetch;

      const refs = [buildCheckpointRef({ name: 'Model hash: 6ce0161689' })];
      const { results } = await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW, sleep,
      });

      expect(slept).toContain(7000); // Retry-After: 7 seconds
      expect(results[0]?.baseModel).toBe('Pony');
      expect(attempt).toBe(2);
    });

    it('backs off exponentially when a 429 arrives without Retry-After', async () => {
      const { slept, sleep } = recordingSleep();
      const fetchImpl = vi.fn(async () => ({
        ok: false,
        status: 429,
        headers: { get: () => null },
        json: async () => ({}),
      })) as unknown as typeof fetch;

      const refs = [buildCheckpointRef({ name: 'Model hash: 6ce0161689' })];
      await resolveCheckpoints({ tablePath, refs, fetchImpl, now: () => NOW, sleep });

      expect(slept).toContain(2000);
      expect(slept).toContain(4000);
    });

    it('spaces request starts by the minimum interval', async () => {
      const starts: number[] = [];
      const { sleep } = recordingSleep();
      let clock = NOW;

      const fetchImpl = vi.fn(async () => {
        starts.push(clock);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => civitaiHashPayload('SD 1.5'),
        };
      }) as unknown as typeof fetch;

      const refs = [
        buildCheckpointRef({ name: 'Model hash: 6ce0161689' }),
        buildCheckpointRef({ name: 'Model hash: 36fab8f31a' }),
      ];

      await resolveCheckpoints({
        tablePath,
        refs,
        fetchImpl,
        // Advance the clock only when the limiter sleeps, so the assertion is
        // about the limiter rather than about real elapsed time.
        now: () => clock,
        sleep: async (ms: number) => { await sleep(ms); clock += ms; },
        minIntervalMs: 250,
        concurrency: 2,
      });

      expect(starts).toHaveLength(2);
      expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(250);
    });
  });

  describe('privacy', () => {
    it('sends only the checkpoint hash, in the URL, with no library data in the headers', async () => {
      // The guard rail. If this ever fails, something new is leaving the
      // machine — update README → "License, privacy & offline use", AGENTS.md,
      // and the CHANGELOG before updating this test.
      const { fetchImpl, calls } = installFetch([
        { match: 'by-hash', body: civitaiHashPayload('SD 1.5') },
      ]);

      const refs = [buildCheckpointRef({ name: 'Model hash: 6ce0161689' })];
      await resolveCheckpoints({
        tablePath, refs, fetchImpl, now: () => NOW, appVersion: '2.4.0',
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://civitai.com/api/v1/model-versions/by-hash/6ce0161689');
      expect(calls[0].init?.headers).toEqual({
        Accept: 'application/json',
        'User-Agent': 'SilkStack/2.4.0',
      });
    });
  });

  describe('the table file', () => {
    it('round-trips through disk', async () => {
      await writeTable(tablePath, {
        entries: { 'autov2:6ce0161689': { baseModel: 'SD 1.5', source: 'civitai-hash', fetchedAt: NOW } },
      });
      const table = await readTable(tablePath);
      expect(table.entries['autov2:6ce0161689']).toMatchObject({ baseModel: 'SD 1.5' });
    });

    it('treats a missing or corrupt file as an empty table rather than an error', async () => {
      expect((await readTable(tablePath)).entries).toEqual({});

      await fs.writeFile(tablePath, '{ this is not json');
      expect((await readTable(tablePath)).entries).toEqual({});
    });

    it('clears on demand', async () => {
      await writeTable(tablePath, { entries: { a: { baseModel: 'SD 1.5' } } });
      await clearTable(tablePath);
      expect((await readTable(tablePath)).entries).toEqual({});
    });

    it('writes atomically, leaving no temp file behind', async () => {
      await writeTable(tablePath, { entries: { a: { baseModel: 'SD 1.5' } } });
      const files = await fs.readdir(dir);
      expect(files).toEqual([path.basename(tablePath)]);
    });
  });

  describe('isEntryFresh', () => {
    it('treats a hit as fresh forever and a miss only until it expires', () => {
      expect(isEntryFresh({ baseModel: 'SD 1.5' }, NOW + 100 * DAY)).toBe(true);
      expect(isEntryFresh({ baseModel: null, expiresAt: NOW + DAY }, NOW)).toBe(true);
      expect(isEntryFresh({ baseModel: null, expiresAt: NOW - 1 }, NOW)).toBe(false);
      expect(isEntryFresh(undefined, NOW)).toBe(false);
    });
  });

  describe('resolveCheckpoint', () => {
    it('returns a miss when the ref carries nothing identifiable', async () => {
      const outcome = await resolveCheckpoint({ key: null }, { fetchImpl: vi.fn() as never });
      expect(outcome.outcome).toBe('miss');
    });
  });
});
