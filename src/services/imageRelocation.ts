/// <reference lib="dom" />

/**
 * Image relocation — preserve derived data across in-app moves and renames.
 *
 * Image identity is path-derived (`{directoryId}::{relativePath}`), so a move
 * changes an image's id and every derived record keyed by it. The watcher
 * compound that by reporting a move as `unlink(old)` + `add(new)`: the delete
 * path (clearAnnotationsForRemovedImages) destroys the annotation + vectors,
 * and the add path re-extracts/re-tags/re-embeds the file from scratch.
 *
 * The fix is RE-KEYING, not refusing-to-delete: immediately after the FS
 * operation the app copies each derived record from the old id to the new one.
 * The existing delete paths then find nothing to destroy, and the pipeline
 * gates (`searchTagVersion`, `isSemanticIndexed`) make every phase skip the
 * image. Real deletions keep their protection because
 * `clearAnnotationsForRemovedImages` is untouched.
 *
 * This module owns the renderer-side pieces that are not part of the store:
 *   - the pure old→new move builder (cache ids, ids, names),
 *   - the drag payload builder every draggable surface shares,
 *   - the short-lived relocation registry the rescan/watcher paths consult,
 *   - the semantic + prompt vector IDB re-key,
 *   - the thin wrapper over the main-process `relocate-derived-files` IPC
 *     (thumbnails + metadata-cache records).
 *
 * The orchestration that needs store state (annotations map, selection,
 * semantic coordinator) lives in the `relocateImages` store action.
 */

import type {
  Directory,
  ImageRelocationMove,
  IndexedImage,
  RelocateDerivedFilesResult,
} from '../types';
import { normalizePath, getImageAbsolutePath, joinPathPreservingCase } from '../utils/pathUtils';
import { getIsPersistenceDisabled, openDatabase } from './indexedDb';

/** The slice of a drag payload the builder needs (see buildDragPayload). */
export interface DraggedItemRef {
  sourcePath: string;
  name: string;
  /** Path-derived image id, when the drag originated from a loaded image. */
  id?: string;
  /** Directory id (== root path) the dragged image belongs to. */
  directoryId?: string;
}

/** A store image resolved to everything a relocation needs. */
export interface RelocationSource {
  id: string;
  directoryId: string;
  name: string;
  absolutePath: string;
  lastModified: number;
}

export interface BuildRelocationMovesInput {
  results: Array<{ sourcePath: string; targetPath?: string; success: boolean }>;
  /** Directory id of the drop target's ROOT (all ids are root-relative). */
  targetRootId: string;
  targetRootName?: string;
  sources: RelocationSource[];
  /** scanSubfolders per root, keyed by normalizePath(rootId). */
  scanSubfoldersByRoot: Map<string, boolean>;
}

/** Same literal every cache writer uses (cacheManager + getCachedData). */
export function buildCacheId(rootPath: string, scanSubfolders: boolean): string {
  return `${rootPath}-${scanSubfolders ? 'recursive' : 'flat'}`;
}

/**
 * Root-relative path of `absPath` under `rootPath`, preserving the original
 * casing of `absPath` (the annotation store is keyed by the exact id string;
 * `normalizePath` lowercasing is only used for the prefix comparison). Falls
 * back to the basename when the file is not under the root.
 */
export function relativePathPreservingCase(rootPath: string, absPath: string): string {
  const absFwd = (absPath || '').replace(/\\/g, '/');
  const rootNorm = normalizePath(rootPath);
  const absNorm = normalizePath(absPath);
  if (rootNorm && absNorm.startsWith(`${rootNorm}/`)) {
    // normalizePath preserves length (separator swap + lowercase + one
    // trailing-slash strip), so the normalized prefix length maps 1:1 onto
    // the original string.
    return absFwd.slice(rootNorm.length + 1);
  }
  return absFwd.split('/').pop() || absFwd;
}

/** The single-item payload shape, shared by the selection and lone-image cases. */
function draggedRefFor(image: IndexedImage): DraggedItemRef {
  // `id` is `${directoryId}::${relativePath}`, so the tail is the path relative
  // to the directory root. `name` may itself carry a relative path (recursive
  // scans fold it in), so it is the fallback rather than the source of truth.
  const [, relativeFromId] = image.id.split('::');
  const relativePath = relativeFromId || image.name;
  // `directoryId` is the directory's PATH (see useImageLoader: "Use path as a
  // unique ID"), and the relative tail always uses `/`-or-`\` separators — the
  // join keeps the root's own style so the result is a real path on Windows,
  // macOS and Linux alike (it goes straight to the OS drag and to fs moves).
  const sourcePath = image.directoryId
    ? joinPathPreservingCase(image.directoryId, relativePath)
    : image.id.includes('::')
      ? image.id.split('::')[1]
      : image.id;
  return {
    // id + directoryId resolve the store image EXACTLY on drop
    // (relocation source resolution; path matching is the fallback).
    id: image.id,
    directoryId: image.directoryId,
    sourcePath,
    name: image.name,
  };
}

/**
 * Build the drag payload for `targetImage`: the whole selection when the
 * dragged image is part of it, otherwise just that image.
 *
 * Every draggable surface (grid card, table row, stack expanded view) builds
 * its payload through here. The selection rule is what makes a drag of one
 * selected image move the entire selection, and it has to be identical
 * everywhere — the payload is consumed by the native OS drag, by the
 * folder-drop move, and by the relocation re-key.
 */
export function buildDragPayload(
  targetImage: IndexedImage,
  images: IndexedImage[],
  selectedImages: ReadonlySet<string>,
): DraggedItemRef[] {
  if (selectedImages.has(targetImage.id)) {
    const selectedItems = images.filter((image) => selectedImages.has(image.id));
    // An empty result means every selected id is outside the loaded list —
    // fall through to the lone image rather than starting an empty drag.
    if (selectedItems.length > 0) return selectedItems.map(draggedRefFor);
  }
  return [draggedRefFor(targetImage)];
}

/**
 * Resolve drag-payload items to store images and their absolute paths.
 * Items without a store image (external Explorer drops) are skipped — they
 * have nothing to preserve.
 */
export function collectRelocationSources(
  dragged: DraggedItemRef[],
  images: IndexedImage[],
  directories: Directory[],
): RelocationSource[] {
  const imagesById = new Map<string, IndexedImage>();
  const imagesByPath = new Map<string, IndexedImage>();
  const dirPathById = new Map<string, string>();
  for (const dir of directories) dirPathById.set(dir.id, dir.path);
  for (const img of images) {
    imagesById.set(img.id.toLowerCase(), img);
    const abs = getImageAbsolutePath(img, dirPathById.get(img.directoryId || ''));
    if (abs) imagesByPath.set(normalizePath(abs), img);
  }

  const seen = new Set<string>();
  const sources: RelocationSource[] = [];
  for (const item of dragged) {
    let image = item.id ? imagesById.get(item.id.toLowerCase()) : undefined;
    if (!image && item.sourcePath) {
      image = imagesByPath.get(normalizePath(item.sourcePath));
    }
    if (!image || seen.has(image.id.toLowerCase())) continue;
    const absolutePath = getImageAbsolutePath(image, dirPathById.get(image.directoryId || ''));
    if (!absolutePath) continue;
    seen.add(image.id.toLowerCase());
    sources.push({
      id: image.id,
      directoryId: image.directoryId || '',
      name: image.name,
      absolutePath,
      lastModified: image.lastModified,
    });
  }
  return sources;
}

/**
 * Pure builder: pair each successful move result with its store source and
 * produce the old→new relocation. Skips files with no store image (external
 * drops) and no-op moves (same normalized path).
 */
export function buildRelocationMoves(
  input: BuildRelocationMovesInput,
): ImageRelocationMove[] {
  const { results, targetRootId, targetRootName, sources, scanSubfoldersByRoot } = input;
  const byPath = new Map<string, RelocationSource>();
  for (const source of sources) {
    byPath.set(normalizePath(source.absolutePath), source);
  }

  const seen = new Set<string>();
  const moves: ImageRelocationMove[] = [];
  for (const result of results) {
    if (!result.success || !result.targetPath) continue;
    const source = byPath.get(normalizePath(result.sourcePath));
    if (!source) continue;
    if (normalizePath(result.sourcePath) === normalizePath(result.targetPath)) continue;
    if (seen.has(source.id.toLowerCase())) continue;
    seen.add(source.id.toLowerCase());

    const newName = relativePathPreservingCase(targetRootId, result.targetPath);
    const newImageId = `${targetRootId}::${newName}`;
    const sourceScan = scanSubfoldersByRoot.get(normalizePath(source.directoryId));
    const targetScan = scanSubfoldersByRoot.get(normalizePath(targetRootId));

    moves.push({
      oldImageId: source.id,
      newImageId,
      oldName: source.name,
      newName,
      oldAbsolutePath: source.absolutePath,
      newAbsolutePath: result.targetPath,
      oldLastModified: source.lastModified,
      // Pre-IPC placeholder; the main process overwrites it from the moved
      // file's stat (EXDEV copy+delete resets birthtime, which the whole
      // thumbnail-key + cache-diff machinery is sensitive to).
      newLastModified: source.lastModified,
      targetRootId,
      targetRootName,
      sourceCacheId: sourceScan === undefined
        ? undefined
        : buildCacheId(source.directoryId, sourceScan),
      targetCacheId: targetScan === undefined
        ? undefined
        : buildCacheId(targetRootId, targetScan),
    });
  }
  return moves;
}

// ── Relocation registry ────────────────────────────────────────────────────
//
// The watcher fires `unlink(old)` + `add(new)` for every move (chokidar has no
// rename correlation), ~2.5s after the FS operation. The re-key itself is
// milliseconds, after which the delete paths are harmless no-ops — but the
// registry makes the outcome deterministic regardless of timing: while an
// entry is tracked, the rescan + watcher paths skip both the old path and the
// new id. Entries live for a short window and are swept lazily.

const PENDING_TTL_MS = 60_000;
const RECENT_TTL_MS = 60_000;

interface TrackedRelocation {
  move: ImageRelocationMove;
  expiresAt: number;
}

/** Keyed by normalizePath(oldAbsolutePath). */
const trackedRelocations = new Map<string, TrackedRelocation>();

function sweepRelocations(now: number): void {
  for (const [key, entry] of trackedRelocations) {
    if (entry.expiresAt <= now) trackedRelocations.delete(key);
  }
}

/** Mark a batch as in-flight (called synchronously before the first await). */
export function beginRelocation(moves: ImageRelocationMove[]): void {
  const now = Date.now();
  sweepRelocations(now);
  for (const move of moves) {
    trackedRelocations.set(normalizePath(move.oldAbsolutePath), {
      move,
      expiresAt: now + PENDING_TTL_MS,
    });
  }
}

/** Move a batch from in-flight to recently-relocated after the re-key completes. */
export function endRelocation(moves: ImageRelocationMove[]): void {
  const now = Date.now();
  for (const move of moves) {
    const key = normalizePath(move.oldAbsolutePath);
    if (trackedRelocations.has(key)) {
      trackedRelocations.set(key, { move, expiresAt: now + RECENT_TTL_MS });
    }
  }
  sweepRelocations(now);
}

/**
 * True when `path` is the source OR destination of an in-flight/recent
 * relocation. Used to make the watcher's delete path and the rescan's
 * scope-deletion skip files that were relocated, not removed.
 */
export function isRelocatedPath(path: string): boolean {
  if (trackedRelocations.size === 0) return false;
  const now = Date.now();
  sweepRelocations(now);
  const normalized = normalizePath(path);
  for (const entry of trackedRelocations.values()) {
    if (
      normalizePath(entry.move.oldAbsolutePath) === normalized ||
      normalizePath(entry.move.newAbsolutePath) === normalized
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when `id` is the NEW id of an in-flight/recent relocation. Used to
 * protect the relocated store entry from the rescan's "changed files" removal
 * and the watcher's force-reindex stale-drop.
 */
export function isRelocatedTargetId(id: string): boolean {
  if (trackedRelocations.size === 0) return false;
  sweepRelocations(Date.now());
  const normalized = id.toLowerCase();
  for (const entry of trackedRelocations.values()) {
    if (entry.move.newImageId.toLowerCase() === normalized) return true;
  }
  return false;
}

/** Drop relocated target ids from a removal candidate list. */
export function filterRelocatedTargetIds(ids: string[]): string[] {
  if (trackedRelocations.size === 0) return ids;
  return ids.filter((id) => !isRelocatedTargetId(id));
}

/** Test hook — the registry is module-level state shared across tests. */
export function resetRelocationRegistryForTests(): void {
  trackedRelocations.clear();
}

// ── Vector re-key (IndexedDB) ──────────────────────────────────────────────

/** Wall-clock budget per transaction chunk; keeps the UI thread breathing. */
const VECTOR_REKEY_CHUNK = 50;

/**
 * Copy the semantic + prompt vector records from the old imageId to the new
 * one, then delete the old records. Same DB the ai-intelligence module writes
 * to (`image-metahub-preferences`); the module's WORKER HEAP is refreshed
 * separately (see the store action) — a bare DB write would leave the worker
 * holding the old id and Δ-skipping the record forever.
 *
 * Best-effort: a closed/missing DB logs and returns; the annotation re-key is
 * what the pipeline gates depend on.
 */
export async function rekeyImageVectors(moves: ImageRelocationMove[]): Promise<number> {
  if (moves.length === 0 || getIsPersistenceDisabled()) return 0;

  const db = await openDatabase();
  if (!db) return 0;

  const stores = ['semanticVectors', 'promptVectors'].filter((name) =>
    db.objectStoreNames.contains(name),
  );
  if (stores.length === 0) {
    try { db.close(); } catch { /* ignore */ }
    return 0;
  }

  let moved = 0;
  try {
    for (let i = 0; i < moves.length; i += VECTOR_REKEY_CHUNK) {
      const chunk = moves.slice(i, i + VECTOR_REKEY_CHUNK);
      await new Promise<void>((resolve) => {
        const tx = db.transaction(stores, 'readwrite');
        // Resolve on every terminal event — a re-key failure must never throw
        // into the move flow; the caller logs and the next Δ run re-embeds.
        tx.oncomplete = tx.onabort = tx.onerror = () => resolve();
        for (const move of chunk) {
          for (const storeName of stores) {
            const store = tx.objectStore(storeName);
            const request = store.get(move.oldImageId);
            request.onsuccess = () => {
              const record = request.result as
                | ({ imageId: string; updatedAt?: number } & Record<string, unknown>)
                | undefined;
              if (!record) return;
              store.put({
                ...record,
                imageId: move.newImageId,
                updatedAt: Date.now(),
              });
              store.delete(move.oldImageId);
              moved += 1;
            };
          }
        }
      });
      if (i + VECTOR_REKEY_CHUNK < moves.length) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return moved;
}

// ── Image rebasing (store objects) ─────────────────────────────────────────

/** The Electron indexer's plain-object file handle (see useImageLoader). */
type MockFileHandle = FileSystemFileHandle & { _filePath?: unknown; name?: string };

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
};

const mimeTypeForName = (name: string): string =>
  MIME_BY_EXTENSION[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * Re-point a file handle at the file's new location.
 *
 * The Electron indexer builds plain-object mock handles whose `getFile()`
 * CLOSES OVER the path it was created with — a carried-over image would keep
 * reading the OLD path, breaking copy-to-clipboard, the modal's full-size
 * load and on-demand thumbnail generation. The rebuilt handle copies the
 * original's own properties and adds a `getFile` that reads the new path
 * through the same `readFile` IPC the loader uses.
 *
 * Real `FileSystemFileHandle`s (browser mode) are returned untouched: they
 * cannot be rebuilt, and in-app moves are Electron-only.
 */
export function rebaseImageHandle(
  handle: FileSystemFileHandle | undefined | null,
  move: ImageRelocationMove,
): FileSystemFileHandle | undefined {
  if (!handle) return undefined;
  const mock = handle as MockFileHandle;
  if (typeof mock._filePath !== 'string' || mock._filePath.length === 0) {
    return handle;
  }

  const fileName = move.newName.split('/').pop() || mock.name || '';
  const newPath = move.newAbsolutePath;
  const rebuilt = {
    ...(handle as unknown as Record<string, unknown>),
    name: fileName,
    kind: 'file',
    _filePath: newPath,
  } as MockFileHandle;

  rebuilt.getFile = async (): Promise<File> => {
    const api = getElectronApi();
    if (!api?.readFile) throw new Error(`Failed to read file: ${fileName}`);
    const result = await api.readFile(newPath);
    if (result.success && result.data) {
      const raw = result.data;
      const data = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      return new File([data as unknown as BlobPart], fileName, {
        type: mimeTypeForName(fileName),
      });
    }
    throw new Error(`Failed to read file: ${fileName}`);
  };

  return rebuilt as unknown as FileSystemFileHandle;
}

/**
 * Rebuild a store image for its new identity — new id, root-relative name,
 * owning root and handles that read the new path. Everything else (blob
 * thumbnail URL, metadata, dimensions, enrichment fields) is carried over
 * untouched: the bytes never changed.
 */
export function rebaseRelocatedImage(
  image: IndexedImage,
  move: ImageRelocationMove,
): IndexedImage {
  return {
    ...image,
    id: move.newImageId,
    name: move.newName,
    directoryId: move.targetRootId,
    directoryName: move.targetRootName ?? image.directoryName,
    handle: rebaseImageHandle(image.handle, move) ?? image.handle,
    thumbnailHandle: rebaseImageHandle(image.thumbnailHandle, move),
    lastModified: move.newLastModified,
  };
}

// ── Main-process derived files (thumbnails + metadata cache) ───────────────

type ElectronApiWithRelocation = {
  relocateDerivedFiles?: (args: {
    moves: ImageRelocationMove[];
  }) => Promise<{
    success: boolean;
    results?: RelocateDerivedFilesResult[];
    error?: string;
  }>;
  readFile?: (filePath: string) => Promise<{
    success: boolean;
    /** Buffer comes back as a Uint8Array through Electron's structured clone. */
    data?: Uint8Array | ArrayBuffer;
    error?: string;
    errorType?: string;
    errorCode?: string;
  }>;
};

function getElectronApi(): ElectronApiWithRelocation | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { electronAPI?: ElectronApiWithRelocation }).electronAPI ?? null;
}

/**
 * Relocate the main-process-owned artifacts: thumbnail `.webp` files and JSON
 * metadata-cache records. Returns per-file results; `[]` when IPC is
 * unavailable (browser mode) or the call fails — a cache/thumbnail miss only
 * costs a re-parse/regeneration, never user data.
 */
export async function relocateDerivedFiles(
  moves: ImageRelocationMove[],
): Promise<RelocateDerivedFilesResult[]> {
  if (moves.length === 0) return [];
  const api = getElectronApi();
  if (!api?.relocateDerivedFiles) return [];
  try {
    const result = await api.relocateDerivedFiles({ moves });
    if (!result?.success) {
      console.warn('[Relocation] relocate-derived-files failed:', result?.error);
      return [];
    }
    return result.results ?? [];
  } catch (error) {
    console.warn('[Relocation] relocate-derived-files threw:', error);
    return [];
  }
}
