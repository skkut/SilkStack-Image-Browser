# Image Stacking in SilkStack

SilkStack provides two complementary systems for grouping similar images: **Library Stacks** (similarity-based grouping, per-image annotation persistence) and **Smart Library Clusters** (similarity clustering via Web Worker, separate file cache). This document covers their architecture, behavior, and extension points.

---

## Table of Contents

- [Overview](#overview)
- [Library Stacks](#library-stacks)
  - [Grouping Strategy (Two-Level)](#grouping-strategy-two-level)
  - [Per-Image Annotation Fields](#per-image-annotation-fields)
  - [Stack Analysis Flow](#stack-analysis-flow)
  - [Similarity Group Computation](#similarity-group-computation)
  - [Store Actions](#store-actions)
  - [Stack Drill-Down](#stack-drill-down)
  - [LibraryStackContext](#librarystackcontext)
  - [Filter Pipeline Integration](#filter-pipeline-integration)
  - [Scroll Position Preservation](#scroll-position-preservation)
- [Smart Library Clusters](#smart-library-clusters)
  - [Clustering Algorithm](#clustering-algorithm)
  - [Cluster Drill-Down](#cluster-drill-down)
- [Comparison](#comparison)
- [Key Files](#key-files)
- [Future Extension Points](#future-extension-points)

---

## Overview

| Feature | Library Stacks | Smart Library Clusters |
|---|---|---|
| **Where** | Main library grid | Smart Library view |
| **Grouping method** | Exact prompt hash (FNV-1a) + async similarity merge (hybrid Jaccard/Levenshtein bar 0.80, unioned with the vector pass) | 4-phase similarity algorithm (0.88) |
| **Performance** | Display: O(n) instant. Computation: O(g²) chunked async with UI yielding | O(n²) within buckets — Web Worker |
| **Persistence** | IndexedDB per-image annotations (`stackGroupId` + `similarityGroupId`) | JSON file cache via `clusterCacheManager` |
| **Persistence pattern** | Same as auto-tags (`ImageAnnotations`) | Separate `{hash}-clusters.json` file |
| **Drill-down** | `SimilarityStackExpandedView` with justified layout + prompt-grouped sections | Overlay via `StackExpandedView` |
| **Membership model** | `similarityGroupId` per image (computed async after indexing) | Explicit `imageIds: string[]` per cluster |
| **Threshold** | Lexical hybrid ≥ 0.80; vector pass ≥ 0.90 on the centered cosine — two bars, unioned | Configurable (default 0.88) |
| **Minimum size** | 2 images | 3 images |
| **Sub-groups** | `StackSubGroup[]` — one per distinct prompt, always displayed | N/A |
| **Progress** | Footer progress bar (green pill) | Footer progress bar (blue pill) |

---

## Library Stacks

Library stacks are the default grouping behavior in the main grid. When stacking is enabled, images are grouped into a stacked card with a `+N` badge. Grouping uses a **two-level** approach:

1. **Similarity level** — images with similar prompts share a `similarityGroupId` and appear in the same stack
2. **Exact level** — within each stack, images are sub-grouped by exact prompt text, each with its own label

Stack membership follows the same per-image annotation pattern as auto-tags: each image's `ImageAnnotations` record in IndexedDB stores grouping fields that survive app restarts.

### Grouping Strategy (Two-Level)

**File:** [`src/hooks/useImageStacking.ts`](../src/hooks/useImageStacking.ts)

The hook groups images in two levels with zero runtime similarity computation:

```
images → any image resolved to a group key?  (resolveStackGroupKey: similarityGroupId || stackGroupId)
  ├─ YES → groupByAnnotation()
  │         ├─ Level 1: Group by that key (stable stack id: `stack-<groupKey>`)
  │         └─ Level 2: Sub-group within each stack by the Group by dimensions (prompt by default)
  └─ NO  → the images are returned ungrouped — the pipeline will group them
```

**Level 1 — Group-key grouping**: Groups by `img.similarityGroupId`, falling back to `img.stackGroupId` when similarity hasn't been computed yet — the single expression in [`stackGroupKey.ts`](../src/utils/stackGroupKey.ts), shared with the drill-down and the store filter. This is O(n) with no computation — just a Map lookup. A group of one is emitted as a bare singleton, not a stack, so views that show only stacks never list ungrouped images.

**Stack identity is the group, not the cover.** `ImageStack.id` is `stack-<groupKey>`; the cover is just the newest image in the group and changes as images arrive. Anything keyed by stack id (the Stacks tab's open drill-down, scroll restoration) therefore survives a new image joining the stack — an id derived from the cover would reset that state on every arrival.

**Level 2 — Sub-groups**: Within each stack, images are further grouped by the user's **Group by** dimensions — prompt (exact text, lowercase, whitespace collapsed) by default, optionally model and/or LoRAs. Each sub-group becomes a `StackSubGroup` with its own label displayed above its images in the drill-down view. The drill-down recomputes these from the images it is given, so a dimension change applies immediately without rebuilding the stacks.

**Ungrouped path**: With no group key on any image (fresh library, annotations not yet loaded, or before `syncNewImagesToStacks` runs) the images are returned as-is — no client-side prompt grouping. Grouping is the pipeline's job; a second grouping rule here is how two views end up disagreeing.

### Per-Image Annotation Fields

**File:** [`src/types.ts`](../src/types.ts)

```typescript
// On ImageAnnotations (persisted in IndexedDB):
interface ImageAnnotations {
  // ... existing fields (isFavorite, tags, autoTags, isAutoTagged, metadataTags) ...
  stackGroupId?: string;      // Prompt hash — groups images with identical prompts
  isStackAnalyzed?: boolean;  // Whether the image has been checked for stack membership
  similarityGroupId?: string; // Similarity group ID — groups images with similar prompts
}

// Denormalized onto IndexedImage by applyAnnotationsToImages():
interface IndexedImage {
  // ... existing fields ...
  stackGroupId?: string;
  isStackAnalyzed?: boolean;
  similarityGroupId?: string;
}
```

- `stackGroupId` — FNV-1a hash of the normalized prompt. Set by `syncNewImagesToStacks`. Groups exact prompt matches.
- `similarityGroupId` — ID of the similarity group. Set by `computeSimilarityGroups`, and added to by the vector pass when semantic search is on. Multiple different `stackGroupId` values that are similar enough — lexical hybrid ≥ **0.80**, or a vector cosine ≥ **0.90** once the prompts are embedded — share the same `similarityGroupId`.
- `isStackAnalyzed` — Prevents re-processing on every indexing cycle (same pattern as `isAutoTagged`).

### Stack Analysis Flow

**Triggered by:** indexing completion, file watcher new-image events, app startup (annotation load).

```
syncNewImagesToStacks()
  │
  ├─ 1. Iterate state.images, skip where annotations.isStackAnalyzed === true
  ├─ 2. For each unanalyzed image:
  │     stackGroupId = generatePromptHash(normalizePrompt(prompt))
  ├─ 3. Persist via bulkSaveAnnotations() → IndexedDB
  └─ 4. Return — no scheduling. The pipeline coordinator
        (processPostIndexingPipeline, Phase 2) runs
        computeSimilarityGroups() next, sequentially
```

On app startup, `loadAnnotations()` logs whether any annotation still needs processing (`!isStackAnalyzed`, or a `stackGroupId` without `isSimilarityAnalyzed`) but schedules nothing itself — the unified pipeline coordinator (`processPostIndexingPipeline`, triggered from `App.tsx` once annotations are loaded and indexing is idle) runs both phases.

### Similarity Group Computation

**File:** [`src/store/useImageStore.ts`](../src/store/useImageStore.ts), action `computeSimilarityGroups`

The similarity merge runs as an **async store action** (not in the render path). It processes all unique prompts in the library using the same hybrid algorithm as Smart Library clusters:

**Step 0 — Backfill**: Ensures every image has a `stackGroupId`. Images indexed before this feature was added get their `stackGroupId` computed and persisted on the fly.

**Phase 1 — Token bucketing**: Extracts tokens from each unique prompt (after `normalizePrompt` + `tokenizeForSimilarity`). Groups entries into buckets by shared keywords (≥1). This reduces comparisons — only entries sharing at least one keyword are compared.

**Phase 2 — Similarity clustering**: Within each bucket, all pairs are compared using `hybridSimilarity()` (Jaccard × 0.6 + Levenshtein × 0.4). Merging uses a **Union-Find** data structure for transitive closure. The threshold is **0.80** — `SIMILARITY_MATCH_THRESHOLD` in [`src/services/aiBridge.ts`](../src/services/aiBridge.ts), lowered from 0.85 in v4 (2026-09). The same value tunes the internal Jaccard prefilter as `(threshold − 0.4) / 0.6`, so the two must move together or matches silently vanish.

**Phase 3 — Assignment**: Each Union-Find root becomes a similarity group. All entries that were merged together get the same `similarityGroupId`.

**Phase 4 — Persistence**: Updates annotations in memory and persists to IndexedDB via `bulkSaveAnnotations`.

**Chunked yielding**: Every 150 comparisons, the function yields to the event loop (`await setTimeout(resolve, 0)`) to keep the UI responsive. Progress is reported via `similarityGroupProgress` in the store, displayed as a green pill in the footer.

**Vector pass (semantic search on)** — `computeVectorSimilarityGroups()` re-judges the same prompt groups on the embedding cosine once semantic indexing has embedded them, writing the same `similarityGroupId` field. Its bar is **0.90** on the *centered* cosine (`PROMPT_GROUPING_VECTOR_THRESHOLD` in `ai-intelligence/src/core/types.ts`, with a per-model override map) — deliberately a separate constant from the 0.80 lexical bar, because a cosine and a hybrid string score are different metrics on different scales. The two passes are **unioned**: the vector pass can only ADD merges to the lexical partition, never split a stack, so a lexical match always survives.

**Version migration**: A `SIMILARITY_GROUP_VERSION` constant (bumped on algorithm/threshold changes) is tracked in `localStorage`. When the version changes, all existing `similarityGroupId` values are cleared and re-computed with the new parameters.

### Store Actions

**File:** [`src/store/useImageStore.ts`](../src/store/useImageStore.ts)

| Action | Trigger | Behavior |
|---|---|---|
| `syncNewImagesToStacks()` | Indexing completes, file watcher (new files) | Finds unanalyzed images, assigns `stackGroupId`, persists, schedules `computeSimilarityGroups` |
| `computeSimilarityGroups()` | After `syncNewImagesToStacks`, after `loadAnnotations`, or on version change | Backfills `stackGroupId` if missing, computes similarity merges, assigns `similarityGroupId`, persists |
| `handleStackImageDeletion(ids)` | File watcher (deleted files) | Clears `stackGroupId`, `isStackAnalyzed`, and `similarityGroupId` from annotations |
| `setSimilarityGroupProgress(p)` | Internal (during computation) | Updates footer progress bar |

### Stack Drill-Down

When a user clicks a stack in the library grid, the app drills down to show images organized by prompt sub-groups. This is handled by `handleStackClick` in [`ImageGrid.tsx`](../src/components/ImageGrid.tsx) and rendered by [`SimilarityStackExpandedViewWrapper`](../src/components/SimilarityStackExpandedViewWrapper.tsx).

**Flow:**

```
User clicks stack card
  │
  ├─ 1. Save scroll position (moduleMainLibraryScrollPosition)
  ├─ 2. Build LibraryStackContext { groupKey, basePrompt }
  ├─ 3. setLibraryStackContext(context) → triggers filterAndSort (group-key filtering)
  ├─ 4. setStackingEnabled(false)
  └─ 5. App.tsx renders SimilarityStackExpandedView instead of ImageGrid
       │
       ├─ Back to Library button (replaces old App.tsx back bar)
       ├─ For each sub-group (recomputed live from the images prop):
       │   ├─ Prompt header panel (prompt text + image count)
       │   └─ Justified image rows (same computeJustifiedLayout as ImageGrid)
       └─ Scroll position restored on back
```

The key design decision: **drill-down uses group-key filtering, not text-based filtering.** This means:
- The search bar is NOT modified — any prior search is preserved
- Filtering is O(n) over the visible set with a Set lookup per image (vs. text matching)
- **Membership is live.** The context stores the group key, and `filterAndSort` re-resolves which images belong to it on every pass. Images indexed while the drill-down is open appear in it immediately — the same instant they appear in the library grid and the Stacks tab. No snapshot of image IDs is kept anywhere, so the three views cannot drift apart.

**Sub-group display**: Every stack drill-down shows prompt headers, even for single-prompt stacks. The prompt label in a dark panel is displayed above its images, making it clear what prompt generated each group. Sub-groups are recomputed from the `images` prop by the wrapper (respecting the user's Group by dimensions), not passed in.

**Image layout**: Sub-group images use `computeJustifiedLayout()` — the same algorithm as `ImageGrid` — producing identical justified rows. Each image card uses `useThumbnail()` for thumbnail loading and includes selection checkboxes, favorite stars, and hover filename overlays matching `ImageCard` behavior.

**Closing the drill-down:** two paths, one rule — the view closes when its group is no longer a stack (fewer than two members, i.e. it fell to a singleton or disappeared):
- the back button / `Escape` (App.tsx) clears the context and re-enables stacking;
- a close-on-shrink effect in `App.tsx` does the same when `collectGroupMembers(...).size < 2`, matching the Stacks tab, which clears its `expandedStackId` as soon as the group is missing from the stacks it renders.

### LibraryStackContext

**File:** [`src/types.ts`](../src/types.ts)

```typescript
interface LibraryStackContext {
  groupKey: string;      // = similarityGroupId || stackGroupId, the open group
  basePrompt: string;    // Display text for the "Back to all stacks" bar
}
```

The membership resolver lives in [`src/utils/stackGroupKey.ts`](../src/utils/stackGroupKey.ts) — one module, imported by the stack builder, the store filter and the drill-down close check:

- `resolveStackGroupKey(image)` → `image.similarityGroupId || image.stackGroupId` (the key an image belongs to, or `undefined` for a singleton)
- `collectGroupMembers(images, annotations, groupKey)` → the id set for one group, used by `filterAndSort` and by the unmerge/undo actions

**Store integration** ([`src/store/useImageStore.ts`](../src/store/useImageStore.ts)):
- **State:** `libraryStackContext: LibraryStackContext | null` (initially `null`)
- **Setter:** `setLibraryStackContext(context)` — calls `filterAndSort` on every change
- **Clear on reset:** All store resets set `libraryStackContext: null`

### Filter Pipeline Integration

**File:** [`src/store/useImageStore.ts`](../src/store/useImageStore.ts), function `filterAndSort`

The filter pipeline applies these stages in order:

```
selectionFiltered → favorites → sensitive tags → GROUP-KEY OR TEXT SEARCH → models → loras → schedulers → advanced filters → sort
```

**Group-key filtering:**
```typescript
const stackContextImageIds = libraryStackContext
    ? collectGroupMembers(images, annotations, libraryStackContext.groupKey)
    : null;
// …
if (stackContextImageIds) {
    out = out.filter(image => stackContextImageIds.has(image.id));
} else if (searchQuery) {
    // Normal text search (unchanged)
}
```

The `if/else if` structure means **group filtering takes priority over text search.** When a stack is open, the grid shows exactly the images whose group key matches — resolved fresh on each pass. When the context is cleared, any active `searchQuery` resumes filtering normally.

The semantic overlay (semantic search mode) intersects its hits with the same set, so semantic results inside a drill-down can never include images from another stack.

### Scroll Position Preservation

When drilling into a stack and returning, the grid scroll position is saved and restored:

1. **On enter** ([`ImageGrid.tsx`](../src/components/ImageGrid.tsx)): `moduleMainLibraryScrollPosition` (module-level variable) captures the grid's `scrollTop`
2. **On exit detection**: A `useLayoutEffect` watches for `libraryStackContext` transitioning from non-null → null and sets a pending restore flag
3. **On restore**: A second `useLayoutEffect` resets the virtualized list cache and scrolls to the saved position

The module-level variable (instead of a `useRef`) is required because `ImageGrid` unmounts during drill-down (replaced by `SimilarityStackExpandedView`). A ref would be lost on unmount; the module variable survives.

---

## Smart Library Clusters

Smart Library clusters are AI-generated groups of semantically similar prompts, accessible via the Smart Library view.

### Clustering Algorithm

**File:** [`src/services/clusteringEngine.ts`](../src/services/clusteringEngine.ts)

The engine uses a **4-phase hybrid algorithm** designed to process 35k images in under 30 seconds. It runs in a Web Worker ([`src/services/workers/clusteringWorker.ts`](../src/services/workers/clusteringWorker.ts)) to avoid blocking the UI.

**Phase 1 — Exact Matching (O(n)):**
Images with identical normalized prompts are grouped by hash.

**Phase 2 — Token Bucketing:**
Keywords are extracted from each cluster's base prompt. Clusters sharing ≥2 keywords are placed into the same bucket. Reduces the pairwise comparison space by ~90%.

**Phase 3 — Similarity Clustering:**
Within each bucket, all cluster pairs are compared using a **hybrid similarity score:**
- **Jaccard similarity** (60% weight): Token overlap between prompt token sets
- **Normalized Levenshtein** (40% weight): Edit distance, catches typos and minor phrasing differences

Merging uses a **union-find** data structure for transitive closure (if A≈B and B≈C, then A,B,C are one cluster).

**Phase 4 — Refinement:**
Clusters are sorted chronologically and the final `ImageCluster` objects are produced.

**Key types** ([`src/types.ts`](../src/types.ts)):
```typescript
interface ImageCluster {
  id: string;                  // Hash-based cluster ID
  promptHash: string;          // Hash of the base prompt
  basePrompt: string;          // Representative prompt text
  imageIds: string[];          // Array of image IDs in this cluster
  coverImageId: string;        // First image chronologically
  size: number;                // Number of images in cluster
  similarityThreshold: number; // Threshold used for clustering (0.85-0.90)
  createdAt: number;           // Timestamp of cluster creation
  updatedAt: number;           // Timestamp of last update
}
```

**Utilities** ([`src/utils/similarityMetrics.ts`](../src/utils/similarityMetrics.ts)):
- `normalizePrompt(text)` — whitespace collapse, lowercase, trim, strip LoRA tags and metadata
- `generatePromptHash(text)` — FNV-1a hash for exact-match grouping
- `hybridSimilarity(a, b)` — Jaccard × 0.6 + Levenshtein × 0.4
- `tokenizeForSimilarity(text)` — splits into word tokens, removes stop words
- `extractKeywords(text, maxCount)` — top N keywords by frequency
- `shareKeywords(a, b, minShared)` — boolean check for bucketing
- `normalizedLevenshtein(a, b)` — edit distance normalized to [0,1]

**Persistence** ([`src/services/clusterCacheManager.ts`](../src/services/clusterCacheManager.ts)):
Clusters are cached to disk as JSON files at `{userData}/smart-library-cache/{hash}-clusters.json` with atomic writes (temp file + rename) for crash safety.

**Incremental updates:**
- `addImageToClusters(image, existingClusters, threshold)` — classifies a new image into an existing cluster or creates a new one
- `removeImagesFromClusters(deletedIds, existingClusters)` — removes deleted images, drops empty clusters

### Cluster Drill-Down

Unlike library stacks, cluster drill-down uses **local component state** and an overlay pattern:

1. [`SmartLibrary.tsx`](../src/components/SmartLibrary.tsx) manages `expandedClusterId` (local `useState`)
2. When a `StackCard` is clicked, `handleOpenStack` saves scroll position and sets `expandedClusterId`
3. [`StackExpandedView`](../src/components/StackExpandedView.tsx) renders as an absolute-positioned overlay
4. It receives an explicit `images: IndexedImage[]` array (from mapping `cluster.imageIds` through the image map)
5. The view contains its own `ImageGrid` with `disableStacking` prop so no recursive stacking occurs
6. `clusterNavigationContext` is set before opening the image viewer, enabling prev/next navigation within the cluster
7. On "Back", scroll positions are restored via a 30ms `setTimeout` (lets DOM settle)

---

## Comparison

| Aspect | Library Stacks | Smart Library Clusters |
|---|---|---|
| **Trigger** | Toggle in grid toolbar, auto after indexing | "Generate Clusters" button |
| **Speed** | Display: instant. Computation: chunked async, non-blocking | 4-phase worker, ~30s for 35k images |
| **Grouping** | Exact hash + similarity merge (lexical ≥ 0.80, unioned with the vector pass), two-level | Similarity threshold 0.88, flat clusters |
| **Drill-down mechanism** | `LibraryStackContext` in store → `SimilarityStackExpandedView` | `expandedClusterId` local state → `StackExpandedView` |
| **Filtering** | ID-based Set lookup | Explicit image array prop |
| **Search bar** | Preserved | N/A (separate view) |
| **Scroll restore** | Module-level variable survives grid unmount | `setTimeout` 30ms + ref |
| **Sub-groups** | `StackSubGroup[]` — one per distinct prompt, always displayed with label | N/A |
| **Navigation context** | Not supported | `clusterNavigationContext` for prev/next |
| **Manual editing** | Possible via annotation mutation | Not yet supported |
| **Persistence** | IndexedDB per-image (`ImageAnnotations`) | JSON file cache (`clusterCacheManager`) |
| **Processing flag** | `isStackAnalyzed` per annotation | N/A (full re-run on each generation) |
| **Progress indicator** | Footer green pill | Footer blue pill |
| **Min group size** | 2 | 3 (configurable in `SmartLibrary.tsx`) |
| **Algorithm versioning** | `SIMILARITY_GROUP_VERSION` in localStorage, auto-migrates | N/A (full re-run on each generation) |

---

## Key Files

| File | Role |
|---|---|
| [`src/types.ts`](../src/types.ts) | `ImageStack`, `StackSubGroup`, `LibraryStackContext`, `ImageCluster`, `ImageAnnotations` (with `stackGroupId`/`similarityGroupId`/`isStackAnalyzed`) |
| [`src/hooks/useImageStacking.ts`](../src/hooks/useImageStacking.ts) | Two-level grouping: similarityGroupId → exact prompt sub-groups. Zero runtime computation. |
| [`src/components/SimilarityStackExpandedView.tsx`](../src/components/SimilarityStackExpandedView.tsx) | Drill-down view: prompt headers + `computeJustifiedLayout` rows + `SubGroupImageCard` with `useThumbnail` |
| [`src/store/useImageStore.ts`](../src/store/useImageStore.ts) | `libraryStackContext` state, `syncNewImagesToStacks`, `computeSimilarityGroups` (async chunked), `handleStackImageDeletion`, `applyAnnotationsToImages`, `filterAndSort` pipeline, `similarityGroupProgress` |
| [`src/components/ImageGrid.tsx`](../src/components/ImageGrid.tsx) | `handleStackClick` (passes `subGroups` in context), scroll restore (module-level variable), stack card rendering |
| [`src/components/Footer.tsx`](../src/components/Footer.tsx) | Renders `similarityGroupProgress` as green progress pill |
| [`src/App.tsx`](../src/App.tsx) | Renders `SimilarityStackExpandedView` during drill-down, passes progress to Footer |
| [`src/services/imageAnnotationsStorage.ts`](../src/services/imageAnnotationsStorage.ts) | `bulkSaveAnnotations`, `loadAllAnnotations` — canonical persistence for all stack fields |
| [`src/services/clusteringEngine.ts`](../src/services/clusteringEngine.ts) | 4-phase clustering algorithm, `addImageToClusters`, `removeImagesFromClusters` |
| [`src/services/workers/clusteringWorker.ts`](../src/services/workers/clusteringWorker.ts) | Web Worker wrapper for clustering |
| [`src/services/clusterCacheManager.ts`](../src/services/clusterCacheManager.ts) | Disk persistence for Smart Library clusters |
| [`src/utils/similarityMetrics.ts`](../src/utils/similarityMetrics.ts) | `normalizePrompt`, `generatePromptHash`, `hybridSimilarity`, `tokenizeForSimilarity`, `shareKeywords` |
| [`src/utils/layoutAlgo.ts`](../src/utils/layoutAlgo.ts) | `computeJustifiedLayout` — shared by `ImageGrid` and `SimilarityStackExpandedView` |
| [`src/components/SmartLibrary.tsx`](../src/components/SmartLibrary.tsx) | Smart Library view with cluster cards |
| [`src/components/StackExpandedView.tsx`](../src/components/StackExpandedView.tsx) | Cluster drill-down overlay |
| [`src/components/StackCard.tsx`](../src/components/StackCard.tsx) | Cluster card rendering in Smart Library |

---

## Future Extension Points

### Manual Image Addition to Stacks

Stack membership is stored as `similarityGroupId` on each image's annotation. To manually move an image to a different stack:

```typescript
const annotation = annotations.get(imageId);
if (annotation) {
  const updated = { ...annotation, similarityGroupId: 'target-sim-id', updatedAt: Date.now() };
  await saveAnnotation(updated);
}
```

Future work:
- Drag-and-drop images between stacks
- Multi-select → "Move to Stack" context menu action
- Remove individual images from a stack (clear `similarityGroupId`)
- "Re-analyze stacks" button to bump version and force full re-processing

### Configurable Threshold

The lexical threshold is currently a constant (`SIMILARITY_MATCH_THRESHOLD = 0.80` in [`src/services/aiBridge.ts`](../src/services/aiBridge.ts)); the vector bar is a separate constant in the ai-intelligence module (`PROMPT_GROUPING_VECTOR_THRESHOLD = 0.90`, plus a per-model override map). A natural extension is making them user-configurable via the Settings UI, similar to the Smart Library threshold slider. This would require bumping `SIMILARITY_GROUP_VERSION` to force re-computation when the threshold changes.

### Clearing Stacking Data

To force a full re-analysis of all images (e.g., after changing the similarity threshold or debugging stacking issues), run the reset script from the Electron DevTools console.

**`scripts/clear-stacking-tags.js`** — Clears `stackGroupId`, `similarityGroupId`, and `isStackAnalyzed` from all image annotations in IndexedDB, and removes the similarity version from `localStorage`. The page reloads automatically. On the next launch, `syncNewImagesToStacks` and `computeSimilarityGroups` will re-process every image from scratch with the current algorithm and threshold.

**When to use**: After changing `SIMILARITY_GROUP_VERSION` or the similarity threshold in `computeSimilarityGroups`, existing annotations still have old `similarityGroupId` values. Run this script to clear them and force re-computation.

**How to run**:
1. Open the app's DevTools — press `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Option+I` (macOS)
2. In the **Console** tab, type `resetStacking()` and press Enter
3. The console will show: `Cleared stacking tags from N images. Re-loading annotations...`
4. Annotations reload in-place — no page refresh needed. Images are re-processed immediately.

Alternatively, copy-paste the contents of `scripts/clear-stacking-tags.js` into the console (useful if the global function is unavailable).

**What it clears**:
- `stackGroupId` — exact prompt hash
- `similarityGroupId` — similarity group assignment
- `isStackAnalyzed` — analysis flag (set to `false`, so images are re-processed)
- `localStorage.similarityGroupVersion` — version tracker (forces fresh computation)

**Other available scripts**: `scripts/clear-manual-tags.js` — clears only manual tags while preserving auto-tags, metadata-tags, and stacking data.

### Web Worker Migration

The similarity computation currently runs on the main thread with chunked yielding. For very large libraries (500+ unique prompts), moving the entire `computeSimilarityGroups` logic to a Web Worker (reusing `clusteringWorker.ts` patterns) would eliminate any UI jank during the comparison phase.

---

*Documentation last updated: 2026-10-14*
