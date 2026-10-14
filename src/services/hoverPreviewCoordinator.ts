import { useSettingsStore } from '../store/useSettingsStore';
import { isAnimatedMedia, resolveMediaMimeType } from '../utils/mediaTypes';
import { getImageMediaUrl } from '../utils/mediaUrl';

/**
 * Hover-preview policy for animated media (video + GIF) in the grids.
 *
 * Why this is a coordinator and not just a hook per card: producing a preview
 * used to be expensive, and on the browser build still is. There the Electron
 * file handle is a mock whose `getFile()` ships the whole file across IPC (see
 * useImageLoader), so every preview is a full read of the media file into
 * renderer memory. Hovering is a very frequent gesture, so the cost is managed
 * centrally:
 *
 *  - a dwell delay, so sweeping the pointer across a row of videos costs nothing
 *  - at most one preview loading or playing at any moment
 *  - a small byte- and count-capped cache, since re-hovering the same card is common
 *
 * On the desktop build, `silkstack-media://` removes most of that cost: the URL
 * is derived from the file's path, and the media element range-requests only
 * what it plays, so neither the size cap nor the byte budget applies. Both
 * paths stay, because the browser build has no protocol to serve.
 *
 * The public surface is deliberately plain objects and promises (no React), so
 * the ai-intelligence package can consume it through a prop without importing
 * anything from the app — the same store-agnostic arrangement its other props
 * already use.
 */

/**
 * Safety valve for the *blob* path only. Above this the poster is simply left
 * on screen rather than pulling a very large file into renderer memory in one
 * piece. Not user-facing: it exists so a pathological file cannot stall a
 * hover. Streaming previews ignore it — their cost does not scale with size.
 */
export const MAX_PREVIEW_BYTES = 150 * 1024 * 1024;

/** How long the pointer must rest on a card before any bytes are read. */
export const HOVER_DWELL_MS = 200;

/** Cache bounds — whichever is reached first evicts. */
export const CACHE_MAX_ENTRIES = 3;
export const CACHE_MAX_BYTES = 48 * 1024 * 1024;

/**
 * The subset of an indexed image the coordinator needs. Structural on purpose:
 * both the app's `IndexedImage` and the ai-intelligence module's `StackImage`
 * satisfy it.
 */
export interface HoverPreviewSource {
  id: string;
  name?: string | null;
  fileType?: string | null;
  fileSize?: number;
  lastModified?: number;
  handle?: unknown;
}

/** One hover. `url` settles to null when the preview is skipped or cancelled. */
export interface HoverSession {
  readonly url: Promise<string | null>;
  cancel(): void;
}

/** What the grids (and the module's drill-down) receive. */
export interface HoverPreviewApi {
  /** Start a preview; supersedes any hover already in progress. */
  activate(source: HoverPreviewSource): HoverSession;
}

interface CacheEntry {
  url: string;
  bytes: number;
  /** Monotonic use counter — the eviction order. */
  lastUsed: number;
}

interface ActiveSession {
  key: string;
  cancelled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (url: string | null) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/**
 * Cache key. Includes lastModified for the same reason the thumbnail cache
 * does: an edited file at the same path must not serve the old bytes.
 */
const cacheKeyOf = (source: HoverPreviewSource): string =>
  `${source.id}-${source.lastModified ?? 0}`;

class HoverPreviewCoordinator implements HoverPreviewApi {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private tick = 0;
  private active: ActiveSession | null = null;

  activate(source: HoverPreviewSource): HoverSession {
    // A new hover always supersedes the old one, however fast the pointer moves.
    this.stopActive();

    const key = cacheKeyOf(source);
    const deferred = createDeferred<string | null>();
    const record: ActiveSession = {
      key,
      cancelled: false,
      timer: null,
      resolve: deferred.resolve,
    };
    this.active = record;

    const session: HoverSession = {
      url: deferred.promise,
      cancel: () => this.cancelSession(record),
    };

    if (!this.isEligible(source)) {
      this.active = null;
      deferred.resolve(null);
      return session;
    }

    const cached = this.cache.get(key);
    if (cached) {
      // A cache hit skips the dwell entirely — there is nothing to wait for.
      cached.lastUsed = ++this.tick;
      deferred.resolve(cached.url);
      return session;
    }

    record.timer = setTimeout(() => {
      record.timer = null;
      void this.load(source, record);
    }, HOVER_DWELL_MS);

    return session;
  }

  /**
   * Drop every cached URL. Call when the library changes — the blob URLs point
   * at media that may no longer be indexed.
   */
  clear(): void {
    this.stopActive();
    for (const entry of this.cache.values()) {
      URL.revokeObjectURL(entry.url);
    }
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private stopActive(): void {
    if (this.active) {
      this.cancelSession(this.active);
    }
  }

  private cancelSession(record: ActiveSession): void {
    record.cancelled = true;
    if (record.timer !== null) {
      clearTimeout(record.timer);
      record.timer = null;
    }
    if (this.active === record) {
      this.active = null;
    }
    // Settle the caller's promise so nothing awaits forever. A load already in
    // flight is left to finish — its bytes land in the cache, so coming back to
    // the card is instant rather than another full read.
    record.resolve(null);
  }

  private isEligible(source: HoverPreviewSource): boolean {
    if (!useSettingsStore.getState().autoplayVideoPreviews) return false;
    if (!isAnimatedMedia(source.name, source.fileType)) return false;

    // Two ways to reach the bytes, with costs that scale differently. A
    // streaming URL costs a few hundred KB of range reads no matter how long
    // the clip is, so size is not a reason to refuse. A blob costs the whole
    // file, so the cap stays for that path.
    if (this.mediaUrlFor(source)) return true;

    if (typeof source.fileSize === 'number' && source.fileSize > MAX_PREVIEW_BYTES) {
      return false;
    }
    const handle = source.handle as { getFile?: unknown } | null | undefined;
    return !!handle && typeof handle.getFile === 'function';
  }

  /**
   * Streaming URL for this source, or null when there is none to build (the
   * browser build, or a stub whose handle carries no `_filePath`).
   */
  private mediaUrlFor(source: HoverPreviewSource): string | null {
    return getImageMediaUrl(source);
  }

  private async load(source: HoverPreviewSource, record: ActiveSession): Promise<void> {
    let url: string | null = null;
    try {
      url = await this.createPreviewUrl(source, record.key);
    } catch {
      // Unreadable or undecodable media just keeps the poster. Not worth
      // surfacing: hovering is exploratory, not an explicit request.
      url = null;
    }

    if (!url || record.cancelled) {
      record.resolve(null);
      return;
    }

    record.resolve(url);
  }

  private async createPreviewUrl(
    source: HoverPreviewSource,
    key: string,
  ): Promise<string | null> {
    const mediaUrl = this.mediaUrlFor(source);
    if (mediaUrl) {
      // Remembered with a byte cost of zero — nothing is held in renderer
      // memory — purely so a repeat hover still skips the dwell. `clear()` and
      // `evict()` call `revokeObjectURL`, which is a documented no-op on a
      // non-blob URL, so neither needs a special case for these entries.
      this.remember(key, mediaUrl, 0);
      return mediaUrl;
    }

    const blob = await this.readBlob(source);
    if (!blob || blob.size > MAX_PREVIEW_BYTES) return null;

    const url = URL.createObjectURL(blob);
    this.remember(key, url, blob.size);
    return url;
  }

  private async readBlob(source: HoverPreviewSource): Promise<Blob | null> {
    const handle = source.handle as { getFile?: () => Promise<File> } | null | undefined;
    if (!handle || typeof handle.getFile !== 'function') return null;

    const file = await handle.getFile();
    const mime = resolveMediaMimeType(source.name ?? file.name);
    // A browser File already reports the right type and stays backed by disk,
    // so it passes through untouched. The Electron mock reports image/jpeg for
    // every video, and the demuxer picks its parser from Blob.type — so those
    // bytes get re-wrapped with the type the media element needs.
    return file.type === mime ? file : new Blob([file], { type: mime });
  }

  private remember(key: string, url: string, bytes: number): void {
    const existing = this.cache.get(key);
    if (existing) {
      URL.revokeObjectURL(existing.url);
      this.cacheBytes -= existing.bytes;
      this.cache.delete(key);
    }

    // Newest lastUsed, so plain LRU order already protects the entry a card is
    // displaying: it is always the most recently used one.
    this.cache.set(key, { url, bytes, lastUsed: ++this.tick });
    this.cacheBytes += bytes;
    this.evict(key);
  }

  /**
   * Trim the cache back inside its bounds, never taking `protectedKey` — that
   * is the URL about to be handed to a card, and revoking it would leave the
   * card with a dead blob. A single preview larger than the byte cap therefore
   * leaves the cache over its bound; a working preview beats a strict bound.
   */
  private evict(protectedKey: string): void {
    while (this.cache.size > CACHE_MAX_ENTRIES || this.cacheBytes > CACHE_MAX_BYTES) {
      let oldestKey: string | null = null;
      let oldestTick = Infinity;

      for (const [key, entry] of this.cache) {
        if (key === protectedKey) continue;
        if (entry.lastUsed < oldestTick) {
          oldestTick = entry.lastUsed;
          oldestKey = key;
        }
      }

      // Nothing left that may be dropped.
      if (oldestKey === null) return;

      const entry = this.cache.get(oldestKey);
      if (entry) {
        URL.revokeObjectURL(entry.url);
        this.cacheBytes -= entry.bytes;
      }
      this.cache.delete(oldestKey);
    }
  }
}

export const hoverPreview = new HoverPreviewCoordinator();
export type { HoverPreviewCoordinator };
