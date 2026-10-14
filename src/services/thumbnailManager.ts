import { IndexedImage } from "../types";
import cacheManager from "./cacheManager";
import { useImageStore } from "../store/useImageStore";
import { getImageMediaUrl } from "../utils/mediaUrl";

const MAX_THUMBNAIL_EDGE = 512;
const MAX_CONCURRENT_THUMBNAILS = 8; // Increased from 3: with Intersection Observer, only visible images load

/**
 * Budget while the indexer is running. Thumbnail decoding competes with
 * metadata parsing for the same cores and the same disk, and a cold index is
 * the one moment the app has to feel responsive. Three is enough to fill the
 * grid visibly while leaving the parser the machine.
 */
const MAX_CONCURRENT_THUMBNAILS_WHILE_INDEXING = 3;

/**
 * Wall-clock ceiling for one job.
 *
 * The waits that make up a thumbnail all carry their own deadlines, so this is
 * a backstop rather than the primary guard. It exists because the failure it
 * prevents is both silent and total: `activeWorkers` never decrementing takes
 * the whole grid's thumbnails down for the rest of the session, and that is too
 * much to rest on every current and future wait being correctly bounded.
 */
const THUMBNAIL_JOB_TIMEOUT_MS = 30_000;

/**
 * How many failed thumbnails to remember.
 *
 * Without this an undecodable video is retried on every mount, and a retry now
 * costs a decoder start plus up to VIDEO_LOAD_TIMEOUT_MS before it fails the
 * same way — scrolling past a folder of such files would spend all its time
 * re-failing. The keys are short strings, but the set lives for the session, so
 * it is capped FIFO rather than left unbounded.
 */
const FAILED_THUMBNAIL_CACHE_LIMIT = 5000;

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi"]);

const isVideoAsset = (image: IndexedImage, file?: File): boolean => {
  if (image.fileType && image.fileType.startsWith("video/")) {
    return true;
  }
  const imageName = image.name?.toLowerCase() || "";
  for (const ext of VIDEO_EXTENSIONS) {
    if (imageName.endsWith(ext)) {
      return true;
    }
  }
  if (file?.type?.startsWith("video/")) {
    return true;
  }
  const fileName = file?.name?.toLowerCase() || "";
  for (const ext of VIDEO_EXTENSIONS) {
    if (fileName.endsWith(ext)) {
      return true;
    }
  }
  return false;
};

// Every one of these events is optional in the sense that a file can simply
// never produce it: an .mkv/.avi (containers Chromium does not decode), a
// truncated download, or a codec this build has no decoder for fires neither
// `loadeddata` nor `error` — the element just sits there. Without a deadline
// the promise never settles, the job never leaves the queue's active set, and
// after MAX_CONCURRENT_THUMBNAILS such files no thumbnail is ever produced
// again for the rest of the session. Timing out degrades one card to an error
// state instead of wedging the whole grid.
const VIDEO_LOAD_TIMEOUT_MS = 10_000;
const VIDEO_SEEK_TIMEOUT_MS = 5_000;

const waitForVideoEvent = (
  video: HTMLVideoElement,
  eventName: string,
  timeoutMs: number,
): Promise<void> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onError = () => {
      cleanup();
      reject(new Error("Video load error"));
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error(`Video ${eventName} timed out after ${timeoutMs}ms`));
    };
    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
    timer = setTimeout(onTimeout, timeoutMs);
  });

/**
 * Decode one frame and downscale it to a WebP blob.
 *
 * `src` is any URL the media stack can read — a `blob:` URL built from an
 * in-memory File, or a `silkstack-media:` URL that streams straight off disk
 * with byte-range requests. The streaming form is what keeps a 400 MB video
 * from being materialised in renderer memory just to grab one frame.
 *
 * @param src    Media URL to decode.
 * @param revoke Whether this function owns `src` and must revoke it (true for
 *               blob URLs; false for protocol URLs, which are just strings).
 */
async function generateVideoThumbnailBlob(
  src: string,
  revoke: boolean,
): Promise<Blob | null> {
  const video = document.createElement("video");
  try {
    // A blob: URL inherits this document's origin, but the media protocol is a
    // different origin entirely. Without `crossOrigin` the frame decodes fine
    // and then taints the canvas, so `toBlob` throws a SecurityError and every
    // video thumbnail fails — with an error that names the canvas, not CORS.
    // Must be set before `src`, or the element has already chosen its mode.
    if (!src.startsWith("blob:")) {
      video.crossOrigin = "anonymous";
    }
    video.src = src;
    video.muted = true;
    video.playsInline = true;
    // "metadata" is enough for `loadeddata` on a seekable source and avoids
    // pulling the whole file into the media cache the way "auto" does.
    video.preload = "metadata";

    await waitForVideoEvent(video, "loadeddata", VIDEO_LOAD_TIMEOUT_MS);

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > 0) {
      const targetTime = Math.min(0.1, Math.max(0, duration - 0.05));
      if (targetTime > 0) {
        video.currentTime = targetTime;
        await waitForVideoEvent(video, "seeked", VIDEO_SEEK_TIMEOUT_MS);
      }
    }

    const width = video.videoWidth || 1;
    const height = video.videoHeight || 1;
    const scale = Math.min(1, MAX_THUMBNAIL_EDGE / height);
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // High quality smoothing settings
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (scale < 0.5) {
      // Multi-step downscaling for better quality (fixes dithering)
      let currentWidth = width;
      let currentHeight = height;

      canvas.width = currentWidth;
      canvas.height = currentHeight;
      ctx.drawImage(video, 0, 0, currentWidth, currentHeight);

      while (currentWidth * 0.5 > targetWidth) {
        currentWidth = Math.floor(currentWidth * 0.5);
        currentHeight = Math.floor(currentHeight * 0.5);

        // Draw to a temporary canvas or reuse the same canvas context by resizing
        // Since we are shrinking, we can just redraw on the same canvas but at smaller size?
        // Actually, safer to use a temp canvas or just resize the main canvas and drawImage itself?
        // Standard technique: Draw current canvas content into itself at half size
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = currentWidth;
        tempCanvas.height = currentHeight;
        const tempCtx = tempCanvas.getContext("2d");
        if (!tempCtx) break;

        tempCtx.imageSmoothingEnabled = true;
        tempCtx.imageSmoothingQuality = "high";
        tempCtx.drawImage(
          canvas,
          0,
          0,
          canvas.width,
          canvas.height,
          0,
          0,
          currentWidth,
          currentHeight,
        );

        // Update main canvas
        canvas.width = currentWidth;
        canvas.height = currentHeight;
        ctx.drawImage(tempCanvas, 0, 0);
      }

      // Final step to exact target size
      const finalCanvas = document.createElement("canvas");
      finalCanvas.width = targetWidth;
      finalCanvas.height = targetHeight;
      const finalCtx = finalCanvas.getContext("2d");
      if (!finalCtx) return null;

      finalCtx.imageSmoothingEnabled = true;
      finalCtx.imageSmoothingQuality = "high";
      finalCtx.drawImage(
        canvas,
        0,
        0,
        canvas.width,
        canvas.height,
        0,
        0,
        targetWidth,
        targetHeight,
      );

      const blob = await new Promise<Blob | null>((resolve) =>
        finalCanvas.toBlob(resolve, "image/webp", 0.7),
      );
      return blob;
    } else {
      // Single step is fine
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.7),
      );
      return blob;
    }
  } catch (error) {
    console.error("Failed to generate video thumbnail blob:", error);
    return null;
  } finally {
    // Detaching the source before revoking is what actually releases the
    // decoder and its buffered ranges — revoking a URL the element still
    // holds leaves the media resource alive until GC gets to it, which for
    // eight concurrent videos is exactly the memory we were trying to save.
    video.removeAttribute("src");
    video.load();
    if (revoke) {
      URL.revokeObjectURL(src);
    }
  }
}

async function generateThumbnailBlob(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_THUMBNAIL_EDGE / (bitmap.height || 1));
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }

    // High quality smoothing settings
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    if (scale < 0.5) {
      // Multi-step downscaling
      let currentWidth = bitmap.width;
      let currentHeight = bitmap.height;

      // Initial draw
      canvas.width = currentWidth;
      canvas.height = currentHeight;
      ctx.drawImage(bitmap, 0, 0);

      while (currentWidth * 0.5 > targetWidth) {
        currentWidth = Math.floor(currentWidth * 0.5);
        currentHeight = Math.floor(currentHeight * 0.5);

        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = currentWidth;
        tempCanvas.height = currentHeight;
        const tempCtx = tempCanvas.getContext("2d");
        if (!tempCtx) break; // Should not happen

        tempCtx.imageSmoothingEnabled = true;
        tempCtx.imageSmoothingQuality = "high";
        tempCtx.drawImage(
          canvas,
          0,
          0,
          canvas.width,
          canvas.height,
          0,
          0,
          currentWidth,
          currentHeight,
        );

        canvas.width = currentWidth;
        canvas.height = currentHeight;
        ctx.drawImage(tempCanvas, 0, 0);
      }

      // Final resize
      const finalCanvas = document.createElement("canvas");
      finalCanvas.width = targetWidth;
      finalCanvas.height = targetHeight;
      const finalCtx = finalCanvas.getContext("2d");
      if (!finalCtx) {
        bitmap.close();
        return null;
      }

      finalCtx.imageSmoothingEnabled = true;
      finalCtx.imageSmoothingQuality = "high";
      finalCtx.drawImage(
        canvas,
        0,
        0,
        canvas.width,
        canvas.height,
        0,
        0,
        targetWidth,
        targetHeight,
      );

      const blob = await new Promise<Blob | null>((resolve) =>
        finalCanvas.toBlob(resolve, "image/webp", 0.7),
      );
      bitmap.close();
      return blob;
    } else {
      // Single step
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      bitmap.close();

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.7),
      );
      return blob;
    }
  } catch (error) {
    console.error("Failed to generate thumbnail blob:", error);
    return null;
  }
}

type ThumbnailJob = {
  image: IndexedImage;
  token: number;
  resolve: () => void;
  reject: (error: unknown) => void;
};

class ThumbnailManager {
  private inflight = new Map<string, Promise<void>>();
  private activeUrls = new Map<string, string>();
  private queue: ThumbnailJob[] = [];
  private activeWorkers = 0;
  private requestTokens = new Map<string, number>();
  private requestCounter = 0;
  /** Cache keys that already failed to decode this session — see the limit's comment. */
  private failed = new Set<string>();

  /** `${id}-${lastModified}`, matching the on-disk thumbnail cache key. */
  private thumbnailKeyOf(image: IndexedImage): string {
    return `${image.id}-${image.lastModified}`;
  }

  async ensureThumbnail(image: IndexedImage): Promise<void> {
    if (!image || !image.id) {
      return;
    }

    // Check current status from store (not from prop, which may be stale)
    const storeState = useImageStore.getState();
    const currentImage = storeState.images.find((img) => img.id === image.id);

    if (
      currentImage?.thumbnailStatus === "ready" &&
      currentImage.thumbnailUrl
    ) {
      return;
    }

    // A file that has already failed to decode stays failed. `lastModified` is
    // part of the key, so overwriting the file at the same path clears this and
    // the new bytes are tried normally.
    if (this.failed.has(this.thumbnailKeyOf(image))) {
      return;
    }

    const existing = this.inflight.get(image.id);
    if (currentImage?.thumbnailStatus === "loading" && existing) {
      return existing;
    }

    // Bump token to invalidate older queued/processing jobs for the same image
    const token = this.nextToken(image.id);
    this.dropQueuedJobs(image.id);

    const promise = new Promise<void>((resolve, reject) => {
      this.queue.push({ image, token, resolve, reject });
      this.processQueue();
    });

    this.inflight.set(image.id, promise);
    return promise;
  }

  private nextToken(imageId: string): number {
    const next = ++this.requestCounter;
    this.requestTokens.set(imageId, next);
    return next;
  }

  private dropQueuedJobs(imageId: string) {
    if (this.queue.length === 0) return;
    this.queue = this.queue.filter((job) => job.image.id !== imageId);
  }

  private isStale(imageId: string, token: number): boolean {
    return this.requestTokens.get(imageId) !== token;
  }

  private processQueue() {
    // Read the budget fresh on every pass rather than caching it: it changes
    // when indexing starts or stops, and every finishing job re-enters here, so
    // the limit self-corrects with no listener and no re-entrancy hazard.
    const limit =
      useImageStore.getState().indexingState === "indexing"
        ? MAX_CONCURRENT_THUMBNAILS_WHILE_INDEXING
        : MAX_CONCURRENT_THUMBNAILS;

    while (this.activeWorkers < limit && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;

      // If a newer request exists, skip this job
      if (this.isStale(job.image.id, job.token)) {
        job.resolve();
        continue;
      }

      this.activeWorkers++;

      this.withJobTimeout(this.loadThumbnail(job.image, job.token))
        .then(() => job.resolve())
        .catch((err) => {
          // Nothing else writes an error status for a job that failed outside
          // `loadThumbnail`'s own try/catch — and a card left at "loading" is
          // never retried, because ensureThumbnail treats "loading" as
          // in-progress. Writing the error state here is what keeps a stuck job
          // recoverable instead of permanent.
          if (!this.isStale(job.image.id, job.token)) {
            useImageStore.getState().setImageThumbnail(job.image.id, {
              status: "error",
              error:
                err instanceof Error ? err.message : "Thumbnail generation failed",
            });
          }
          job.reject(err);
        })
        .finally(() => {
          // Clean inflight only if this job is still the latest for the image
          if (!this.isStale(job.image.id, job.token)) {
            this.inflight.delete(job.image.id);
          }
          this.activeWorkers--;
          this.processQueue();
        });
    }
  }

  /**
   * Race a job against a wall-clock deadline.
   *
   * The abandoned load is left to finish on its own rather than being torn
   * down — there is no way to cancel a decode from outside, and its store
   * writes are token-guarded, so a late result cannot clobber a newer one. All
   * this promises is that the worker slot comes back.
   */
  private withJobTimeout(work: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Thumbnail job timed out after ${THUMBNAIL_JOB_TIMEOUT_MS}ms`),
          ),
        THUMBNAIL_JOB_TIMEOUT_MS,
      );
      work.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /**
   * Drop a card's *queued* thumbnail work — called when the card unmounts.
   *
   * Only queued jobs: a load already in flight is left to finish and cache its
   * result, so re-mounting that card is instant and the decode is not wasted.
   */
  cancel(imageId: string): void {
    if (!imageId) return;
    this.dropQueuedJobs(imageId);
  }

  /** Remember a decode failure, evicting the oldest entry past the cap. */
  private rememberFailure(key: string): void {
    this.failed.add(key);
    if (this.failed.size > FAILED_THUMBNAIL_CACHE_LIMIT) {
      // A Set iterates in insertion order, so the first value is the oldest.
      const oldest = this.failed.values().next().value;
      if (oldest !== undefined) {
        this.failed.delete(oldest);
      }
    }
  }

  private async loadThumbnail(
    image: IndexedImage,
    token: number,
  ): Promise<void> {
    const setImageThumbnail = useImageStore.getState().setImageThumbnail;
    const setSafe = (payload: {
      status: "loading" | "ready" | "error";
      thumbnailUrl?: string | null;
      error?: string | null;
    }) => {
      if (this.isStale(image.id, token)) return;
      setImageThumbnail(image.id, payload);
    };

    setSafe({ status: "loading" });

    // Create a cache key that includes validation data (timestamp)
    // This ensures we don't serve stale thumbnails if the file changes but path remains same
    const thumbnailKey = `${image.id}-${image.lastModified}`;

    try {
      if (image.thumbnailUrl) {
        setSafe({ status: "ready", thumbnailUrl: image.thumbnailUrl });
        return;
      }

      const cachedBlob = await cacheManager.getCachedThumbnail(thumbnailKey);
      if (cachedBlob) {
        const url = this.updateObjectUrl(image.id, cachedBlob);
        setSafe({ status: "ready", thumbnailUrl: url });
        return;
      }

      const blob = await this.generateThumbnailBlob(image);
      if (!blob) {
        throw new Error("Thumbnail generation failed");
      }

      await cacheManager.cacheThumbnail(thumbnailKey, blob);
      const url = this.updateObjectUrl(image.id, blob);
      setSafe({ status: "ready", thumbnailUrl: url });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown thumbnail error";
      // Only video failures are remembered. A video failure means the decoder
      // could not produce a frame — an unsupported container or codec — which
      // is a property of the file: retrying costs another full load timeout and
      // reaches the same verdict. A still failure is far more often transient
      // (a file briefly locked by the generator that just wrote it), and a
      // retry is cheap, so stills are always allowed to try again.
      if (isVideoAsset(image)) {
        this.rememberFailure(thumbnailKey);
      }
      setSafe({ status: "error", error: message });
    }
  }

  /**
   * Produce the downscaled WebP for one image.
   *
   * Videos prefer the streaming media protocol. A thumbnail needs the moov atom
   * and the frame at ~0.1 s and nothing else; over the protocol those arrive as
   * a few byte ranges, where the old path read the entire file over IPC,
   * structured-cloned it, and held it as a Blob for the duration of the decode.
   * With eight concurrent decodes that difference is the whole memory story.
   *
   * The fallback is not dead code: the browser build has no protocol, and an
   * Electron stub whose handle has not yet been hydrated with `_filePath` has
   * no absolute path to build a URL from. Both keep the old behaviour — correct,
   * just expensive.
   */
  private async generateThumbnailBlob(
    image: IndexedImage,
  ): Promise<Blob | null> {
    if (isVideoAsset(image)) {
      const mediaUrl = getImageMediaUrl(image);
      if (mediaUrl) {
        return generateVideoThumbnailBlob(mediaUrl, false);
      }
      const file = await (image.thumbnailHandle ?? image.handle).getFile();
      return generateVideoThumbnailBlob(URL.createObjectURL(file), true);
    }

    const file = await (image.thumbnailHandle ?? image.handle).getFile();
    return generateThumbnailBlob(file);
  }

  private updateObjectUrl(imageId: string, blob: Blob): string {
    const existing = this.activeUrls.get(imageId);
    if (existing) {
      URL.revokeObjectURL(existing);
    }

    const url = URL.createObjectURL(blob);
    this.activeUrls.set(imageId, url);
    return url;
  }

  /**
   * Re-key this manager's per-image bookkeeping after an in-app move/rename
   * (the image id is path-derived, so the old key would leak/evict wrongly).
   * The blob URL is path-independent, so it is carried over — the relocated
   * image keeps rendering its thumbnail with no flash. Queued jobs for the old
   * id are dropped; their `image` object carries the stale id.
   */
  renameEntry(oldImageId: string, newImageId: string): void {
    if (!oldImageId || !newImageId || oldImageId === newImageId) return;

    const url = this.activeUrls.get(oldImageId);
    if (url) {
      this.activeUrls.delete(oldImageId);
      this.activeUrls.set(newImageId, url);
    }

    const token = this.requestTokens.get(oldImageId);
    if (token !== undefined) {
      this.requestTokens.delete(oldImageId);
      this.requestTokens.set(newImageId, token);
    }

    const inflight = this.inflight.get(oldImageId);
    if (inflight) {
      this.inflight.delete(oldImageId);
      this.inflight.set(newImageId, inflight);
    }

    this.dropQueuedJobs(oldImageId);
  }

  clearAllUrls(): void {
    for (const url of this.activeUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.activeUrls.clear();
  }
}

export const thumbnailManager = new ThumbnailManager();
