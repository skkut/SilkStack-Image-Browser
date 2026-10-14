import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getScanApi,
  streamDirectoryScan,
  type DirectoryScanBatch,
  type ScanApi,
} from "../utils/scanStream";

/**
 * The stream is what makes a large first index possible: the walk in main
 * hands over one batch at a time and this generator decides when to ask for the
 * next one. Its two failure modes are both silent — a scan that is never
 * cancelled keeps walking a folder nobody is looking at, and a missing `done`
 * check reports half a library as the whole library — so both are pinned here.
 */

type BatchReply = Awaited<ReturnType<ScanApi["nextDirectoryScanBatch"]>>;

function makeFile(name: string) {
  return { name, lastModified: 1, size: 2, type: "image/png" };
}

/**
 * A fake main process. `next` hands out the queued replies in order; running
 * out is an error rather than `undefined`, because a consumer that asks for one
 * batch too many would otherwise see a TypeError instead of a useful message.
 */
function makeApi(startResult: { success: boolean; scanId?: string; error?: string }, replies: BatchReply[]) {
  const calls = { started: 0, next: 0, cancelled: 0 };
  const queue = [...replies];

  const api: ScanApi = {
    startDirectoryScan: vi.fn(async () => {
      calls.started += 1;
      return startResult;
    }),
    nextDirectoryScanBatch: vi.fn(async () => {
      calls.next += 1;
      const reply = queue.shift();
      if (!reply) throw new Error("nextDirectoryScanBatch called past the end of the scripted replies");
      return reply;
    }),
    cancelDirectoryScan: vi.fn(async () => {
      calls.cancelled += 1;
      return { success: true };
    }),
  };

  return { api, calls, queue };
}

async function collect(gen: AsyncGenerator<DirectoryScanBatch>) {
  const batches: DirectoryScanBatch[] = [];
  for await (const batch of gen) {
    batches.push(batch);
  }
  return batches;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("streamDirectoryScan", () => {
  it("yields each batch and stops on the one flagged done", async () => {
    const { api, calls } = makeApi({ success: true, scanId: "scan-1" }, [
      { success: true, files: [makeFile("a.png")], scanned: 1, truncated: false, done: false },
      { success: true, files: [makeFile("b.png")], scanned: 2, truncated: false, done: true },
    ]);

    const batches = await collect(
      streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api }),
    );

    expect(batches.map((b) => b.files.map((f) => f.name))).toEqual([["a.png"], ["b.png"]]);
    expect(batches.map((b) => b.done)).toEqual([false, true]);
    expect(batches[1].scanned).toBe(2);
    expect(calls.next).toBe(2);
  });

  it("asks for the next batch only when the consumer asks for it", async () => {
    // This is the backpressure: a renderer that stops pulling stops the walk.
    // If the generator prefetched, a paused index would keep queueing batches.
    const { api, calls } = makeApi({ success: true, scanId: "scan-1" }, [
      { success: true, files: [makeFile("a.png")], scanned: 1, done: false },
      { success: true, files: [makeFile("b.png")], scanned: 2, done: true },
    ]);

    const gen = streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api });
    const first = await gen.next();

    expect(first.value?.files[0].name).toBe("a.png");
    expect(calls.next).toBe(1);

    await gen.next();
    expect(calls.next).toBe(2);
  });

  it("cancels the scan in main when the consumer breaks out early", async () => {
    const { api, calls } = makeApi({ success: true, scanId: "scan-7" }, [
      { success: true, files: [makeFile("a.png")], scanned: 1, done: false },
      { success: true, files: [makeFile("b.png")], scanned: 2, done: true },
    ]);

    for await (const batch of streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api })) {
      expect(batch.files).toHaveLength(1);
      break; // the library was removed mid-scan
    }

    expect(calls.cancelled).toBe(1);
    expect(api.cancelDirectoryScan).toHaveBeenCalledWith("scan-7");
    // The walk must not have been advanced past the batch it already handed over.
    expect(calls.next).toBe(1);
  });

  it("still cancels when a batch comes back as a failure", async () => {
    const { api, calls } = makeApi({ success: true, scanId: "scan-2" }, [
      { success: false, error: "Unknown scan" },
    ]);

    await expect(
      collect(streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api })),
    ).rejects.toThrow("Unknown scan");

    expect(calls.cancelled).toBe(1);
  });

  it("throws instead of reporting an empty library when the scan cannot start", async () => {
    const { api, calls } = makeApi({ success: false, error: "Access denied" }, []);

    await expect(
      collect(streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api })),
    ).rejects.toThrow("Access denied");

    expect(calls.next).toBe(0);
    // Nothing was started, so there is nothing to cancel.
    expect(calls.cancelled).toBe(0);
  });

  it("keeps pulling past a batch that omits done rather than ending early", async () => {
    // A reply shape from an older main process: no `done` at all. Treating a
    // missing flag as "finished" would silently halve a library.
    const { api, calls } = makeApi({ success: true, scanId: "scan-3" }, [
      { success: true, files: [makeFile("a.png")], scanned: 1 },
      { success: true, files: [makeFile("b.png")], scanned: 2 },
      { success: true, files: [], scanned: 2, done: true },
    ]);

    const batches = await collect(
      streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api }),
    );

    expect(batches.flatMap((b) => b.files.map((f) => f.name))).toEqual(["a.png", "b.png"]);
    expect(calls.next).toBe(3);
  });

  it("normalises a sparse reply into the documented batch shape", async () => {
    // `files`/`scanned`/`truncated` are optional on the wire so main can send a
    // minimal terminal batch; downstream code should not have to re-check.
    const { api } = makeApi({ success: true, scanId: "scan-4" }, [
      { success: true, done: true },
    ]);

    const [batch] = await collect(
      streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api }),
    );

    expect(batch).toEqual({ files: [], scanned: 0, truncated: false, done: true });
  });

  it("passes the scan arguments through, omitting batchSize when unset", async () => {
    const { api } = makeApi({ success: true, scanId: "scan-5" }, [{ success: true, done: true }]);

    await collect(streamDirectoryScan({ dirPath: "C:/Images", recursive: false, api }));

    expect(api.startDirectoryScan).toHaveBeenCalledWith({
      dirPath: "C:/Images",
      recursive: false,
    });
  });

  it("throws when this build cannot stream", async () => {
    await expect(
      collect(streamDirectoryScan({ dirPath: "C:/Images", recursive: true, api: null })),
    ).rejects.toThrow(/not available/i);
  });
});

describe("getScanApi", () => {
  it("returns null when there is no bridge at all", () => {
    expect(getScanApi()).toBeNull();
  });

  it("returns null for a bridge that predates streaming", () => {
    // The browser build and any older desktop build land here; callers fall
    // back to the collected listing instead of throwing.
    (window as { electronAPI?: unknown }).electronAPI = {
      startDirectoryScan: async () => ({ success: true }),
    };

    expect(getScanApi()).toBeNull();
  });

  it("returns the bridge when all three calls are present", () => {
    const api = {
      startDirectoryScan: async () => ({ success: true, scanId: "s" }),
      nextDirectoryScanBatch: async () => ({ success: true, done: true }),
      cancelDirectoryScan: async () => ({ success: true }),
    };
    (window as { electronAPI?: unknown }).electronAPI = api;

    expect(getScanApi()).toBe(api);
  });

  it("defaults to the live bridge when the caller passes nothing", async () => {
    const startDirectoryScan = vi.fn(async () => ({ success: true, scanId: "scan-live" }));
    const nextDirectoryScanBatch = vi.fn(async () => ({ success: true, done: true }));
    const cancelDirectoryScan = vi.fn(async () => ({ success: true }));
    (window as { electronAPI?: unknown }).electronAPI = {
      startDirectoryScan,
      nextDirectoryScanBatch,
      cancelDirectoryScan,
    };

    const batches = await collect(
      streamDirectoryScan({ dirPath: "C:/Images", recursive: true }),
    );

    expect(batches).toHaveLength(1);
    expect(startDirectoryScan).toHaveBeenCalledTimes(1);
    expect(cancelDirectoryScan).toHaveBeenCalledWith("scan-live");
  });
});
