/**
 * Checkpoint identity — the pure half of the base-model lookup.
 *
 * Split out from checkpointLookup.mjs for one reason: that module imports
 * `node:fs` to persist its table, so it cannot be pulled into the renderer
 * bundle. The renderer still has to derive the *same* key for a checkpoint as
 * the main process does — a mismatch would mean every lookup missed forever —
 * so the identity rules live here, importable from both sides, with no
 * dependencies at all.
 *
 * Everything in this file is pure: no I/O, no network, no Node built-ins.
 */

/**
 * Recognised model file extensions, stripped when deriving a comparable name.
 */
export const MODEL_EXTENSION_RE = /\.(safetensors|ckpt|pt|pth|sft|bin|gguf)$/i;

/**
 * LoRA-ish names are not checkpoints. `models[0]` is a checkpoint by
 * construction, but a stray LoRA string occasionally lands there through the
 * generic object walk some parsers use.
 */
export const LORA_SUFFIX_RE = /(?:^|[_\-. ])(lora|lycoris|locon|embedding|textual_inversion|ti)$/i;

/**
 * Deterministic 8+ hex characters — a hash, either on its own or folded into a
 * name string by a parser that had nowhere else to put it.
 */
export const HEX_RE = /^[0-9a-f]{8,64}$/i;

/**
 * Normalizes a checkpoint name into a comparable form: lowercase, no directory
 * prefix, no file extension, collapsed separators.
 *
 * Deliberately conservative. It must NOT strip version numbers —
 * `juggernautXL_v9` and `juggernautXL_v10` are different checkpoints, and
 * `ponyDiffusionV6XL` vs `ponyDiffusionV5XL` have different base models. Only
 * genuinely insignificant differences (case, path, extension, punctuation)
 * are erased.
 *
 * @param {string} [name]
 * @returns {string}
 */
export function normalizeModelName(name) {
  if (typeof name !== 'string') return '';
  return name
    .split(/[/\\]/)
    .pop()
    .replace(MODEL_EXTENSION_RE, '')
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')
    .trim();
}

/**
 * The key prefix for a checkpoint identified by name alone.
 *
 * Exported because a *manual* row filed this way is recognized by its prefix
 * (see `buildNameIndex`): a mapping the user attached to a model name is a
 * statement about the name, so — unlike a hash key, which names one exact file
 * — it is allowed to answer an image of the same checkpoint that carries a hash
 * of its own.
 */
export const NAME_KEY_PREFIX = 'name:';

/**
 * The key a checkpoint is filed under in the offline table.
 *
 * Hash keys are preferred over name keys because a hash is globally unique
 * while a name is whatever the user happened to call the file — two people's
 * `model.safetensors` are unrelated, but their hashes never collide. The
 * prefix keeps an 8-character CRC32 from colliding with an 8-character AutoV1.
 *
 * @param {{ hash?: string | null, name?: string | null }} [ref]
 * @returns {string | null} null when the ref carries nothing identifiable.
 */
export function checkpointKey({ hash, name } = {}) {
  const cleanHash = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
  if (HEX_RE.test(cleanHash)) {
    // Length is the only in-band signal for which algorithm produced it:
    // Civitai accepts all of them at the same path, so the distinction is
    // documentation rather than routing.
    const scheme = cleanHash.length === 64 ? 'sha256' : cleanHash.length === 10 ? 'autov2' : 'autov1';
    return `${scheme}:${cleanHash}`;
  }

  const cleanName = normalizeModelName(name);
  return cleanName ? `${NAME_KEY_PREFIX}${cleanName}` : null;
}

/**
 * Builds a checkpoint reference from the fields a parsed image actually has.
 *
 * Real libraries are messier than the schema suggests. `models[0]` is usually a
 * name, but the A1111 and ComfyUI parsers fall back to *encoding a hash into the
 * name string* when no name was present:
 *   - A1111 / SD.Next → "Model hash: 6ce0161689"
 *   - ComfyUI         → "unknown (hash: 36fab8f3)"
 * and Forge / MetaHub stash a real hash in an untyped extra key (`modelHash`,
 * `model_hash`). All of those shapes have to resolve to the same hash.
 *
 * @param {{ name?: string | null, hash?: string | null }} [fields]
 * @returns {{ hash: string | null, name: string | null, query: string | null, key: string | null, isLora: boolean }}
 */
export function buildCheckpointRef({ name, hash } = {}) {
  const rawName = typeof name === 'string' ? name.trim() : '';
  let resolvedHash = typeof hash === 'string' && HEX_RE.test(hash.trim()) ? hash.trim().toLowerCase() : null;
  let resolvedName = null;
  let query = null;

  if (rawName) {
    const encoded = matchEncodedHash(rawName);
    if (encoded) {
      resolvedHash = resolvedHash || encoded;
    } else if (HEX_RE.test(rawName)) {
      // A bare hex string in the name slot is a hash with no label — treat it
      // as one rather than searching Civitai for a 40-character "name".
      resolvedHash = resolvedHash || rawName.toLowerCase();
    } else {
      const normalized = normalizeModelName(rawName);
      if (normalized) {
        resolvedName = normalized;
        // What to *ask* Civitai for. Civitai's search is full-text, so it
        // wants the name roughly as a human wrote it ("dreamshaper_8"), not
        // our normalized form ("dreamshaper 8") — the normalization is for
        // comparing the answers, never for asking the question.
        query = rawName.split(/[/\\]/).pop().replace(MODEL_EXTENSION_RE, '').trim();
      }
    }
  }

  return {
    hash: resolvedHash,
    name: resolvedName,
    query,
    key: checkpointKey({ hash: resolvedHash, name: resolvedName }),
    isLora: resolvedName ? LORA_SUFFIX_RE.test(resolvedName) : false,
  };
}

/**
 * Pulls a hash back out of the name strings the parsers synthesize. Returns
 * null when the string is an ordinary name.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function matchEncodedHash(name) {
  const labelled = name.match(/model\s*hash\s*[:=]\s*([0-9a-f]{8,64})/i);
  if (labelled) return labelled[1].toLowerCase();

  const wrapped = name.match(/\(\s*hash\s*[:=]\s*([0-9a-f]{8,64})\s*\)/i);
  if (wrapped) return wrapped[1].toLowerCase();

  const generic = name.match(/hash\s*[:=]\s*([0-9a-f]{8,64})/i);
  if (generic) return generic[1].toLowerCase();

  return null;
}

/**
 * Every name an entry can be found by later, normalized. A checkpoint resolved
 * by hash also learns the names it goes by — both the Civitai version name and
 * the actual filename — which is what lets a *later*, hash-less ComfyUI image
 * with the same file resolve from the offline table instead of the network.
 *
 * @param {{ checkpointName?: string, fileNames?: string[] }} entry
 * @returns {string[]}
 */
export function entryAliases(entry) {
  const names = [entry?.checkpointName, ...(entry?.fileNames || [])];
  return Array.from(new Set(names.map(normalizeModelName).filter(Boolean)));
}

/**
 * True when an entry is still usable: a live hit, or a miss whose negative TTL
 * has not yet expired.
 *
 * @param {object | undefined} entry
 * @param {number} now
 */
export function isEntryFresh(entry, now = Date.now()) {
  if (!entry) return false;
  if (entry.baseModel) return true;
  return Number.isFinite(entry.expiresAt) && entry.expiresAt > now;
}

/**
 * The name index over a table's answers: what a checkpoint can be read as when
 * its *key* is not the thing you have in hand.
 *
 * Two questions get asked of a name, and they are different questions:
 *
 *  - `manual` — did the user map this name in Settings? A mapping filed by name
 *    is a statement about the model, so it answers every image of it, whether
 *    that image carries a hash or not.
 *  - `learned` — does the table know this name at all (a looked-up row's
 *    version name, or one of its filenames)? This is what lets a hash-less
 *    ComfyUI image be answered from a checkpoint that some other image in the
 *    library resolved by hash. It is a name match, so it may only be used for a
 *    ref with no hash to go by.
 *
 * Shared by the resolver and by the renderer's display path, so the two cannot
 * drift: the renderer shows what the resolver would decide, and it has no
 * engine to ask.
 *
 * @param {Record<string, { baseModel?: string | null, source?: string, checkpointName?: string | null, fileNames?: string[], expiresAt?: number }>} entries
 * @param {number} [now]
 * @returns {{ manual: Map<string, { baseModel?: string | null }>, learned: Map<string, { baseModel?: string | null }> }}
 */
export function buildNameIndex(entries, now = Date.now()) {
  /** @type {Map<string, { baseModel?: string | null }>} */
  const manual = new Map();
  /** @type {Map<string, { baseModel?: string | null }>} */
  const learned = new Map();

  const rows = Object.entries(entries || {});
  // Manual rows first. `learned` keeps the *first* entry filed under a name, and
  // two rows can share one — an answer looked up under `autov2:<hash>`, and the
  // mapping the user later attached to that same model name — so the row the
  // user wrote by hand has to come first.
  const ordered = [
    ...rows.filter(([, entry]) => entry?.source === 'manual'),
    ...rows.filter(([, entry]) => entry?.source !== 'manual'),
  ];

  for (const [key, entry] of ordered) {
    if (!entry?.baseModel || !isEntryFresh(entry, now)) continue;

    if (entry.source === 'manual' && key.startsWith(NAME_KEY_PREFIX)) {
      // The key already *is* the name, normalized — read it back from there
      // rather than depending on the row having restated it in `checkpointName`.
      const named = key.slice(NAME_KEY_PREFIX.length);
      if (named && !manual.has(named)) manual.set(named, entry);
    }

    for (const alias of entryAliases(entry)) {
      if (!learned.has(alias)) learned.set(alias, entry);
    }
  }

  return { manual, learned };
}

/**
 * The mapping the user wrote for this checkpoint's name, if there is one.
 *
 * Answers the ref outright, hash included: the mapping was made against a name
 * in Settings, so it speaks for the model — every revision of it, and every
 * image of it, whatever identity those images happen to carry.
 *
 * @param {{ name?: string | null, hash?: string | null }} [ref]
 * @param {{ manual: Map<string, { baseModel?: string | null }> }} [nameIndex]
 */
export function manualMappingFor(ref, nameIndex) {
  if (!ref?.name || !nameIndex) return undefined;
  return nameIndex.manual.get(ref.name);
}

/**
 * A name the table has learned for this checkpoint, if there is one.
 *
 * Undefined for a ref that carries a hash: a name match must never stand in for
 * a hash, which is the entire reason a hash key exists. Hash-less refs are the
 * ones this is for — an image whose only identity is the filename.
 *
 * @param {{ name?: string | null, hash?: string | null }} [ref]
 * @param {{ learned: Map<string, { baseModel?: string | null }> }} [nameIndex]
 */
export function learnedNameFor(ref, nameIndex) {
  if (!ref?.name || ref.hash || !nameIndex) return undefined;
  return nameIndex.learned.get(ref.name);
}

/**
 * Reads a `base_model:<repo>` relation out of a HuggingFace repo's tags.
 * Derived repos carry these; the canonical bases themselves do not.
 *
 * The `base_model:adapter:<repo>` / `base_model:quantized:<repo>` forms are
 * skipped — those describe how a repo relates to its base (a LoRA adapter, a
 * GGUF quantisation), not what the base is, and taking them would report the
 * intermediate repo instead of the architecture.
 *
 * @param {string[]} [tags]
 * @returns {string | null}
 */
export function readBaseModelTag(tags) {
  if (!Array.isArray(tags)) return null;
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.startsWith('base_model:')) continue;
    const value = tag.slice('base_model:'.length);
    if (value.includes(':')) continue;
    if (value) return value;
  }
  return null;
}
