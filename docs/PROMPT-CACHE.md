# Prompt-Level AI Processing Cache — Design

**Status:** implemented (2026-11-26). Phases 0–2 below are in the codebase.
**Scope:** auto-tagging and semantic indexing (search vectors + prompt vectors).
**Principle:** AI output is a pure function of its input. The input is the prompt (plus a
small, explicit set of model/version parameters), not the image. Store each result once,
keyed by that input, and every image that carries the same prompt reuses it.

## Implementation map

| Piece | File |
|---|---|
| Cache database + enrichment CRUD + warm-up marker | `src/services/promptCache.ts` |
| Auto-tag hydration / representative dedupe / fan-out | `src/store/useImageStore.ts` (`startAutoTagging`, `clearAutoTags`, `clearDerivedImageData`) |
| One-time library backfill | `warmPromptCacheFromLibrary()` in `src/store/useImageStore.ts`, called at the top of `runPipelineRound` |
| Settings → Processed prompts | `src/components/PromptCacheSection.tsx`, mounted in `SettingsModal.tsx` |
| Embedding cache storage (module) | `ai-intelligence/src/storage/embeddingCacheStorage.ts` |
| Content-keyed planning, cache lookups, promotion-on-clear | `ai-intelligence/src/coordinator/semanticSearchEngine.ts` |
| Tests | `src/__tests__/promptCache.test.ts`, `src/__tests__/autoTagPromptCache.test.ts`, `ai-intelligence/src/storage/embeddingCacheStorage.test.ts`, `ai-intelligence/src/coordinator/semanticSearchCoordinator.test.ts` |

---

## 1. The problem

Today every gate in the AI pipeline is **per image**:

| Gate | Where | Effect |
|---|---|---|
| `searchTagVersion !== SEARCH_ENRICHMENT_VERSION` | `src/store/useImageStore.ts` (`needsSearchEnrichment`) | every un-enriched image is sent to the LLM, even when 200 images share one prompt |
| `!isSemanticIndexed` | `useImageStore.ts` (`needsSemanticIndexing`) | every un-stamped image is sent to the coordinator |
| `textHash` / `promptHash` per imageId | `ai-intelligence/src/coordinator/semanticSearchEngine.ts` (`indexImages`) | Δ works, but only against *that image's own* record |

So a batch of 200 seed iterations from one prompt costs **200 LLM completions** and up to
**200 searchable-text embeddings**, even though the inputs are byte-identical. The same
happens again after *Reprocess Images* and after *Settings → Re-index*, because both wipe
the per-image results.

Two things are already deduplicated, and the design builds on them:

- The **prompt-vector half** of `indexImages` collapses equal `promptHash` values *within
  one coordinator call* (`promptImageIdsByHash`) — one embed, N records. It does not
  survive across runs, and `embedPromptVectors()` (the backfill path) has no dedupe at all.
- The **exact-prompt identity** (`generatePromptHash(normalizePrompt(prompt))` = the app's
  `stackGroupId`) already exists and is trusted by stacking and clustering.

What is missing is a place to keep results **after the per-image copies are gone**.

---

## 2. What each AI output is a pure function of

| Output | Inputs | Existing identity |
|---|---|---|
| Auto-tag concepts | raw prompt, tag model id, `SEARCH_ENRICHMENT_VERSION` | none (per image) |
| Hidden search vocabulary (synonyms + categories) | same as above | none (per image) |
| Prompt vector (stacking) | canonical prompt, embed model id, dimension, `PROMPT_TEXT_VERSION` | `promptHash` |
| Searchable-text vector (semantic search) | built searchable text, embed model id, dimension | `textHash` |

The auto-tag worker reads **only** `image.prompt` (`autoTagWorker.ts:178`). `models` and
`loras` are sent in the payload but are not used by the LLM path, so they must not enter the
cache key. If that ever changes, the key must change with it.

The searchable text is built from the canonical prompt, curated tags, auto-tags, and
synonyms. Once auto-tags are prompt-cached, an image with no curated tags has searchable
text that is **also** a pure function of the prompt — which is what makes one cache serve
both halves.

---

## 3. The cache database

A **new, app-owned IndexedDB database**, deliberately separate from
`image-metahub-preferences`:

| | |
|---|---|
| **Name** | `silkstack-prompt-cache` |
| **Version** | 2 (v1 data stores; v2 adds the `meta` warm-up marker) |
| **Schema owner** | the app (`src/services/promptCache.ts`) |
| **Module access** | opens the same schema (v2); missing stores disable the cache for that run |

Why not extend the main DB (v9 → v10):

- The main DB version is a **lockstep contract** with the closed module
  (`ai-intelligence/src/storage/semanticVectorsStorage.ts`), and an older module build
  opening v9 on a v10 database throws `VersionError`. A new DB removes that coupling.
- The cache has a different lifecycle from user data: it must **survive** *Reprocess
  Images* and *Re-index*, and its own "clear" is a separate user action. Keeping it apart
  makes that obvious in code and in DevTools.
- If the cache is ever corrupted, deleting it costs only recomputation — never favorites,
  tags, stacks, or folder settings.

### Stores

#### `promptEnrichments` — one row per processed prompt (app-owned)

```ts
// keyPath: ['modelId', 'enrichmentVersion', 'prompt']   (compound key, no hash collisions)
interface PromptEnrichmentRecord {
  modelId: string;            // RESOLVED tag model id (see §4.1)
  enrichmentVersion: number;  // SEARCH_ENRICHMENT_VERSION
  prompt: string;             // the EXACT string the LLM was given
  concepts: string[];         // untruncated (module cap: MAX_TAGS_PER_IMAGE = 15)
  synonyms: string[];         // merged hidden vocabulary (synonyms + categories)
  source: 'llm';              // rule-based output is NOT cached (it is cheap and upgradeable)
  createdAt: number;
  updatedAt: number;
}
```

No secondary index: the store is small (one row per distinct prompt), so *Clear
Auto-Tags* purges by scanning the rows and deleting those whose `prompt` is in the
cleared set, and the Settings card counts rows. Keying on the prompt string (not a hash)
removes collision risk entirely and stores the prompt, as intended.

#### `promptEmbeddings` — one vector per canonical prompt (module-owned)

```ts
// keyPath: ['modelId', 'dimension', 'textVersion', 'promptHash']
interface PromptEmbeddingRecord {
  modelId: string;
  dimension: number;
  textVersion: number;        // PROMPT_TEXT_VERSION
  promptHash: string;
  vector: Float32Array;
  updatedAt: number;
}
```

#### `meta` — one row, the one-time warm-up marker (app-owned)

`{ key: 'warmup', version, completedAt, enrichmentCount, textPromoted, promptPromoted }`.
Its absence is the trigger for the library backfill (§5.4). **Clear prompt cache does not
delete it** — otherwise the next start would immediately rebuild the cache from the same
per-image data and silently undo the clear.

#### `textEmbeddings` — one vector per distinct searchable text (module-owned)

```ts
// keyPath: ['modelId', 'dimension', 'textHash']
interface TextEmbeddingRecord {
  modelId: string;
  dimension: number;
  textHash: string;           // buildTextHash(searchableText)
  text?: string;              // verification + debugging (FNV is 32-bit; see §6)
  vector: Float32Array;
  updatedAt: number;
}
```

Approximate steady-state size: thousands of distinct prompts × (concepts + synonyms) is a
few MB; vectors are 3 KB each at 768 dims and are stored **once per distinct text**, not
once per image. That is smaller than the per-image stores it prevents from growing.

---

## 4. Auto-tagging flow

`startAutoTagging` in `src/store/useImageStore.ts` becomes a **resolve → hydrate → (maybe)
call the model → fan out** pipeline.

1. **Filter as today** (`needsSearchEnrichment`) and resolve the model id.
   The key must use the same id the worker will actually use: look the setting up in
   `getTagModelOptions()` and fall back to its first entry, mirroring
   `resolveTagModel()` in the module. An unknown persisted id must not produce a cache key
   the worker never uses.
2. **Group images by exact prompt.** Prompt-less images need no model at all.
3. **Cache lookup** — one transaction, `get([modelId, version, prompt])` per distinct
   prompt.
4. **Upgrade bridge** (cache miss only): search the in-memory `images` + `annotations` for
   any image with the same prompt whose annotation is already enriched at the current
   version. If found, reuse its `autoTags` + `synonymTags`, and write the cache row
   (write-behind). This is what makes the change free for existing libraries — their tags
   are already in annotations, they just were never keyed by prompt.
5. **Persist everything hydrated** in batches (`bulkSaveAnnotations` per prompt group, one
   state patch), reusing the existing `persistImageTags` logic (which also clears
   `isSemanticIndexed` so the semantic phase re-checks the text — the embedding cache
   makes that free).
6. **Send one representative per uncached prompt to the worker.** Send
   `topN: MAX_TAGS_PER_IMAGE` so the cache stores the full result regardless of any future
   caller-supplied cap; apply the caller's `topN` when persisting instead. No worker
   protocol change and no edit to the MPL-covered `autoTagWorker.ts`.
7. On `image-tagged` for a representative:
   a. **Write the cache row first** (concepts + synonyms), before persisting images, so a
      crash between here and the next sibling cannot lose the model's work;
   b. persist the representative;
   c. fan out to every image with the same prompt and persist them;
   d. advance progress by the sibling count (image space).
8. If nothing is left to process, **never create or load the chat model** — the run
   resolves after hydration. This is the biggest single win: no multi-GB model load for a
   library whose prompts are already known.
9. `complete` keeps its backward-compatibility map; fan-out from the map as well for
   non-streaming hosts.

`Clear Auto-Tags` (`clearAutoTags`) must **purge the enrichment rows for the affected
prompts** (delete by the `promptHash` index, all model/version rows). Otherwise the next
pipeline run re-hydrates exactly what the user just removed, and the button stops meaning
what it says. Per-image chip removal is unaffected: it does not reset `searchTagVersion`,
so that image is never re-hydrated.

Progress stays in **image space** (the footer copy already says "images"): hydrated images
count as done up front, representatives advance by fan-out size, and model-loading reports
keep their percent scale and `loadingModel` flag.

---

## 5. Semantic indexing flow

### 5.1 `indexImages` becomes plan-then-embed

Today the coordinator decides per image and queues per image. Keep the Δ decisions but
group by **content identity** before any model work:

```
plan:
  searchGroups: Map<textHash, { text, imageIds[] }>
  promptGroups: Map<promptHash, { text, imageIds[] }>
```

For each group, resolve a vector in this order:

1. **Cache store** (`textEmbeddings` / `promptEmbeddings`) — one batched transaction of
   `get(key)` calls, capped per transaction.
2. **Per-image persisted data (upgrade bridge).** Search half: `indexImages` already loads
   every `semanticVectors` record, so build a `textHash → record` map; verify
   `record.text === text` when the record carries text. Prompt half: the Δ already streams
   `promptVector` metas; map `promptHash → imageId` and fetch the representative's vector
   via `getPromptVectorsByImageIds`. A fallback hit also populates the cache (write-behind).
3. **Embed once per group** — the existing `EMBED_BATCH_SIZE` loop over groups, then fan
   the vector out to every imageId in the group (records share the same `Float32Array`,
   exactly as the prompt half does today).

Consequences:

- The `ensureInitialized()` call must happen **only when a group actually needs an embed**.
  An all-cache-hit run must not load the embedding model.
- If the worker is already ready, restore the newly written records so search sees them
  immediately. If an init is in flight, chain the restore after it; if no worker exists,
  skip it — the next `ensureInitialized()` restores from storage.
- `this.indexed` is updated from `countVectors()` after persistence, as today.
- On cancel or failure, the `finally` block persists every completed group **and its cache
  rows** (same crash-resume contract as today).

### 5.2 `embedPromptVectors` gets the same treatment

The backfill path currently queues one embed per image with no dedupe. Give it the same
`promptHash` grouping + cache lookup. This is a one-line-ish win for every upgrade.

### 5.3 `clearIndex` promotes before it wipes

*Reprocess Images* and *Settings → Re-index* call `clearIndex()`. Before deleting the
per-image stores, copy every record that matches the active target
(`modelId`, `dimension`, plus `textVersion` for prompt vectors) into the cache stores. That
is what closes the upgrade hole: a user who reprocesses **before** the cache has warmed up
still gets a free rebuild, because the data was promoted on the way out.

Cache stores are **not** cleared by `clearIndex`. Add a separate
`clearEmbeddingCache()` method (used by Settings → Clear prompt cache) that wipes only the
two embedding stores.

### 5.4 One-time library warm-up (automatic, on upgrade)

The cache must not start empty on a library that already holds thousands of tags and
vectors. The `meta` marker makes the first pipeline round after the cache database is
created or upgraded (v1 → v2) run a backfill **before** the AI phases:

1. **Enrichments** — one row per distinct prompt that any image was already enriched for
   at the current `SEARCH_ENRICHMENT_VERSION` (concepts + hidden vocabulary).
2. **Vectors** — `warmEmbeddingCache()` on the coordinator promotes every per-image
   `semanticVectors` / `promptVectors` record matching the active model/dimension/
   `PROMPT_TEXT_VERSION` into the two embedding caches. Storage reads only: no worker, no
   model load.

Both parts are idempotent upserts. The marker is written only after both succeed, so a
failure retries on the next pipeline round/session. There is **no Settings button** for
this — it is part of the feature's upgrade path. **Clear prompt cache** deliberately keeps
the marker, so an explicit clear is not undone by a re-warm.

### 5.5 `removeImages` and `switchStorageDb`

- `removeImages` deletes per-image records and leaves the cache untouched — the prompt was
  still processed, and the result will be reused when the image (or another one with the
  same prompt) returns.
- The cache follows the coordinator's storage DB selection via a new `cacheDbName`
  option: production uses `silkstack-prompt-cache`, and the dev tester's isolated vector DB
  (`image-metahub-semantic-test`) derives `image-metahub-semantic-test-prompt-cache`, so
  tester runs do not pollute the library cache.

---

## 6. Correctness details that matter

- **FNV-1a is 32-bit.** `textHash` collisions are already tolerated by the existing Δ
  ("same hash ⇒ same text" is the current contract). The cache adds a second consumer of
  that assumption, so `textEmbeddings` stores the built text and a hit verifies it when
  present. Prompt records key on the prompt string itself, so they cannot collide.
- **Auto-tag output must not be cached from the rule-based fallback.** The worker's
  `image-tagged` payload has `synonyms` only on the LLM path; use its presence as the
  signal. If the LLM later becomes available, the prompt is processed again.
- **Version bumps are the invalidation mechanism.** `SEARCH_ENRICHMENT_VERSION` and
  `PROMPT_TEXT_VERSION` are part of the keys. Editing `TAGS_PROMPT` without bumping
  `SEARCH_ENRICHMENT_VERSION` would silently serve stale tags — keep the existing
  convention explicit and cover it in review/tests.
- **Model switches.** Embedding model id + dimension are in every embedding key; tag model
  id is in every enrichment key. Old rows become unreachable but harmless (GC optional,
  see §8).
- **Empty prompts.** No cache row, no worker item. Persist the empty enrichment + version
  stamp exactly as the worker does today, so the gate closes.
- **Two windows.** Per-window runs can still duplicate a prompt's work if both start at
  once. This is a pre-existing behaviour (both windows already run pipelines); a
  cross-window lock is a non-goal for v1.
- **Quota / private mode.** Every cache read and write fails soft: a miss falls back to the
  AI path, a failed write just means the next run recomputes. The feature must never break
  tagging or search.

---

## 7. Settings and observability

Settings → AI Intelligence, next to the existing model cache card:

- A "Processed prompts" card showing distinct prompt count and approximate vector-cache
  size (count × dimension × 4 bytes).
- **Clear prompt cache** button (confirm dialog) — clears all three stores. This is the
  escape hatch for bad cached results or reclaiming space after model experiments.
- Copy states the behaviour plainly: prompts are processed once; results stay on this
  device; Reprocess reuses them.

Console logging stays value-first:
`[AutoTag] reused cached results for 412 images across 12 prompts; 3 prompts need the model`.

---

## 8. Future / optional work (not required for v1)

- **GC of unreachable rows.** Every embedding record has `updatedAt`; a Settings action can
  drop rows whose model id is not the current one, or use an LRU cap. Not needed until
  users switch models often.
- **Pointer prompt vectors.** `promptVectors` stores one 3 KB vector per image; with a
  prompt-keyed cache it could store `imageId → promptKey` and resolve vectors at read time.
  That saves ~50 MB at 18k images but touches clustering reads (`getPromptVectors`,
  `searchPromptVectors`) — defer.
- **Cross-window coordination** for concurrent runs (BroadcastChannel lock).
- **Migrate the cache into the main DB** if the app ever owns the version bump end-to-end;
  the separate DB is the low-risk choice today.

---

## 9. Testing plan

App (`src/__tests__/`):

- `promptEnrichmentCache.test.ts` — round-trip, compound-key isolation by model/version,
  `promptHash` index purge, invalid-record rejection.
- `autoTagCache.test.tsx` (store) — N images / 1 prompt sends **one** representative; a
  cache hit creates no worker and hydrates every sibling with identical tags/synonyms;
  fan-out persistence patches state; prompt-less images bypass the worker; cancellation;
  `clearAutoTags` purges and a following run does **not** re-hydrate; a changed tag model
  or enrichment version misses.
- Extend `reprocessStore.test.ts` — caches survive `clearDerivedImageData`; annotations
  promoted into the cache before the wipe; the rebuild produces identical tags without a
  model call.

Module (`ai-intelligence/src/`):

- Two `indexImages` calls where the second adds an image with a prompt seen in the first →
  second call embeds 0 prompt texts.
- Many images with identical searchable text in one call → one embed, N records.
- Cache hit path never calls `ensureInitialized` (spy).
- `embedPromptVectors` dedupes repeated prompts.
- `clearIndex` promotes then clears; caches intact; `clearEmbeddingCache` wipes only them.
- Model/dimension mismatch ignores cache rows; missing stores degrade gracefully.
- Cancel mid-run persists completed groups and their cache rows.

Gate: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build` (plus the
ai-intelligence build for module changes).

---

## 10. Phased implementation

| Phase | Work | Risk |
|---|---|---|
| **0** | Cache DB + app service (`promptCacheDb.ts` / `promptEnrichmentCache.ts`) + tests. No behaviour change. | low |
| **1** | Auto-tag hydration, representative dedupe, write-behind cache, fan-out, `clearAutoTags` purge, Settings card. App-only. | medium |
| **2** | Coordinator cache lookups for both halves, `embedPromptVectors` dedupe, promotion in `clearIndex`, `clearEmbeddingCache`, tester cache isolation. Ships with an ai-intelligence version bump. | medium |
| **3** | Optional: pointer prompt vectors, GC, cross-window lock. | low priority |

Phase 1 alone removes the worst cost (N LLM completions per repeated prompt) and is
independently shippable.

---

## 11. Decisions taken

Approved 2026-11-26, with the database named `silkstack-prompt-cache`:

1. **Caches survive Reprocess / Re-index** — "Reprocess" rebuilds per-image data, it does
   not forget what was computed.
2. **Separate cache DB** — no main-DB version bump, no closed-module version lockstep.
3. **`Clear Auto-Tags` purges the prompt cache** for the affected prompts, so the button
   stays durable.
4. **Progress stays in image space** — hydrated images count as done; the worker's
   representative-space report is translated back using the app's fan-out counter.
5. **No on/off toggle** — the behaviour is always on; **Clear prompt cache** in Settings is
   the escape hatch.
6. **No manual warm/backfill button** — the existing library seeds the cache automatically
   on the first start after the feature/schema upgrade (a one-time marker in the cache DB),
   not on user action.
