# IndexedDB Schema & Migrations

How the app's single IndexedDB is structured, how version upgrades work, and how to add a future migration safely.

## Overview

All client-side persistence lives in **one IndexedDB database**:

| | |
|---|---|
| **Name** | `image-metahub-preferences` (`DB_NAME` in `src/services/indexedDb.ts`) |
| **Current version** | **8** (`DB_VERSION`) |
| **Opened by** | the renderer only, through `openDatabase()` in `src/services/indexedDb.ts`. No main-process code, no worker, and no CLI/reset script touches the DB directly. |
| **Schema** | created defensively in `onupgradeneeded` — every open ensures *all* stores exist, so a fresh install (v0 → v8) and an upgrade (v7 → v8) hit the same code path. |

## The migration model

`openDatabase()` calls `indexedDB.open(DB_NAME, DB_VERSION)`. The browser fires `onupgradeneeded` whenever the requested version is **higher** than the stored one (`event.oldVersion` = stored version, `0` for a fresh database). All migration logic lives in that one handler — there is no separate migration framework.

Two patterns are used inside the handler:

1. **Guarded creation (the default)** — works for every old version, fresh installs included:

   ```ts
   if (!db.objectStoreNames.contains('semanticVectors')) {
     const store = db.createObjectStore('semanticVectors', { keyPath: 'imageId' });
     store.createIndex('updatedAt', 'updatedAt', { unique: false });
   }
   ```

2. **Conditional upgrade (version-specific)** — only when a change applies to DBs *older* than a known version:

   ```ts
   } else if (oldVersion < 6) {
     // v6 added the autoTags/metadataTags indexes to imageAnnotations
     const annotationStore = request.transaction.objectStore('imageAnnotations');
     if (!annotationStore.indexNames.contains('autoTags')) { /* … */ }
     if (!annotationStore.indexNames.contains('metadataTags')) { /* … */ }
   }
   ```

Because every storage module closes its connection after each operation (`transaction.oncomplete/abort/error` → `db.close()`), upgrades are not blocked by lingering connections. `onsuccess` also wires `db.onversionchange → close()` so a later upgrade from another window can proceed.

## Version history

| Version | Change |
|---|---|
| ≤ 5 | Unrecoverable from this repo (single squashed commit). Only the v6 boundary is knowable from the code. |
| **6** | `imageAnnotations` gains `autoTags` + `metadataTags` multiEntry indexes (the `oldVersion < 6` branch). |
| 7 | (No code-visible schema change — the defensive block creates the same stores as v6.) |
| **8** | **NEW** `semanticVectors` store — `keyPath: 'imageId'`, non-unique `updatedAt` index. Phase 3 of semantic search (see `ai-intelligence/docs/semantic-search.md` §7). |

## The v7 → v8 migration (current)

**What changes:** one new empty store is created. `imageAnnotations`, `folderSelection`, `clusterPreferences`, `smartCollections`, and `folderPreferences` are untouched — no records are transformed, moved, or deleted.

**What happens on first launch after the upgrade:**
1. The first storage access triggers `openDatabase()` → the browser upgrades v7 → v8 and creates `semanticVectors`.
2. Nothing is written into it yet. Vectors are backfilled by the semantic indexing pipeline (Phase 4/5) — for every image with no record (or a `textHash` mismatch), the coordinator embeds and persists via `putManyVectors`. At startup the worker *restores* persisted records chunked (2,000/message) without re-embedding.
3. Users with the feature disabled (or no premium license) see zero impact — the empty store costs nothing.

**Why a separate store:** vectors are ~3 KB each (768 × float32). Storing them in `imageAnnotations` would balloon the annotations Map the renderer loads wholesale (100k images ≈ +300 MB heap). The vector store is read only by the persistence module + worker, chunked.

## Failure modes & safety

| Condition | Behavior |
|---|---|
| `UnknownError` / `InvalidStateError` on open | `openDatabase` deletes the database and reopens once (fresh schema, all user data in that DB lost — the same behavior as before v8). |
| Upgrade blocked by another connection (`onblocked`) | The delete path logs and returns; the app keeps running on what it can read. |
| `IndexedDB` unavailable / open fails | `disablePersistence()` marks the session persistence-disabled; storage modules fall back to in-memory (annotations/favorites) or no-op (semantic vectors) and log a warning. |
| Migration code throws inside `onupgradeneeded` | The transaction aborts; `openDatabase` rejects; the reset path above applies. |

There is intentionally **no** data-migration work at upgrade time — this schema's migrations are additive store creation only. If a future migration needs to *transform* records, do it in a version-gated pass *after* the stores are ensured (the `oldVersion < N` pattern), not in `createObjectStore` calls.

## How to add a future migration (v8 → v9)

1. **Bump the version** — `DB_VERSION = 9` in `src/services/indexedDb.ts`.
2. **Add the schema change in `onupgradeneeded`**:
   - New store: use the guarded `if (!db.objectStoreNames.contains(...))` pattern (covers fresh installs too).
   - Indexes on an existing store: guard with `indexNames.contains(...)`, inside an `oldVersion < 9` branch if the store already exists from before.
   - Record transforms: never inside `createObjectStore`; add a version-gated pass that reads/writes through a transaction.
3. **Write the migration test** (harness: `fake-indexeddb`, pattern in `src/__tests__/semanticVectorsStorage.test.ts`):
   - Seed a DB at the *old* version with real records (`indexedDB.open(DB_NAME, 7)` + `put`), then call `openDatabase()` and assert: version bumped, new store exists with the right keyPath/indexes, and **the seeded records survived untouched**.
   - Add CRUD round-trip tests for the new store.
4. **Run the harness** — `npx vitest run src/__tests__/<new-store>.test.ts`, then the full suite + `npx tsc --noEmit -p tsconfig.json`.
5. **Update docs** — this file's version table, the semantic-search.md §13/phase inventory if the change belongs to a phase, and the release notes.
6. **Verify manually in the packaged app** (user flow): upgrade an existing install, confirm favorites/tags/stacks survived, and check DevTools → Application → IndexedDB → `image-metahub-preferences` shows the new store.

## Verification checklist for the current migration

- [ ] Automated: `semanticVectorsStorage.test.ts` — v7-seeded DB upgrades to v8, annotations survive, store keyPath/index correct; CRUD round-trips (incl. Float32Array vectors).
- [ ] Manual (packaged app): first launch after upgrade creates `semanticVectors` silently; auto-tags, favorites, stacks, and folder state all intact; semantic indexing (when enabled) writes records and restart restores them without re-embedding.

## Related

- Store consumers: `src/services/semanticVectorsStorage.ts` (CRUD), `src/services/imageAnnotationsStorage.ts` (annotations, in-memory cache), `src/services/folderSelectionStorage.ts`, `src/services/folderPreferencesStorage.ts`.
- Semantic search design & phases: `ai-intelligence/docs/semantic-search.md` (§7 persistence, §14 Phase 3).
