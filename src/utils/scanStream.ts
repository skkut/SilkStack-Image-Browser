import type { ElectronAPI } from "../types";

/**
 * Pull-based stream over the main process's directory walk.
 *
 * Why a stream instead of one big array
 * -------------------------------------
 * `listDirectoryFiles` returns the whole listing in a single IPC reply, so a
 * folder holding 200k files meant: a serial walk in main (nothing else
 * happening), one enormous structured clone, and a renderer that could not show
 * a single card until the last file had been stat'd. On first setup that is the
 * difference between "images appear" and "the window is frozen".
 *
 * The main process now walks lazily and hands back one batch at a time, and the
 * renderer asks for the next batch only when it is ready for it. That ordering
 * is the point: a renderer busy indexing, painting or paused inside Phase A
 * simply stops asking, and the walk waits — backpressure, not a queue of
 * batches nobody has looked at yet.
 *
 * The generator owns the scan id's lifetime, so the only way to leak a walk is
 * to hold the generator forever. Breaking out of the `for await` early runs the
 * `finally`, which cancels in main.
 */

/** A file as the scanner reports it — the same shape `listDirectoryFiles` returns. */
export interface ScannedFile {
  name: string;
  lastModified: number;
  size: number;
  type: string;
  birthtimeMs?: number;
}

/** One step of the walk. `done` marks the last batch — see below. */
export interface DirectoryScanBatch {
  files: ScannedFile[];
  /** Matched files so far *including* this batch, for a "N found" readout. */
  scanned: number;
  /** The scanner hit its entry cap and stopped; `scanned` is a floor, not a total. */
  truncated: boolean;
  /** The walk is over. After this batch the scan id is dead. */
  done: boolean;
}

/**
 * The three calls this module needs. Narrowed on purpose so tests can pass a
 * plain object and so a partial `electronAPI` (an older build, or the browser
 * build) can be detected without pretending to satisfy the full interface.
 */
export type ScanApi = Pick<
  ElectronAPI,
  "startDirectoryScan" | "nextDirectoryScanBatch" | "cancelDirectoryScan"
>;

/**
 * The scan API, or null when this build cannot stream.
 *
 * The browser build has no `electronAPI` at all, and an app running against an
 * older main process has an `electronAPI` without these methods — both must fall
 * back to the collected listing rather than throw.
 */
export function getScanApi(): ScanApi | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { electronAPI?: Partial<ScanApi> }).electronAPI;
  if (
    !api ||
    typeof api.startDirectoryScan !== "function" ||
    typeof api.nextDirectoryScanBatch !== "function" ||
    typeof api.cancelDirectoryScan !== "function"
  ) {
    return null;
  }
  return api as ScanApi;
}

/**
 * Walk `dirPath`, yielding one batch at a time until `done`.
 *
 * `api` is injectable so this is testable without a main process; callers in
 * the app pass nothing and get the real bridge.
 *
 * A failed batch throws rather than yielding an empty batch: an empty batch
 * would be indistinguishable from "the walk found nothing here", and the caller
 * would report a library as empty when the scan had actually broken. The
 * `finally` still cancels, so a throw cannot leave the walk running in main.
 */
export async function* streamDirectoryScan(options: {
  dirPath: string;
  recursive: boolean;
  batchSize?: number;
  api?: ScanApi | null;
}): AsyncGenerator<DirectoryScanBatch> {
  const api = options.api ?? getScanApi();
  if (!api) {
    throw new Error("Streaming directory scan is not available in this build");
  }

  const started = await api.startDirectoryScan({
    dirPath: options.dirPath,
    recursive: options.recursive,
    ...(options.batchSize ? { batchSize: options.batchSize } : {}),
  });
  if (!started.success || !started.scanId) {
    throw new Error(started.error || "Failed to start directory scan");
  }

  const scanId = started.scanId;
  try {
    for (;;) {
      const batch = await api.nextDirectoryScanBatch(scanId);
      if (!batch.success) {
        throw new Error(batch.error || "Directory scan failed");
      }

      // `done` is `=== true` on purpose: a main process that predates the flag
      // would otherwise end the loop on its first batch and silently report a
      // truncated library.
      const done = batch.done === true;
      yield {
        files: batch.files ?? [],
        scanned: batch.scanned ?? 0,
        truncated: batch.truncated ?? false,
        done,
      };
      if (done) return;
    }
  } finally {
    // Idempotent in main, so this is also safe after a normal `done`. It is the
    // only path that releases a scan whose consumer walked away early — a
    // removed library, an aborted indexing run, a component that unmounted.
    try {
      await api.cancelDirectoryScan(scanId);
    } catch {
      // A scan that is already gone is exactly the outcome we wanted.
    }
  }
}
