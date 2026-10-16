import fs from 'node:fs/promises';
import path from 'node:path';

// Only what this module *uses*: the rest of the identity helpers are re-exported
// below, and a re-export needs no local binding.
import {
  buildNameIndex,
  isEntryFresh,
  learnedNameFor,
  manualMappingFor,
  normalizeModelName,
  readBaseModelTag,
} from './checkpointKeys.mjs';

// Re-exported so callers (and the tests) can import every checkpoint-identity
// helper from the module they already use, while the definitions live in the
// dependency-free half that the renderer can also import.
export {
  buildCheckpointRef,
  buildNameIndex,
  checkpointKey,
  entryAliases,
  isEntryFresh,
  learnedNameFor,
  manualMappingFor,
  NAME_KEY_PREFIX,
  normalizeModelName,
  readBaseModelTag,
  matchEncodedHash,
} from './checkpointKeys.mjs';

/** Civitai API v1 — public, no API key. See README for the outbound-call list. */
export const CIVITAI_HASH_ENDPOINT = 'https://civitai.com/api/v1/model-versions/by-hash/';
export const CIVITAI_MODELS_ENDPOINT = 'https://civitai.com/api/v1/models';

/** HuggingFace Hub API — public, no token. */
export const HUGGINGFACE_MODELS_ENDPOINT = 'https://huggingface.co/api/models';

export const TABLE_FILE_NAME = 'checkpoint-base-models.json';
export const TABLE_VERSION = 1;

export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A miss is cached too, but expires: a checkpoint genuinely absent from Civitai
 * today may be uploaded next month, and, more importantly, a *transient* 404
 * (site outage, rate-limit page) must not become permanent.
 */
export const NEGATIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Politeness limits. Civitai asks for identification and answers anonymous
 * callers with a 5-minute edge cache; HuggingFace is generous. Two in flight
 * with a 250 ms gap resolves a 60-checkpoint library in a few seconds while
 * staying well clear of anything that looks like scraping.
 */
export const MAX_CONCURRENT_REQUESTS = 2;
export const MIN_REQUEST_INTERVAL_MS = 250;

/** 429 handling: honour Retry-After, else back off exponentially from here. */
export const BACKOFF_BASE_MS = 2000;
export const MAX_ATTEMPTS = 3;

/**
 * Exact knowledge, not a heuristic: a handful of canonical base repositories
 * carry no `base_model:` tag of their own (they *are* the base), so their
 * display name has to come from somewhere. Kept deliberately tiny — anything
 * not listed is treated as unknown rather than guessed at.
 */
const KNOWN_BASE_REPOS = {
  'stable-diffusion-v1-5/stable-diffusion-v1-5': 'SD 1.5',
  'runwayml/stable-diffusion-v1-5': 'SD 1.5',
  'stabilityai/stable-diffusion-2-1': 'SD 2.1',
  'stabilityai/stable-diffusion-xl-base-1.0': 'SDXL 1.0',
  'stabilityai/stable-diffusion-xl-refiner-1.0': 'SDXL 1.0',
  'stabilityai/stable-diffusion-3-medium': 'SD 3 Medium',
  'stabilityai/stable-diffusion-3.5-large': 'SD 3.5 Large',
  'stabilityai/stable-diffusion-3.5-medium': 'SD 3.5 Medium',
  'black-forest-labs/FLUX.1-dev': 'Flux.1 D',
  'black-forest-labs/FLUX.1-schnell': 'Flux.1 S',
};

/** Promise-based sleep that never keeps the event loop alive on its own. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialises request *starts* so no two fire closer together than
 * `minIntervalMs`, regardless of how many workers are running.
 *
 * This is a start-spacing limiter, not a concurrency limiter: the concurrency
 * cap is applied by the caller's worker pool. Keeping the two concerns apart
 * means a 429 backoff inside one worker still spaces every other worker's
 * starts correctly.
 *
 * @param {{ minIntervalMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
 */
export function createStartLimiter({
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  let chain = Promise.resolve();
  let lastStart = -Infinity;

  return function nextSlot() {
    const slot = chain.then(async () => {
      const wait = lastStart + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
    });
    // Failures must not poison the chain for later callers.
    chain = slot.catch(() => {});
    return slot;
  };
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, preserving
 * input order in the result. Rejections are the worker's problem — this
 * function only schedules.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {number} concurrency
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

/**
 * One HTTP GET with timeout, identification and 429 backoff.
 *
 * Returns `{ ok, status, body }` rather than throwing on a non-2xx, because a
 * 404 is a *normal answer* here ("Civitai has never seen this checkpoint") and
 * must be cached as a miss rather than retried. Only transport failures and
 * retry exhaustion produce `ok: false` with no body.
 *
 * @param {string} url
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   headers?: Record<string, string>,
 *   sleep?: (ms: number) => Promise<void>,
 *   nextSlot?: () => Promise<void>,
 *   maxAttempts?: number,
 * }} [options]
 */
export async function fetchJson(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
  headers = {},
  sleep = defaultSleep,
  nextSlot = async () => {},
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 0, body: null };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await nextSlot();

      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const status = response?.status ?? 0;

      if (status === 429) {
        // Retry-After is in seconds per RFC 9110; a date form is legal but
        // Civitai has never sent one, so only the numeric form is honoured.
        const retryAfter = Number(response?.headers?.get?.('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BACKOFF_BASE_MS * 2 ** (attempt - 1);
        if (attempt < maxAttempts) {
          await sleep(Math.min(wait, 60_000));
          continue;
        }
        return { ok: false, status, body: null };
      }

      if (status === 404) {
        return { ok: true, status, body: null };
      }

      if (status < 200 || status >= 300) {
        // 5xx and anything else unexpected: worth one more try, unlike 404.
        if (attempt < maxAttempts && status >= 500) {
          await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, status, body: null };
      }

      const body = await response.json();
      return { ok: true, status, body };
    } catch {
      if (attempt < maxAttempts) {
        await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      return { ok: false, status: 0, body: null };
    }
  }

  return { ok: false, status: 0, body: null };
}

/**
 * Civitai by file hash — the fast path, and the reason A1111/Forge libraries
 * resolve almost perfectly. Accepts AutoV1 (8), AutoV2 (10) and SHA256 (64)
 * at the same URL; the API figures out which it was given.
 *
 * @param {string} hash
 * @param {object} [options]
 */
async function lookupCivitaiByHash(hash, options) {
  const { ok, status, body } = await fetchJson(
    `${CIVITAI_HASH_ENDPOINT}${encodeURIComponent(hash)}`,
    options,
  );

  if (!ok) return { outcome: 'error', status };
  if (!body || typeof body.baseModel !== 'string' || !body.baseModel) {
    return { outcome: 'miss', status };
  }

  return {
    outcome: 'hit',
    status,
    result: {
      baseModel: body.baseModel,
      source: 'civitai-hash',
      confidence: 1,
      checkpointName: typeof body.name === 'string' ? body.name : undefined,
      // The version's own filename(s) — recorded so a hash-less ComfyUI image
      // pointing at the same file can be resolved offline later.
      fileNames: readFileNames(body),
      civitaiModelId: Number.isFinite(body.modelId) ? body.modelId : undefined,
      civitaiVersionId: Number.isFinite(body.id) ? body.id : undefined,
    },
  };
}

/**
 * The `.safetensors` / `.ckpt` filenames a Civitai model version ships.
 *
 * @param {{ files?: Array<{ name?: string }> }} body
 * @returns {string[]}
 */
function readFileNames(body) {
  if (!Array.isArray(body?.files)) return [];
  return body.files
    .map((file) => (typeof file?.name === 'string' ? file.name : ''))
    .filter(Boolean);
}

/**
 * Civitai by name — the fallback for checkpoints whose metadata carried no
 * hash, which in practice means ComfyUI (its workflows record only
 * `ckpt_name`).
 *
 * Civitai's `query=` is a *fuzzy full-text* search: asking for
 * "juggernautXL_v9Rundiffusion" returns "Juggernaut XL → Ragnarok", the model's
 * current version rather than the one the user has. So the search only
 * *proposes* candidates; the decision is made here by exact comparison. Two
 * comparisons are accepted, both of which identify the specific file rather
 * than the model in general:
 *
 *   1. `files[].name` — the literal filename this version ships. Comparing it
 *      normalized against the user's normalized checkpoint name is as strong
 *      as a hash hit, because it is the same file.
 *   2. the version name — matches when the user's filename is the version
 *      name, which is how Civitai-named downloads often arrive.
 *
 * Deliberately *not* accepted: a bare model-name match. "DreamShaper" matching
 * the user's `dreamshaper_8` would be a guess about which version they had, and
 * a wrong base model is worse than a blank one — it silently corrupts every
 * filter built on the column.
 *
 * @param {{ name: string, query?: string | null }} ref
 * @param {object} [options]
 */
async function lookupCivitaiByName(ref, options) {
  const name = ref.name;
  const url = `${CIVITAI_MODELS_ENDPOINT}?query=${encodeURIComponent(ref.query || name)}&types=Checkpoint&limit=20`;
  const { ok, status, body } = await fetchJson(url, options);

  if (!ok) return { outcome: 'error', status };

  const items = Array.isArray(body?.items) ? body.items : [];

  for (const item of items) {
    const versions = Array.isArray(item?.modelVersions) ? item.modelVersions : [];

    for (const version of versions) {
      if (typeof version?.baseModel !== 'string' || !version.baseModel) continue;

      const fileNames = readFileNames(version);
      const fileMatch = fileNames.some((fileName) => normalizeModelName(fileName) === name);
      const versionMatch = normalizeModelName(version?.name) === name;
      if (!fileMatch && !versionMatch) continue;

      return {
        outcome: 'hit',
        status,
        result: {
          baseModel: version.baseModel,
          source: 'civitai-name',
          // A filename match identifies the file; a version-name match
          // identifies the release. Both are exact, neither is a guess.
          confidence: fileMatch ? 0.9 : 0.8,
          checkpointName: typeof version.name === 'string' ? version.name : undefined,
          fileNames,
          civitaiModelId: Number.isFinite(item.id) ? item.id : undefined,
          civitaiVersionId: Number.isFinite(version.id) ? version.id : undefined,
        },
      };
    }
  }

  return { outcome: 'miss', status };
}

/**
 * HuggingFace by exact repo-name match.
 *
 * The search endpoint already returns each candidate's tags, so one request is
 * enough — no second round trip to fetch full repo metadata.
 *
 * @param {string} name Normalized name to match.
 * @param {object} [options]
 */
async function lookupHuggingFace(name, options) {
  const url = `${HUGGINGFACE_MODELS_ENDPOINT}?search=${encodeURIComponent(name)}&limit=10`;
  const { ok, status, body } = await fetchJson(url, options);

  if (!ok) return { outcome: 'error', status };
  if (!Array.isArray(body)) return { outcome: 'miss', status };

  for (const repo of body) {
    const repoId = typeof repo?.id === 'string' ? repo.id : repo?.modelId;
    if (typeof repoId !== 'string') continue;
    if (normalizeModelName(repoId) !== name) continue;

    // The repo is itself a canonical base (a base repo carries no tag of its own).
    const knownBase = KNOWN_BASE_REPOS[repoId.toLowerCase()];
    if (knownBase) {
      return {
        outcome: 'hit',
        status,
        result: {
          baseModel: knownBase,
          source: 'huggingface',
          confidence: 1,
          checkpointName: repoId,
          huggingfaceRepo: repoId,
        },
      };
    }

    const baseRepo = readBaseModelTag(repo?.tags);
    const declaredBase = baseRepo ? KNOWN_BASE_REPOS[baseRepo.toLowerCase()] : null;

    // Only a base we can actually name is accepted.
    //
    // HuggingFace is full of mirrors of the same popular checkpoints
    // (`AiAF/ponyDiffusionV6XL_v6StartWithThisOne`, and a dozen siblings), and
    // their `base_model:` tags point at each other rather than at an
    // architecture. Reporting the tag verbatim would fill the column with the
    // checkpoint's own name — true to the tag, useless to the reader, and worse
    // than blank because it looks like an answer.
    if (!declaredBase) continue;

    return {
      outcome: 'hit',
      status,
      result: {
        baseModel: declaredBase,
        source: 'huggingface',
        confidence: 0.8,
        checkpointName: repoId,
        huggingfaceRepo: repoId,
      },
    };
  }

  return { outcome: 'miss', status };
}

/**
 * Resolves one checkpoint through the cascade. Never throws: every failure is
 * an `error` outcome, which the caller leaves *uncached* so it is retried on a
 * later run instead of being remembered as a permanent miss.
 *
 * @param {{ hash?: string | null, name?: string | null, key?: string | null }} ref
 * @param {object} [options]
 * @returns {Promise<{ outcome: 'hit' | 'miss' | 'error', result?: object, status?: number }>}
 */
export async function resolveCheckpoint(ref, options = {}) {
  if (!ref?.key) return { outcome: 'miss', status: 0 };

  const attempts = [];

  if (ref.hash) {
    attempts.push(() => lookupCivitaiByHash(ref.hash, options));
  }
  if (ref.name) {
    attempts.push(() => lookupCivitaiByName(ref, options));
    attempts.push(() => lookupHuggingFace(ref.name, options));
  }

  let sawError = false;
  for (const attempt of attempts) {
    const outcome = await attempt();
    if (outcome.outcome === 'hit') return outcome;
    if (outcome.outcome === 'error') sawError = true;
  }

  // A transport failure anywhere in the chain means "unknown", not "absent" —
  // reporting a miss would freeze a network problem into the offline table.
  return sawError ? { outcome: 'error', status: 0 } : { outcome: 'miss', status: 404 };
}

let tableLock = Promise.resolve();

/**
 * Serializes read-modify-write cycles on the table file.
 *
 * Two writers touch it: a resolve run's write-back and `setManualMappings` from
 * the settings screen. Both read the file, merge, and write it back with awaits
 * in between, so the main process can interleave them — and a user saving a
 * mapping while a resolve is in flight is exactly that case, not a rare one.
 * Chaining the cycles means the second writer sees the first one's write rather
 * than a stale snapshot of it.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withTableLock(fn) {
  const result = tableLock.then(fn, fn);
  // The chain must not carry a rejection forward, or one failed write would
  // poison every later one.
  tableLock = result.then(
    () => {},
    () => {},
  );
  return result;
}

/**
 * Reads the offline table. A missing or corrupt file is an empty table, never
 * an error — the table is a cache, and losing it must cost a re-fetch at worst.
 *
 * @param {string} tablePath
 * @returns {Promise<{ version: number, entries: Record<string, object> }>}
 */
export async function readTable(tablePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(tablePath, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
      return { version: TABLE_VERSION, entries: parsed.entries };
    }
  } catch {
    // Missing, unreadable or malformed — fall through to an empty table.
  }
  return { version: TABLE_VERSION, entries: {} };
}

/**
 * Writes the table atomically (temp file + rename) so a crash mid-write cannot
 * leave a half-serialized table that would read back as a silent full miss.
 *
 * @param {string} tablePath
 * @param {{ entries: Record<string, object> }} table
 * @param {{ readFile?: typeof fs.readFile, writeFile?: typeof fs.writeFile, rename?: typeof fs.rename }} [io]
 */
export async function writeTable(tablePath, table, io = {}) {
  const writeFile = io.writeFile || fs.writeFile;
  const rename = io.rename || fs.rename;
  const mkdir = io.mkdir || fs.mkdir;
  const tempPath = `${tablePath}.tmp`;

  const payload = JSON.stringify({ version: TABLE_VERSION, entries: table.entries }, null, 2);

  // The cache root can legitimately not exist yet — a fresh profile whose
  // cachePath points at a folder the app has not written to, or a CLI run
  // against one. Without this the write fails ENOENT and is swallowed by the
  // caller, which would look exactly like "resolution never works".
  await mkdir(path.dirname(tablePath), { recursive: true });

  await writeFile(tempPath, payload);
  await rename(tempPath, tablePath);
}

/**
 * Resolves a batch of checkpoint refs, consulting the offline table first and
 * the network only for what is missing.
 *
 * Anything the table can answer costs no request at all: a row filed under the
 * ref's own key, a name the table already learned, and — the one case that has
 * to outrank the others — a mapping the user wrote by hand, which answers the
 * images of every ref carrying its name whether or not they have a hash.
 *
 * The returned array is **positionally aligned with `refs`**, which is what
 * lets the renderer zip results straight back onto its own list without
 * agreeing on a key format with this module.
 *
 * @param {{
 *   tablePath: string,
 *   refs: Array<{ hash?: string | null, name?: string | null, key?: string | null }>,
 *   allowNetwork?: boolean,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   minIntervalMs?: number,
 *   concurrency?: number,
 *   timeoutMs?: number,
 *   appVersion?: string,
 *   io?: object,
 * }} options
 */
export async function resolveCheckpoints({
  tablePath,
  refs = [],
  allowNetwork = true,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  concurrency = MAX_CONCURRENT_REQUESTS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  appVersion,
  io = {},
} = {}) {
  const table = await readTable(tablePath);
  const startedAt = now();

  const results = new Array(refs.length).fill(null);
  /** @type {number[]} indexes still needing the network */
  const pending = [];

  /**
   * What the table can answer by *name*, for a ref whose key is not the thing
   * the image carries. Built by the identity module so the renderer's display
   * path asks the same question of the same rows and gets the same answer —
   * see `buildNameIndex`.
   */
  const nameIndex = buildNameIndex(table.entries, startedAt);

  refs.forEach((ref, index) => {
    if (!ref?.key) return;

    // A mapping the user filed by *name* answers first, ahead of the table's own
    // answer for this ref. That ordering is the point: the mapping is a
    // statement about the model, so it holds for every image of it — including
    // an image whose hash the app already answered (wrongly, or for a different
    // revision of the same name) and including a cached "not found", which is
    // the absence of an answer rather than one. Without this, mapping a
    // checkpoint in Settings would work for some of its images and silently do
    // nothing for the rest, and the ones it skipped would still be looked up.
    const mapped = manualMappingFor(ref, nameIndex);
    if (mapped) {
      results[index] = mapped;
      return;
    }

    const entry = table.entries[ref.key];
    if (isEntryFresh(entry, startedAt)) {
      results[index] = entry.baseModel ? entry : null;
      return;
    }

    // No hash: the filename is the only identity this image can offer, so any
    // name the table has learned answers it — that is what makes a ComfyUI
    // library resolve with no network once one hashed image of the same file
    // did. Looked-up entries are held to that rule and no further (see
    // `learnedNameFor`); the manual rows that are allowed past it were matched
    // above.
    const aliased = learnedNameFor(ref, nameIndex);
    if (aliased) {
      results[index] = aliased;
      return;
    }

    pending.push(index);
  });

  let fetched = 0;
  if (pending.length > 0 && allowNetwork && typeof fetchImpl === 'function') {
    const nextSlot = createStartLimiter({ minIntervalMs, now, sleep });
    const headers = {
      Accept: 'application/json',
      'User-Agent': `SilkStack/${appVersion ?? 'unknown'}`,
    };
    const requestOptions = { fetchImpl, timeoutMs, headers, sleep, nextSlot };

    const resolved = await mapWithConcurrency(pending, async (index) => {
      const ref = refs[index];
      const outcome = await resolveCheckpoint(ref, requestOptions);

      if (outcome.outcome === 'error') {
        // Left uncached on purpose — a network failure is not knowledge.
        return { index, entry: null, cached: false };
      }

      const entry = outcome.outcome === 'hit'
        ? { ...outcome.result, fetchedAt: now() }
        : { baseModel: null, source: 'miss', fetchedAt: now(), expiresAt: now() + NEGATIVE_TTL_MS };

      return { index, key: ref.key, entry, cached: true };
    }, concurrency);

    // Which result slot belongs to which checkpoint key, so the write-back
    // below can correct a slot when a mapping turns up for it.
    const resolvedIndexByKey = new Map();

    for (const item of resolved) {
      if (!item.cached) continue;
      table.entries[item.key] = item.entry;
      results[item.index] = item.entry.baseModel ? item.entry : null;
      resolvedIndexByKey.set(item.key, item.index);
      fetched++;
    }

    if (fetched > 0) {
      try {
        await withTableLock(async () => {
          // Re-read before writing. `table` is a snapshot of the file taken
          // before these requests were made, so a mapping the user saved while
          // they were in flight exists *only* on disk — and writing the
          // snapshot would erase it and answer with the network's value
          // instead. The latest manual rows are merged in, and the results
          // computed above are corrected to match.
          const latest = await readTable(tablePath);
          for (const [key, entry] of Object.entries(latest.entries)) {
            if (entry?.source !== 'manual') continue;
            table.entries[key] = entry;
            const index = resolvedIndexByKey.get(key);
            if (index !== undefined) results[index] = entry;
          }

          await writeTable(tablePath, table, io);
        });
      } catch {
        // An unwritable cache must not fail the resolve — the caller still
        // gets usable results, it just pays for them again next run.
      }
    }
  }

  return {
    results,
    stats: { total: refs.length, fromTable: refs.length - pending.length, fetched },
  };
}

/**
 * Discards the offline table's *looked-up* entries, keeping any the user wrote
 * by hand.
 *
 * A manual mapping is authored data, not cache: it is the answer for a
 * checkpoint Civitai and HuggingFace do not know (or that the user has since
 * deleted), and no amount of re-resolving would ever bring it back. Losing a
 * whole library's worth of those to a button labelled "clear cached table"
 * would be the worst kind of surprise, so the manual rows are carried over.
 *
 * @param {string} tablePath
 * @param {{ readFile?: typeof fs.readFile, writeFile?: typeof fs.writeFile, rename?: typeof fs.rename }} [io]
 */
export async function clearTable(tablePath, io = {}) {
  return withTableLock(async () => {
    const table = await readTable(tablePath);
    const manual = Object.fromEntries(
      Object.entries(table.entries).filter(([, entry]) => entry?.source === 'manual'),
    );
    await writeTable(tablePath, { entries: manual }, io);
  });
}

/**
 * Applies user-authored checkpoint → base model mappings.
 *
 * These are stored as ordinary rows carrying `source: 'manual'`, which buys
 * three things for free: `isEntryFresh` already treats any truthy baseModel as
 * permanent, the direct key lookup answers them offline like any other hit, and
 * `entryAliases` lets a later, hash-less image of the same file use them. The
 * only change that required is in `resolveCheckpoints`, which must decline to
 * overwrite them.
 *
 * A mapping whose `baseModel` is empty *removes* the manual row, handing the
 * checkpoint back to automatic resolution. An automatic row is never dropped
 * this way — that would discard a lookup nobody asked to lose.
 *
 * @param {string} tablePath
 * @param {Array<{ key: string, baseModel?: string | null, checkpointName?: string | null }>} mappings
 * @param {{ readFile?: typeof fs.readFile, writeFile?: typeof fs.writeFile, rename?: typeof fs.rename }} [io]
 * @returns {Promise<{ version: number, entries: Record<string, object> }>} the table as written
 */
export async function setManualMappings(tablePath, mappings, io = {}) {
  return withTableLock(async () => {
    const table = await readTable(tablePath);

    for (const mapping of mappings || []) {
      const key = mapping?.key;
      if (!key) continue;

      const baseModel = typeof mapping.baseModel === 'string' ? mapping.baseModel.trim() : '';

      if (baseModel) {
        table.entries[key] = {
          baseModel,
          source: 'manual',
          // The name the checkpoint is known by locally. For a hash-keyed row
          // this is what lets the same file resolve from a hash-less ComfyUI
          // image; for a name-keyed row it merely restates the key.
          ...(mapping.checkpointName ? { checkpointName: mapping.checkpointName } : {}),
          fetchedAt: Date.now(),
        };
      } else if (table.entries[key]?.source === 'manual') {
        delete table.entries[key];
      }
    }

    await writeTable(tablePath, table, io);
    return table;
  });
}

/**
 * The table's on-disk location. It lives under the cache root, not userData,
 * so "delete cache folder" clears it along with everything else derived.
 *
 * @param {string} cacheRootPath
 */
export function tablePathFor(cacheRootPath) {
  return path.join(cacheRootPath, TABLE_FILE_NAME);
}
