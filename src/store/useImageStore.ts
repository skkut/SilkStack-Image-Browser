import { create } from 'zustand';
import { IndexedImage, Directory, ThumbnailStatus, ImageAnnotations, TagInfo, AutoTag, LibraryStackContext } from '../types';
import { loadSelectedFolders, saveSelectedFolders, loadExcludedFolders, saveExcludedFolders } from '../services/folderSelectionStorage';
import { loadFolderPreferences, saveFolderPreference, deleteFolderPreference, FolderPreference } from '../services/folderPreferencesStorage';
import {
  loadAllAnnotations,
  saveAnnotation,
  bulkSaveAnnotations,
  getAllTags,
} from '../services/imageAnnotationsStorage';

import { normalizePath } from '../utils/pathUtils';
import { getAspectRatio as getImageAspectRatio } from '../utils/imageUtils';
import { useSettingsStore } from './useSettingsStore';
import { isAiFeaturesEnabled, isSemanticSearchEnabled } from '../services/aiFeatureAccess';
import type { ISemanticSearchHit, DetectedGpuInfo, AiModelsStatus } from '../services/aiBridge';
import { SEARCH_ENRICHMENT_VERSION, TAG_GENERATION_MODEL_ID } from '../services/aiBridge';
import type { GpuDeviceReport } from '../services/gpuPreference';
import type { SemanticSearchCoordinator, SemanticIndexProgress } from '../services/semanticSearchEngine';
import cacheManager from '../services/cacheManager';
import { thumbnailManager } from '../services/thumbnailManager';
import { clearSemanticVectorsStore } from '../services/indexedDb';
import { processingQueue } from '../services/processingQueue';

// Search-enrichment idempotency gate (mirrors SEARCH_ENRICHMENT_VERSION in
// the ai-intelligence worker — that module is the source of truth). An image
// needs (re)enrichment when its stored version differs from the current one:
// never-tagged images carry no version, and images tagged before synonyms
// existed are isAutoTagged but version-less, so they get enriched exactly
// once on the next auto-tag run.
export const needsSearchEnrichment = (annotation?: ImageAnnotations): boolean =>
    annotation?.searchTagVersion !== SEARCH_ENRICHMENT_VERSION;

const RECENT_TAGS_STORAGE_KEY = 'image-metahub-recent-tags';
const MAX_RECENT_TAGS = 12;
// The last WebGPU adapter detected by an AI worker — persisted so Settings
// shows the GPU without waiting for the next model load.
const DETECTED_GPU_STORAGE_KEY = 'image-metahub-detected-gpu';
// Every GPU Chromium detected (main-process report) — persisted so the
// Settings dropdown shows the detected cards instantly on load, before the
// async re-fetch completes (which then detects system changes).
const DETECTED_GPUS_STORAGE_KEY = 'image-metahub-detected-gpus';

// Bump this version whenever the similarity algorithm or threshold changes
// to force re-computation of similarityGroupId for all images.
const SIMILARITY_GROUP_VERSION = 2;
const SIMILARITY_VERSION_KEY = 'similarityGroupVersion';

// Module-level concurrency guards. Must be module-scoped (not on state) because
// Zustand's get() returns a new snapshot after every set(), making state-attached
// flags invisible to subsequent calls.
let __syncInProgress = false;
let __similaritySyncInProgress = false;
let __similaritySyncQueued = false;
// Pipeline + semantic serialization now live in processingQueue (the global
// sequencer) — the queue guarantees one phase-set at a time app-wide, so the
// old in-progress/queued setTimeout-replay flags are gone. syncNewImagesToStacks
// and computeSimilarityGroups keep their own guards because they can also be
// invoked directly (not only through the round).

// ── Semantic search (Phase 5) ──────────────────────────────────────────
// Debounce window for runSemanticSearch — coalesces keystrokes so the
// worker only sees the settled query (the coordinator's latest-query-wins
// backs this up when searches do overlap).
const SEMANTIC_SEARCH_DEBOUNCE_MS = 300;
// Must match the module coordinator's SEMANTIC_INDEX_CANCELLED
// (ai-intelligence/src/coordinator/semanticSearchEngine.ts) — used to
// swallow a user-cancelled run without surfacing it as a failure.
const SEMANTIC_INDEX_CANCELLED = 'Semantic indexing cancelled by user';

// A force (Settings → Re-index) requested while a run is in flight — the
// queued run must also clear the index or the rebuild silently degrades
// to a Δ run. Survives coalescing into a pending non-force job.
let __semanticIndexQueuedForce = false;
// Auto-tag in-flight bookkeeping: the run's promise (resolved on 'complete'/
// 'error'/cancel) lets callers await the run — the round awaits it before its
// semantic phase. Module-scoped for the same reason as the guards above.
let __autoTagInFlight: Promise<void> | null = null;
let __autoTagResolve: (() => void) | null = null;
let __semanticSearchTimer: ReturnType<typeof setTimeout> | null = null;
// Monotonic sequence for latest-query-wins: results from a superseded
// search (or a search invalidated by clearSemanticSearch) are discarded.
let __semanticSearchSeq = 0;
// One coordinator per app lifetime — owns the AI worker + progress callbacks.
let __semanticCoordinator: SemanticSearchCoordinator | null = null;

// Footer chips (aiModelsLoaded): which workers hold AI models in GPU memory.
// Tracked per source — the long-lived semantic coordinator worker and the
// per-run auto-tag worker each report their own residency, and the footer
// shows the union. Both engines carry BOTH records (CreateMLCEngine
// ([chatId, embedId])), so each source's flags flip together; the union
// clears a source when its worker is terminated (auto-tag eject, cancel,
// error — the auto-tag worker now stays resident between runs).
let __semanticModelsStatus: AiModelsStatus | null = null;
let __autoTagModelsStatus: AiModelsStatus | null = null;

const EMPTY_AI_MODELS_STATUS: AiModelsStatus = {
    chatLoaded: false,
    embedLoaded: false,
    chatModelId: null,
    embedModelId: null,
    chatVramMb: null,
    embedVramMb: null,
};

function recomputeAiModelsLoaded(): void {
    const chatModelId =
        (__semanticModelsStatus?.chatLoaded ? __semanticModelsStatus.chatModelId : null) ??
        (__autoTagModelsStatus?.chatLoaded ? __autoTagModelsStatus.chatModelId : null);
    const embedModelId =
        (__semanticModelsStatus?.embedLoaded ? __semanticModelsStatus.embedModelId : null) ??
        (__autoTagModelsStatus?.embedLoaded ? __autoTagModelsStatus.embedModelId : null);
    // VRAM figures pair with their model id — take them from whichever source
    // contributed the id (same precedence: semantic first, auto-tag fallback).
    const chatVramMb =
        (__semanticModelsStatus?.chatLoaded ? __semanticModelsStatus.chatVramMb : null) ??
        (__autoTagModelsStatus?.chatLoaded ? __autoTagModelsStatus.chatVramMb : null);
    const embedVramMb =
        (__semanticModelsStatus?.embedLoaded ? __semanticModelsStatus.embedVramMb : null) ??
        (__autoTagModelsStatus?.embedLoaded ? __autoTagModelsStatus.embedVramMb : null);
    useImageStore.setState({
        aiModelsLoaded: {
            chatLoaded: chatModelId !== null,
            embedLoaded: embedModelId !== null,
            chatModelId,
            embedModelId,
            chatVramMb,
            embedVramMb,
        },
    });
}

const getSemanticCoordinator = async (): Promise<SemanticSearchCoordinator> => {
    if (!__semanticCoordinator) {
        const { SemanticSearchCoordinator } = await import('../services/semanticSearchEngine');
        __semanticCoordinator = new SemanticSearchCoordinator((progress) => {
            useImageStore.getState().setSemanticIndexProgress(progress);
        }, (info) => {
            // The shared engine loads in the worker — its detected adapter
            // (from the requestAdapter patch) comes back via gpu-info.
            useImageStore.getState().setDetectedGpuInfo(info);
        }, undefined, (status) => {
            // The worker reports which records its engine holds (pushed after
            // every load); unloadModels() clears it when the worker dies.
            useImageStore.getState().setSemanticModelsStatus(status);
        });
    }
    return __semanticCoordinator;
};

/**
 * RAW semantic Δ-index run — the implementation behind the queue-wrapped
 * `semanticIndexImages` action. Call this directly from inside queued jobs
 * (the pipeline round): awaiting the wrapped action there would deadlock
 * (FIFO — the semantic job can't start until the outer job finishes).
 * Only images whose textHash changed get embedded.
 */
export async function runSemanticIndexNow(options?: { force?: boolean }): Promise<void> {
    if (!isSemanticSearchEnabled()) {
        console.log('[SemanticIndex] Semantic search disabled — skipping');
        return;
    }

    if (!useImageStore.getState().isAnnotationsLoaded) {
        console.log('[SemanticIndex] Annotations not yet loaded — deferring');
        return;
    }

    try {
        const coordinator = await getSemanticCoordinator();
        if (options?.force || __semanticIndexQueuedForce) {
            __semanticIndexQueuedForce = false;
            await coordinator.clearIndex();
        }
        // Δ-only: the coordinator computes the delta BEFORE loading the
        // embed model, so a fully-indexed library costs zero model load —
        // startup runs finish instantly instead of loading WebGPU models for
        // no work.
        // Split each image's index text into its weighted segments — the
        // module now weights auto-tags (0.9) separately from manual +
        // metadata tags (0.8), so the merged IndexedImage.tags can't be
        // passed whole. Images never annotated fall back to their stored tags.
        const { images, annotations } = useImageStore.getState();
        const payload = images.map(img => {
            const ann = annotations.get(img.id);
            return {
                id: img.id,
                prompt: img.prompt,
                tags: ann ? [...(ann.tags ?? []), ...(ann.metadataTags ?? [])] : (img.tags ?? []),
                autoTags: ann?.autoTags ?? img.autoTags ?? [],
                synonyms: img.synonymTags ?? [],
            };
        });
        const result = await coordinator.indexImages(payload);
        const status = coordinator.getStatus(); // authoritative persisted count
        useImageStore.setState({ semanticIndexedCount: status.indexed, semanticLastError: null });
        console.log(`[SemanticIndex] Indexed ${result.indexed}, skipped ${result.skipped} (total ${status.indexed})`);
    } catch (error) {
        if (error instanceof Error && error.message === SEMANTIC_INDEX_CANCELLED) {
            // User cancel — a normal outcome, not an error.
            console.log('[SemanticIndex] Indexing cancelled by user');
        } else {
            // A missing module lands here — report but don't fail the
            // pipeline.
            console.error('[SemanticIndex] Indexing failed:', error);
            useImageStore.setState({ semanticLastError: error instanceof Error ? error.message : String(error) });
        }
    } finally {
        // Always close the progress bar — success, failure, or cancel.
        // Without this the bar sticks at the last progress event
        // (e.g. "100/100 — Finish loading on WebGPU") forever.
        useImageStore.getState().setSemanticIndexProgress(null);
    }
}

/**
 * RAW pipeline round — the implementation behind the queue-wrapped
 * `processPostIndexingPipeline` action. One strictly sequential round:
 *
 *   Phase 1/4 — stacking (exact prompt hashing → stackGroupId)
 *   Phase 2/4 — similarity grouping (semantic clustering)
 *   Phase 3/4 — auto-tagging (AI enrichment, LIBRARY scope)
 *   Phase 4/4 — semantic search indexing (textHash Δ → semanticVectors)
 *
 * Auto-tag sits between similarity and semantic so enrichment results feed
 * both downstream phases — and so it always completes before the semantic
 * index consumes tag changes. Only images that actually need each phase
 * (e.g. un-stacked images, changed textHashes) do work — an idle round is
 * cheap.
 *
 * Called from INSIDE queued jobs (reprocess, watcher events, reconnect):
 * awaiting the queue-wrapped `processPostIndexingPipeline` action here
 * would deadlock (FIFO — the pipeline job can't start until the outer job
 * finishes), so the raw function is what queued jobs await. `pipelinePhase`
 * drives the Footer's "Phase N/4" label one phase at a time.
 */
export async function runPipelineRound(): Promise<void> {
    const store = useImageStore.getState();

    if (!store.isAnnotationsLoaded) {
        console.log('[Pipeline] Annotations not yet loaded — deferring (will retry on next trigger)');
        return;
    }

    try {
        // Phase 1: Exact-prompt hash stacking (syncNewImagesToStacks)
        // Only processes images where isStackAnalyzed is false.
        console.log('[Pipeline] Phase 1/4: Prompt stacking (exact-match hashing)...');
        store.setPipelinePhase('stacking');
        await store.syncNewImagesToStacks();

        // Phase 2: Semantic similarity grouping
        // Only processes images where isSimilarityAnalyzed is false
        // (or where similarityGroupId was never assigned by the engine).
        console.log('[Pipeline] Phase 2/4: Similarity grouping (semantic clustering)...');
        store.setPipelinePhase('similarity');
        await store.computeSimilarityGroups();

        // Phase 3: Auto-tagging — library scope so it covers images outside
        // the current view (the view-scoped default only ever saw what the
        // user was looking at, which is why reprocess never tagged anything).
        console.log('[Pipeline] Phase 3/4: Auto-tagging (library scope)...');
        store.setPipelinePhase('autoTag');
        await store.startAutoTagging('', false, { scope: 'library' });

        // Phase 4: Semantic search indexing (§8.3) — raw call, see above.
        // Δ by textHash — only images missing a vector record (or whose
        // searchable text changed) get embedded. Skipped silently when
        // semantic search is disabled.
        console.log('[Pipeline] Phase 4/4: Semantic search indexing...');
        store.setPipelinePhase('semantic');
        await runSemanticIndexNow();

        console.log('[Pipeline] All phases complete.');
    } catch (error) {
        console.error('[Pipeline] Post-indexing pipeline failed:', error);
    } finally {
        useImageStore.getState().setPipelinePhase(null);
    }
}

/**
 * Pure §8.2 merge: overlay ranked semantic hits on the synchronous text
 * results. `curationVisible` is the filterAndSort scope after the curation
 * filters (directory visibility, folder selection + exclusions, favorites,
 * safe mode, tags) — the filters semantic results must respect. Semantic
 * hits are NOT keyword-filtered (that is the point of semantic search).
 *
 *   off / no hits → textResults unchanged
 *   semantic      → all hits ∩ curation-visible (score order) — the keyword
 *                   filter is replaced entirely
 */
export function applySemanticMerge(
    textResults: IndexedImage[],
    hits: ISemanticSearchHit[],
    curationVisible: IndexedImage[],
    mode: 'semantic' | 'off',
): IndexedImage[] {
    if (mode === 'off' || !hits || hits.length === 0) return textResults;

    const imagesById = new Map(curationVisible.map((img) => [img.id, img] as const));

    // Hits arrive ranked from the coordinator, but re-sort defensively so the
    // final ordering never depends on worker message order.
    const orderedHits = [...hits].sort((a, b) => b.score - a.score);

    const visibleHits: IndexedImage[] = [];
    const seen = new Set<string>();
    for (const hit of orderedHits) {
        if (seen.has(hit.imageId)) continue; // defensive dedupe
        seen.add(hit.imageId);
        const image = imagesById.get(hit.imageId);
        if (!image) continue; // hit outside the curation-visible scope → drop
        visibleHits.push(image);
    }

    return visibleHits; // semantic mode — all hits ∩ curation-visible (score order)
}

// ── Undo stack (session-only) ───────────────────────────────────────────
// Captures pre-merge annotation snapshots so Ctrl+Z can restore them.
interface UndoEntry {
  description: string;
  previousAnnotations: Array<{
    imageId: string;
    stackGroupId?: string;
    similarityGroupId?: string;
    isSimilarityAnalyzed?: boolean;
  }>;
}
const __undoStack: UndoEntry[] = [];
const MAX_UNDO_STACK = 20;

/**
 * Restore the last detected WebGPU adapter (Settings → AI Intelligence).
 * Detection fires only when a model first loads into a worker, so the value
 * is persisted on detection and restored here — Settings shows the GPU
 * without waiting for another load. Corrupt/absent data → null (same as
 * never detected).
 */
export function loadDetectedGpuInfo(): DetectedGpuInfo | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(DETECTED_GPU_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        if (parsed && typeof parsed.vendor === 'string' && typeof parsed.device === 'string') {
            return parsed as unknown as DetectedGpuInfo;
        }
        return null;
    } catch {
        return null;
    }
}

/** Restore the last main-process GPU list (Settings dropdown options).
 *  Corrupt/absent data → [] (the async re-fetch repopulates it). */
export function loadDetectedGpuDevices(): GpuDeviceReport[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = localStorage.getItem(DETECTED_GPUS_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        const devices = parsed.filter(
            (d): d is GpuDeviceReport =>
                typeof d === 'object' &&
                d !== null &&
                typeof (d as Record<string, unknown>).vendor === 'string' &&
                typeof (d as Record<string, unknown>).device === 'string',
        );
        return devices.map((d) => ({
            vendor: d.vendor,
            device: d.device,
            description: typeof d.description === 'string' ? d.description : undefined,
            vendorId: typeof d.vendorId === 'number' ? d.vendorId : undefined,
            active: d.active === true,
        }));
    } catch {
        return [];
    }
}

const loadRecentTags = (): string[] => {
    if (typeof window === 'undefined') {
        return [];
    }

    try {
        const raw = localStorage.getItem(RECENT_TAGS_STORAGE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed
            .map(tag => (typeof tag === 'string' ? tag.trim().toLowerCase() : ''))
            .filter(Boolean)
            .slice(0, MAX_RECENT_TAGS);
    } catch (error) {
        console.warn('Failed to load recent tags:', error);
        return [];
    }
};

const persistRecentTags = (tags: string[]) => {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        localStorage.setItem(RECENT_TAGS_STORAGE_KEY, JSON.stringify(tags));
    } catch (error) {
        console.warn('Failed to persist recent tags:', error);
    }
};

const updateRecentTags = (currentTags: string[], tag: string): string[] => {
    const normalizedTag = tag.trim().toLowerCase();
    if (!normalizedTag) {
        return currentTags;
    }

    const next = [normalizedTag, ...currentTags.filter(existing => existing !== normalizedTag)];
    return next.slice(0, MAX_RECENT_TAGS);
};


const getImageFolderPath = (image: IndexedImage, directoryPath: string): string => {
    const normalizedDirectory = normalizePath(directoryPath);
    const idParts = image.id.split('::');
    if (idParts.length !== 2) {
        return normalizedDirectory;
    }

    const relativePath = idParts[1];
    const segments = relativePath.split(/[/\\]/).filter(Boolean);
    if (segments.length <= 1) {
        return normalizedDirectory;
    }

    const folderSegments = segments.slice(0, -1);
    const folderRelativePath = folderSegments.join('/');
    return joinPath(normalizedDirectory, folderRelativePath);
};

const detectSeparator = (path: string) => (path.includes('\\') && !path.includes('/')) ? '\\' : '/';

const joinPath = (base: string, relative: string) => {
    if (!relative) {
        return normalizePath(base);
    }
    const separator = detectSeparator(base);
    const normalizedBase = normalizePath(base);
    const normalizedRelative = relative
        .split(/[/\\]/)
        .filter(segment => segment.length > 0)
        .join(separator);
    if (!normalizedBase) {
        return normalizedRelative;
    }
    return `${normalizedBase}${separator}${normalizedRelative}`;
};

const getRelativeImagePath = (image: IndexedImage): string => {
    if (!image?.id) return image?.name ?? '';
    const [, relative = ''] = image.id.split('::');
    return relative || image.name;
};

const buildCatalogSearchText = (image: IndexedImage): string => {
    const relativePath = getRelativeImagePath(image).replace(/\\/g, '/').toLowerCase();
    const name = (image.name || '').toLowerCase();
    const directory = (image.directoryName || '').replace(/\\/g, '/').toLowerCase();
    
    const tags = (image.tags || []).join(' ').toLowerCase();
    const autoTags = (image.autoTags || []).join(' ').toLowerCase();
    const metadataTags = (image.metadataTags || []).join(' ').toLowerCase();
    const models = (image.models || []).join(' ').toLowerCase();

    return [name, relativePath, directory, tags, autoTags, metadataTags, models].filter(Boolean).join(' ');
};

const buildEnrichedSearchText = (image: IndexedImage): string => {
    if (image.enrichmentState !== 'enriched') {
        return '';
    }

    const segments: string[] = [];
    if (image.metadataString) {
        // metadataString is intentionally set to '' to save memory
        // keeping this block in case older clients have it, but skipping segments.push to avoid bloat
    }
    if (image.prompt) {
        segments.push(image.prompt.toLowerCase());
    }
    if (image.negativePrompt) {
        segments.push(image.negativePrompt.toLowerCase());
    }
    if (image.models?.length) {
        segments.push(image.models.filter(model => typeof model === 'string').map(model => model.toLowerCase()).join(' '));
    }
    if (image.loras?.length) {
        const loraNames = image.loras.map(lora => {
            if (typeof lora === 'string') {
                return lora.toLowerCase();
            } else if (lora && typeof lora === 'object' && lora.name) {
                return lora.name.toLowerCase();
            }
            return '';
        }).filter(Boolean);
        if (loraNames.length > 0) {
            segments.push(loraNames.join(' '));
        }
    }
    if (image.scheduler) {
        segments.push(image.scheduler.toLowerCase());
    }
    if (image.board) {
        segments.push(image.board.toLowerCase());
    }

    return segments.join(' ');
};

interface ImageState {
  // Core Data
  images: IndexedImage[];
  filteredImages: IndexedImage[];
  selectionTotalImages: number;
  selectionDirectoryCount: number;
  directories: Directory[];
  selectedFolders: Set<string>;
  excludedFolders: Set<string>;
  isFolderSelectionLoaded: boolean;
  includeSubfolders: boolean;
  folderPreferences: Map<string, FolderPreference>;

  // UI State
  isLoading: boolean;
  progress: { current: number; total: number; message?: string } | null;
  enrichmentProgress: { processed: number; total: number; message?: string } | null;
  indexingState: 'idle' | 'indexing' | 'paused' | 'completed';
  error: string | null;
  success: string | null;
  selectedImage: IndexedImage | null;
  selectedImages: Set<string>;
  previewImage: IndexedImage | null;
  focusedImageIndex: number | null;
  isStackingEnabled: boolean;
  undoAvailable: boolean;
  scanSubfolders: boolean;
  libraryStackContext: LibraryStackContext | null;  // For Back to Stacks navigation (ID-based, preserves search bar)
  isFullscreenMode: boolean;
  activeView: 'library' | 'smart' | 'model';



  // Filter & Sort State
  searchQuery: string;
  availableModels: string[];
  availableLoras: string[];
  availableSchedulers: string[];
  availableDimensions: string[];
  availableAspectRatios: string[];
  selectedModels: string[];
  selectedLoras: string[];
  selectedSchedulers: string[];
  sortOrder: 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random' | 'relevance';
  randomSeed: number;
  advancedFilters: any;

  // Annotations State
  annotations: Map<string, ImageAnnotations>;
  availableTags: TagInfo[];
  recentTags: string[];
  selectedTags: string[];
  showFavoritesOnly: boolean;
  selectionFavoriteCount: number;
  isAnnotationsLoaded: boolean;
  activeWatchers: Set<string>; // IDs das pastas sendo monitoradas
  refreshingDirectories: Set<string>;

  // Smart Clustering State (Phase 2)
  // Clustering state retained for backward compatibility (no longer used)
  clusters: any[];
  clusteringProgress: { current: number; total: number; message: string } | null;
  clusteringWorker: Worker | null;
  isClustering: boolean;
  clusterNavigationContext: IndexedImage[] | null;

  // Similarity Grouping State
  similarityGroupProgress: { current: number; total: number; message: string } | null;

  // Pipeline State
  pipelinePhase: 'idle' | 'stacking' | 'similarity' | 'autoTag' | 'semantic' | null;

  // Auto-Tagging State (Phase 3)

  autoTaggingProgress: { current: number; total: number; message: string } | null;
  autoTaggingWorker: Worker | null;
  isAutoTagging: boolean;
  /** Which tag model id the resident auto-tag worker was loaded with
   *  (resolved — '' is stored as the default id). Drives worker reuse:
   *  runs with the same model keep the worker; a different id spawns a
   *  fresh one. Cleared when the worker is terminated (eject, cancel,
   *  error). */
  autoTagWorkerModelId: string | null;

  // Semantic Search State (Phase 5)
  semanticMode: 'semantic' | 'off';
  semanticHits: ISemanticSearchHit[] | null;
  semanticSearchStatus: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  semanticIndexProgress: SemanticIndexProgress | null;
  semanticIndexedCount: number;
  semanticLastError: string | null;
  /** Detected WebGPU adapter (vendor/device) reported by the AI worker. */
  detectedGpuInfo: DetectedGpuInfo | null;
  /** Every GPU Chromium detected (main-process report) — the readout lists
   *  all of them with the active one marked. */
  detectedGpuDevices: GpuDeviceReport[];
  /** Which AI model records are resident in GPU memory — footer chips + eject.
   *  Union of the semantic coordinator worker and the per-run auto-tag
   *  worker; each worker reports its own residency (models-status). */
  aiModelsLoaded: AiModelsStatus;

  // Actions
  addDirectory: (directory: Directory) => void;
  updateDirectoryStatus: (directoryId: string, isConnected: boolean) => void;
  removeDirectory: (directoryId: string) => void;
  markReprocessPending: (directoryId: string, pending: boolean) => void;
  reorderDirectories: (orderedIds: string[]) => void;
  toggleDirectoryVisibility: (directoryId: string) => void;
  toggleAutoWatch: (directoryId: string) => void;
  initializeFolderSelection: () => Promise<void>;
  toggleFolderSelection: (path: string, ctrlKey: boolean) => void;
  clearFolderSelection: () => void;
  // Excluded Folders Actions
  addExcludedFolder: (path: string) => void;
  removeExcludedFolder: (path: string) => void;
  isFolderSelected: (path: string) => boolean;
  setFolderEmoji: (path: string, emoji: string | undefined) => Promise<void>;
  setFolderScanSubfolders: (path: string, scanSubfolders: boolean) => Promise<void>;
  toggleIncludeSubfolders: () => void;
  setLoading: (loading: boolean) => void;
  setProgress: (progress: { current: number; total: number } | null) => void;
  setEnrichmentProgress: (progress: { processed: number; total: number; message?: string } | null) => void;
  setIndexingState: (indexingState: 'idle' | 'indexing' | 'paused' | 'completed') => void;
  setError: (error: string | null) => void;
  setSuccess: (success: string | null) => void;
  setImages: (images: IndexedImage[]) => void;
  addImages: (newImages: IndexedImage[]) => void;
  replaceDirectoryImages: (directoryId: string, newImages: IndexedImage[]) => void;
  mergeImages: (updatedImages: IndexedImage[]) => void;
  removeImage: (imageId: string) => void;
  removeImages: (imageIds: string[]) => void;
  removeImagesByPaths: (paths: string[]) => void;
  updateImage: (imageId: string, newName: string) => void;
  updateImageDimensions: (imageId: string, dimensions: string) => void;
  clearImages: (directoryId?: string) => void;
  setImageThumbnail: (
    imageId: string,
    data: {
      thumbnailUrl?: string | null;
      thumbnailHandle?: FileSystemFileHandle | null;
      status: ThumbnailStatus;
      error?: string | null;
    }
  ) => void;
  clearAllThumbnails: () => void;

  // Filter & Sort Actions
  setSearchQuery: (query: string) => void;
  setFilterOptions: (options: { models: string[]; loras: string[]; schedulers: string[]; dimensions: string[] }) => void;
  setSelectedFilters: (filters: { models?: string[]; loras?: string[]; schedulers?: string[] }) => void;
  setSortOrder: (order: 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random' | 'relevance') => void;
  reshuffle: () => void;
  setAdvancedFilters: (filters: any) => void;
  filterAndSortImages: () => void;

  // Selection Actions
  setPreviewImage: (image: IndexedImage | null) => void;
  setSelectedImage: (image: IndexedImage | null) => void;
  toggleImageSelection: (imageId: string) => void;
  selectAllImages: () => void;
  clearImageSelection: () => void;
  deleteSelectedImages: () => Promise<void>; // This will require file operations logic
  setScanSubfolders: (scan: boolean) => void;
  setFocusedImageIndex: (index: number | null) => void;
  setLibraryStackContext: (context: LibraryStackContext | null) => void;
  syncNewImagesToStacks: () => Promise<void>;
  handleStackImageDeletion: (deletedImageIds: string[]) => void;
  mergeSelectedToStack: () => Promise<void>;
  unmergeSelectedFromStack: () => Promise<void>;
  tryUndo: () => Promise<boolean>;
  computeSimilarityGroups: () => Promise<void>;
  processPostIndexingPipeline: () => Promise<void>;
  setFullscreenMode: (isFullscreen: boolean) => void;

  // Clustering Actions (Phase 2)
  startClustering: (directoryPath: string, scanSubfolders: boolean, threshold: number) => Promise<void>;
  cancelClustering: () => void;
  setClusters: (clusters: any[]) => void;
  setClusteringProgress: (progress: { current: number; total: number; message: string } | null) => void;
  setSimilarityGroupProgress: (progress: { current: number; total: number; message: string } | null) => void;
  setPipelinePhase: (phase: 'idle' | 'stacking' | 'similarity' | 'autoTag' | 'semantic' | null) => void;
  setSemanticMode: (mode: 'semantic' | 'off') => void;
  runSemanticSearch: (query: string) => Promise<void>;
  clearSemanticSearch: () => void;
  semanticIndexImages: (options?: { force?: boolean }) => Promise<void>;
  cancelSemanticIndexing: () => void;
  applySemanticEmbeddingModel: (modelId: string) => Promise<void>;
  setSemanticIndexProgress: (progress: SemanticIndexProgress | null) => void;
  /** Footer chips: the semantic coordinator worker's model residency. */
  setSemanticModelsStatus: (status: AiModelsStatus) => void;
  /** Footer chips: the per-run auto-tag worker's model residency (null = worker gone). */
  setAutoTagModelsStatus: (status: AiModelsStatus | null) => void;
  /** Footer eject: terminate the auto-tag worker (if running) and unload the
   *  semantic coordinator's engine from GPU memory. */
  unloadAiModels: () => Promise<void>;
  setDetectedGpuInfo: (info: DetectedGpuInfo | null) => void;
  setDetectedGpuDevices: (devices: GpuDeviceReport[]) => void;
  handleClusterImageDeletion: (deletedImageIds: string[]) => void;
  setClusterNavigationContext: (images: IndexedImage[] | null) => void;

  // Auto-Tagging Actions (Phase 3)
  startAutoTagging: (
    directoryPath: string,
    scanSubfolders: boolean,
    options?: { topN?: number; minScore?: number; scope?: 'view' | 'library' }
  ) => Promise<void>;
  cancelAutoTagging: () => void;
  setAutoTaggingProgress: (progress: { current: number; total: number; message: string } | null) => void;
  restoreSmartLibraryCache: (directoryPath: string, scanSubfolders: boolean) => Promise<void>;



  // Annotations Actions
  loadAnnotations: () => Promise<void>;
  toggleFavorite: (imageId: string) => Promise<void>;
  bulkToggleFavorite: (imageIds: string[], isFavorite: boolean) => Promise<void>;
  addTagToImage: (imageId: string, tag: string) => Promise<void>;
  removeTagFromImage: (imageId: string, tag: string) => Promise<void>;
  bulkAddTag: (imageIds: string[], tag: string) => Promise<void>;
  bulkRemoveTag: (imageIds: string[], tag: string) => Promise<void>;
  setSelectedTags: (tags: string[]) => void;
  setShowFavoritesOnly: (show: boolean) => void;
  getImageAnnotations: (imageId: string) => ImageAnnotations | null;
  refreshAvailableTags: () => Promise<void>;
  clearAutoTags: () => Promise<void>;
  /** Reprocess Images: wipe all derived image data (caches, thumbnails,
   *  semantic vectors, auto-tags, stack/similarity groups) — keeps favorites,
   *  manual tags, folders, license and settings. The caller then re-scans and
   *  the post-indexing pipeline rebuilds everything. Throws when a scan,
   *  pipeline, or semantic run is in flight. */
  clearDerivedImageData: () => Promise<void>;
  importMetadataTags: (images: IndexedImage[]) => Promise<void>;
  flushPendingImages: () => void;
  setDirectoryRefreshing: (directoryId: string, isRefreshing: boolean) => void;

  // Navigation Actions
  handleNavigateNext: () => void;
  handleNavigatePrevious: () => void;

  // Cleanup invalid images
  cleanupInvalidImages: () => void;
  setStackingEnabled: (enabled: boolean) => void;

  // Drag and Drop State (Internal)
  draggedItems: { sourcePath: string; name: string }[];
  setDraggedItems: (items: { sourcePath: string; name: string }[]) => void;
  clearDraggedItems: () => void;

  // Scroll Positions
  folderScrollPositions: Record<string, number>;
  setFolderScrollPosition: (key: string, position: number) => void;
  setActiveView: (view: 'library' | 'smart' | 'model') => void;

  // Reset Actions
  resetState: () => void;
}

export const useImageStore = create<ImageState>((set, get) => {
    // --- Throttle map to prevent excessive setImageThumbnail calls ---
    const thumbnailUpdateTimestamps = new Map<string, { count: number; lastUpdate: number }>();
    const thumbnailUpdateInProgress = new Set<string>();
    const lastThumbnailState = new Map<string, {
        url: string | undefined;
        handle: FileSystemFileHandle | undefined;
        status: ThumbnailStatus;
        error: string | null | undefined;
    }>();
    let pendingImagesQueue: IndexedImage[] = [];
    let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const FLUSH_INTERVAL_MS = 100;
    let pendingMergeQueue: IndexedImage[] = [];
    let pendingMergeTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingFilterRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingDimensionUpdates = new Map<string, string>();
    let pendingDimensionTimer: ReturnType<typeof setTimeout> | null = null;
    const MERGE_FLUSH_INTERVAL_MS = 250;
    const MERGE_FLUSH_INTERVAL_INDEXING_MS = 3000;
    const MERGE_FLUSH_INTERVAL_INDEXING_LARGE_MS = 15000;
    const MERGE_FLUSH_LARGE_THRESHOLD = 8000;
    const FILTER_RECOMPUTE_INDEXING_MS = 5000;

    const clearPendingQueue = () => {
        pendingImagesQueue = [];
        if (pendingFlushTimer) {
            clearTimeout(pendingFlushTimer);
            pendingFlushTimer = null;
        }
        pendingMergeQueue = [];
        if (pendingMergeTimer) {
            clearTimeout(pendingMergeTimer);
            pendingMergeTimer = null;
        }
        if (pendingFilterRecomputeTimer) {
            clearTimeout(pendingFilterRecomputeTimer);
            pendingFilterRecomputeTimer = null;
        }
        pendingDimensionUpdates.clear();
        if (pendingDimensionTimer) {
            clearTimeout(pendingDimensionTimer);
            pendingDimensionTimer = null;
        }
    };

    const flushPendingImages = () => {
        if (pendingImagesQueue.length === 0) {
            return;
        }

        const imagesToAdd = pendingImagesQueue;
        pendingImagesQueue = [];
        if (pendingFlushTimer) {
            clearTimeout(pendingFlushTimer);
            pendingFlushTimer = null;
        }

        let addedImages: IndexedImage[] = [];
        set(state => {
            const deduped = new Map<string, IndexedImage>();
            for (const img of imagesToAdd) {
                if (img?.id && !deduped.has(img.id.toLowerCase())) {
                    deduped.set(img.id.toLowerCase(), img);
                }
            }
            const queuedUnique = Array.from(deduped.values());
            const existingIdsLower = new Set(state.images.map(img => img.id.toLowerCase()));
            const uniqueNewImages = queuedUnique.filter(img => !existingIdsLower.has(img.id.toLowerCase()));

            if (uniqueNewImages.length === 0) {

                return state;
            }
            addedImages = uniqueNewImages;
            const allImages = [...state.images, ...uniqueNewImages];

            const newState = _updateState(state, allImages);

            return newState;
        });

        // Import tags from metadata after images are added to store
        if (addedImages.length > 0) {
            get().importMetadataTags(addedImages);
        }
    };

    const scheduleFlush = () => {
        if (pendingFlushTimer) {
            return;
        }
        pendingFlushTimer = setTimeout(() => {
            flushPendingImages();
        }, FLUSH_INTERVAL_MS);
    };

    const flushPendingMerges = (forceFullRecompute: boolean = false) => {
        if (pendingMergeQueue.length === 0) {
            return;
        }

        const updatesToMerge = pendingMergeQueue;
        pendingMergeQueue = [];
        if (pendingMergeTimer) {
            clearTimeout(pendingMergeTimer);
            pendingMergeTimer = null;
        }

        set(state => {
            const updates = new Map<string, IndexedImage>();
            for (const img of updatesToMerge) {
                if (img?.id) {
                    updates.set(img.id, img);
                }
            }
            if (updates.size === 0) {
                return state;
            }

            let hasChanges = false;
            const merged = state.images.map(img => {
                const updated = updates.get(img.id);
                if (updated) {
                    hasChanges = true;
                    // Preserve annotation-derived fields from the existing image.
                    // Enrichment merges (metadata parsing results) do not carry
                    // stackGroupId, similarityGroupId, tags, isFavorite, etc.
                    // Without this preservation, stacks visually ungroup whenever
                    // enrichment results overwrite store images during indexing.
                    return {
                        ...updated,
                        isFavorite: img.isFavorite,
                        tags: img.tags,
                        autoTags: img.autoTags,
                        isAutoTagged: img.isAutoTagged,
                        metadataTags: img.metadataTags,
                        stackGroupId: img.stackGroupId,
                        isStackAnalyzed: img.isStackAnalyzed,
                        similarityGroupId: img.similarityGroupId,
                        isSimilarityAnalyzed: img.isSimilarityAnalyzed,
                    };
                }
                return img;
            });

            if (!hasChanges) {
                return state;
            }

            const isIndexing = state.indexingState === 'indexing';
            if (isIndexing && !forceFullRecompute) {
                const filtersActive = isFilteringActive(state);
                let nextFilteredImages = state.filteredImages;
                let availableFiltersUpdate: Partial<ImageState> = {};

                if (!filtersActive) {
                    nextFilteredImages = merged;
                    const models = new Set(state.availableModels);
                    const loras = new Set(state.availableLoras);
                    const schedulers = new Set(state.availableSchedulers);
                    const dimensions = new Set(state.availableDimensions);
                    const aspectRatios = new Set(state.availableAspectRatios);

                    for (const img of updates.values()) {
                        img.models?.forEach(model => { if (typeof model === 'string' && model) models.add(model); });
                        img.loras?.forEach(lora => {
                            if (typeof lora === 'string' && lora) {
                                loras.add(lora);
                            } else if (lora && typeof lora === 'object' && lora.name) {
                                loras.add(lora.name);
                            }
                        });
                        if (img.scheduler) {
                            schedulers.add(img.scheduler);
                        }
                        if (img.dimensions) {
                            dimensions.add(img.dimensions);
                            const [w, h] = img.dimensions.split('x').map(Number);
                            if (w > 0 && h > 0) {
                                const ar = getImageAspectRatio(w, h);
                                if (ar) aspectRatios.add(ar);
                            }
                        }
                    }

                    availableFiltersUpdate = {
                        availableModels: Array.from(models),
                        availableLoras: Array.from(loras),
                        availableSchedulers: Array.from(schedulers),
                        availableDimensions: Array.from(dimensions),
                        availableAspectRatios: Array.from(aspectRatios),
                    };
                } else {
                    nextFilteredImages = state.filteredImages.map(img => {
                        const updated = updates.get(img.id);
                        if (updated) {
                            // Same annotation-field preservation as the `merged`
                            // array above — prevents temporary ungrouping during
                            // the window before scheduleFilterRecompute fires.
                            return {
                                ...updated,
                                isFavorite: img.isFavorite,
                                tags: img.tags,
                                autoTags: img.autoTags,
                                isAutoTagged: img.isAutoTagged,
                                metadataTags: img.metadataTags,
                                stackGroupId: img.stackGroupId,
                                isStackAnalyzed: img.isStackAnalyzed,
                                similarityGroupId: img.similarityGroupId,
                                isSimilarityAnalyzed: img.isSimilarityAnalyzed,
                            };
                        }
                        return img;
                    });
                    scheduleFilterRecompute();
                }

                return {
                    ...state,
                    images: merged,
                    filteredImages: nextFilteredImages,
                    selectionTotalImages: merged.length,
                    selectionDirectoryCount: state.directories.length,
                    ...availableFiltersUpdate,
                };
            }

            return _updateState(state, merged);
        });
    };

    const scheduleMergeFlush = () => {
        if (pendingMergeTimer) {
            return;
        }
        const isIndexing = get().indexingState === 'indexing';
        const interval = isIndexing
            ? (get().images.length >= MERGE_FLUSH_LARGE_THRESHOLD
                ? MERGE_FLUSH_INTERVAL_INDEXING_LARGE_MS
                : MERGE_FLUSH_INTERVAL_INDEXING_MS)
            : MERGE_FLUSH_INTERVAL_MS;
        pendingMergeTimer = setTimeout(() => {
            flushPendingMerges();
        }, interval);
    };

    const isFilteringActive = (state: ImageState) => {
        if (state.searchQuery) return true;
        if (state.libraryStackContext) return true;
        if (state.showFavoritesOnly) return true;
        if (state.selectedTags?.length) return true;

        if (state.selectedModels?.length || state.selectedLoras?.length || state.selectedSchedulers?.length) return true;
        if (state.advancedFilters && Object.keys(state.advancedFilters).length > 0) return true;
        if (state.selectedFolders && state.selectedFolders.size > 0) return true;
        if (state.directories.some(dir => dir.visible === false)) return true;
        return false;
    };

    const scheduleFilterRecompute = () => {
        if (pendingFilterRecomputeTimer) {
            return;
        }
        pendingFilterRecomputeTimer = setTimeout(() => {
            pendingFilterRecomputeTimer = null;
            set(state => {
                const filteredResult = filterAndSort(state);
                const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);
                return { ...state, ...filteredResult, ...availableFilters };
            });
        }, FILTER_RECOMPUTE_INDEXING_MS);
    };

    const getImageById = (state: ImageState, imageId: string): IndexedImage | undefined => {
        return state.images.find(img => img.id === imageId) || state.filteredImages.find(img => img.id === imageId);
    };

    // --- Helper function to recalculate available filters from visible images ---
    const recalculateAvailableFilters = (visibleImages: IndexedImage[]) => {
        const models = new Set<string>();
        const loras = new Set<string>();
        const schedulers = new Set<string>();
        const dimensions = new Set<string>();
        const aspectRatios = new Set<string>();

        for (const image of visibleImages) {
            image.models?.forEach(model => { if(typeof model === 'string' && model) models.add(model) });
            image.loras?.forEach(lora => {
                if (typeof lora === 'string' && lora) {
                    loras.add(lora);
                } else if (lora && typeof lora === 'object' && lora.name) {
                    loras.add(lora.name);
                }
            });
            if (image.scheduler) schedulers.add(image.scheduler);
            if (image.dimensions && image.dimensions !== '0x0') {
                dimensions.add(image.dimensions);
                const [w, h] = image.dimensions.split('x').map(Number);
                if (w > 0 && h > 0) {
                    const ar = getImageAspectRatio(w, h);
                    if (ar) aspectRatios.add(ar);
                }
            }
        }

        // Case-insensitive alphabetical comparator
        const caseInsensitiveSort = (a: string, b: string) => {
            return a.toLowerCase().localeCompare(b.toLowerCase());
        };

        return {
            availableModels: Array.from(models).sort(caseInsensitiveSort),
            availableLoras: Array.from(loras).sort(caseInsensitiveSort),
            availableSchedulers: Array.from(schedulers).sort(caseInsensitiveSort),
            availableDimensions: Array.from(dimensions).sort((a, b) => {
                // Sort dimensions by total pixels (width * height)
                const [aWidth, aHeight] = a.split('x').map(Number);
                const [bWidth, bHeight] = b.split('x').map(Number);
                return (aWidth * aHeight) - (bWidth * bHeight);
            }),
            availableAspectRatios: Array.from(aspectRatios).sort((a, b) => {
                // Sort by ratio value (width/height)
                const [aW, aH] = a.split(':').map(Number);
                const [bW, bH] = b.split(':').map(Number);
                return (aW / aH) - (bW / bH);
            }),
        };
    };

    const mergeAnnotationTags = (annotation: ImageAnnotations): string[] => {
        return [...new Set([
            ...(annotation.tags || []),
            ...(annotation.autoTags || []),
            ...(annotation.metadataTags || []),
        ])];
    };

    // --- Helper function to apply annotations to images ---
    const applyAnnotationsToImages = (images: IndexedImage[], annotations: Map<string, ImageAnnotations>): IndexedImage[] => {
        let hasChanges = false;
        const result = images.map(img => {
            const annotation = annotations.get(img.id);
            if (annotation) {
                // Check if annotation values are different from current image values
                const isFavoriteChanged = img.isFavorite !== annotation.isFavorite;
                const mergedTags = mergeAnnotationTags(annotation);
                const tagsChanged = JSON.stringify(img.tags || []) !== JSON.stringify(mergedTags);
                const stackChanged = img.stackGroupId !== annotation.stackGroupId
                    || img.isStackAnalyzed !== annotation.isStackAnalyzed
                    || img.similarityGroupId !== annotation.similarityGroupId
                    || img.isSimilarityAnalyzed !== annotation.isSimilarityAnalyzed;

                if (isFavoriteChanged || tagsChanged || stackChanged) {
                    hasChanges = true;
                    return {
                        ...img,
                        isFavorite: annotation.isFavorite,
                        tags: mergedTags,
                        autoTags: annotation.autoTags || [],
                        metadataTags: annotation.metadataTags || [],
                        stackGroupId: annotation.stackGroupId,
                        isStackAnalyzed: annotation.isStackAnalyzed,
                        similarityGroupId: annotation.similarityGroupId,
                        isSimilarityAnalyzed: annotation.isSimilarityAnalyzed,
                        // Enrichment metadata rides annotations → images so the
                        // indexer's Δ pass sees stable text after a restart.
                        synonymTags: annotation.synonymTags ?? [],
                        searchTagVersion: annotation.searchTagVersion,
                    };
                }
            }
            return img;
        });

        // Only return new array if there were actual changes
        return hasChanges ? result : images;
    };

    // --- Helper function for recalculating all derived state ---
    const _updateState = (currentState: ImageState, newImages: IndexedImage[]) => {
        // Apply annotations to new images
        const imagesWithAnnotations = applyAnnotationsToImages(newImages, currentState.annotations);

        // Early return if images didn't change (prevents unnecessary recalculations)
        if (imagesWithAnnotations === currentState.images) {
            return currentState;
        }

        const newState: Partial<ImageState> = {
            images: imagesWithAnnotations,
        };

        const combinedState = { ...currentState, ...newState };

        // First, get filtered images based on folder selection

        const filteredResult = filterAndSort(combinedState);


        // Then, recalculate available filters based on the filtered images (after folder selection)
        const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

        return {
            ...combinedState,
            ...filteredResult,
            ...availableFilters,
        };
    };

    // --- Helper for calculating available tags and favorites in a given image set ---
    const calculateTagInfo = (images: IndexedImage[]): TagInfo[] => {
        const tagCounts = new Map<string, number>();
        for (const img of images) {
            if (img.tags && img.tags.length > 0) {
                for (const tag of img.tags) {
                    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
                }
            }
        }

        const result: TagInfo[] = Array.from(tagCounts.entries()).map(([name, count]) => ({
            name,
            count,
        }));

        return result.sort((a, b) => a.name.localeCompare(b.name));
    };

    // --- Helper function for basic filtering and sorting ---
    const filterAndSort = (state: ImageState) => {
        const { images, searchQuery, libraryStackContext, selectedModels, selectedLoras, selectedSchedulers, sortOrder, advancedFilters, directories, selectedFolders, excludedFolders, includeSubfolders } = state;

        const visibleDirectoryIds = new Set(
            directories.filter(dir => (dir.visible ?? true) && (dir.isConnected !== false)).map(dir => dir.id)
        );


        const directoryPathMap = new Map<string, string>();
        directories.forEach(dir => {
            const normalized = normalizePath(dir.path);
            directoryPathMap.set(dir.id, normalized);
        });

        // Filter images based on folder selection and exclusion
        const selectionFiltered = images.filter((img) => {
            if (!visibleDirectoryIds.has(img.directoryId || '')) {
                return false;
            }

            const parentPath = directoryPathMap.get(img.directoryId || '');
            if (!parentPath) {
                return false;
            }

            const folderPath = normalizePath(getImageFolderPath(img, parentPath));

            // EXCLUSION CHECK: If folder is excluded, hide image
            if (excludedFolders && excludedFolders.size > 0) {
                for (const excludedFolder of excludedFolders) {
                    const normalizedExcluded = normalizePath(excludedFolder);
                    // Check if folderPath IS the excluded folder or IS A CHILD of the excluded folder
                    if (folderPath === normalizedExcluded ||
                        folderPath.startsWith(normalizedExcluded + '/') ||
                        folderPath.startsWith(normalizedExcluded + '\\')) {
                        return false;
                    }
                }
            }

            // If no folders are selected, show all images from visible directories (unless excluded)
            if (selectedFolders.size === 0) {
                return true;
            }

            // Direct matching - check if folder is explicitly selected
            if (selectedFolders.has(folderPath)) {
                return true;
            }

            // If includeSubfolders is enabled, check if any parent folder is selected
            if (includeSubfolders) {
                for (const selectedFolder of selectedFolders) {
                    const normalizedSelected = normalizePath(selectedFolder);
                    // Check if folderPath is a subfolder of selectedFolder
                    if (folderPath.startsWith(normalizedSelected + '/') || folderPath.startsWith(normalizedSelected + '\\')) {
                        return true;
                    }
                }
            }

            return false;
        });

        const selectionFavoriteCount = selectionFiltered.filter(img => img.isFavorite).length;
        const availableTags = calculateTagInfo(selectionFiltered);

        let results = selectionFiltered;

        // Step 2: Favorites filter
        if (state.showFavoritesOnly) {
            results = results.filter(img => img.isFavorite === true);
        }

        // Step 3: Sensitive tags filter (safe mode)
        const { sensitiveTags, blurSensitiveImages, enableSafeMode, displayStarredFirst } = useSettingsStore.getState();
        const normalizedSensitiveTags = (sensitiveTags ?? [])
            .map(tag => (typeof tag === 'string' ? tag.trim().toLowerCase() : ''))
            .filter(Boolean);
        const sensitiveTagSet = new Set(normalizedSensitiveTags);
        const shouldFilterSensitive = enableSafeMode && !blurSensitiveImages && sensitiveTagSet.size > 0;
        if (shouldFilterSensitive) {
            results = results.filter(img => {
                if (!img.tags || img.tags.length === 0) return true;
                return !img.tags.some(tag => sensitiveTagSet.has(tag.toLowerCase()));
            });
        }

        // Step 4: Tags filter
        if (state.selectedTags && state.selectedTags.length > 0) {
            results = results.filter(img => {
                if (!img.tags || img.tags.length === 0) return false;
                // Match ANY selected tag (OR logic)
                return state.selectedTags.some(tag => img.tags!.includes(tag));
            });
        }

        // Semantic search scope (Phase 5): the curation-visible set that
        // semantic hits must respect (directory visibility, folder selection
        // + exclusions, favorites, safe mode, tags). Captured here — after
        // the curation filters, before the keyword/metadata filters — because
        // semantic results are ranked by vector similarity, not keywords.
        const curationVisible = results;

        // ID-based stack filtering (preserves search bar state)
        if (libraryStackContext) {
            const contextImageIds = new Set(libraryStackContext.imageIds);
            results = results.filter(image => contextImageIds.has(image.id));
        } else if (searchQuery) {
            const searchTerms = searchQuery
                .toLowerCase()
                .split(/\s+/)
                .filter(Boolean);

            if (searchTerms.length > 0) {
                results = results.filter(image => {
                    const catalogText = buildCatalogSearchText(image);
                    const catalogMatch = searchTerms.every(term => catalogText.includes(term));
                    if (catalogMatch) {
                        return true;
                    }

                    const enrichedText = buildEnrichedSearchText(image);
                    if (!enrichedText) {
                        return false;
                    }

                    return searchTerms.every(term => enrichedText.includes(term));
                });
            }
        }

        if (selectedModels.length > 0) {
            results = results.filter(image => {
                // '' is the 'no model' sentinel: match images without any model metadata
                if (selectedModels.includes('') && (!image.models || image.models.filter(Boolean).length === 0)) {
                    return true;
                }
                return image.models?.length > 0 && selectedModels.some(sm => sm && image.models.includes(sm));
            });
        }

        if (selectedLoras.length > 0) {
            results = results.filter(image => {
                if (!image.loras || image.loras.length === 0) return false;

                // Extract LoRA names from both strings and LoRAInfo objects
                const loraNames = image.loras.map(lora =>
                    typeof lora === 'string' ? lora : (lora?.name || '')
                ).filter(Boolean);

                return selectedLoras.some(sl => loraNames.includes(sl));
            });
        }

        if (selectedSchedulers.length > 0) {
            results = results.filter(image =>
                selectedSchedulers.includes(image.scheduler)
            );
        }

        if (advancedFilters) {
            if (advancedFilters.dimension) {
                results = results.filter(image => {
                    if (!image.dimensions) return false;
                    // Normalize dimensions format (handle both "512x512" and "512 x 512")
                    const imageDim = image.dimensions.replace(/\s+/g, '');
                    const filterDim = advancedFilters.dimension.replace(/\s+/g, '');
                    return imageDim === filterDim;
                });
            }
            if (advancedFilters.aspectRatio) {
                results = results.filter(image => {
                    if (!image.dimensions) return false;
                    const [w, h] = image.dimensions.split('x').map(Number);
                    if (!w || !h) return false;
                    // Handle orientation-based filters
                    if (advancedFilters.aspectRatio === 'portrait') return h > w;
                    if (advancedFilters.aspectRatio === 'landscape') return w > h;
                    if (advancedFilters.aspectRatio === 'square') return w === h;
                    return getImageAspectRatio(w, h) === advancedFilters.aspectRatio;
                });
            }
            if (advancedFilters.steps) {
                 results = results.filter(image => {
                    const steps = image.steps;
                    if (steps !== null && steps !== undefined) {
                        return steps >= advancedFilters.steps.min && steps <= advancedFilters.steps.max;
                    }
                    return false;
                });
            }
            if (advancedFilters.cfg) {
                 results = results.filter(image => {
                    const cfg = image.cfgScale;
                    if (cfg !== null && cfg !== undefined) {
                        return cfg >= advancedFilters.cfg.min && cfg <= advancedFilters.cfg.max;
                    }
                    return false;
                });
            }
            if (advancedFilters.date && (advancedFilters.date.from || advancedFilters.date.to)) {
                results = results.filter(image => {
                    const imageTime = image.lastModified;
                    
                    // Check "from" date if provided
                    if (advancedFilters.date!.from) {
                        const fromTime = new Date(advancedFilters.date!.from).getTime();
                        if (imageTime < fromTime) return false;
                    }
                    
                    // Check "to" date if provided
                    if (advancedFilters.date!.to) {
                        const toDate = new Date(advancedFilters.date!.to);
                        toDate.setDate(toDate.getDate() + 1); // Include full end date
                        const toTime = toDate.getTime();
                        if (imageTime >= toTime) return false;
                    }
                    
                    return true;
                });
            }

        }

        const totalInScope = images.length; // Total absoluto de imagens indexadas
        const selectionDirectoryCount = state.directories.length;

        const compareById = (a: IndexedImage, b: IndexedImage) => a.id.localeCompare(b.id);
        const compareByNameAsc = (a: IndexedImage, b: IndexedImage) => {
            const nameComparison = (a.name || '').localeCompare(b.name || '');
            if (nameComparison !== 0) {
                return nameComparison;
            }
            return compareById(a, b);
        };
        const compareByNameDesc = (a: IndexedImage, b: IndexedImage) => {
            const nameComparison = (b.name || '').localeCompare(a.name || '');
            if (nameComparison !== 0) {
                return nameComparison;
            }
            return compareById(a, b);
        };
        const compareByDateAsc = (a: IndexedImage, b: IndexedImage) => {
            const dateComparison = a.lastModified - b.lastModified;
            if (dateComparison !== 0) {
                return dateComparison;
            }
            return compareByNameAsc(a, b);
        };
        const compareByDateDesc = (a: IndexedImage, b: IndexedImage) => {
            const dateComparison = b.lastModified - a.lastModified;
            if (dateComparison !== 0) {
                return dateComparison;
            }
            return compareByNameAsc(a, b);
        };

        // Seeded random number generator helper
        const seededRandom = (seed: number) => {
            const x = Math.sin(seed) * 10000;
            return x - Math.floor(x);
        };

        // Simple string hash function
        const stringHash = (str: string) => {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32bit integer
            }
            return hash;
        };

        // Hash string with a seed, mixing it non-linearly at each step.
        // DJB2 is purely linear: stringHash(a + suffix) - stringHash(b + suffix) ≈
        // (stringHash(a) - stringHash(b)) * 33^len(suffix), so appending or prepending
        // the seed doesn't change the relative ordering for same-length IDs.
        // By XOR-ing the seed into each iteration the hash becomes non-separable
        // (hash(str,S) ≠ f(S) + g(str)), guaranteeing different seeds reorder images.
        const hashWithSeed = (str: string, seed: number): number => {
            let hash = 0;
            for (let i = 0; i < str.length; i++) {
                hash = ((hash << 5) - hash) + str.charCodeAt(i);
                hash = (hash ^ seed) | 0; // XOR seed non-linearly at each step
            }
            return hash;
        };

        const compareRandom = (a: IndexedImage, b: IndexedImage) => {
            const seed = state.randomSeed || 0;
            const hashA = hashWithSeed(a.id, seed);
            const hashB = hashWithSeed(b.id, seed);

            if (hashA !== hashB) {
                return hashA - hashB;
            }
            return a.id.localeCompare(b.id);
        };

        const sorted = [...results].sort((a, b) => {
            if (displayStarredFirst) {
                if (a.isFavorite && !b.isFavorite) return -1;
                if (!a.isFavorite && b.isFavorite) return 1;
            }

            if (sortOrder === 'asc') return compareByNameAsc(a, b);
            if (sortOrder === 'desc') return compareByNameDesc(a, b);
            if (sortOrder === 'date-asc') return compareByDateAsc(a, b);
            if (sortOrder === 'date-desc') return compareByDateDesc(a, b);
            if (sortOrder === 'random') return compareRandom(a, b);
            // 'relevance' outside a semantic overlay (stale state from an
            // ended search) behaves like the app default — newest first.
            if (sortOrder === 'relevance') return compareByDateDesc(a, b);
            return compareById(a, b);
        });

        // Semantic overlay (§8.2): ranked hits replace the keyword ordering
        // whenever hits are present and semantic mode is on. Falls through
        // to the normal sorted results otherwise — byte-identical behavior
        // when the feature is unused.
        let filteredImages = sorted;
        if (state.semanticMode === 'semantic' && state.semanticHits && state.semanticHits.length > 0) {
            filteredImages = applySemanticMerge(sorted, state.semanticHits, curationVisible, state.semanticMode);
            // The sort box is honest in semantic mode: 'relevance' (the
            // auto-selected default while hits are on screen) keeps the
            // merge's score order; any other chosen sort re-orders the hit
            // subset so the box never claims an order the grid doesn't show.
            if (filteredImages.length > 1 && state.sortOrder !== 'relevance') {
                const compareHit =
                    state.sortOrder === 'asc' ? compareByNameAsc :
                    state.sortOrder === 'desc' ? compareByNameDesc :
                    state.sortOrder === 'date-asc' ? compareByDateAsc :
                    state.sortOrder === 'date-desc' ? compareByDateDesc :
                    state.sortOrder === 'random' ? compareRandom : null;
                if (compareHit) filteredImages = [...filteredImages].sort(compareHit);
            }
        }

        return {
            filteredImages,
            selectionTotalImages: totalInScope,
            selectionDirectoryCount,
            selectionFavoriteCount,
            availableTags,
        };
    };

    const flushDimensionUpdates = () => {
        if (pendingDimensionUpdates.size === 0) return;
        if (pendingDimensionTimer) {
            clearTimeout(pendingDimensionTimer);
            pendingDimensionTimer = null;
        }

        set(state => {
            let changed = false;
            const updatedImages = state.images.map(img => {
                const newDim = pendingDimensionUpdates.get(img.id);
                if (newDim && img.dimensions !== newDim) {
                    changed = true;
                    return { ...img, dimensions: newDim };
                }
                return img;
            });
            
            pendingDimensionUpdates.clear();
            
            if (!changed) return state;
            return _updateState(state, updatedImages);
        });
    };

    return {
        // Initial State
        images: [],
        filteredImages: [],
        selectionTotalImages: 0,
        selectionDirectoryCount: 0,
        selectionFavoriteCount: 0,
        directories: [],
        selectedFolders: new Set(),
        excludedFolders: new Set(),
        isFolderSelectionLoaded: false,
        includeSubfolders: localStorage.getItem('image-metahub-include-subfolders') !== 'false', // Default to true
        folderPreferences: new Map(),
        isLoading: false,
        progress: null,
        enrichmentProgress: null,
        indexingState: 'idle',
        error: null,
        success: null,
        selectedImage: null,
        previewImage: null,
        selectedImages: new Set(),
        focusedImageIndex: null,
        isStackingEnabled: true,
        undoAvailable: false,
        searchQuery: '',
        semanticMode: 'off',
        semanticHits: null,
        semanticSearchStatus: 'idle',
        semanticIndexProgress: null,
        semanticIndexedCount: 0,
        semanticLastError: null,
        detectedGpuInfo: loadDetectedGpuInfo(),
        detectedGpuDevices: loadDetectedGpuDevices(),
        aiModelsLoaded: EMPTY_AI_MODELS_STATUS,
        availableModels: [],
        availableLoras: [],
        availableSchedulers: [],
        availableDimensions: [],
        availableAspectRatios: [],
        selectedModels: [],
        selectedLoras: [],
        selectedSchedulers: [],
        sortOrder: 'date-desc',
        randomSeed: Date.now(),
        advancedFilters: {},
        scanSubfolders: localStorage.getItem('image-metahub-scan-subfolders') !== 'false', // Default to true
        libraryStackContext: null,
        activeView: 'library',
        isFullscreenMode: false,

        // Annotations initial values
        annotations: new Map(),
        availableTags: [],
        recentTags: loadRecentTags(),
        selectedTags: [],
        showFavoritesOnly: false,
        isAnnotationsLoaded: false,
        activeWatchers: new Set(),
        refreshingDirectories: new Set(),

        // Smart Clustering initial values (Phase 2)
        clusters: [],
        clusteringProgress: null,
        clusteringWorker: null,
        isClustering: false,
        clusterNavigationContext: null,

        // Similarity Grouping initial value
        similarityGroupProgress: null,
        pipelinePhase: null,

        // Auto-Tagging initial values (Phase 3)

        autoTaggingProgress: null,
        autoTaggingWorker: null,
        autoTagWorkerModelId: null,
        isAutoTagging: false,
        draggedItems: [],

        // --- ACTIONS ---

        addDirectory: (directory) => set(state => {
            // Case-insensitive check for duplicates
            const normalizedNewId = normalizePath(directory.id);
            if (state.directories.some(d => normalizePath(d.id) === normalizedNewId)) {
                return state; // Prevent adding duplicates
            }
            const newDirectories = [...state.directories, { ...directory, visible: directory.visible ?? true }];
            const newState = { ...state, directories: newDirectories };
            return { ...newState, ...filterAndSort(newState) };
        }),


        updateDirectoryStatus: (directoryId, isConnected) => set(state => {
            const updatedDirectories = state.directories.map(dir =>
                dir.id === directoryId ? { ...dir, isConnected } : dir
            );
            
            // Only trigger re-render if status actually changed
            const changed = state.directories.some(dir => 
                dir.id === directoryId && dir.isConnected !== isConnected
            );
            
            if (!changed) return state;

            const newState = { ...state, directories: updatedDirectories };
            return { ...newState, ...filterAndSort(newState) };
        }),

        // Reprocess Images marks offline dirs as pending — when the drive
        // reconnects (5s connection poll) the canonical round re-runs for it.
        // The pending ids survive a restart via localStorage.
        markReprocessPending: (directoryId, pending) => set(state => {
            const directories = state.directories.map(dir =>
                dir.id === directoryId ? { ...dir, reprocessPending: pending } : dir
            );
            try {
                localStorage.setItem(
                    'image-metahub-reprocess-pending',
                    JSON.stringify(directories.filter(d => d.reprocessPending).map(d => d.id)),
                );
            } catch { /* storage unavailable */ }
            return { directories };
        }),

        toggleDirectoryVisibility: (directoryId) => set(state => {
            const updatedDirectories = state.directories.map(dir =>
                dir.id === directoryId ? { ...dir, visible: !(dir.visible ?? true) } : dir
            );
            const newState = { ...state, directories: updatedDirectories };
            return { ...newState, ...filterAndSort(newState) };
        }),

        toggleAutoWatch: (directoryId) => {
            set((state) => {
                const directories = state.directories.map((dir) =>
                    dir.id === directoryId
                        ? { ...dir, autoWatch: !dir.autoWatch }
                        : dir
                );

                // Persistir directories no localStorage
                if (typeof window !== 'undefined') {
                    const paths = directories.map(d => d.path);
                    localStorage.setItem('image-metahub-directories', JSON.stringify(paths));

                    // Persistir estado de autoWatch separadamente para manter sincronizado
                    const watchStates = Object.fromEntries(
                        directories.map(d => [d.id, { enabled: !!d.autoWatch, path: d.path }])
                    );
                    localStorage.setItem('image-metahub-directory-watchers', JSON.stringify(watchStates));
                }

                return { directories };
            });
        },

        initializeFolderSelection: async () => {
            Promise.all([
                loadSelectedFolders(),
                loadExcludedFolders(),
                loadFolderPreferences()
            ]).then(([selectedPaths, excludedPaths, preferences]) => {
                set(state => {
                    // Only update if not already loaded to avoid overwriting current selection during re-renders
                    if (state.isFolderSelectionLoaded) {
                        return state;
                    }

                    const prefMap = new Map<string, FolderPreference>();
                    preferences.forEach(p => {
                        const normalizedP = normalizePath(p.path);
                        prefMap.set(normalizedP, { ...p, path: normalizedP });
                    });

                    const newState = {
                        selectedFolders: new Set(selectedPaths.map(p => normalizePath(p))),
                        excludedFolders: new Set(excludedPaths.map(p => normalizePath(p))),
                        folderPreferences: prefMap,
                        isFolderSelectionLoaded: true
                    };
                    
                    return _updateState({ ...state, ...newState }, state.images); // Re-run filtering
                });
            });
        },

        addExcludedFolder: (path: string) => {
            const normalizedPath = normalizePath(path);
            set(state => {
                const newExcluded = new Set(state.excludedFolders);
                newExcluded.add(normalizedPath);
                
                // If the folder was selected, deselect it
                const newSelected = new Set(state.selectedFolders);
                if (newSelected.has(normalizedPath)) {
                    newSelected.delete(normalizedPath);
                }

                saveExcludedFolders(Array.from(newExcluded));
                saveSelectedFolders(Array.from(newSelected));

                return _updateState({ ...state, excludedFolders: newExcluded, selectedFolders: newSelected }, state.images);
            });
        },

        removeExcludedFolder: (path: string) => {
            const normalizedPath = normalizePath(path);
            set(state => {
                const newExcluded = new Set(state.excludedFolders);
                newExcluded.delete(normalizedPath);
                saveExcludedFolders(Array.from(newExcluded));
                return _updateState({ ...state, excludedFolders: newExcluded }, state.images);
            });
        },

        toggleFolderSelection: (path: string, ctrlKey: boolean) => {
            const normalizedPath = normalizePath(path);
            set(state => {
                const selection = new Set(state.selectedFolders);

                if (ctrlKey) {
                    // Multi-select: toggle this folder
                    if (selection.has(normalizedPath)) {
                        selection.delete(normalizedPath);
                    } else {
                        selection.add(normalizedPath);
                    }
                } else {
                    // Single select: replace all with this folder
                    // If clicking the same folder that's already the only selection, clear it
                    if (selection.size === 1 && selection.has(normalizedPath)) {
                        selection.clear();
                    } else {
                        selection.clear();
                        selection.add(normalizedPath);
                    }
                }

                const newState = { ...state, selectedFolders: selection };
                const resultState = { ...newState, ...filterAndSort(newState) };

                // Recalculate available filters based on the new filtered images
                const availableFilters = recalculateAvailableFilters(resultState.filteredImages);
                const finalState = { ...resultState, ...availableFilters };

                // Persist to IndexedDB
                saveSelectedFolders(Array.from(selection)).catch((error) => {
                    console.error('Failed to persist folder selection state', error);
                });

                return finalState;
            });
        },

        clearFolderSelection: () => {
            set(state => {
                const selection = new Set<string>();

                const newState = { ...state, selectedFolders: selection };
                const resultState = { ...newState, ...filterAndSort(newState) };

                // Recalculate available filters based on the new filtered images
                const availableFilters = recalculateAvailableFilters(resultState.filteredImages);
                const finalState = { ...resultState, ...availableFilters };

                // Persist to IndexedDB
                saveSelectedFolders([]).catch((error) => {
                    console.error('Failed to persist folder selection state', error);
                });

                return finalState;
            });
        },

        isFolderSelected: (path) => {
            const normalizedPath = normalizePath(path);
            return get().selectedFolders.has(normalizedPath);
        },



        setFolderEmoji: async (path, emoji) => {
            const normalizedPath = normalizePath(path);
            const { folderPreferences } = get();

            const existingPref = folderPreferences.get(normalizedPath) || { path: normalizedPath };
            const pref: FolderPreference = {
                ...existingPref,
                emoji
            };

            set(state => {
                const newPrefs = new Map(state.folderPreferences);
                if (emoji === undefined && pref.scanSubfolders === undefined) {
                    newPrefs.delete(normalizedPath);
                } else {
                    newPrefs.set(normalizedPath, pref);
                }
                return { folderPreferences: newPrefs };
            });

            if (emoji === undefined && pref.scanSubfolders === undefined) {
                await deleteFolderPreference(normalizedPath);
            } else {
                await saveFolderPreference(pref);
            }
        },

        setFolderScanSubfolders: async (path, scanSubfolders) => {
            const normalizedPath = normalizePath(path);
            const { folderPreferences } = get();
            
            const existingPref = folderPreferences.get(normalizedPath) || { path: normalizedPath };
            const pref: FolderPreference = {
                ...existingPref,
                scanSubfolders
            };

            set(state => {
                const newPrefs = new Map(state.folderPreferences);
                newPrefs.set(normalizedPath, pref);
                return { folderPreferences: newPrefs };
            });

            await saveFolderPreference(pref);
        },

        toggleIncludeSubfolders: () => {
            set(state => {
                const newValue = !state.includeSubfolders;
                localStorage.setItem('image-metahub-include-subfolders', String(newValue));
                const newState = { ...state, includeSubfolders: newValue };
                return { ...newState, ...filterAndSort(newState) };
            });
        },

        removeDirectory: (directoryId) => {
            const { directories, images, selectedFolders, folderPreferences } = get();
            const targetDirectory = directories.find(d => d.id === directoryId);
            const newDirectories = directories.filter(d => d.id !== directoryId);
            if (window.electronAPI) {
                localStorage.setItem('image-metahub-directories', JSON.stringify(newDirectories.map(d => d.path)));
            }
            const newImages = images.filter(img => img.directoryId !== directoryId);

            // Remove all selected folders belonging to this directory
            const updatedSelection = new Set(selectedFolders);
            const updatedPrefs = new Map(folderPreferences);

            if (targetDirectory) {
                const normalizedPath = normalizePath(targetDirectory.path);
                for (const folderPath of Array.from(updatedSelection)) {
                    const normalizedFolder = normalizePath(folderPath);
                    // Remove if it's the directory itself or starts with the directory path
                    if (normalizedFolder === normalizedPath || normalizedFolder.startsWith(normalizedPath + '/') || normalizedFolder.startsWith(normalizedPath + '\\')) {
                        updatedSelection.delete(folderPath);
                    }
                }

                for (const [folderPath, pref] of Array.from(updatedPrefs.entries())) {
                    const normalizedFolder = normalizePath(folderPath);
                    if (normalizedFolder === normalizedPath || normalizedFolder.startsWith(normalizedPath + '/') || normalizedFolder.startsWith(normalizedPath + '\\')) {
                        updatedPrefs.delete(folderPath);
                        
                        // Delete both the raw key and the normalized key to ensure we catch old stored records
                        // that didn't apply normalizePath before saving.
                        deleteFolderPreference(folderPath).catch(err => {
                            console.error('Failed to delete folder preference for', folderPath, err);
                        });
                        
                        if (folderPath !== normalizedFolder) {
                            deleteFolderPreference(normalizedFolder).catch(err => {
                                console.error('Failed to delete folder preference for', normalizedFolder, err);
                            });
                        }
                    }
                }
            }

            set(state => {
                const baseState = { ...state, directories: newDirectories, selectedFolders: updatedSelection, folderPreferences: updatedPrefs };
                return _updateState(baseState, newImages);
            });

            // Hygiene: a removed dir must not stay in the reprocess-pending
            // list (ids are paths, so a re-added folder would otherwise
            // rescan on connect).
            try {
                localStorage.setItem(
                    'image-metahub-reprocess-pending',
                    JSON.stringify(newDirectories.filter(d => d.reprocessPending).map(d => d.id)),
                );
            } catch { /* storage unavailable */ }

            saveSelectedFolders(Array.from(updatedSelection)).catch((error) => {
                console.error('Failed to persist folder selection state', error);
            });
        },

        reorderDirectories: (orderedIds) => set(state => {
            const orderedDirs = orderedIds
                .map(id => state.directories.find(d => d.id === id))
                .filter((d): d is Directory => d !== undefined);
            const remaining = state.directories.filter(d => !orderedIds.includes(d.id));
            const newDirectories = [...orderedDirs, ...remaining];

            if (window.electronAPI) {
                localStorage.setItem('image-metahub-directories', JSON.stringify(newDirectories.map(d => d.path)));
            }

            return { directories: newDirectories };
        }),

        setLoading: (loading) => set({ isLoading: loading }),
        setProgress: (progress) => set({ progress }),
        setEnrichmentProgress: (progress) => set({ enrichmentProgress: progress }),
        setIndexingState: (indexingState) => {
            if (indexingState !== 'indexing') {
                flushPendingMerges(true);
            }
            set({ indexingState });
        },
        setError: (error) => set({ error, success: null }),
        setSuccess: (success) => set({ success, error: null }),

        filterAndSortImages: () => set(state => filterAndSort(state)),

        setImages: (images) => {
            clearPendingQueue();
            set(state => _updateState(state, images));
        },

        addImages: (newImages) => {
            if (!newImages || newImages.length === 0) {
                return;
            }
            pendingImagesQueue.push(...newImages);
            scheduleFlush();
        },

        replaceDirectoryImages: (directoryId, newImages) => {
            clearPendingQueue();
            set(state => {
                // Remove all images from this directory
                const otherImages = state.images.filter(img => img.directoryId !== directoryId);
                // Add new images for this directory
                const allImages = [...otherImages, ...newImages];
                return _updateState(state, allImages);
            });
        },

        mergeImages: (updatedImages) => {
            if (!updatedImages || updatedImages.length === 0) {
                return;
            }

            const isIndexing = get().indexingState === 'indexing';
            if (isIndexing) {
                pendingMergeQueue.push(...updatedImages);
                scheduleMergeFlush();
                return;
            }

            flushPendingImages();
            flushPendingMerges();
            set(state => {
                const updates = new Map(updatedImages.map(img => [img.id, img]));
                const merged = state.images.map(img => {
                    const updated = updates.get(img.id);
                    if (updated) {
                        return {
                            ...updated,
                            isFavorite: img.isFavorite,
                            tags: img.tags,
                            autoTags: img.autoTags,
                            isAutoTagged: img.isAutoTagged,
                            metadataTags: img.metadataTags,
                            stackGroupId: img.stackGroupId,
                            isStackAnalyzed: img.isStackAnalyzed,
                            similarityGroupId: img.similarityGroupId,
                            isSimilarityAnalyzed: img.isSimilarityAnalyzed,
                        };
                    }
                    return img;
                });
                return _updateState(state, merged);
            });
        },

        clearImages: (directoryId?: string) => set(state => {
            clearPendingQueue();
            if (directoryId) {
                const newImages = state.images.filter(img => img.directoryId !== directoryId);
                return _updateState(state, newImages);
            } else {
                return _updateState(state, []);
            }
        }),

        removeImages: (imageIds) => {
            const idsToRemove = new Set(imageIds);
            flushPendingImages();
            set(state => {
                const remainingImages = state.images.filter(img => !idsToRemove.has(img.id));
                return _updateState(state, remainingImages);
            });
        },

        removeImagesByPaths: (paths) => {
            const pathsToRemove = new Set(paths.map(p => normalizePath(p).toLowerCase())); // Normalize and lowercase
            flushPendingImages();

            set(state => {
                const { directories } = state;
                // Create directory map for fast lookup
                const dirMap = new Map<string, string>();
                directories.forEach(dir => dirMap.set(dir.id, normalizePath(dir.path)));

                const remainingImages = state.images.filter(img => {
                    const dirPath = dirMap.get(img.directoryId || '');
                    if (!dirPath) return true; // Keep if we can't determine path
                    
                    const relativePath = getRelativeImagePath(img);
                    const fullPath = joinPath(dirPath, relativePath);
                    const normalizedFullPath = normalizePath(fullPath).toLowerCase();
                    
                    return !pathsToRemove.has(normalizedFullPath);
                });
                
                if (remainingImages.length === state.images.length) return state;
                return _updateState(state, remainingImages);
            });
        },

        removeImage: (imageId) => {
            flushPendingImages();
            set(state => {
                const remainingImages = state.images.filter(img => img.id !== imageId);
                return _updateState(state, remainingImages);
            });
        },

        updateImage: (imageId, newName) => {
            set(state => {
                const updatedImages = state.images.map(img => img.id === imageId ? { ...img, name: newName } : img);
                // No need to recalculate filters for a simple name change
                return { ...state, ...filterAndSort({ ...state, images: updatedImages }), images: updatedImages };
            });
        },

        updateImageDimensions: (imageId, dimensions) => {
            pendingDimensionUpdates.set(imageId, dimensions);
            if (!pendingDimensionTimer) {
                pendingDimensionTimer = setTimeout(() => {
                    flushDimensionUpdates();
                }, 200); // Batch every 200ms
            }
        },

        clearAllThumbnails: () => {
            set(state => {
                const nextImages = state.images.map(img => {
                    if (img.thumbnailStatus === 'ready' || img.thumbnailUrl) {
                        return {
                            ...img,
                            thumbnailStatus: undefined as any,
                            thumbnailUrl: undefined
                        };
                    }
                    return img;
                });
                
                let nextPreviewImage = state.previewImage;
                if (nextPreviewImage && (nextPreviewImage.thumbnailStatus === 'ready' || nextPreviewImage.thumbnailUrl)) {
                    nextPreviewImage = {
                        ...nextPreviewImage,
                        thumbnailStatus: undefined as any,
                        thumbnailUrl: undefined
                    };
                }

                let nextSelectedImage = state.selectedImage;
                if (nextSelectedImage && (nextSelectedImage.thumbnailStatus === 'ready' || nextSelectedImage.thumbnailUrl)) {
                    nextSelectedImage = {
                        ...nextSelectedImage,
                        thumbnailStatus: undefined as any,
                        thumbnailUrl: undefined
                    };
                }

                return {
                    ..._updateState(state, nextImages),
                    previewImage: nextPreviewImage,
                    selectedImage: nextSelectedImage
                };
            });
        },

        setImageThumbnail: (imageId, data) => {
            const preState = get();
            const preImage = getImageById(preState, imageId);

            if (!preImage) {
                return;
            }

            const nextThumbnailUrl = data.thumbnailUrl ?? preImage.thumbnailUrl;
            const nextThumbnailHandle = data.thumbnailHandle ?? preImage.thumbnailHandle;
            const nextThumbnailStatus = data.status;
            const nextThumbnailError = data.error ?? (data.status === 'error'
                ? 'Failed to load thumbnail'
                : preImage.thumbnailError);

            const lastState = lastThumbnailState.get(imageId);
            if (
                lastState &&
                lastState.url === nextThumbnailUrl &&
                lastState.handle === nextThumbnailHandle &&
                lastState.status === nextThumbnailStatus &&
                lastState.error === nextThumbnailError
            ) {
                return; // Identical to last applied payload
            }

            if (
                preImage.thumbnailUrl === nextThumbnailUrl &&
                preImage.thumbnailHandle === nextThumbnailHandle &&
                preImage.thumbnailStatus === nextThumbnailStatus &&
                preImage.thumbnailError === nextThumbnailError
            ) {
                lastThumbnailState.set(imageId, {
                    url: nextThumbnailUrl,
                    handle: nextThumbnailHandle,
                    status: nextThumbnailStatus,
                    error: nextThumbnailError,
                });
                return;
            }

            if (thumbnailUpdateInProgress.has(imageId)) {
                return;
            }

            thumbnailUpdateInProgress.add(imageId);

            try {
                set(state => {
                    // CIRCUIT BREAKER: Prevent excessive updates
                    const now = Date.now();
                    const stats = thumbnailUpdateTimestamps.get(imageId) || { count: 0, lastUpdate: now };

                    if (now - stats.lastUpdate > 1000) {
                        stats.count = 0;
                        stats.lastUpdate = now;
                    }

                    stats.count++;
                    thumbnailUpdateTimestamps.set(imageId, stats);

                    if (stats.count > 10) {
                        console.warn(`⚠️ Circuit breaker activated: ${imageId} received ${stats.count} updates in 1s. Blocking update.`);
                        return state;
                    }

                    const currentImage = getImageById(state, imageId);

                    if (!currentImage) {
                        return state;
                    }

                    const nextThumbnailUrl = data.thumbnailUrl ?? currentImage.thumbnailUrl;
                    const nextThumbnailHandle = data.thumbnailHandle ?? currentImage.thumbnailHandle;
                    const nextThumbnailStatus = data.status;
                    const nextThumbnailError = data.error ?? (data.status === 'error'
                        ? 'Failed to load thumbnail'
                        : currentImage.thumbnailError);

                    if (
                        currentImage.thumbnailUrl === nextThumbnailUrl &&
                        currentImage.thumbnailHandle === nextThumbnailHandle &&
                        currentImage.thumbnailStatus === nextThumbnailStatus &&
                        currentImage.thumbnailError === nextThumbnailError
                    ) {
                        return state;
                    }

                    const updateList = (list: IndexedImage[]) => {
                        const index = list.findIndex(img => img.id === imageId);
                        if (index === -1) {
                            return list;
                        }

                        const current = list[index];

                        if (
                            current.thumbnailUrl === nextThumbnailUrl &&
                            current.thumbnailHandle === nextThumbnailHandle &&
                            current.thumbnailStatus === nextThumbnailStatus &&
                            current.thumbnailError === nextThumbnailError
                        ) {
                            return list;
                        }

                        const newList = [...list];
                        newList[index] = {
                            ...list[index],
                            thumbnailUrl: nextThumbnailUrl,
                            thumbnailHandle: nextThumbnailHandle,
                            thumbnailStatus: nextThumbnailStatus,
                            thumbnailError: nextThumbnailError,
                        };
                        return newList;
                    };

                    const updatedImages = updateList(state.images);
                    const updatedFilteredImages = updateList(state.filteredImages);

                    if (updatedImages === state.images && updatedFilteredImages === state.filteredImages) {
                        return state;
                    }

                    lastThumbnailState.set(imageId, {
                        url: nextThumbnailUrl,
                        handle: nextThumbnailHandle,
                        status: nextThumbnailStatus,
                        error: nextThumbnailError,
                    });

                    return {
                        ...state,
                        images: updatedImages,
                        filteredImages: updatedFilteredImages,
                    };
                });
            } finally {
                thumbnailUpdateInProgress.delete(imageId);
            }
        },

        setSearchQuery: (query) => {
            if (!(query ?? '').trim()) {
                // Clearing the search bar also clears semantic hits and any
                // pending search. Delegating to clearSemanticSearch keeps the
                // two clear paths in lockstep — it restores the previous
                // (durable) sort order when 'relevance' was active (§8.2).
                get().clearSemanticSearch();
                set(state => ({ ...filterAndSort({ ...state, searchQuery: query }), searchQuery: query }));
                return;
            }
            set(state => ({ ...filterAndSort({ ...state, searchQuery: query }), searchQuery: query }));
            // Phase 6 (§9): typing → semantic search, but only in semantic
            // mode. Fire-and-forget — the action has its own 300 ms debounce
            // + latest-query-wins seq and gates internally (status
            // 'unavailable' when the feature is off, which the hidden toggle
            // never surfaces). In 'off' mode the query stays pure keyword.
            if (get().semanticMode === 'semantic') {
                void get().runSemanticSearch(query);
            }
        },

        setFilterOptions: (options) => set({
            availableModels: options.models,
            availableLoras: options.loras,
            availableSchedulers: options.schedulers,
            availableDimensions: options.dimensions,
        }),

        setSelectedFilters: (filters) => set(state => ({
            ...filterAndSort({
                ...state,
                selectedModels: filters.models ?? state.selectedModels,
                selectedLoras: filters.loras ?? state.selectedLoras,
                selectedSchedulers: filters.schedulers ?? state.selectedSchedulers,
            }),
            selectedModels: filters.models ?? state.selectedModels,
            selectedLoras: filters.loras ?? state.selectedLoras,
            selectedSchedulers: filters.schedulers ?? state.selectedSchedulers,
        })),

        setAdvancedFilters: (filters) => set(state => ({
            ...filterAndSort({ ...state, advancedFilters: filters }),
            advancedFilters: filters,
        })),

        setSortOrder: (order) => {
          set(state => ({ ...filterAndSort({ ...state, sortOrder: order }), sortOrder: order }));
          // Persist to settings — except 'relevance', which is meaningful
          // only while a semantic search's results are on screen.
          if (order !== 'relevance') useSettingsStore.getState().setSortOrder(order);
        },
        
        reshuffle: () => set(state => {
            const newSeed = Date.now();
            return {
                ...filterAndSort({ ...state, randomSeed: newSeed }),
                randomSeed: newSeed
            };
        }),

        setPreviewImage: (image) => set({ previewImage: image }),
        setSelectedImage: (image) => {
            set({ selectedImage: image });
        },
        setFocusedImageIndex: (index) => set({ focusedImageIndex: index }),
        setFullscreenMode: (isFullscreen) => set({ isFullscreenMode: isFullscreen }),

        // Clustering removed — these are no-ops retained for interface compatibility
        startClustering: async (_directoryPath: string, _scanSubfolders: boolean, _threshold: number) => {
            console.warn('Clustering has been removed. Use library similarity stacks instead.');
        },

        cancelClustering: () => {
            // No-op: clustering removed
        },

        setClusters: (clusters) => set({ clusters }),

        setClusteringProgress: (progress) => set({ clusteringProgress: progress }),

        setSimilarityGroupProgress: (progress) => set({ similarityGroupProgress: progress }),
        setPipelinePhase: (phase) => set({ pipelinePhase: phase }),

        setClusterNavigationContext: (images) => set({ clusterNavigationContext: images }),

        handleClusterImageDeletion: (deletedImageIds: string[]) => {
            const { clusters } = get();
            if (clusters.length === 0) return;

            // clusteringEngine removed — handleClusterImageDeletion is a no-op
        },

        // Auto-Tagging Actions (Phase 3)
        startAutoTagging: async (directoryPath, scanSubfolders, options) => {
            // In-flight coalesce: a second request (e.g. the manual button
            // while the round's library-scoped phase runs) joins the running
            // run instead of clobbering the worker's onmessage.
            if (get().isAutoTagging && __autoTagInFlight) {
                return __autoTagInFlight;
            }

            // Premium-only — there is no fallback without the ai-intelligence
            // module, so skip before doing any work (no-op for non-premium).
            if (!isAiFeaturesEnabled()) {
                console.log('[AutoTag] Premium not enabled — skipping');
                return;
            }

            const { images, filteredImages, annotations, directories, autoTaggingWorker: existingWorker } = get();

            // Scope: the pipeline round tags the WHOLE library ('library' —
            // connected dirs only, so offline drives aren't re-tagged from
            // stale memory); the manual Auto-Tag button tags the current view.
            const scope = options?.scope ?? 'view';
            const sourceImages = scope === 'library'
                ? images.filter(img =>
                    directories.some(d => d.id === img.directoryId && d.isConnected !== false))
                : filteredImages;

            if (sourceImages.length === 0) {
                console.log(`[AutoTag] No images in ${scope} scope to auto-tag`);
                return;
            }

            // Filter to images that still need auto-tagging (or search
            // enrichment) BEFORE creating the worker. The enrichment gate
            // re-includes previously-tagged, version-less images exactly once
            // so they pick up synonyms for the semantic index.
            const taggingImages = sourceImages.filter(img => {
                const annotation = annotations.get(img.id);
                return needsSearchEnrichment(annotation);
            }).map(img => ({
                id: img.id,
                prompt: img.prompt,
                models: img.models,
                loras: img.loras,
            }));

            if (taggingImages.length === 0) {
                console.log(`[AutoTag] No images need enrichment (${scope} scope) — nothing to do`);
                return;
            }

            // Resolve the model this run would use. The default lives in
            // aiBridge (TAG_GENERATION_MODEL_ID); '' (fresh install) means
            // "the default" — compare the RESOLVED id so '' and the default
            // id reuse each other's worker.
            const aiTagModel = useSettingsStore.getState().aiTagModel;
            const resolvedTagModelId = aiTagModel || TAG_GENERATION_MODEL_ID;

            // Worker reuse: the engine is designed to stay resident for the
            // worker's lifetime, so a run with the SAME model keeps the
            // existing worker — no model reload, the big per-run cost. Only
            // a model switch (or a missing worker) spawns a new one; the old
            // worker is terminated so its GPU memory is released.
            let activeWorker = existingWorker;
            if (existingWorker && get().autoTagWorkerModelId !== resolvedTagModelId) {
                existingWorker.terminate();
                // Its engine dies with it — the footer chips lose this source.
                useImageStore.getState().setAutoTagModelsStatus(null);
                activeWorker = null;
            }

            if (!activeWorker) {
                // The AI worker lives in the closed-source ai-intelligence
                // module (moved 2026-08-12). Guarded load: no-module builds
                // fall through here — auto-tagging is premium-only, so there
                // is no fallback.
                let createAiWorker: ((...args: unknown[]) => Worker) | null = null;
                try {
                    createAiWorker = (await import('@ai-images-browser/ai-intelligence')).createAiWorker ?? null;
                } catch { /* module absent */ }
                if (!createAiWorker) {
                    console.warn('AI auto-tagging unavailable: ai-intelligence module not present');
                    return;
                }
                activeWorker = createAiWorker();
            }
            const worker = activeWorker;

            set({
                autoTaggingWorker: worker,
                autoTagWorkerModelId: resolvedTagModelId,
                isAutoTagging: true,
                autoTaggingProgress: { current: 0, total: taggingImages.length, message: 'Initializing...' }
            });

            // Resolve-on-complete: the returned promise settles when the run
            // ends ('complete' / 'error' / cancel). The pipeline round awaits
            // it before running the semantic phase so the fresh tags and
            // synonyms land in the index — strictly sequenced. Created BEFORE
            // postMessage so a fast 'complete' can't race the resolver capture.
            __autoTagInFlight = new Promise<void>((resolve) => {
                __autoTagResolve = resolve;
            });

            worker.onmessage = (e: MessageEvent) => {
                const { type, payload } = e.data;

                switch (type) {
                    case 'progress':
                        // The worker's payload may omit a human-readable
                        // message — fall back to a stable description so the
                        // footer bar always explains what it is doing.
                        set({ autoTaggingProgress: { ...payload, message: payload.message || 'Generating tags…' } });
                        break;
                    case 'complete': {
                        const generatedAt = Date.now();
                        const tagMap = new Map<string, string[]>();
                        Object.entries(payload.autoTags || {}).forEach(([id, tags]: [string, AutoTag[]]) => {
                            const normalizedTags = [...new Set((tags || []).map((tag) => tag.tag).filter(Boolean))];
                            tagMap.set(id, normalizedTags);
                        });

                        // Search enrichment: the worker also generated English
                        // synonyms for the core tags — hidden from the UI, but
                        // embedded into the semantic index text below.
                        const synonymMap = (payload.synonymTags || {}) as Record<string, string[]>;

                        // Add generated tags to autoTags (not manual tags)
                        const { annotations } = get();
                        const updatedAnnotations: ImageAnnotations[] = [];

                        for (const [imageId, newTags] of tagMap) {
                            const current = annotations.get(imageId);
                            const existingAutoTags = current?.autoTags ?? [];
                            const mergedAutoTags = [...new Set([...existingAutoTags, ...newTags])];

                            updatedAnnotations.push({
                                imageId,
                                isFavorite: current?.isFavorite ?? false,
                                tags: current?.tags ?? [],
                                autoTags: mergedAutoTags,
                                metadataTags: current?.metadataTags ?? [],
                                addedAt: current?.addedAt ?? generatedAt,
                                updatedAt: generatedAt,
                                isAutoTagged: true,
                                // Enrichment metadata: synonyms feed the semantic
                                // index text; the version stamp makes enrichment
                                // idempotent across runs (see needsSearchEnrichment).
                                synonymTags: synonymMap[imageId] ?? current?.synonymTags ?? [],
                                searchTagVersion: SEARCH_ENRICHMENT_VERSION,
                            });
                        }

                        // Persist annotations
                        if (updatedAnnotations.length > 0) {
                            import('../services/imageAnnotationsStorage')
                                .then(({ bulkSaveAnnotations }) => bulkSaveAnnotations(updatedAnnotations))
                                .catch(error => console.warn('Failed to persist auto-tags as annotations:', error));
                        }

                        set(state => {
                            const newAnnotations = new Map(state.annotations);
                            for (const annotation of updatedAnnotations) {
                                newAnnotations.set(annotation.imageId, annotation);
                            }

                            const updateList = (list: IndexedImage[]) => list.map(img => {
                                const annotation = newAnnotations.get(img.id);
                                if (annotation) {
                                    const mergedTags = mergeAnnotationTags(annotation);
                                    return { ...img, tags: mergedTags, autoTags: annotation.autoTags, metadataTags: annotation.metadataTags, isAutoTagged: annotation.isAutoTagged, synonymTags: annotation.synonymTags ?? [], searchTagVersion: annotation.searchTagVersion };
                                }
                                return img;
                            });

                            return {
                                ...state,
                                annotations: newAnnotations,
                                images: updateList(state.images),
                                filteredImages: updateList(state.filteredImages),
                                autoTaggingProgress: null,
                                isAutoTagging: false,
                            };
                        });

                        // Worker reuse: KEEP the worker alive — the engine is
                        // designed to stay resident for the worker's lifetime,
                        // and the next run with the same model reuses it (no
                        // reload). The footer chips keep reporting this source;
                        // only eject (unloadAiModels) releases it.
                        console.log(`Auto-tagging complete: ${tagMap.size} images tagged`);

                        // NOTE: the semantic Δ re-index is NOT fired here
                        // anymore — the pipeline round awaits this run's
                        // promise and then runs its semantic phase
                        // (runSemanticIndexNow), so the fresh tags + synonyms
                        // land in the index strictly sequenced.

                        if (payload.autoTags) {
                            // clusterCacheManager removed — auto-tag cache save disabled
                        }
                        const resolveAutoTag = __autoTagResolve;
                        __autoTagResolve = null;
                        __autoTagInFlight = null;
                        resolveAutoTag?.();
                        break;
                    }
                    case 'gpu-info':
                        // Route through the setter so the detection persists
                        // (Settings shows it without waiting for another load).
                        useImageStore.getState().setDetectedGpuInfo(payload);
                        break;
                    case 'models-status':
                        // This worker's engine holds the tag model (and the
                        // embed record — CreateMLCEngine loads both together).
                        useImageStore.getState().setAutoTagModelsStatus(payload);
                        break;
                    case 'error':
                        console.error('Auto-tagging error:', payload.error);
                        set({
                            autoTaggingProgress: null,
                            isAutoTagging: false,
                            error: `Auto-tagging failed: ${payload.error}`,
                        });
                        worker.terminate();
                        set({ autoTaggingWorker: null, autoTagWorkerModelId: null });
                        useImageStore.getState().setAutoTagModelsStatus(null);
                        // Resolve, not reject — the error is already surfaced
                        // in store.error; the round must still proceed to
                        // semantic with whatever was tagged before the failure.
                        const resolveAutoTag = __autoTagResolve;
                        __autoTagResolve = null;
                        __autoTagInFlight = null;
                        resolveAutoTag?.();
                        break;
                }
            };

            const disableAiFallback = useSettingsStore.getState().disableAiFallback;
            const aiDevicePreference = useSettingsStore.getState().aiDevicePreference;

            worker.postMessage({
                type: 'start',
                payload: {
                    images: taggingImages,
                    topN: options?.topN ?? 10,
                    minScore: options?.minScore,
                    disableFallback: disableAiFallback,
                    devicePreference: aiDevicePreference,
                    tagModelId: aiTagModel || undefined,
                    // The worker cannot check premium itself — its Zustand store
                    // is a separate instance without the user's license data.
                    isPremium: isAiFeaturesEnabled(),
                },
            });
            return __autoTagInFlight;
        },

        cancelAutoTagging: () => {
            const { autoTaggingWorker } = get();
            if (autoTaggingWorker) {
                autoTaggingWorker.postMessage({ type: 'cancel' });
                autoTaggingWorker.terminate();
                set({
                    autoTaggingWorker: null,
                    autoTagWorkerModelId: null,
                    autoTaggingProgress: null,
                    isAutoTagging: false,
                });
                // The worker's engine died with it — clear this source of the
                // footer chips (the semantic worker, if loaded, still reports
                // its own residency).
                useImageStore.getState().setAutoTagModelsStatus(null);
            }
            // Resolve any in-flight run's promise so a cancelled round phase
            // doesn't hang the queue job awaiting it (terminate() means the
            // worker's 'complete'/'error' handlers will never fire).
            __autoTagResolve?.();
            __autoTagResolve = null;
            __autoTagInFlight = null;
        },

        setAutoTaggingProgress: (progress) => set({ autoTaggingProgress: progress }),

        // restoreSmartLibraryCache removed — clustering and cache manager deleted
        restoreSmartLibraryCache: async (_directoryPath, _scanSubfolders) => {
            // No-op: clustering and smart library cache have been removed.
            // Auto-tag cache restoration was previously part of this function;
            // it can be re-added here if needed from a new cache source.
        },



        // Annotations Actions
        loadAnnotations: async () => {
            const annotationsMap = await loadAllAnnotations();
            const tags = await getAllTags();

            set(state => {
                // Denormalize annotations into images array using helper
                const updatedImages = applyAnnotationsToImages(state.images, annotationsMap);

                const newState = {
                    ...state,
                    annotations: annotationsMap,
                    availableTags: tags,
                    isAnnotationsLoaded: true,
                    images: updatedImages,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            // After loading annotations, schedule similarity group computation.
            // Wrapped in try/catch — any error here must not prevent images from loading.
            try {
                const state = get();
                const annValues = Array.from(state.annotations.values());
                const withStackId = annValues.filter(a => !!a.stackGroupId).length;
                const withSimId = annValues.filter(a => !!a.similarityGroupId).length;
                console.log(`[SimilarityGroups] Annotations loaded: ${annValues.length} total, ${withStackId} with stackGroupId, ${withSimId} with similarityGroupId`);

                // Check if similarity algorithm version changed — if so, clear old
                // similarityGroupId values and force re-computation with new threshold.
                const storedVersion = localStorage.getItem(SIMILARITY_VERSION_KEY);
                if (storedVersion !== String(SIMILARITY_GROUP_VERSION) && withSimId > 0) {
                    console.log(`[SimilarityGroups] Version changed (${storedVersion} → ${SIMILARITY_GROUP_VERSION}), resetting similarity groups...`);
                    const { bulkSaveAnnotations } = await import('../services/imageAnnotationsStorage');
                    const resetAnnotations: ImageAnnotations[] = [];
                    const resetMap = new Map(state.annotations);
                    for (const [id, ann] of resetMap) {
                        if (ann.similarityGroupId) {
                            const updated = { ...ann, similarityGroupId: undefined, isSimilarityAnalyzed: false, updatedAt: Date.now() };
                            resetAnnotations.push(updated);
                            resetMap.set(id, updated);
                        }
                    }
                    if (resetAnnotations.length > 0) {
                        await bulkSaveAnnotations(resetAnnotations);
                        const currentImages = get().images;
                        const currentState = get();
                        const imagesWithAnnotations = applyAnnotationsToImages(currentImages, resetMap);
                        const filteredResult = filterAndSort({ ...currentState, images: imagesWithAnnotations, annotations: resetMap });
                        const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);
                        set({ ...filteredResult, ...availableFilters, images: imagesWithAnnotations, annotations: resetMap });
                        console.log(`[SimilarityGroups] Reset ${resetAnnotations.length} similarityGroupId values`);
                    }
                }
                localStorage.setItem(SIMILARITY_VERSION_KEY, String(SIMILARITY_GROUP_VERSION));

                // Migrate existing annotations: if similarityGroupId is set
                // but isSimilarityAnalyzed flag is missing (from a prior version),
                // mark them as analyzed so they aren't re-processed.
                const migrationAnnotations: ImageAnnotations[] = [];
                const migrateMap = new Map(get().annotations);
                for (const [id, ann] of migrateMap) {
                    if (ann.similarityGroupId && !ann.isSimilarityAnalyzed) {
                        const updated = { ...ann, isSimilarityAnalyzed: true, updatedAt: Date.now() };
                        migrationAnnotations.push(updated);
                        migrateMap.set(id, updated);
                    }
                }
                if (migrationAnnotations.length > 0) {
                    const { bulkSaveAnnotations } = await import('../services/imageAnnotationsStorage');
                    await bulkSaveAnnotations(migrationAnnotations);
                    const currentImages = get().images;
                    const currentState = get();
                    const imagesWithAnnotations = applyAnnotationsToImages(currentImages, migrateMap);
                    const filteredResult = filterAndSort({ ...currentState, images: imagesWithAnnotations, annotations: migrateMap });
                    const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);
                    set({ ...filteredResult, ...availableFilters, images: imagesWithAnnotations, annotations: migrateMap });
                    console.log(`[Pipeline] Migrated ${migrationAnnotations.length} annotations: set isSimilarityAnalyzed=true`);
                }

                // Post-load processing is now handled by the unified
                // processPostIndexingPipeline() — invoked from App.tsx after
                // both annotations and images are loaded. This prevents the
                // race where similarity was scheduled before stacking completed.
                const updatedState = get();
                const needsPipeline = Array.from(updatedState.annotations.values()).some(
                    a => (!a.isStackAnalyzed) || (a.stackGroupId && !a.isSimilarityAnalyzed)
                );
                if (needsPipeline) {
                    console.log('[Pipeline] Images need post-indexing processing — will be handled by unified pipeline');
                } else {
                    console.log('[Pipeline] All processing already complete — skipping');
                }
            } catch (err) {
                console.error('[SimilarityGroups] Post-load processing failed (images still loaded):', err);
                // Ensure version is still written so we don't retry the failing migration
                try { localStorage.setItem(SIMILARITY_VERSION_KEY, String(SIMILARITY_GROUP_VERSION)); } catch {}
            }
        },

        toggleFavorite: async (imageId) => {
            const { annotations, images } = get();

            const currentAnnotation = annotations.get(imageId);
            const newIsFavorite = !(currentAnnotation?.isFavorite ?? false);

            const updatedAnnotation: ImageAnnotations = {
                // Spread first: preserves synonymTags/searchTagVersion and the
                // stack/similarity fields — a hardcoded rebuild drops them,
                // which re-queues enriched images on every auto-tag run.
                ...currentAnnotation,
                imageId,
                isFavorite: newIsFavorite,
                tags: currentAnnotation?.tags ?? [],
                autoTags: currentAnnotation?.autoTags ?? [],
                isAutoTagged: currentAnnotation?.isAutoTagged ?? false,
                metadataTags: currentAnnotation?.metadataTags ?? [],
                addedAt: currentAnnotation?.addedAt ?? Date.now(),
                updatedAt: Date.now(),
            };

            // Update in-memory state
            set(state => {
                const newAnnotations = new Map(state.annotations);
                newAnnotations.set(imageId, updatedAnnotation);

                const updatedImages = state.images.map(img =>
                    img.id === imageId ? { ...img, isFavorite: newIsFavorite } : img
                );

                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: updatedImages,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            // Persist to IndexedDB
            try {
                await saveAnnotation(updatedAnnotation);
            } catch (error) {
                console.error('Failed to save annotation:', error);
            }
        },

        bulkToggleFavorite: async (imageIds, isFavorite) => {
            const { annotations } = get();
            const updatedAnnotations: ImageAnnotations[] = [];

            for (const imageId of imageIds) {
                const current = annotations.get(imageId);
                updatedAnnotations.push({
                    // Spread first — preserves synonymTags/searchTagVersion
                    // and the stack/similarity fields (see toggleFavorite).
                    ...current,
                    imageId,
                    isFavorite,
                    tags: current?.tags ?? [],
                    autoTags: current?.autoTags ?? [],
                    isAutoTagged: current?.isAutoTagged ?? false,
                    metadataTags: current?.metadataTags ?? [],
                    addedAt: current?.addedAt ?? Date.now(),
                    updatedAt: Date.now(),
                });
            }

            // Update state
            set(state => {
                const newAnnotations = new Map(state.annotations);
                for (const annotation of updatedAnnotations) {
                    newAnnotations.set(annotation.imageId, annotation);
                }

                const updatedImages = state.images.map(img => {
                    const annotation = newAnnotations.get(img.id);
                    if (annotation && imageIds.includes(img.id)) {
                        return { ...img, isFavorite: annotation.isFavorite };
                    }
                    return img;
                });

                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: updatedImages,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            // Persist to IndexedDB
            try {
                await bulkSaveAnnotations(updatedAnnotations);
            } catch (error) {
                console.error('Failed to bulk save annotations:', error);
            }
        },

        addTagToImage: async (imageId, tag) => {
            const normalizedTag = tag.trim().toLowerCase();
            if (!normalizedTag) return;

            const { annotations } = get();
            const currentAnnotation = annotations.get(imageId);

            // Don't add duplicate across any tag source
            const allExisting = [
                ...(currentAnnotation?.tags ?? []),
                ...(currentAnnotation?.autoTags ?? []),
                ...(currentAnnotation?.metadataTags ?? []),
            ];
            if (allExisting.includes(normalizedTag)) {
                return;
            }

            const updatedAnnotation: ImageAnnotations = {
                // Spread first — preserves synonymTags/searchTagVersion and
                // the stack/similarity fields (see toggleFavorite).
                ...currentAnnotation,
                imageId,
                isFavorite: currentAnnotation?.isFavorite ?? false,
                tags: [...(currentAnnotation?.tags ?? []), normalizedTag],
                autoTags: currentAnnotation?.autoTags ?? [],
                isAutoTagged: currentAnnotation?.isAutoTagged ?? false,
                metadataTags: currentAnnotation?.metadataTags ?? [],
                addedAt: currentAnnotation?.addedAt ?? Date.now(),
                updatedAt: Date.now(),
            };

            let nextRecentTags = get().recentTags;

            // Update state
            set(state => {
                const newAnnotations = new Map(state.annotations);
                newAnnotations.set(imageId, updatedAnnotation);

                const mergedTags = mergeAnnotationTags(updatedAnnotation);
                const updatedImages = state.images.map(img =>
                    img.id === imageId ? { ...img, tags: mergedTags, autoTags: updatedAnnotation.autoTags, metadataTags: updatedAnnotation.metadataTags } : img
                );

                nextRecentTags = updateRecentTags(state.recentTags, normalizedTag);
                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: updatedImages,
                    recentTags: nextRecentTags,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            persistRecentTags(nextRecentTags);

            // Persist and refresh tags
            try {
                await saveAnnotation(updatedAnnotation);
                await get().refreshAvailableTags();
            } catch (error) {
                console.error('Failed to save annotation:', error);
            }

            // Tag text feeds the semantic index — Δ-re-index so the edit is
            // immediately searchable (no-op when semantic search is off).
            void get().semanticIndexImages();
        },

        removeTagFromImage: async (imageId, tag) => {
            const { annotations } = get();
            const currentAnnotation = annotations.get(imageId);

            if (!currentAnnotation) return;

            // Remove from whichever source contains it
            const inManual = currentAnnotation.tags.includes(tag);
            const inAuto = (currentAnnotation.autoTags || []).includes(tag);
            const inMetadata = (currentAnnotation.metadataTags || []).includes(tag);

            if (!inManual && !inAuto && !inMetadata) return;

            const updatedAnnotation: ImageAnnotations = {
                ...currentAnnotation,
                tags: inManual ? currentAnnotation.tags.filter(t => t !== tag) : currentAnnotation.tags,
                autoTags: inAuto ? (currentAnnotation.autoTags || []).filter(t => t !== tag) : (currentAnnotation.autoTags || []),
                metadataTags: inMetadata ? (currentAnnotation.metadataTags || []).filter(t => t !== tag) : (currentAnnotation.metadataTags || []),
                updatedAt: Date.now(),
            };

            const mergedTags = mergeAnnotationTags(updatedAnnotation);

            // Update state
            set(state => {
                const newAnnotations = new Map(state.annotations);
                newAnnotations.set(imageId, updatedAnnotation);

                const updatedImages = state.images.map(img =>
                    img.id === imageId ? { ...img, tags: mergedTags, autoTags: updatedAnnotation.autoTags, metadataTags: updatedAnnotation.metadataTags } : img
                );

                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: updatedImages,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            // Persist and refresh tags
            try {
                await saveAnnotation(updatedAnnotation);
                await get().refreshAvailableTags();
            } catch (error) {
                console.error('Failed to save annotation:', error);
            }

            // Tag text feeds the semantic index — Δ-re-index so the edit is
            // immediately searchable (no-op when semantic search is off).
            void get().semanticIndexImages();
        },

        bulkAddTag: async (imageIds, tag) => {
            const normalizedTag = tag.trim().toLowerCase();
            if (!normalizedTag || imageIds.length === 0) return;

            const { annotations } = get();
            const updatedAnnotations: ImageAnnotations[] = [];

            for (const imageId of imageIds) {
                const current = annotations.get(imageId);
                const allExisting = [
                    ...(current?.tags ?? []),
                    ...(current?.autoTags ?? []),
                    ...(current?.metadataTags ?? []),
                ];
                if (allExisting.includes(normalizedTag)) {
                    continue; // Skip if already tagged in any source
                }

                updatedAnnotations.push({
                    // Spread first — preserves synonymTags/searchTagVersion
                    // and the stack/similarity fields (see toggleFavorite).
                    ...current,
                    imageId,
                    isFavorite: current?.isFavorite ?? false,
                    tags: [...(current?.tags ?? []), normalizedTag],
                    autoTags: current?.autoTags ?? [],
                    isAutoTagged: current?.isAutoTagged ?? false,
                    metadataTags: current?.metadataTags ?? [],
                    addedAt: current?.addedAt ?? Date.now(),
                    updatedAt: Date.now(),
                });
            }

            let nextRecentTags = get().recentTags;

            // Update state
            set(state => {
                const newAnnotations = new Map(state.annotations);
                for (const annotation of updatedAnnotations) {
                    newAnnotations.set(annotation.imageId, annotation);
                }

                const updatedImages = state.images.map(img => {
                    const annotation = newAnnotations.get(img.id);
                    if (annotation && imageIds.includes(img.id)) {
                        const mergedTags = mergeAnnotationTags(annotation);
                        return { ...img, tags: mergedTags, autoTags: annotation.autoTags, metadataTags: annotation.metadataTags };
                    }
                    return img;
                });

                nextRecentTags = updateRecentTags(state.recentTags, normalizedTag);
                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: updatedImages,
                    recentTags: nextRecentTags,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            persistRecentTags(nextRecentTags);

            // Persist and refresh tags
            try {
                await bulkSaveAnnotations(updatedAnnotations);
                await get().refreshAvailableTags();
            } catch (error) {
                console.error('Failed to bulk save annotations:', error);
            }

            // Tag text feeds the semantic index — Δ-re-index so the edit is
            // immediately searchable (no-op when semantic search is off).
            void get().semanticIndexImages();
        },

        bulkRemoveTag: async (imageIds, tag) => {
            const { annotations } = get();
            const updatedAnnotations: ImageAnnotations[] = [];

            for (const imageId of imageIds) {
                const current = annotations.get(imageId);
                if (!current) continue;

                const inManual = current.tags.includes(tag);
                const inAuto = (current.autoTags || []).includes(tag);
                const inMetadata = (current.metadataTags || []).includes(tag);
                if (!inManual && !inAuto && !inMetadata) continue;

                updatedAnnotations.push({
                    ...current,
                    tags: inManual ? current.tags.filter(t => t !== tag) : current.tags,
                    autoTags: inAuto ? (current.autoTags || []).filter(t => t !== tag) : (current.autoTags || []),
                    metadataTags: inMetadata ? (current.metadataTags || []).filter(t => t !== tag) : (current.metadataTags || []),
                    updatedAt: Date.now(),
                });
            }

            // Update state
            set(state => {
                const newAnnotations = new Map(state.annotations);
                for (const annotation of updatedAnnotations) {
                    newAnnotations.set(annotation.imageId, annotation);
                }

                const updatedImages = state.images.map(img => {
                    const annotation = newAnnotations.get(img.id);
                    if (annotation && imageIds.includes(img.id)) {
                        const mergedTags = mergeAnnotationTags(annotation);
                        return { ...img, tags: mergedTags, autoTags: annotation.autoTags, metadataTags: annotation.metadataTags };
                    }
                    return img;
                });

                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: updatedImages,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            // Persist and refresh tags
            try {
                await bulkSaveAnnotations(updatedAnnotations);
                await get().refreshAvailableTags();
            } catch (error) {
                console.error('Failed to bulk save annotations:', error);
            }

            // Tag text feeds the semantic index — Δ-re-index so the edit is
            // immediately searchable (no-op when semantic search is off).
            void get().semanticIndexImages();
        },

        setSelectedTags: (tags) => set(state => {
            const newState = { ...state, selectedTags: tags };
            return { ...newState, ...filterAndSort(newState) };
        }),

        setShowFavoritesOnly: (show) => set(state => {
            const newState = { ...state, showFavoritesOnly: show };
            return { ...newState, ...filterAndSort(newState) };
        }),

        getImageAnnotations: (imageId) => {
            return get().annotations.get(imageId) || null;
        },

        refreshAvailableTags: async () => {
            // Now handled automatically by filterAndSort
            // We just need to trigger a recompute if somehow the tags changed but no other state did
            set(state => ({ ...filterAndSort(state) }));
        },

        importMetadataTags: async (images) => {
            if (!images || images.length === 0) return;

            const { annotations } = get();
            const updatedAnnotations: ImageAnnotations[] = [];

            // Collect all tags to import from metadata
            for (const image of images) {
                const rawTags = image.metadata?.normalizedMetadata?.tags;
                if (!rawTags || rawTags.length === 0) continue;

                const currentAnnotation = annotations.get(image.id);
                const existingMetadataTags = currentAnnotation?.metadataTags ?? [];
                const allExisting = [
                    ...(currentAnnotation?.tags ?? []),
                    ...(currentAnnotation?.autoTags ?? []),
                    ...existingMetadataTags,
                ];

                // Normalize and filter out duplicates across all sources
                const newTags = rawTags
                    .map((tag: string) => tag.trim().toLowerCase())
                    .filter((tag: string) => tag && !allExisting.includes(tag));

                if (newTags.length === 0) continue;

                const updatedAnnotation: ImageAnnotations = {
                    imageId: image.id,
                    isFavorite: currentAnnotation?.isFavorite ?? false,
                    tags: currentAnnotation?.tags ?? [],
                    autoTags: currentAnnotation?.autoTags ?? [],
                    isAutoTagged: currentAnnotation?.isAutoTagged ?? false,
                    metadataTags: [...existingMetadataTags, ...newTags],
                    addedAt: currentAnnotation?.addedAt ?? Date.now(),
                    updatedAt: Date.now(),
                };

                updatedAnnotations.push(updatedAnnotation);
            }

            if (updatedAnnotations.length === 0) return;

            // Update state
            set(state => {
                const newAnnotations = new Map(state.annotations);
                for (const annotation of updatedAnnotations) {
                    newAnnotations.set(annotation.imageId, annotation);
                }

                const updatedImages = state.images.map(img => {
                    const annotation = newAnnotations.get(img.id);
                    if (annotation) {
                        const mergedTags = mergeAnnotationTags(annotation);
                        return { ...img, tags: mergedTags, autoTags: annotation.autoTags, metadataTags: annotation.metadataTags };
                    }
                    return img;
                });

                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: updatedImages,
                };

                return { ...newState, ...filterAndSort(newState) };
            });

            // Persist annotations
            bulkSaveAnnotations(updatedAnnotations).catch(error => {
                console.error('Failed to import metadata tags:', error);
            });

            // Refresh available tags
            get().refreshAvailableTags();

            // Tag text feeds the semantic index — Δ-re-index so the edit is
            // immediately searchable (no-op when semantic search is off).
            void get().semanticIndexImages();
        },

        clearAutoTags: async () => {
            const { annotations, directories } = get();
            const updatedAnnotations: ImageAnnotations[] = [];

            for (const [, annotation] of annotations) {
                const autoTags = annotation.autoTags || [];
                if (autoTags.length > 0 || annotation.isAutoTagged) {
                    updatedAnnotations.push({
                        imageId: annotation.imageId,
                        isFavorite: annotation.isFavorite,
                        tags: annotation.tags || [],
                        autoTags: [],
                        isAutoTagged: false,
                        metadataTags: annotation.metadataTags || [],
                        addedAt: annotation.addedAt,
                        updatedAt: Date.now(),
                        // Synonyms die with the auto-tags; dropping the
                        // searchTagVersion re-opens the enrichment gate so a
                        // future run re-enriches from scratch.
                        synonymTags: [],
                    });
                }
            }

            if (updatedAnnotations.length === 0) {
                // No auto-tags in annotations, but there may still be stale cache
                // files on disk. Fall through to invalidate caches.
            } else {
                // Persist to IndexedDB
                try {
                    await bulkSaveAnnotations(updatedAnnotations);
                } catch (error) {
                    console.error('Failed to clear auto-tags:', error);
                }

                // Update in-memory state — only replace what changed
                set(state => {
                    const newAnnotations = new Map(state.annotations);
                    for (const annotation of updatedAnnotations) {
                        newAnnotations.set(annotation.imageId, annotation);
                    }

                    const changedIds = new Set(updatedAnnotations.map(a => a.imageId));
                    const updatedImages = state.images.map(img => {
                        if (!changedIds.has(img.id)) return img;
                        const annotation = newAnnotations.get(img.id);
                        if (!annotation) return img;
                        const mergedTags = mergeAnnotationTags(annotation);
                        return {
                            ...img,
                            tags: mergedTags,
                            autoTags: [],
                            metadataTags: annotation.metadataTags,
                            isAutoTagged: false,
                            // Drop the spread-inherited stale enrichment state
                            // so the indexer stops embedding these synonyms.
                            synonymTags: [],
                            searchTagVersion: undefined,
                        };
                    });

                    return {
                        annotations: newAnnotations,
                        images: updatedImages,
                    };
                });

                // Re-run filter/sort to refresh availableTags etc.
                set(state => filterAndSort(state));

                console.log(`Cleared auto-tags from ${updatedAnnotations.length} images`);
            }

            // Auto-tag text feeds the semantic index — Δ-re-index so the
            // cleared state is searchable immediately.
            void get().semanticIndexImages();

            // clusterCacheManager removed — auto-tag cache invalidation disabled
        },

        clearDerivedImageData: async () => {
            const state = get();

            // ── Guards ─────────────────────────────────────────────────────
            // An in-flight auto-tag run would WRITE autoTags/synonymTags back
            // through its 'complete' handler mid-wipe — terminate it (its
            // results are derived data being cleared anyway).
            if (state.isAutoTagging) get().cancelAutoTagging();
            if (state.indexingState === 'indexing') {
                throw new Error('An indexing operation is in progress — wait for it to finish.');
            }
            if (__syncInProgress || __similaritySyncInProgress) {
                throw new Error('Stacking/similarity processing is in progress — try again shortly.');
            }
            // Pipeline/semantic work lives on the global serial queue — refuse
            // to wipe while a round or an index job is RUNNING, and drop any
            // queued ones so nothing replays stale data after the wipe.
            if (processingQueue.hasRunning('pipeline') || processingQueue.hasRunning('semantic')) {
                throw new Error('Processing is in progress — wait for the current phase to finish.');
            }
            processingQueue.dropQueued('pipeline');
            processingQueue.dropQueued('semantic');
            __semanticIndexQueuedForce = false;

            // ── 1. Disk caches: per-directory metadata (BOTH scan variants —
            //    main <cacheRoot>/<cacheId>.json + json_cache chunks) and the
            //    whole thumbnails dir. clearDirectoryCache self-guards
            //    !isElectron; the window.electronAPI check is belt-and-braces.
            if (window.electronAPI) {
                for (const dir of state.directories) {
                    try {
                        await cacheManager.clearDirectoryCache(dir.path, true);
                        await cacheManager.clearDirectoryCache(dir.path, false);
                    } catch (error) {
                        console.error(`Failed to clear metadata cache for ${dir.path}:`, error);
                    }
                }
                try {
                    await window.electronAPI.clearThumbnailCache();
                } catch (error) {
                    console.error('Failed to clear thumbnail cache:', error);
                }
            }
            // Revoke in-memory blob URLs so stale thumbnails can't be served.
            thumbnailManager.clearAllUrls();

            // ── 2. Semantic vectors: coordinator (worker memory + IndexedDB
            //    store) when it exists or the feature is enabled; direct store
            //    clear otherwise (the module may be unusable when disabled).
            try {
                if (__semanticCoordinator) {
                    await __semanticCoordinator.clearIndex();
                } else if (isSemanticSearchEnabled()) {
                    const coordinator = await getSemanticCoordinator();
                    await coordinator.clearIndex();
                } else {
                    await clearSemanticVectorsStore();
                }
                set({ semanticIndexedCount: 0, semanticLastError: null });
            } catch (error) {
                console.error('Failed to clear semantic vectors:', error);
            }

            // ── 3. Surgical annotation rewrite — keep user data (favorites,
            //    manual tags, addedAt), zero the 9 derived fields. Zeroing
            //    searchTagVersion re-opens the auto-tag enrichment gate and
            //    the stack/similarity flags re-open those pipeline gates, so
            //    the post-rescan pipeline genuinely reprocesses every image.
            const updatedAnnotations: ImageAnnotations[] = [];
            const newAnnotations = new Map(state.annotations);
            const now = Date.now();
            for (const [imageId, annotation] of state.annotations) {
                const hasDerived = (annotation.autoTags?.length ?? 0) > 0
                    || !!annotation.isAutoTagged
                    || (annotation.synonymTags?.length ?? 0) > 0
                    || annotation.searchTagVersion !== undefined
                    || (annotation.metadataTags?.length ?? 0) > 0
                    || annotation.stackGroupId !== undefined
                    || !!annotation.isStackAnalyzed
                    || annotation.similarityGroupId !== undefined
                    || !!annotation.isSimilarityAnalyzed;
                if (!hasDerived) continue; // already clean — skip the write

                const updated: ImageAnnotations = {
                    imageId: annotation.imageId,
                    isFavorite: annotation.isFavorite,   // KEEP
                    tags: annotation.tags ?? [],        // KEEP — manual tags
                    autoTags: [],                       // CLEAR
                    isAutoTagged: false,                // CLEAR
                    synonymTags: [],                    // CLEAR
                    searchTagVersion: undefined,        // CLEAR — enrichment gate
                    metadataTags: [],                   // CLEAR — re-extracted on rescan
                    stackGroupId: undefined,            // CLEAR — re-stack
                    isStackAnalyzed: false,             // CLEAR
                    similarityGroupId: undefined,       // CLEAR — re-group
                    isSimilarityAnalyzed: false,        // CLEAR
                    addedAt: annotation.addedAt,        // KEEP
                    updatedAt: now,                     // bump
                };
                updatedAnnotations.push(updated);
                newAnnotations.set(imageId, updated);
            }
            if (updatedAnnotations.length > 0) {
                try {
                    await bulkSaveAnnotations(updatedAnnotations);
                } catch (error) {
                    console.error('Failed to save cleared annotations:', error);
                }
            }

            // ── 4. In-memory state: re-apply annotations to images + filters.
            //    (Same shape as loadAnnotations — applyAnnotationsToImages
            //    re-merges the zeroed annotation onto each IndexedImage.)
            set(state => {
                const newState = {
                    ...state,
                    annotations: newAnnotations,
                    images: applyAnnotationsToImages(state.images, newAnnotations),
                };
                return { ...newState, ...filterAndSort(newState) };
            });
            await get().refreshAvailableTags();

            console.log(`[Reprocess] Cleared derived data for ${updatedAnnotations.length} images`);
        },

        flushPendingImages: () => {
            flushPendingImages();
        },

        setDirectoryRefreshing: (directoryId, isRefreshing) => {
            set(state => {
                const next = new Set(state.refreshingDirectories);
                if (isRefreshing) {
                    next.add(directoryId);
                } else {
                    next.delete(directoryId);
                }
                return { refreshingDirectories: next };
            });
        },

        toggleImageSelection: (imageId) => {
            set(state => {
                const newSelection = new Set(state.selectedImages);
                if (newSelection.has(imageId)) {
                    newSelection.delete(imageId);
                } else {
                    newSelection.add(imageId);
                }
                return { selectedImages: newSelection };
            });
        },

        selectAllImages: () => set(state => {
            const allImageIds = new Set(state.filteredImages.map(img => img.id));
            return { selectedImages: allImageIds };
        }),

        clearImageSelection: () => set({ selectedImages: new Set() }),

        deleteSelectedImages: async () => {
            get().clearImageSelection();
        },

        setScanSubfolders: (scan) => {
            localStorage.setItem('image-metahub-scan-subfolders', String(scan));
            set({ scanSubfolders: scan });
        },

        handleNavigateNext: () => {
            const state = get();
            if (!state.selectedImage) return;

            // Use cluster context if available, otherwise use filtered images
            const imagesToNavigate = state.clusterNavigationContext || state.filteredImages;
            const currentIndex = imagesToNavigate.findIndex(img => img.id === state.selectedImage!.id);

            if (currentIndex < imagesToNavigate.length - 1) {
                const nextImage = imagesToNavigate[currentIndex + 1];
                set({ selectedImage: nextImage });
            }
        },

        handleNavigatePrevious: () => {
            const state = get();
            if (!state.selectedImage) return;

            // Use cluster context if available, otherwise use filtered images
            const imagesToNavigate = state.clusterNavigationContext || state.filteredImages;
            const currentIndex = imagesToNavigate.findIndex(img => img.id === state.selectedImage!.id);

            if (currentIndex > 0) {
                const prevImage = imagesToNavigate[currentIndex - 1];
                set({ selectedImage: prevImage });
            }
        },

        // Drag and Drop (Internal)
        setDraggedItems: (items) => set({ draggedItems: items }),
        clearDraggedItems: () => set({ draggedItems: [] }),

        folderScrollPositions: {},
        setFolderScrollPosition: (key, position) => set(state => ({
            folderScrollPositions: { ...state.folderScrollPositions, [key]: position }
        })),

        setActiveView: (view) => set({ activeView: view }),

        resetState: () => {
            try {
                localStorage.removeItem(DETECTED_GPU_STORAGE_KEY);
                localStorage.removeItem(DETECTED_GPUS_STORAGE_KEY);
            } catch {
                // storage failure — the in-memory state is cleared regardless
            }
            set({
            images: [],
            filteredImages: [],
            selectionTotalImages: 0,
            selectionDirectoryCount: 0,
            directories: [],
            selectedFolders: new Set(),
            isFolderSelectionLoaded: false,
            isLoading: false,
            progress: { current: 0, total: 0 },
            enrichmentProgress: null,
            error: null,
            success: null,
            selectedImage: null,
            selectedImages: new Set(),
            searchQuery: '',
            availableModels: [],
            availableLoras: [],
            availableSchedulers: [],
            availableDimensions: [],
            availableAspectRatios: [],
            selectedModels: [],
            selectedLoras: [],
            selectedSchedulers: [],
            advancedFilters: {},
            indexingState: 'idle',
            previewImage: null,
            focusedImageIndex: null,
            scanSubfolders: true,
            libraryStackContext: null,
            sortOrder: useSettingsStore.getState().sortOrder || 'date-desc',
            isFullscreenMode: false,
            undoAvailable: false,
            annotations: new Map(),
            availableTags: [],
            selectionFavoriteCount: 0,
            recentTags: loadRecentTags(),
            selectedTags: [],
            showFavoritesOnly: false,
            isAnnotationsLoaded: false,
            activeWatchers: new Set(),
            refreshingDirectories: new Set(),
            clusters: [],
            clusteringProgress: null,
            clusteringWorker: null,
            isClustering: false,
            clusterNavigationContext: null,

            autoTaggingWorker: null,
            autoTagWorkerModelId: null,
            isAutoTagging: false,
            detectedGpuInfo: null,
            detectedGpuDevices: [],
            aiModelsLoaded: EMPTY_AI_MODELS_STATUS,
            draggedItems: [],
            clearAllThumbnails: () => {},
        });
        },

        cleanupInvalidImages: () => {
            const state = get();
            const isElectron = typeof window !== 'undefined' && window.electronAPI;
            
            const validImages = state.images.filter(image => {
                const fileHandle = image.thumbnailHandle || image.handle;
                return isElectron || (fileHandle && typeof fileHandle.getFile === 'function');
            });
            
            if (validImages.length !== state.images.length) {
                set(state => ({
                    ...state,
                    images: validImages,
                    ...filterAndSort({ ...state, images: validImages })
                }));

            }
        },

        setStackingEnabled: (enabled: boolean) => {
            // Without ai-intelligence or a premium license, stacking cannot be enabled
            if (enabled && !isAiFeaturesEnabled()) return;
            set({ isStackingEnabled: enabled });
            // Persist synchronously via localStorage as a backup so the setting
            // survives even when the Electron IPC saveSettings call is delayed
            // or skipped (e.g. during rehydration window, or IPC congestion).
            try { localStorage.setItem('silkstack-stacking-enabled', String(enabled)); } catch {}
            // Also persist to the settings store (async, via Electron IPC)
            useSettingsStore.getState().setStackingEnabled(enabled);
        },

        setLibraryStackContext: (context: LibraryStackContext | null) => {
            set(state => ({ ...filterAndSort({ ...state, libraryStackContext: context }), libraryStackContext: context }));
        },

        syncNewImagesToStacks: async () => {
            const state = get();
            const { images, annotations } = state;

            // Premium gate: stacking is an AI feature — without a valid
            // license nothing here may run. (The aiBridge factory also
            // returns null, but the gate must be explicit and testable at
            // this layer — defense in depth.)
            if (!isAiFeaturesEnabled()) {
                console.log('[Stacks] Premium not enabled — skipping stack sync');
                return;
            }

            // Prevent concurrent runs (module-level guard — survives state updates)
            if (__syncInProgress) return;

            // Guard: do not process until annotations are loaded from IndexedDB.
            // Without this, all images appear unanalyzed (annotations is empty),
            // and we would overwrite existing stack data with fresh assignments.
            // This also prevents the race where loadAnnotations later overwrites
            // the in-memory state with stale DB data, discarding our writes.
            if (!state.isAnnotationsLoaded) {
                console.log('[Stacks] Annotations not yet loaded — deferring stack sync');
                return;
            }

            __syncInProgress = true;

            try {
                const { createStackingEngine } = await import('../services/aiBridge');
                const engine = await createStackingEngine();
                if (!engine) {
                    console.log('[Stacks] AI intelligence not available — skipping stack sync');
                    return;
                }

                const { bulkSaveAnnotations } = await import('../services/imageAnnotationsStorage');

                const now = Date.now();
                const updatedAnnotations: ImageAnnotations[] = [];
                const newAnnotations = new Map(annotations);

                for (const image of images) {
                    const existing = annotations.get(image.id);

                    // Skip already-analyzed images (same pattern as isAutoTagged)
                    if (existing?.isStackAnalyzed) continue;

                    const prompt = image.prompt
                        || image.metadata?.normalizedMetadata?.prompt
                        || image.metadata?.positive_prompt;

                    const stackGroupId = prompt && prompt.trim()
                        ? engine.generatePromptHash(prompt)
                        : undefined;

                    const updated: ImageAnnotations = {
                        imageId: image.id,
                        isFavorite: existing?.isFavorite ?? false,
                        tags: existing?.tags ?? [],
                        autoTags: existing?.autoTags ?? [],
                        metadataTags: existing?.metadataTags ?? [],
                        isAutoTagged: existing?.isAutoTagged,
                        // New stack fields
                        stackGroupId,
                        similarityGroupId: existing?.similarityGroupId,
                        isSimilarityAnalyzed: existing?.isSimilarityAnalyzed,
                        isStackAnalyzed: true,
                        addedAt: existing?.addedAt ?? now,
                        updatedAt: now,
                    };

                    updatedAnnotations.push(updated);
                    newAnnotations.set(image.id, updated);
                }

                if (updatedAnnotations.length > 0) {
                    // Persist to IndexedDB (same path as auto-tags)
                    await bulkSaveAnnotations(updatedAnnotations);

                    // Update in-memory state — use get().images so we don't overwrite
                    // thumbnail URLs loaded concurrently during IndexedDB write.
                    const currentImages = get().images;
                    const imagesWithAnnotations = applyAnnotationsToImages(currentImages, newAnnotations);
                    const filteredResult = filterAndSort({ ...state, images: imagesWithAnnotations, annotations: newAnnotations });
                    const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

                    set({
                        ...filteredResult,
                        ...availableFilters,
                        images: imagesWithAnnotations,
                        annotations: newAnnotations,
                    });

                    // Similarity grouping is now handled by the unified
                    // processPostIndexingPipeline() coordinator, which runs
                    // syncNewImagesToStacks → computeSimilarityGroups sequentially.
                    // This prevents the race where similarity was scheduled
                    // before stacking fully completed.
                }
            } catch (error) {
                console.error('Failed to sync new images to stacks:', error);
            } finally {
                __syncInProgress = false;
            }
        },

        handleStackImageDeletion: (deletedImageIds: string[]) => {
            const { annotations } = get();
            const deletedSet = new Set(deletedImageIds);

            // Build updated annotations: clear stackGroupId for deleted images
            const updatedList: ImageAnnotations[] = [];
            const newAnnotations = new Map(annotations);

            for (const [imageId, annotation] of annotations) {
                if (deletedSet.has(imageId) && (annotation.stackGroupId || annotation.isStackAnalyzed || annotation.similarityGroupId)) {
                    const updated = {
                        ...annotation,
                        stackGroupId: undefined,
                        isStackAnalyzed: false,
                        similarityGroupId: undefined,
                        isSimilarityAnalyzed: false,
                        updatedAt: Date.now(),
                    };
                    updatedList.push(updated);
                    newAnnotations.set(imageId, updated);
                }
            }

            if (updatedList.length > 0) {
                import('../services/imageAnnotationsStorage').then(({ bulkSaveAnnotations }) => {
                    bulkSaveAnnotations(updatedList);
                }).catch(() => {});

                const state = get();
                const imagesWithAnnotations = applyAnnotationsToImages(state.images, newAnnotations);
                const filteredResult = filterAndSort({ ...state, images: imagesWithAnnotations, annotations: newAnnotations });
                const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

                set({
                    ...filteredResult,
                    ...availableFilters,
                    images: imagesWithAnnotations,
                    annotations: newAnnotations,
                });
            }
        },

        /**
         * Merge selected images and/or stacks into a single stack.
         *
         * Collects all directly-selected images AND all images belonging to
         * any selected stack (identified via its coverImage.id) and assigns
         * them a common similarityGroupId so the stacking engine groups them
         * together.  Also clears the selection on success.
         */
        mergeSelectedToStack: async () => {
            if (!isAiFeaturesEnabled()) return;
            const state = get();
            const { selectedImages, images, annotations } = state;

            if (selectedImages.size < 2) return;

            // ── 1. Collect all image IDs involved in the selection ─────────
            const directlySelected = new Set(selectedImages);
            const involvedImageIds = new Set<string>();

            // Collect stack group IDs of directly selected images so we can
            // pull in every image belonging to those stacks.
            const selectedStackGroupIds = new Set<string>();

            for (const img of images) {
                if (directlySelected.has(img.id)) {
                    involvedImageIds.add(img.id);
                    if (img.similarityGroupId) selectedStackGroupIds.add(img.similarityGroupId);
                    if (img.stackGroupId) selectedStackGroupIds.add(img.stackGroupId);
                }
            }

            // Add all sibling images from the same stacks
            for (const img of images) {
                if (
                    (img.similarityGroupId && selectedStackGroupIds.has(img.similarityGroupId)) ||
                    (img.stackGroupId && selectedStackGroupIds.has(img.stackGroupId))
                ) {
                    involvedImageIds.add(img.id);
                }
            }

            if (involvedImageIds.size < 2) return;

            // ── 1a. Save pre-merge snapshot for Ctrl+Z undo ───────────────
            const preMergeSnapshot: UndoEntry['previousAnnotations'] = [];
            for (const imageId of involvedImageIds) {
                const ann = annotations.get(imageId);
                preMergeSnapshot.push({
                    imageId,
                    stackGroupId: ann?.stackGroupId,
                    similarityGroupId: ann?.similarityGroupId,
                    isSimilarityAnalyzed: ann?.isSimilarityAnalyzed,
                });
            }

            // ── 2. Choose a target similarityGroupId ──────────────────────
            // Reuse an existing similarityGroupId from one of the selected
            // stacks if available; otherwise generate a fresh one.
            let targetGroupId = '';
            for (const gid of selectedStackGroupIds) {
                if (gid) { targetGroupId = gid; break; }
            }
            if (!targetGroupId) {
                targetGroupId = `merged-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            }

            // ── 3. Build updated annotations ──────────────────────────────
            const updatedAnnotations: ImageAnnotations[] = [];
            const newAnnotations = new Map(annotations);

            for (const imageId of involvedImageIds) {
                const existing = annotations.get(imageId);
                // Skip if already in the target group
                if (existing?.similarityGroupId === targetGroupId) continue;

                const updated: ImageAnnotations = {
                    imageId,
                    isFavorite: existing?.isFavorite ?? false,
                    tags: existing?.tags ?? [],
                    autoTags: existing?.autoTags ?? [],
                    isAutoTagged: existing?.isAutoTagged ?? false,
                    metadataTags: existing?.metadataTags ?? [],
                    stackGroupId: existing?.stackGroupId,
                    similarityGroupId: targetGroupId,
                    isSimilarityAnalyzed: true,
                    isStackAnalyzed: existing?.isStackAnalyzed ?? false,
                    addedAt: existing?.addedAt ?? Date.now(),
                    updatedAt: Date.now(),
                };
                updatedAnnotations.push(updated);
                newAnnotations.set(imageId, updated);
            }

            if (updatedAnnotations.length === 0) return;

            // ── 4. Persist ───────────────────────────────────────────────
            try {
                const { bulkSaveAnnotations } = await import('../services/imageAnnotationsStorage');
                await bulkSaveAnnotations(updatedAnnotations);

                // Push undo entry only after persistence succeeds
                __undoStack.push({
                    description: `Merge ${involvedImageIds.size} images into stack`,
                    previousAnnotations: preMergeSnapshot,
                });
                // Keep the stack bounded
                while (__undoStack.length > MAX_UNDO_STACK) {
                    __undoStack.shift();
                }
            } catch (err) {
                console.error('[mergeSelectedToStack] Failed to persist annotations:', err);
            }

            // ── 5. Update in-memory state + clear selection ──────────────
            const updatedImages = applyAnnotationsToImages(images, newAnnotations);
            const filteredResult = filterAndSort({ ...state, images: updatedImages, annotations: newAnnotations });
            const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

            set({
                ...filteredResult,
                ...availableFilters,
                images: updatedImages,
                annotations: newAnnotations,
                selectedImages: new Set(),
                undoAvailable: __undoStack.length > 0,
            });
        },

        /**
         * Remove selected images from their current stack by clearing
         * their similarityGroupId.  Only meaningful when viewing a stack
         * drill-down (libraryStackContext is set).
         */
        unmergeSelectedFromStack: async () => {
            if (!isAiFeaturesEnabled()) return;

            const state = get();
            const { selectedImages, annotations, libraryStackContext } = state;

            if (selectedImages.size === 0 || !libraryStackContext) return;

            // Only unmerge images that are actually in the current stack
            const stackImageIds = new Set(libraryStackContext.imageIds);
            const toUnmerge = [...selectedImages].filter(id => stackImageIds.has(id));
            if (toUnmerge.length === 0) return;

            // Save pre-unmerge snapshot for Ctrl+Z undo
            const preUnmergeSnapshot: UndoEntry['previousAnnotations'] = [];
            for (const imageId of toUnmerge) {
                const ann = annotations.get(imageId);
                preUnmergeSnapshot.push({
                    imageId,
                    stackGroupId: ann?.stackGroupId,
                    similarityGroupId: ann?.similarityGroupId,
                    isSimilarityAnalyzed: ann?.isSimilarityAnalyzed,
                });
            }

            const updatedAnnotations: ImageAnnotations[] = [];
            const newAnnotations = new Map(annotations);

            for (const imageId of toUnmerge) {
                const existing = annotations.get(imageId);
                if (!existing?.similarityGroupId && !existing?.stackGroupId) continue; // already standalone

                const updated: ImageAnnotations = {
                    ...existing,
                    stackGroupId: undefined,
                    similarityGroupId: undefined,
                    isSimilarityAnalyzed: false,
                    // Keep isStackAnalyzed true — prevents the image from
                    // being automatically re-grouped on the next sync.
                    updatedAt: Date.now(),
                };
                updatedAnnotations.push(updated);
                newAnnotations.set(imageId, updated);
            }

            if (updatedAnnotations.length === 0) return;

            // Persist
            try {
                const { bulkSaveAnnotations } = await import('../services/imageAnnotationsStorage');
                await bulkSaveAnnotations(updatedAnnotations);

                // Push undo entry
                __undoStack.push({
                    description: `Unmerge ${toUnmerge.length} image${toUnmerge.length > 1 ? 's' : ''} from stack`,
                    previousAnnotations: preUnmergeSnapshot,
                });
                while (__undoStack.length > MAX_UNDO_STACK) {
                    __undoStack.shift();
                }
            } catch (err) {
                console.error('[unmergeSelectedFromStack] Failed to persist:', err);
                return;
            }

            // Remove unmerged images from the libraryStackContext so they
            // disappear from the stack view immediately.
            const unmergedSet = new Set(toUnmerge);
            const updatedStackContext = {
                ...libraryStackContext,
                imageIds: libraryStackContext.imageIds.filter(id => !unmergedSet.has(id)),
            };

            // Update in-memory state + clear selection
            const updatedImages = applyAnnotationsToImages(state.images, newAnnotations);
            const filteredResult = filterAndSort({ ...state, images: updatedImages, annotations: newAnnotations, libraryStackContext: updatedStackContext });
            const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

            set({
                ...filteredResult,
                ...availableFilters,
                images: updatedImages,
                annotations: newAnnotations,
                libraryStackContext: updatedStackContext,
                selectedImages: new Set(),
                undoAvailable: __undoStack.length > 0,
            });
        },

        /**
         * Undo the most recent merge by restoring the pre-merge annotation
         * snapshot.  Returns true if an undo was performed, false if the
         * undo stack is empty.
         */
        tryUndo: async (): Promise<boolean> => {
            if (!isAiFeaturesEnabled()) return false;
            const entry = __undoStack.pop();
            if (!entry) return false;

            const state = get();
            const { annotations } = state;

            // Build restored annotations from the snapshot
            const restoredAnnotations: ImageAnnotations[] = [];
            const newAnnotations = new Map(annotations);

            for (const snap of entry.previousAnnotations) {
                const existing = annotations.get(snap.imageId);
                if (!existing) continue;

                // Skip if nothing changed (shouldn't happen, but safe)
                if (
                    existing.stackGroupId === snap.stackGroupId &&
                    existing.similarityGroupId === snap.similarityGroupId &&
                    existing.isSimilarityAnalyzed === snap.isSimilarityAnalyzed
                ) continue;

                const restored: ImageAnnotations = {
                    ...existing,
                    stackGroupId: snap.stackGroupId,
                    similarityGroupId: snap.similarityGroupId,
                    isSimilarityAnalyzed: snap.isSimilarityAnalyzed,
                    updatedAt: Date.now(),
                };
                restoredAnnotations.push(restored);
                newAnnotations.set(snap.imageId, restored);
            }

            if (restoredAnnotations.length === 0) return false;

            // Persist the restored annotations
            try {
                const { bulkSaveAnnotations } = await import('../services/imageAnnotationsStorage');
                await bulkSaveAnnotations(restoredAnnotations);
            } catch (err) {
                console.error('[tryUndo] Failed to persist restored annotations:', err);
                // Put the entry back so the user can retry
                __undoStack.push(entry);
                return false;
            }

            // If we're inside a stack view, re-add restored images that now
            // belong to the stack (e.g. undoing an unmerge).
            let updatedStackContext = state.libraryStackContext;
            if (updatedStackContext) {
                // Collect the similarityGroupId(s) of images still in the stack
                const stackGroupIds = new Set<string>();
                for (const id of updatedStackContext.imageIds) {
                    const ann = newAnnotations.get(id);
                    if (ann?.similarityGroupId) stackGroupIds.add(ann.similarityGroupId);
                }
                // Re-add restored images whose group matches the stack's group
                const reAddIds = restoredAnnotations
                    .filter(a => a.similarityGroupId && stackGroupIds.has(a.similarityGroupId))
                    .map(a => a.imageId)
                    .filter(id => !updatedStackContext!.imageIds.includes(id));

                if (reAddIds.length > 0) {
                    updatedStackContext = {
                        ...updatedStackContext,
                        imageIds: [...updatedStackContext.imageIds, ...reAddIds],
                    };
                }
            }

            // Update in-memory state
            const updatedImages = applyAnnotationsToImages(state.images, newAnnotations);
            const filteredResult = filterAndSort({
                ...state,
                images: updatedImages,
                annotations: newAnnotations,
                libraryStackContext: updatedStackContext,
            });
            const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

            set({
                ...filteredResult,
                ...availableFilters,
                images: updatedImages,
                annotations: newAnnotations,
                libraryStackContext: updatedStackContext,
                undoAvailable: __undoStack.length > 0,
            });

            return true;
        },

        /**
         * Compute similarity-based groupings from existing exact-match stackGroupIds.
         *
         * INCREMENTAL MODE: When existing similarity groups are already present,
         * only the newly-assigned stackGroupIds are compared against existing
         * group representatives — avoiding a full O(n²) reclustering.
         *
         * FULL MODE (first run): When no similarity groups exist yet, delegates
         * to the engine for full token-bucketed Union-Find clustering.
         */
        computeSimilarityGroups: async () => {
            const state = get();
            const { images, annotations } = state;

            // Premium gate: similarity grouping is an AI feature — skip
            // BEFORE any progress reporting so non-premium users never see
            // a "Loading similarity engine..." flash for work that can't run.
            if (!isAiFeaturesEnabled()) {
                console.log('[SimilarityGroups] Premium not enabled — skipping similarity computation');
                return;
            }

            // Prevent concurrent runs (module-level guard — survives state updates)
            if (__similaritySyncInProgress) {
                __similaritySyncQueued = true;
                return;
            }

            // Guard: do not run before annotations are loaded from IndexedDB.
            // Prevents the same race described in syncNewImagesToStacks.
            if (!state.isAnnotationsLoaded) {
                console.log('[SimilarityGroups] Annotations not yet loaded — deferring');
                return;
            }

            __similaritySyncInProgress = true;

            const reportProgress = (current: number, total: number, message: string) => {
                get().setSimilarityGroupProgress({ current, total, message });
            };

            try {
                reportProgress(0, 1, 'Loading similarity engine...');

                const { createStackingEngine } = await import('../services/aiBridge');
                const engine = await createStackingEngine();
                if (!engine) {
                    console.log('[Stacks] AI intelligence not available — skipping similarity computation');
                    return;
                }

                const { bulkSaveAnnotations } = await import('../services/imageAnnotationsStorage');

                let currentAnnotations = new Map(annotations);

                // ── Step 0: Ensure all images have stackGroupId ──────────
                // Also tracks which stackGroupIds need similarity assignment
                // (images with stackGroupId but no similarityGroupId yet).
                reportProgress(0, images.length, 'Assigning prompt IDs...');
                const missingStackIds: ImageAnnotations[] = [];
                const newStackGroupIds = new Set<string>();
                for (const img of images) {
                    const ann = currentAnnotations.get(img.id);

                    // ── Guard: respect intentional unmerging ─────────────────
                    // When a user manually unmerges an image via
                    // unmergeSelectedFromStack, stackGroupId is set to undefined
                    // but isStackAnalyzed remains true. This signals "this image
                    // was intentionally removed from its stack — do NOT re-assign
                    // it automatically."  Without this guard, computeSimilarityGroups
                    // would re-assign the same prompt-hash-based stackGroupId,
                    // silently undoing the user's manual unmerge.
                    if (ann?.isStackAnalyzed && !ann?.stackGroupId) {
                        // Intentionally unstacked — skip this image entirely.
                        continue;
                    }

                    if (!ann?.stackGroupId) {
                        // Image was never analyzed — assign stackGroupId now
                        const prompt = img.prompt
                            || img.metadata?.normalizedMetadata?.prompt
                            || img.metadata?.positive_prompt;
                        const stackGroupId = prompt && prompt.trim()
                            ? engine.generatePromptHash(prompt)
                            : undefined;

                        const updated: ImageAnnotations = {
                            imageId: img.id,
                            isFavorite: ann?.isFavorite ?? false,
                            tags: ann?.tags ?? [],
                            autoTags: ann?.autoTags ?? [],
                            metadataTags: ann?.metadataTags ?? [],
                            isAutoTagged: ann?.isAutoTagged,
                            stackGroupId,
                            similarityGroupId: ann?.similarityGroupId,
                            isStackAnalyzed: true,
                            addedAt: ann?.addedAt ?? Date.now(),
                            updatedAt: Date.now(),
                        };
                        missingStackIds.push(updated);
                        currentAnnotations.set(img.id, updated);
                        if (stackGroupId) {
                            if (!ann?.similarityGroupId) {
                                newStackGroupIds.add(stackGroupId);
                            }
                        }
                    } else if (ann.stackGroupId && !ann.similarityGroupId) {
                        // Image has exact-match group but was never similarity-merged.
                        // This happens when syncNewImagesToStacks already ran and
                        // assigned stackGroupId, but computeSimilarityGroups was
                        // deferred — the image needs incremental matching now.
                        newStackGroupIds.add(ann.stackGroupId);
                    }
                }

                if (missingStackIds.length > 0) {
                    console.log(`[SimilarityGroups] Assigned stackGroupId to ${missingStackIds.length} images that were missing it`);
                    await bulkSaveAnnotations(missingStackIds);

                    const currentImages = get().images;
                    const currentState = get();
                    const imagesWithAnnotations = applyAnnotationsToImages(currentImages, currentAnnotations);
                    const filteredResult = filterAndSort({ ...currentState, images: imagesWithAnnotations, annotations: currentAnnotations });
                    const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

                    set({
                        ...filteredResult,
                        ...availableFilters,
                        images: imagesWithAnnotations,
                        annotations: currentAnnotations,
                    });
                }

                if (newStackGroupIds.size === 0) {
                    return;
                }

                // ── Step 1: Build existing similarity group map ──────────
                // existingSimGroups: similarityGroupId → all distinct prompts
                // Using ALL prompts per group (not just one representative)
                // ensures new prompts match reliably even when groups contain
                // diverse prompt variations.
                const existingSimGroups = new Map<string, Set<string>>();
                for (const img of images) {
                    const ann = currentAnnotations.get(img.id);
                    const simId = ann?.similarityGroupId;
                    if (!simId) continue;

                    let prompts = existingSimGroups.get(simId);
                    if (!prompts) {
                        prompts = new Set();
                        existingSimGroups.set(simId, prompts);
                    }

                    const prompt = img.prompt
                        || img.metadata?.normalizedMetadata?.prompt
                        || img.metadata?.positive_prompt;
                    if (prompt && prompt.trim()) {
                        prompts.add(prompt.trim());
                    }
                }

                // ── Step 2: Build new group entries ──────────────────────
                const newEntries: Array<{ groupId: string; prompt: string }> = [];
                for (const img of images) {
                    const ann = currentAnnotations.get(img.id);
                    const sgId = ann?.stackGroupId;
                    if (!sgId || !newStackGroupIds.has(sgId) || newEntries.some(e => e.groupId === sgId)) continue;

                    const prompt = img.prompt
                        || img.metadata?.normalizedMetadata?.prompt
                        || img.metadata?.positive_prompt;
                    if (prompt && prompt.trim()) {
                        newEntries.push({ groupId: sgId, prompt });
                    }
                }

                console.log(`[SimilarityGroups] ${newEntries.length} new prompt groups, ${existingSimGroups.size} existing similarity groups`);

                // ── Step 3: Assign similarityGroupIds ────────────────────
                let groupIdToSimId: Map<string, string>;

                if (existingSimGroups.size === 0) {
                    // First run — full clustering of all groups
                    const allGroups = new Map<string, string>();
                    for (const img of images) {
                        const ann = currentAnnotations.get(img.id);
                        const sgId = ann?.stackGroupId;
                        if (!sgId || allGroups.has(sgId)) continue;
                        const prompt = img.prompt
                            || img.metadata?.normalizedMetadata?.prompt
                            || img.metadata?.positive_prompt;
                        if (prompt && prompt.trim()) {
                            allGroups.set(sgId, prompt);
                        }
                    }

                    if (allGroups.size <= 1) {
                        groupIdToSimId = new Map<string, string>();
                        if (allGroups.size === 1) {
                            const [sgId] = allGroups.keys();
                            groupIdToSimId.set(sgId, sgId);
                        }
                    } else {
                        const result = await engine.computeSimilarityGroupIds({
                            groups: Array.from(allGroups.entries()).map(([groupId, prompt]) => ({ groupId, prompt })),
                            threshold: 0.85,
                            onProgress: reportProgress,
                        });
                        groupIdToSimId = result.groupIdToSimId;
                    }
                } else {
                    // Incremental — compare new prompts against ALL prompts in
                    // each existing similarity group (not just one representative).
                    groupIdToSimId = new Map<string, string>();

                    // Pre-index new entries by groupId — the per-pair `.find`
                    // made this loop O(n²); a Map lookup keeps it O(n).
                    const newEntriesById = new Map(newEntries.map(e => [e.groupId, e] as const));

                    // Yield to the event loop every 50 pairs — synchronous
                    // similarity math over a large library visibly froze the UI.
                    let pairsSinceYield = 0;
                    for (const entry of newEntries) {
                        let bestMatch: string | null = null;
                        let bestScore = 0;

                        // Check against ALL prompts in each existing similarity group
                        for (const [simId, prompts] of existingSimGroups) {
                            for (const groupPrompt of prompts) {
                                const score = engine.computePromptSimilarity(entry.prompt, groupPrompt);
                                if (score >= 0.85 && score > bestScore) {
                                    bestScore = score;
                                    bestMatch = simId;
                                }
                                if (++pairsSinceYield % 50 === 0) {
                                    await new Promise(r => setTimeout(r, 0));
                                }
                            }
                        }

                        // Also check against other new entries (already-processed ones)
                        for (const [sgId, simId] of groupIdToSimId) {
                            const otherEntry = newEntriesById.get(sgId);
                            if (!otherEntry) continue;
                            const score = engine.computePromptSimilarity(entry.prompt, otherEntry.prompt);
                            if (score >= 0.85 && score > bestScore) {
                                bestScore = score;
                                bestMatch = simId;
                            }
                            if (++pairsSinceYield % 50 === 0) {
                                await new Promise(r => setTimeout(r, 0));
                            }
                        }

                        groupIdToSimId.set(entry.groupId, bestMatch || entry.groupId);
                    }
                }

                // ── Step 4: Seed existing mappings so they pass through unchanged ──
                // Without this, existing stackGroupIds not in groupIdToSimId would
                // fall back to their own stackGroupId, ejecting them from their
                // similarity groups.
                for (const [imageId, annotation] of currentAnnotations) {
                    const sgId = annotation.stackGroupId;
                    if (!sgId || groupIdToSimId.has(sgId)) continue;
                    // Preserve the existing similarityGroupId mapping for unchanged groups
                    const existingSimId = annotation.similarityGroupId || sgId;
                    groupIdToSimId.set(sgId, existingSimId);
                }

                // ── Step 5: Apply results to annotations ─────────────────
                reportProgress(0, 1, 'Saving similarity groups...');
                const now = Date.now();
                const updatedAnnotations: ImageAnnotations[] = [];

                for (const [imageId, annotation] of currentAnnotations) {
                    const sgId = annotation.stackGroupId;
                    
                    // Prevent silent unstacking of manually merged images.
                    // If an image has no stackGroupId (e.g. manually unstacked),
                    // the clustering engine should not forcefully remove its similarityGroupId.
                    if (!sgId) continue;

                    const simId = groupIdToSimId.get(sgId);
                    const targetId = simId || sgId;

                    if (annotation.similarityGroupId !== targetId || !annotation.isSimilarityAnalyzed) {
                        const updated = { ...annotation, similarityGroupId: targetId, isSimilarityAnalyzed: true, updatedAt: now };
                        updatedAnnotations.push(updated);
                    }
                }

                if (updatedAnnotations.length > 0) {
                    await bulkSaveAnnotations(updatedAnnotations);

                    // Fetch the freshest state to prevent overwriting concurrent user actions
                    const currentState = get();
                    const freshAnnotations = new Map(currentState.annotations);
                    
                    // Apply ONLY our specific updates to the fresh state
                    for (const updated of updatedAnnotations) {
                        // Merge with the freshest version of the annotation
                        const current = freshAnnotations.get(updated.imageId) || updated;
                        freshAnnotations.set(updated.imageId, { ...current, similarityGroupId: updated.similarityGroupId, isSimilarityAnalyzed: updated.isSimilarityAnalyzed, updatedAt: now });
                    }

                    const imagesWithAnnotations = applyAnnotationsToImages(currentState.images, freshAnnotations);
                    const filteredResult = filterAndSort({ ...currentState, images: imagesWithAnnotations, annotations: freshAnnotations });
                    const availableFilters = recalculateAvailableFilters(filteredResult.filteredImages);

                    set({
                        ...filteredResult,
                        ...availableFilters,
                        images: imagesWithAnnotations,
                        annotations: freshAnnotations,
                    });

                    console.log(`Similarity groups updated: ${newEntries.length} new prompts → ${updatedAnnotations.length} annotations changed`);
                }
            } catch (error) {
                console.error('Failed to compute similarity groups:', error);
                reportProgress(0, 0, 'Similarity grouping failed');
            } finally {
                __similaritySyncInProgress = false;
                if (__similaritySyncQueued) {
                    __similaritySyncQueued = false;
                    console.log('[SimilarityGroups] Running queued similarity computation');
                    setTimeout(() => get().computeSimilarityGroups(), 100);
                }
                // Clear progress after a short delay so the user sees completion
                setTimeout(() => get().setSimilarityGroupProgress(null), 1500);
            }
        },

        /**
         * Unified post-indexing pipeline coordinator — a thin queue wrapper
         * around the raw `runPipelineRound()` (module level, above).
         *
         * Runs processing phases SEQUENTIALLY for images that need them:
         *   1. Stacking (exact prompt hashing → stackGroupId)
         *   2. Similarity grouping (semantic clustering → similarityGroupId)
         *   3. Auto-tagging (AI enrichment, library scope)
         *   4. Semantic search indexing (textHash Δ → semanticVectors)
         *
         * Called from:
         *   - App.tsx on startup (when annotations loaded + indexing idle)
         *   - useImageLoader.ts after file watcher detects new images
         *
         * Serialization: the global processingQueue runs ONE job at a time,
         * FIFO — no more module-level flags + 500 ms setTimeout replays.
         * Rapid calls coalesce while a round is PENDING, but a call arriving
         * while a round RUNS is appended, so freshly added images always get
         * their own pass.
         *
         * ⚠️ Never `await` this from INSIDE a queued job — FIFO would
         * deadlock. Queued jobs call the raw `runPipelineRound()` instead.
         */
        processPostIndexingPipeline: () =>
            processingQueue.enqueueOnce('pipeline', runPipelineRound, { label: 'post-indexing pipeline' }),

        // ── Semantic Search Actions (Phase 5) ─────────────────────────

        setSemanticMode: (mode) => {
            // Turning OFF must invalidate the semantic pipeline. A search
            // fired while ON (300 ms debounce + WebGPU inference can take
            // seconds) must not land after the toggle: without the cancel +
            // seq bump it resurrects hits and the relevance sort under a
            // gray sparkle, and the next ON instantly merges those stale
            // hits before the fresh search lands. clearSemanticSearch drops
            // hits + restores the durable sort — re-enabling re-runs the
            // query, so nothing is lost.
            if (mode === 'off' && get().semanticMode === 'semantic') {
                get().clearSemanticSearch();
            }
            set(state => ({
                ...filterAndSort({ ...state, semanticMode: mode }),
                semanticMode: mode,
                ...(mode === 'off' && state.sortOrder === 'relevance'
                    ? { sortOrder: useSettingsStore.getState().sortOrder || 'date-desc' }
                    : {}),
            }));
            // Phase 6: re-run the current query in the new mode so results
            // reflect the switched ranking ('semantic' replaces the keyword
            // filter entirely). Debounced + seq-guarded; no-op when 'off' or
            // no query.
            if (mode === 'semantic') {
                const query = get().searchQuery;
                if (query && query.trim()) {
                    void get().runSemanticSearch(query);
                }
            }
        },

        /**
         * Debounced semantic query (§8.1). The 300ms window coalesces
         * keystrokes so the worker only sees the settled query; the
         * coordinator's latest-query-wins (§5.1) backs it up when searches
         * do overlap. Results from a superseded search are discarded via
         * the __semanticSearchSeq guard.
         */
        runSemanticSearch: async (query) => {
            if (__semanticSearchTimer) {
                clearTimeout(__semanticSearchTimer);
                __semanticSearchTimer = null;
            }

            const trimmed = (query ?? '').trim();
            if (!trimmed) {
                get().clearSemanticSearch();
                return;
            }

            if (!isSemanticSearchEnabled()) {
                set({ semanticHits: null, semanticSearchStatus: 'unavailable', semanticLastError: null });
                return;
            }

            const seq = ++__semanticSearchSeq;
            set({ semanticSearchStatus: 'loading' });

            __semanticSearchTimer = setTimeout(async () => {
                __semanticSearchTimer = null;
                try {
                    const coordinator = await getSemanticCoordinator();
                    const hits = await coordinator.search(trimmed);
                    if (seq !== __semanticSearchSeq) return; // superseded by a newer query
                    const state = get();
                    set({
                        semanticHits: hits,
                        semanticSearchStatus: 'ready',
                        semanticLastError: null,
                        // Semantic results default to relevance order — the
                        // sort box shows "Relevance" while they're on screen.
                        sortOrder: 'relevance',
                        ...filterAndSort({ ...state, semanticHits: hits, sortOrder: 'relevance' }),
                    });
                } catch (error) {
                    if (seq !== __semanticSearchSeq) return;
                    console.error('Semantic search failed:', error);
                    set({
                        semanticHits: null,
                        semanticSearchStatus: 'error',
                        semanticLastError: error instanceof Error ? error.message : String(error),
                    });
                }
            }, SEMANTIC_SEARCH_DEBOUNCE_MS);
        },

        /** Clear hits + pending work; restores the normal (keyword/sort) flow. */
        clearSemanticSearch: () => {
            if (__semanticSearchTimer) {
                clearTimeout(__semanticSearchTimer);
                __semanticSearchTimer = null;
            }
            __semanticSearchSeq++; // invalidate any in-flight search
            set(state => ({
                ...filterAndSort({ ...state, semanticHits: null }),
                semanticHits: null,
                semanticSearchStatus: 'idle',
                semanticLastError: null,
                // 'relevance' exists only while semantic hits are on screen;
                // restore the user's durable sort (last persisted choice)
                // when the search ends or the mode turns off.
                ...(state.sortOrder === 'relevance'
                    ? { sortOrder: useSettingsStore.getState().sortOrder || 'date-desc' }
                    : {}),
            }));
        },

        /**
         * Queue-wrapped semantic indexing (§8.3 — pipeline phase, Settings →
         * Re-index, tag edits). Serialized app-wide by processingQueue:
         * pending duplicates coalesce by key; a run in flight does NOT
         * swallow a new request (the queue appends it after).
         *
         * ⚠️ NEVER await this from inside a queued job (FIFO deadlock) — call
         * the raw `runSemanticIndexNow` implementation instead.
         *
         * `options.force` (Settings → Re-index): wipes the index first, so
         * the Δ run becomes a full re-embed.
         */
        semanticIndexImages: (options?: { force?: boolean }) => {
            if (options?.force) {
                // Survives coalescing into a pending non-force job: the run
                // must also clear the index or the rebuild silently degrades
                // to a Δ run.
                __semanticIndexQueuedForce = true;
            }
            return processingQueue.enqueueOnce('semantic', () => runSemanticIndexNow(options), { label: 'semantic indexing' });
        },

        /**
         * Cancel an in-flight semantic indexing run (Footer × button): clears
         * the progress bar immediately, drops a queued replay, and asks the
         * coordinator to abort — it stops sending new embed batches, persists
         * the completed ones, and rejects the run (swallowed as a cancel by
         * semanticIndexImages).
         */
        cancelSemanticIndexing: () => {
            set({ semanticIndexProgress: null });
            __semanticIndexQueuedForce = false;
            processingQueue.dropQueued('semantic');
            __semanticCoordinator?.cancelIndexing();
        },

        /**
         * Settings → AI Intelligence embedding-model switch: persist the new
         * model, stop any in-flight run, release the worker, and force a full
         * re-index. The engine is a per-worker singleton — it loads once from
         * the first init's model id and cannot reload a different record
         * (web-llm has no per-record load-without-unload) — so the worker must
         * be recreated. The coordinator's model-aware Δ then re-embeds every
         * image because the stored records' modelId/dimension no longer match
         * the new target. The re-index runs through the normal progress-bar +
         * cancel path.
         */
        applySemanticEmbeddingModel: async (modelId: string) => {
            useSettingsStore.getState().setAiEmbeddingModel(modelId);
            // Cancel BEFORE dispose: dispose rejects pending embeds as a plain
            // error (would surface as semanticLastError), while cancelIndexing
            // rejects with the swallowed SEMANTIC_INDEX_CANCELLED path.
            get().cancelSemanticIndexing();
            __semanticCoordinator?.dispose();
            __semanticCoordinator = null;
            await get().semanticIndexImages({ force: true });
        },

        setSemanticIndexProgress: (progress) => set({ semanticIndexProgress: progress }),
        setSemanticModelsStatus: (status) => {
            __semanticModelsStatus = status;
            recomputeAiModelsLoaded();
        },
        setAutoTagModelsStatus: (status) => {
            __autoTagModelsStatus = status;
            recomputeAiModelsLoaded();
        },
        unloadAiModels: async () => {
            // Stop an in-flight auto-tag run first — the resident worker holds
            // its own engine, so terminating it frees that context too.
            const { autoTaggingWorker } = get();
            if (autoTaggingWorker) {
                autoTaggingWorker.terminate();
                set({ autoTaggingWorker: null, autoTagWorkerModelId: null, isAutoTagging: false, autoTaggingProgress: null });
                __autoTagModelsStatus = null;
                recomputeAiModelsLoaded();
            }
            // The long-lived semantic worker: the coordinator terminates it
            // (releasing the WebGPU device) and resets ready state — the next
            // semantic use reloads lazily and re-restores the persisted index.
            if (__semanticCoordinator) {
                try {
                    await __semanticCoordinator.unloadModels();
                } catch (error) {
                    console.warn('Failed to unload AI models:', error);
                }
            }
        },
        setDetectedGpuInfo: (info) => {
            // WebGPU adapter.info exposes vendor/device as opaque ids that
            // some drivers leave empty — a blank report is worse than none
            // (it would flip the readout to "not reported yet"), so ignore
            // it and keep the previous value. null still clears (reset).
            if (info && (!info.vendor || !info.device)) return;
            try {
                if (info) {
                    localStorage.setItem(DETECTED_GPU_STORAGE_KEY, JSON.stringify(info));
                } else {
                    localStorage.removeItem(DETECTED_GPU_STORAGE_KEY);
                }
            } catch (error) {
                console.warn('Failed to persist detected GPU info:', error);
            }
            set({ detectedGpuInfo: info });
        },
        setDetectedGpuDevices: (devices) => {
            // Skip the write when nothing changed — the startup re-fetch runs
            // on every launch, so an unchanged list would otherwise re-persist
            // (and re-render) pointlessly.
            const current = get().detectedGpuDevices;
            const unchanged =
                current.length === devices.length &&
                current.every((d, i) => JSON.stringify(d) === JSON.stringify(devices[i]));
            if (unchanged) return;
            try {
                localStorage.setItem(DETECTED_GPUS_STORAGE_KEY, JSON.stringify(devices));
            } catch (error) {
                console.warn('Failed to persist detected GPU devices:', error);
            }
            set({ detectedGpuDevices: devices });
        },

        /**
         * Internal helper — delegates to the engine for hybrid similarity
         * scoring between two prompts. Used by the incremental clustering path.
         */
    };
});

// Sync sort order from settings changes (e.g. rehydration or settings UI).
// 'relevance' is semantic-session-only state (never persisted) — it must
// NOT be clobbered while a semantic search's hits are on screen; the
// durable settings sort resumes via clearSemanticSearch's restore.
useSettingsStore.subscribe((state) => {
    const currentSortOrder = useImageStore.getState().sortOrder;
    if (currentSortOrder === 'relevance') return;
    if (state.sortOrder && state.sortOrder !== currentSortOrder) {
        useImageStore.getState().setSortOrder(state.sortOrder);
    }
});

// Sync stacking enabled from settings changes (e.g. rehydration on app restart)
let prevStackingEnabled: boolean | undefined = undefined;
useSettingsStore.subscribe((state) => {
    if (typeof state.isStackingEnabled === 'boolean' && state.isStackingEnabled !== prevStackingEnabled) {
        prevStackingEnabled = state.isStackingEnabled;
        const imageState = useImageStore.getState();
        if (state.isStackingEnabled !== imageState.isStackingEnabled) {
            imageState.setStackingEnabled(state.isStackingEnabled);
        }
    }
});

// Sync semantic search from settings changes (e.g. rehydration on app
// restart). The effective gate is the user pref AND premium (license ∧
// module), and either side can flip independently — react to both so the
// feature clears when disabled AND kicks off Δ-indexing the moment it
// becomes usable (the post-indexing pipeline may have already run without
// the premium phases).
let prevSemanticSearchEnabled: boolean | undefined = undefined;
let prevSemanticSearchUsable: boolean | undefined = undefined;
useSettingsStore.subscribe((state) => {
    if (typeof state.isSemanticSearchEnabled === 'boolean' && state.isSemanticSearchEnabled !== prevSemanticSearchEnabled) {
        prevSemanticSearchEnabled = state.isSemanticSearchEnabled;
        if (state.isSemanticSearchEnabled) {
            // Just toggled on — Δ-index now. Idempotent (textHash Δ) and
            // premium-gated inside, so a no-op without a license.
            useImageStore.getState().semanticIndexImages();
        } else {
            useImageStore.getState().clearSemanticSearch();
        }
    }
    const usable = isAiFeaturesEnabled();
    if (usable !== prevSemanticSearchUsable) {
        prevSemanticSearchUsable = usable;
        if (usable) {
            if (useSettingsStore.getState().isSemanticSearchEnabled) {
                // License/module arrived while the pref was on — index now.
                useImageStore.getState().semanticIndexImages();
            }
        } else {
            // Premium lost (revoked license, missing module) — drop hits.
            useImageStore.getState().clearSemanticSearch();
        }
    }
});

