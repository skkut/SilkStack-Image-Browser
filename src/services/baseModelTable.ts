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
 * The offline table exactly as the main process holds it, keyed by checkpoint
 * key. Kept whole rather than projected down to names because the settings
 * mapping table has to show each row's *source* — a manual mapping reads very
 * differently from a resolved one — and its aliases.
 */
let baseModelEntries: Record<string, BaseModelEntry> = {};

/**
 * The display projection of the above: checkpoint key → base model. Rebuilt
 * whenever the entries change, so every render-time reader (`baseModelForImage`
 * on the hot path) keeps doing a flat object lookup.
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
 * Adopts a whole table — from the disk read, a resolve run, or a settings
 * write — and rebuilds the projection in one step. Entries are replaced
 * wholesale, never mutated: `baseModelMap` is handed out by reference to callers
 * that diff it across a notify, so mutating it in place would make a change
 * invisible to them.
 */
function adoptEntries(entries: Record<string, BaseModelEntry>) {
  const next: Record<string, string> = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (entry?.baseModel) next[key] = entry.baseModel;
  }

  baseModelEntries = entries;
  baseModelMap = next;
  notify();
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

/**
 * The current table with its metadata: source, aliases, timestamps. For the
 * settings mapping table, which needs to distinguish a mapping the user wrote
 * from one that was looked up.
 */
export function getBaseModelEntries(): Record<string, BaseModelEntry> {
  return baseModelEntries;
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

    adoptEntries(response.entries);
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

    const next = { ...baseModelEntries };
    let resolved = 0;
    response.results.forEach((entry, index) => {
      const key = refs[index]?.key;
      if (!key || !entry?.baseModel) return;
      next[key] = entry;
      resolved++;
    });

    adoptEntries(next);

    return { resolved, fetched: response.stats?.fetched ?? 0 };
  } catch {
    return { resolved: 0, fetched: 0 };
  }
}

/**
 * Writes user-authored mappings and adopts the table the main process hands
 * back.
 *
 * A mapping with an empty `baseModel` clears that checkpoint's manual row and
 * hands it back to automatic resolution. Everything the user did not touch is
 * preserved on disk by the main process, so this never needs to send the whole
 * table across.
 */
export async function setBaseModelMappings(
  mappings: Array<{ key: string; baseModel: string | null; checkpointName?: string | null }>,
): Promise<void> {
  if (!isElectron || mappings.length === 0) return;

  try {
    const response = await window.electronAPI!.setBaseModelMappings({ mappings });
    if (!response?.success || !response.entries) return;

    adoptEntries(response.entries);
  } catch {
    // Left as it was. The UI keeps rendering the previous value rather than a
    // phantom one, and the next render of the table shows the true state.
  }
}

/**
 * Discards the looked-up entries, keeping the ones the user wrote by hand.
 *
 * The memory side has to mirror the disk side exactly: the main process carries
 * manual rows across the wipe, so clearing them here as well would leave the
 * two disagreeing until the next launch — and would blank a column the user
 * deliberately filled in.
 */
export async function clearBaseModelTable(): Promise<void> {
  adoptEntries(
    Object.fromEntries(
      Object.entries(baseModelEntries).filter(([, entry]) => entry?.source === 'manual'),
    ),
  );

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

/**
 * One row of the settings mapping table: a distinct checkpoint in the library,
 * with how many images use it.
 *
 * Same key derivation as everything else — this is the *display* half of
 * `collectCheckpointRefs`, which is why the two share `checkpointRefForImage`
 * and therefore its memo. On an 18,000-image library that memo turns this into
 * a walk over a few dozen entries.
 */
export interface CheckpointSummary {
  key: string;
  /** Human spelling, for display and for the entry's alias. */
  label: string;
  name: string | null;
  hash: string | null;
  /** How many images in the library were made with it. */
  imageCount: number;
  ref: CheckpointRef;
}

export function collectCheckpointSummaries(images: IndexedImage[]): CheckpointSummary[] {
  const byKey = new Map<string, CheckpointSummary>();

  for (const image of images) {
    const ref = checkpointRefForImage(image);
    if (!ref.key || ref.isLora) continue;

    const existing = byKey.get(ref.key);
    if (existing) {
      existing.imageCount++;
      continue;
    }

    byKey.set(ref.key, {
      key: ref.key,
      // `query` is the raw spelling from the metadata — what the user
      // recognises from their models folder. `name` is the normalized form,
      // which is only a fallback for when the raw one was unusable.
      label: ref.query || ref.name || ref.hash || ref.key,
      name: ref.name,
      hash: ref.hash,
      imageCount: 1,
      ref,
    });
  }

  return Array.from(byKey.values());
}
