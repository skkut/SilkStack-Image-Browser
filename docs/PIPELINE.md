# Unified Post-Indexing Pipeline

## Overview

The **Unified Post-Indexing Pipeline** (`processPostIndexingPipeline`) is the single entry point for all automatic image processing that occurs after file indexing completes. It replaces the previous fragmented architecture where each processing phase independently scheduled the next via `setTimeout`, creating race conditions and permanently skipped work.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Image Lifecycle                     │
├──────────┬──────────┬──────────┬────────────────────┤
│ 1. Index │ 2. Enrich│ 3. Stack │ 4. Similarity      │
│ (Phase A)│ (Phase B)│ (Pipeline│ (Pipeline          │
│          │          │  Phase 1)│  Phase 2)           │
├──────────┼──────────┼──────────┼────────────────────┤
│ Catalog  │ Metadata │ Prompt   │ Semantic            │
│ stub     │ parsing  │ hashing  │ clustering          │
│          │          │          │                     │
│ File     │ file-    │ useImage │ useImage            │
│ Indexer  │ Indexer  │ Store    │ Store               │
└──────────┴──────────┴──────────┴────────────────────┘
                        │              │
                        └──────┬───────┘
                               │
                    processPostIndexingPipeline()
                    (Sequential — Phase 1 → Phase 2)
```

### What it replaces

| Old Pattern | New Pattern |
|-------------|-------------|
| `loadAnnotations()` scheduled `computeSimilarityGroups` via `setTimeout(300)` | Pipeline runs from unified startup check in App.tsx |
| `syncNewImagesToStacks()` scheduled `computeSimilarityGroups` via `setTimeout(200)` | Pipeline calls Phase 1 → Phase 2 sequentially |
| `indexingState` transition triggered `syncNewImagesToStacks` (one-shot — could skip) | Startup check waits for `isAnnotationsLoaded && indexingState === 'idle'` |
| File watcher called `syncNewImagesToStacks` directly (skipping similarity) | File watcher calls `processPostIndexingPipeline` (all phases) |
| **Pipeline ran from `finalizeDirectoryLoad` BEFORE Phase B enrichment completed** | **Pipeline triggers in `phaseB.then()` AFTER enrichment populates metadata** |

### Critical Timing Fix

The pipeline MUST run **after** Phase B (enrichment/metadata parsing) completes. If it runs before, images still have `enrichmentState: 'catalog'` with no `prompt` data. `syncNewImagesToStacks` then sets `isStackAnalyzed: true` with `stackGroupId: undefined` (no prompt to hash), which `computeSimilarityGroups` later misinterprets as "intentionally unstacked" — permanently skipping the image across all subsequent boots.

**Enrichment → Pipeline ordering is enforced in both paths:**

| Path | Enrichment trigger | Pipeline trigger |
|------|-------------------|-----------------|
| Initial indexing | `processFiles()` returns `{ phaseB }` | `phaseB.then(() => processPostIndexingPipeline())` |
| File watcher | `processFiles()` returns `{ phaseB }` | `await phaseB; processPostIndexingPipeline()` |
| App startup (cached) | N/A (already enriched) | `useEffect([isAnnotationsLoaded, indexingState])` in App.tsx |

## Pipeline Phases

One `runPipelineRound()` runs a strictly sequential round. Phases 1-2 are shared by both branches; the count then depends on the branch (the Footer's labels follow it — see [Branch-dependent phase order](#branch-dependent-phase-order)):

| # | Phase | Function | State flag | Output |
|---|-------|----------|-----------|--------|
| 1 | Stacking (exact-prompt hashing) | `syncNewImagesToStacks()` + `reconcilePromptHashes()` | `isStackAnalyzed` | `stackGroupId` — FNV-1a hash of the normalized prompt |
| 2 | Similarity grouping — **lexical** | `computeSimilarityGroups()` | `isSimilarityAnalyzed` | `similarityGroupId` |
| 3 | Auto-tagging (AI enrichment) | `startAutoTagging('', false, { scope: 'library' })` | `searchTagVersion` | `autoTags`, `synonymTags` |
| 4 | Semantic search indexing | `runSemanticIndexNow()` | `isSemanticIndexed` | semantic + prompt vectors |
| 5 | Similarity grouping — **vector** (vector branch only) | `computeVectorSimilarityGroups()` | `isSimilarityAnalyzed` | merges added to phase 2's partition |

Phase 2 is deliberately hoisted ahead of the model phases: it is pure string work, so new images join (or mint) their stacks the moment they are indexed instead of waiting behind a model load — which is what keeps the library grid, the Stacks tab and an open drill-down showing the same thing at the same moment. Auto-tag and semantic run after it and preserve the grouping fields.

### Phase 1: Prompt Stacking (Exact-Match Hashing)

- **Function**: `syncNewImagesToStacks()`
- **State flag**: `isStackAnalyzed` (on `ImageAnnotations`)
- **Output**: `stackGroupId` — FNV-1a hash of the normalized prompt text
- **Footer**: Shows amber "Phase 1/5: Stacking…" (vector branch) or "Phase 1/4: Stacking…" (lexical branch)

**What it does**:
1. Iterates all images in the store
2. Skips images where `isStackAnalyzed === true` (already processed)
3. For unprocessed images, generates a `stackGroupId` from the prompt text:
   - Extracts prompt from `image.prompt`, `metadata.normalizedMetadata.prompt`, or `metadata.positive_prompt`
   - Computes an FNV-1a hash via the StackingEngine
4. Persists `{ stackGroupId, isStackAnalyzed: true }` to IndexedDB via `bulkSaveAnnotations`
5. Updates in-memory store with new annotations

**Idempotency**: Safe to call multiple times — only unprocessed images are modified.

### Phase 2: Similarity Grouping (Lexical Clustering)

- **Function**: `computeSimilarityGroups()`
- **State flag**: `isSimilarityAnalyzed` (on `ImageAnnotations`)
- **Output**: `similarityGroupId` — shared ID grouping semantically similar prompts
- **Footer**: Shows amber "Phase 2/5: Similarity…" (vector branch) or "Phase 2/4: Similarity…" (lexical branch)

**What it does**:
1. Ensures all images have `stackGroupId` (Step 0 — catch-up for images that bypassed Phase 1)
2. **Full mode** (first run): Delegates to StackingEngine for token-bucketed Union-Find clustering of all prompt groups
3. **Incremental mode** (subsequent runs): Compares only new `stackGroupId` entries against representatives from existing similarity groups
4. Persists `{ similarityGroupId, isSimilarityAnalyzed: true }` to IndexedDB
5. Updates in-memory store

**Similarity threshold**: 0.80 (`SIMILARITY_MATCH_THRESHOLD` in `src/services/aiBridge.ts`)

**Idempotency**: Only processes images where `isSimilarityAnalyzed` is false or `similarityGroupId` is absent.

### Branch-dependent phase order

`isSemanticSearchEnabled()` selects the branch. The vector pass (phase 5) can only run after phase 4 — a prompt vector does not exist until the semantic pass has embedded it — and it may only ADD merges to phase 2's partition, never remove a match.

```
VECTOR branch  (semantic search on):  1 stacking → 2 similarity (lexical) → 3 autoTag → 4 semantic → 5 similarity (vector)
LEXICAL branch (semantic search off): 1 stacking → 2 similarity (lexical) → 3 autoTag → 4 semantic
```

The Footer's phase labels are per-branch (`VECTOR_PHASE_LABELS` / `LEXICAL_PHASE_LABELS` in [Footer.tsx](src/components/Footer.tsx)) because the denominator differs. `pipelinePhase` uses `'similarity'` for the lexical pass and `'vectorSimilarity'` for the vector one, so the two passes are distinguishable in the label and in tests.

## When the Pipeline Runs

### 1. App Startup (primary trigger)

**Location**: [App.tsx:277-288](src/App.tsx)

```typescript
// Unified startup check — waits for BOTH conditions:
//   1. isAnnotationsLoaded === true (IndexedDB data available)
//   2. indexingState === 'idle' (file indexing complete or not needed)
// Fires ONCE per session via pipelineStartedRef.
useEffect(() => {
  if (isAnnotationsLoaded && indexingState === 'idle' && !pipelineStartedRef.current) {
    pipelineStartedRef.current = true;
    processPostIndexingPipeline();
  }
}, [isAnnotationsLoaded, indexingState, processPostIndexingPipeline]);
```

**Key property**: This check is **persistent** — it waits for both conditions to be true, regardless of which resolves first. Unlike the old one-shot `indexingState` transition, this cannot permanently skip processing.

### 2. File Watcher (new images detected while app is running)

**Location**: [useImageLoader.ts:638](src/hooks/useImageLoader.ts) and [useImageLoader.ts:1582](src/hooks/useImageLoader.ts)

```typescript
// After indexing new watched files completes:
useImageStore.getState().processPostIndexingPipeline();
```

### 3. Manual Reset (debug helper)

**Location**: [App.tsx:249](src/App.tsx)

```typescript
// Debug: window.resetStacking() — clears all stack data and re-runs pipeline
await useImageStore.getState().processPostIndexingPipeline();
```

## Concurrency Guards

The pipeline uses two layers of protection:

### Layer 1: Pipeline-level (`__pipelineInProgress` / `__pipelineQueued`)

```typescript
if (__pipelineInProgress) {
    __pipelineQueued = true;  // Will auto-retry after current run
    return;
}
__pipelineInProgress = true;
// ... phases execute ...
finally {
    __pipelineInProgress = false;
    if (__pipelineQueued) {
        __pipelineQueued = false;
        setTimeout(() => get().processPostIndexingPipeline(), 500);
    }
}
```

### Layer 2: Phase-level (individual guards)

- `__syncInProgress` — prevents concurrent stacking runs
- `__similaritySyncInProgress` / `__similaritySyncQueued` — prevents concurrent similarity runs

These are retained as safety nets for direct calls to individual phases (e.g., from tests or debug tools).

## Per-Image Processing State Flags

Each image's processing state is tracked by persistent flags in `ImageAnnotations` (stored in IndexedDB):

| Flag | Set by | Meaning |
|------|--------|---------|
| `enrichmentState` | `fileIndexer.ts` (Phase B) | `'catalog'` = stub only; `'enriched'` = metadata parsed |
| `isStackAnalyzed` | `syncNewImagesToStacks` (Pipeline Phase 1) | Exact-prompt hash has been computed |
| `stackGroupId` | `syncNewImagesToStacks` (Pipeline Phase 1) | FNV-1a hash of normalized prompt; groups identical prompts |
| `isSimilarityAnalyzed` | `computeSimilarityGroups` (Pipeline Phase 2) | Semantic similarity has been computed |
| `similarityGroupId` | `computeSimilarityGroups` (Pipeline Phase 2) | Shared ID for semantically similar prompts |
| `isAutoTagged` | `startAutoTagging` (user-initiated) | LLM auto-tagging has run |

### Flag lifecycle during manual operations

| Operation | `isStackAnalyzed` | `stackGroupId` | `isSimilarityAnalyzed` | `similarityGroupId` |
|-----------|-------------------|----------------|------------------------|---------------------|
| **Merge** (user merges stacks) | preserved | preserved | set to `true` | set to target group ID |
| **Unmerge** (user removes from stack) | preserved (`true`) | cleared (`undefined`) | cleared (`false`) | cleared (`undefined`) |
| **Delete** (image deleted) | cleared (`false`) | cleared (`undefined`) | cleared (`false`) | cleared (`undefined`) |
| **Undo** | restored from snapshot | restored from snapshot | restored from snapshot | restored from snapshot |

### Migration on startup

When annotations are loaded from IndexedDB, a migration step detects existing images with `similarityGroupId` but no `isSimilarityAnalyzed` flag (from prior app versions) and sets `isSimilarityAnalyzed: true` so they are not re-processed.

## State Diagram

```
Image added to library
        │
        ▼
┌──────────────────┐
│  Indexing        │  fileIndexer.ts Phase A
│  (Catalog stub)  │  enrichmentState: 'catalog'
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Enrichment      │  fileIndexer.ts Phase B
│  (Metadata parse)│  enrichmentState: 'enriched'
└────────┬─────────┘
         │
         ▼  (pipeline triggers: startup OR watcher)
┌──────────────────┐
│  Phase 1: Stack  │  processPostIndexingPipeline()
│  (Prompt hash)   │  → syncNewImagesToStacks()
│                  │  isStackAnalyzed: true
│                  │  stackGroupId: hash(prompt)
└────────┬─────────┘
         │
         ▼  (sequential — only after Phase 1 completes)
┌──────────────────┐
│  Phase 2: Sim    │  processPostIndexingPipeline()
│  (Lexical)       │  → computeSimilarityGroups()
│                  │  isSimilarityAnalyzed: true
│                  │  similarityGroupId: cluster ID
└────────┬─────────┘
         │
         ▼  (branch-dependent from here: see Pipeline Phases)
┌──────────────────┐
│  Phase 3-5       │  autoTag → semantic → (vector pass, vector branch only)
│  (Model phases)  │  setPipelinePhase('autoTag' | 'semantic' | 'vectorSimilarity')
└────────┬─────────┘
         │
         ▼
    ┌─────────┐
    │  IDLE   │  pipelinePhase: null
    └─────────┘
```

## Adding a New Phase

To add a new automatic processing phase to the pipeline:

1. **Add state flags** to `ImageAnnotations` and `IndexedImage` in [types.ts](src/types.ts)
2. **Implement the phase function** in [useImageStore.ts](src/store/useImageStore.ts) (follow the `isXxxAnalyzed` pattern for idempotency)
3. **Add to the pipeline coordinator** in `processPostIndexingPipeline()`:
   ```typescript
   // Phase 3: Your new phase
   get().setPipelinePhase('your-phase-name');
   await get().yourNewPhaseFunction();
   ```
4. **Add the phase label** to the `pipelinePhase` type and Footer display
5. **Add migration logic** to `loadAnnotations()` for existing data

## Debugging

### Window helpers
- `window.resetStacking()` — Clears all stack/similarity data and re-runs the full pipeline
- Check console for `[Pipeline]` prefixed log messages

### Key console messages
- `[Pipeline] Annotations not yet loaded — deferring` — Pipeline called too early; will retry on next trigger
- `[Pipeline] Phase 1: Prompt stacking (exact-match hashing)...` — Phase 1 started
- `[Pipeline] Phase 2: Similarity grouping (lexical clustering)...` — Phase 2 started (both branches)
- `[Pipeline] Phase 3/5: Auto-tagging (library scope)...` — auto-tag started (vector branch; `3/4` in the lexical branch)
- `[Pipeline] Phase 4/5: Semantic search indexing...` — semantic indexing started (`4/4` in the lexical branch)
- `[Pipeline] Phase 5/5: Similarity grouping (vector)...` — vector pass started (vector branch only)
- `[Pipeline] All phases complete.` — Pipeline finished successfully
- `[Pipeline] Running queued pipeline invocation` — A follow-up run was queued (normal under high churn)

### Footer indicators

Each processing stage has its own color-coded badge with file-level detail:

| Badge | Color | Shows | Meaning |
|-------|-------|-------|---------|
| **Cataloging X/Y — file.png** | 🟢 Green | File count + current file name | Phase A: building catalog stubs |
| **Enriching X/Y — file.png** | 🔵 Blue | File count + current file name | Phase B: parsing metadata from binary |
| **Phase 1/5: Stacking…** | 🟠 Amber | Phase label | Pipeline: exact-prompt hashing |
| **Phase 2/5: Similarity…** | 🟠 Amber | Phase label | Pipeline: lexical clustering |
| **Phase 3/5: Auto-tagging…** | 🟠 Amber | Phase label | Pipeline: AI enrichment |
| **Phase 4/5: Semantic indexing…** | 🟠 Amber | Phase label | Pipeline: embedding the index text |
| **Phase 5/5: Similarity…** | 🟠 Amber | Phase label | Pipeline: vector clustering on top of phase 2 |
| **Similarity message** | 🟢 Green | `similarityGroupProgress.message` | Clustering progress with counts |

The denominators are `N/5` while semantic search is on and `N/4` while it is off (there is no vector pass to run) — see [Branch-dependent phase order](#branch-dependent-phase-order).

**Troubleshooting guide:**

| What you see | What it means | Action |
|-------------|---------------|--------|
| "Cataloging 1/1 — image.png" stuck | Phase A has 1 file; check if Phase B started | Wait for Phase B to begin (blue badge should appear) |
| "Enriching 0/1" no file name | Phase B queued but hasn't started processing | Normal — worker pool initializing |
| "Enriching 1/1 — image.png" stuck | Phase B is parsing this file (large file, slow parse) | Check file size; PNG iTXt chunks require deflate decompression |
| "Phase 1/5: Stacking…" persists | Stacking engine is running; may be slow for many new images | Check console for `[Pipeline]` logs |
| No badge after enrichment completes | Pipeline hasn't triggered yet or enrichment failed | Check console for Phase B errors; pipeline triggers in `phaseB.then()` |
| "Cataloging" → nothing → "Phase 1/5" | Normal flow: Phase A complete → Phase B runs silently → Pipeline starts | Expected behavior when Phase B is fast |
| All badges gone but images not stacked | Possible: pipeline ran before enrichment completed (fixed — see Critical Timing Fix) | If reproducing after fix, check `isStackAnalyzed` flag in IndexedDB |
