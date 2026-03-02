import { IndexedImage } from "../types";
import cacheManager from "./cacheManager";
import { useImageStore } from "../store/useImageStore";

const MAX_THUMBNAIL_EDGE = 512;
const MAX_CONCURRENT_THUMBNAILS = 8; // Increased from 3: with Intersection Observer, only visible images load

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

const waitForVideoEvent = (
  video: HTMLVideoElement,
  eventName: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = () => {
      cleanup();
      reject(new Error("Video load error"));
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });

async function generateVideoThumbnailBlob(file: File): Promise<Blob | null> {
  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = objectUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    await waitForVideoEvent(video, "loadeddata");

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration > 0) {
      const targetTime = Math.min(0.1, Math.max(0, duration - 0.05));
      if (targetTime > 0) {
        video.currentTime = targetTime;
        await waitForVideoEvent(video, "seeked");
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
        finalCanvas.toBlob(resolve, "image/webp", 0.9),
      );
      return blob;
    } else {
      // Single step is fine
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.9),
      );
      return blob;
    }
  } catch (error) {
    console.error("Failed to generate video thumbnail blob:", error);
    return null;
  } finally {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
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
        finalCanvas.toBlob(resolve, "image/webp", 0.9),
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
        canvas.toBlob(resolve, "image/webp", 0.9),
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
    while (
      this.activeWorkers < MAX_CONCURRENT_THUMBNAILS &&
      this.queue.length > 0
    ) {
      const job = this.queue.shift();
      if (!job) break;

      // If a newer request exists, skip this job
      if (this.isStale(job.image.id, job.token)) {
        job.resolve();
        continue;
      }

      this.activeWorkers++;

      this.loadThumbnail(job.image, job.token)
        .then(() => job.resolve())
        .catch((err) => job.reject(err))
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

    try {
      if (image.thumbnailUrl) {
        setSafe({ status: "ready", thumbnailUrl: image.thumbnailUrl });
        return;
      }

      // Create a cache key that includes validation data (timestamp)
      // This ensures we don't serve stale thumbnails if the file changes but path remains same
      const thumbnailKey = `${image.id}-${image.lastModified}`;

      const cachedBlob = await cacheManager.getCachedThumbnail(thumbnailKey);
      if (cachedBlob) {
        const url = this.updateObjectUrl(image.id, cachedBlob);
        setSafe({ status: "ready", thumbnailUrl: url });
        return;
      }

      const file = await (image.thumbnailHandle ?? image.handle).getFile();
      const blob = isVideoAsset(image, file)
        ? await generateVideoThumbnailBlob(file)
        : await generateThumbnailBlob(file);
      if (!blob) {
        throw new Error("Thumbnail generation failed");
      }

      await cacheManager.cacheThumbnail(thumbnailKey, blob);
      const url = this.updateObjectUrl(image.id, blob);
      setSafe({ status: "ready", thumbnailUrl: url });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown thumbnail error";
      setSafe({ status: "error", error: message });
    }
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
}

export const thumbnailManager = new ThumbnailManager();
