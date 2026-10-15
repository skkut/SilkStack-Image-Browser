/**
 * Renderer side of the checkpoint → base model lookup.
 *
 * Holds the offline table in memory and answers "what is this image's base
 * model?" for the table column, the sidebar facet, sorting and search.
 *
 * The important property is that this is **per checkpoint, not per image**. The
 * map below has one entry per distinct checkpoint in the library — a few dozen
 * entries for tens of thousands of images — and every image reads from it. That
 * is why the feature costs a handful of requests once and then nothing, why no
 * per-image cache schema had to change, and why re-resolving is instant.
 *
 * Checkpoint identity is derived by `buildCheckpointRef` from
 * electron/checkpointKeys.mjs, the *same* function the main process uses to key
 * its table. Sharing it matters: if the two sides disagreed about a key, every
 * lookup would miss forever and the table would grow without ever being read.
 */

import { buildCheckpointRef } from '../../electron/checkpointKeys.mjs';
import type { BaseModelEntry, CheckpointRef, IndexedImage } from '../types';

/**
 * Progress of an online resolution run, for the toolbar chip. `fetched` counts
 * the checkpoints that actually needed a network round trip, which is what
 * makes the "resolved once, never again" property visible to the user.
 */
export interface BaseModelResolveStatus {
  state: 'idle' | 'resolving' | 'done';
  /** Distinct checkpoints found across the library. */
  total: number;
  /** Of those, how many now have a base model (offline table + this run). */
  resolved: number;
  /** How many required a network request this run. */
  fetched: number;
  error: string | null;
}

/**
 * The offline table, keyed by checkpoint key. Hits only — cached misses are
 * remembered by the main process but are nothing to display.
 */
let baseModelMap: Record<string, string> = {};

const listeners = new Set<() => void>();

/** Bounded memo, see `checkpointRefForImage`. */
const refMemo = new Map<string, CheckpointRef>();
const REF_MEMO_LIMIT = 4096;

const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;

function notify() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A broken subscriber must not stop the others.
    }
  }
}

/**
 * Subscribe to table changes. Returns an unsubscribe function.
 */
export function subscribeToBaseModelTable(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current table: checkpoint key → display base model. */
export function getBaseModelMap(): Record<string, string> {
  return baseModelMap;
}

/** True when online resolution is possible at all (desktop build). */
export function isBaseModelLookupAvailable(): boolean {
  return isElectron;
}

/**
 * The untyped metadata keys a parser may have stashed a real hash in. Forge
 * writes `modelHash`, the MetaHub video parser writes `model_hash`, and both
 * survive only through BaseMetadata's index signature — so they are read here
 * rather than declared on the type.
 */
function readModelHash(image: IndexedImage): string | null {
  const meta = image.metadata as any;
  const normalized = meta?.normalizedMetadata;
  const candidates = [
    normalized?.model_hash,
    normalized?.modelHash,
    normalized?.hash,
    meta?.model_hash,
    meta?.modelHash,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * The checkpoint an image was made with, as an identity the lookup understands.
 *
 * Memoized on the raw inputs (`models[0]` + hash) rather than on the image id,
 * because those two strings are what actually determine the answer and they
 * survive the store replacing an image object on every enrichment pass. There
 * are only a few dozen distinct pairs in a library, so the memo is effectively
 * a permanent hit after the first frame.
 */
export function checkpointRefForImage(image: IndexedImage): CheckpointRef {
  const name = image.models?.[0] || '';
  const hash = readModelHash(image) || '';
  const memoKey = `${hash}\u0000${name}`;

  const memoized = refMemo.get(memoKey);
  if (memoized) return memoized;

  const ref = buildCheckpointRef({ name, hash: hash || null }) as CheckpointRef;

  if (refMemo.size >= REF_MEMO_LIMIT) refMemo.clear();
  refMemo.set(memoKey, ref);
  return ref;
}

/**
 * The base model for an image, or an empty string when it is not known (yet).
 *
 * LoRAs are skipped: a LoRA's own base model says nothing about the checkpoint
 * that rendered the image, and `models[0]` is a checkpoint by construction.
 */
export function baseModelForImage(image: IndexedImage): string {
  const ref = checkpointRefForImage(image);
  if (!ref.key || ref.isLora) return '';
  return baseModelMap[ref.key] || '';
}

/**
 * Loads the table the main process already has on disk. Purely local — this
 * never makes a request, so it is safe to call on every library load.
 */
export async function loadBaseModelTable(): Promise<void> {
  if (!isElectron) return;
  try {
    const response = await window.electronAPI!.getBaseModelTable();
    if (!response?.success || !response.entries) return;

    const next: Record<string, string> = {};
    for (const [key, entry] of Object.entries(response.entries)) {
      if (entry?.baseModel) next[key] = entry.baseModel;
    }

    baseModelMap = next;
    notify();
  } catch {
    // A missing table is not an error — it just means nothing is resolved yet.
  }
}

/**
 * Resolves the given checkpoints, using the offline table first and the network
 * only for what is genuinely missing.
 *
 * `refs` and the returned results are positionally aligned, so callers zip them
 * back onto their own lists without agreeing on a key format with the main
 * process.
 */
export async function resolveBaseModels(
  refs: CheckpointRef[],
  options: { allowNetwork?: boolean } = {},
): Promise<{ resolved: number; fetched: number }> {
  if (!isElectron || refs.length === 0) return { resolved: 0, fetched: 0 };

  try {
    const response = await window.electronAPI!.resolveBaseModels({
      refs,
      allowNetwork: options.allowNetwork !== false,
    });
    if (!response?.success || !Array.isArray(response.results)) {
      return { resolved: 0, fetched: 0 };
    }

    const next = { ...baseModelMap };
    let resolved = 0;
    response.results.forEach((entry, index) => {
      const key = refs[index]?.key;
      if (!key || !entry?.baseModel) return;
      next[key] = entry.baseModel;
      resolved++;
    });

    baseModelMap = next;
    notify();

    return { resolved, fetched: response.stats?.fetched ?? 0 };
  } catch {
    return { resolved: 0, fetched: 0 };
  }
}

/** Discards the offline table, in memory and on disk. */
export async function clearBaseModelTable(): Promise<void> {
  baseModelMap = {};
  notify();
  if (!isElectron) return;
  try {
    await window.electronAPI!.clearBaseModelTable();
  } catch {
    // The in-memory map is already clear; a failed disk wipe is retried by the
    // next clear (or by the cache-folder reset).
  }
}

/**
 * The distinct checkpoints in a set of images, in first-seen order.
 *
 * This is the whole reason the feature is cheap: a library of 18,000 images
 * collapses to a few dozen refs here, and only those are ever looked up.
 */
export function collectCheckpointRefs(images: IndexedImage[]): CheckpointRef[] {
  const seen = new Map<string, CheckpointRef>();
  for (const image of images) {
    const ref = checkpointRefForImage(image);
    if (!ref.key || ref.isLora) continue;
    if (!seen.has(ref.key)) seen.set(ref.key, ref);
  }
  return Array.from(seen.values());
}
