import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The watcher has two backends and one contract. These tests pin the contract
 * (what the renderer receives, and when) and the backend selection, because the
 * observable behavior — not the implementation — is what the rest of the app
 * depends on: `new-images-detected` / `images-deleted` with a settled file, and
 * never a half-written one.
 *
 * Backend choice matters for a measured reason: chokidar attaches an OS watch
 * per FILE (20,401 handles / 3.1 s startup on 20k files), the native recursive
 * watch attaches one for the whole tree. See tmp/watch-bench.mjs.
 */

const fsMock = vi.hoisted(() => ({
  watch: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));

const chokidarMock = vi.hoisted(() => ({ watch: vi.fn() }));

vi.mock("chokidar", () => ({ default: chokidarMock }));

import { startWatching, stopAllWatchers, getWatcherStatus, stopWatching } from "../../electron/fileWatcher.mjs";

/** A stand-in for both fs.FSWatcher and chokidar's FSWatcher. */
function makeWatcher() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    handlers,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
      return undefined;
    }),
    close: vi.fn(),
  };
}

function fileStats(mtimeMs: number, size: number, birthtimeMs = mtimeMs - 1000) {
  return { isFile: () => true, mtimeMs, size, birthtimeMs };
}

let sends: Array<{ channel: string; payload: any }>;

/** Stands in for the file system the baseline is written to and read back from. */
const disk = new Map<string, string>();

const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  sends = [];
  disk.clear();
  fsMock.watch.mockReset();
  fsMock.statSync.mockReset();
  fsMock.existsSync.mockReset();
  fsMock.readFileSync.mockReset();
  fsMock.writeFileSync.mockReset();
  fsMock.renameSync.mockReset();
  fsMock.mkdirSync.mockReset();
  chokidarMock.watch.mockReset();

  fsMock.watch.mockImplementation(() => makeWatcher());
  chokidarMock.watch.mockImplementation(() => makeWatcher());

  // A tiny in-memory file system, so a baseline written by one session can be
  // read back by the next one.
  fsMock.readFileSync.mockImplementation((filePath: string) => {
    if (!disk.has(filePath)) throw enoent();
    return disk.get(filePath);
  });
  fsMock.writeFileSync.mockImplementation((filePath: string, data: string) => {
    disk.set(filePath, String(data));
  });
  fsMock.renameSync.mockImplementation((from: string, to: string) => {
    disk.set(to, disk.get(from) ?? "");
    disk.delete(from);
  });
  fsMock.mkdirSync.mockImplementation(() => undefined);
});

afterEach(() => {
  stopAllWatchers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: any) => {
        sends.push({ channel, payload });
      },
    },
  };
}

function messages(channel: string) {
  return sends.filter((s) => s.channel === channel).map((s) => s.payload);
}

/**
 * Run the batch timer (500 ms) followed by enough stability re-checks for a
 * settled file to be reported. A path is only reported once it has held the
 * same size+mtime for WRITE_STABILITY_MS (2000 ms), so a single 500 ms tick is
 * never enough — that is the point of the gate.
 */
function settle() {
  vi.advanceTimersByTime(500);
  for (let i = 0; i < 6; i += 1) {
    vi.advanceTimersByTime(400);
  }
}

describe("watcher backend selection", () => {
  it("uses one native recursive watch on a local Windows path", () => {
    const win = makeWindow();
    const result = startWatching("d-native", "C:\\lib", win);

    expect(result).toEqual({ success: true });
    expect(fsMock.watch).toHaveBeenCalledTimes(1);
    expect(fsMock.watch.mock.calls[0][1]).toMatchObject({ recursive: true });
    expect(chokidarMock.watch).not.toHaveBeenCalled();
    expect(getWatcherStatus("d-native")).toEqual({ active: true });
  });

  it("keeps chokidar for UNC paths, where native watching is unreliable", () => {
    startWatching("d-unc", "\\\\nas\\share\\lib", makeWindow());

    expect(fsMock.watch).not.toHaveBeenCalled();
    expect(chokidarMock.watch).toHaveBeenCalledTimes(1);
    expect(chokidarMock.watch.mock.calls[0][1]).toMatchObject({ usePolling: true });
  });

  it("falls back to chokidar when the folder is not reachable", () => {
    // fs.watch throws ENOENT on a missing path where chokidar waits quietly —
    // the offline-drive case App.tsx's reinstate flow depends on.
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    fsMock.watch.mockImplementationOnce(() => {
      throw enoent;
    });

    const result = startWatching("d-offline", "C:\\gone", makeWindow());

    expect(result).toEqual({ success: true });
    expect(chokidarMock.watch).toHaveBeenCalledTimes(1);
    expect(getWatcherStatus("d-offline")).toEqual({ active: true });
  });

  it("does not start a second watcher for the same directory", () => {
    const win = makeWindow();
    startWatching("d-dup", "C:\\lib2", win);
    startWatching("d-dup", "C:\\lib2", win);

    expect(fsMock.watch).toHaveBeenCalledTimes(1);
  });
});

describe("reporting file changes", () => {
  it("reports a settled image once, with forceReindex", () => {
    const win = makeWindow();
    const dir = "C:\\lib-a";
    startWatching("d-a", dir, win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    fsMock.statSync.mockReturnValue(fileStats(5_000, 1234));
    onEvent("change", "shot.png");
    settle();

    const detected = messages("new-images-detected");
    expect(detected).toHaveLength(1);
    expect(detected[0].directoryId).toBe("d-a");
    expect(detected[0].files).toEqual([
      {
        name: "shot.png",
        path: path.join(dir, "shot.png"),
        lastModified: 4_000, // birthtime when present
        size: 1234,
        type: "png",
        forceReindex: true,
      },
    ]);
  });

  it("holds a file back while it is still being written", () => {
    const win = makeWindow();
    startWatching("d-grow", "C:\\lib-b", win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    // A download in progress: every pass sees a bigger file.
    let size = 100;
    fsMock.statSync.mockImplementation(() => fileStats(5_000, (size += 100)));
    onEvent("change", "downloading.mp4");
    settle();

    expect(messages("new-images-detected")).toHaveLength(0);

    // The write finishes; now it settles and is reported exactly once.
    size = 900;
    fsMock.statSync.mockImplementation(() => fileStats(5_000, 900));
    settle();

    const detected = messages("new-images-detected");
    expect(detected).toHaveLength(1);
    expect(detected[0].files[0]).toMatchObject({ name: "downloading.mp4", size: 900, forceReindex: true });
  });

  it("reports a vanished file as deleted", () => {
    const win = makeWindow();
    const dir = "C:\\lib-c";
    startWatching("d-c", dir, win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    fsMock.statSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    onEvent("rename", "gone.png");
    vi.advanceTimersByTime(500);

    expect(messages("images-deleted")).toEqual([
      { directoryId: "d-c", paths: [path.join(dir, "gone.png")] },
    ]);
  });

  it("re-indexes the image beside a changed sidecar JSON", () => {
    const win = makeWindow();
    const dir = "C:\\lib-d";
    startWatching("d-d", dir, win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    const imagePath = path.join(dir, "cat.png");
    fsMock.existsSync.mockImplementation((p: string) => p === imagePath);
    fsMock.statSync.mockReturnValue(fileStats(5_000, 42));
    onEvent("change", "cat.json");
    settle();

    const detected = messages("new-images-detected");
    expect(detected).toHaveLength(1);
    expect(detected[0].files[0]).toMatchObject({ name: "cat.png", forceReindex: true });
  });

  it("ignores extensions the library does not index", () => {
    const win = makeWindow();
    startWatching("d-e", "C:\\lib-e", win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    onEvent("change", "notes.txt");
    onEvent("change", "archive.zip");
    settle();

    expect(fsMock.statSync).not.toHaveBeenCalled();
    expect(messages("new-images-detected")).toHaveLength(0);
    expect(messages("images-deleted")).toHaveLength(0);
  });

  it("does not re-report a file that has not changed since the last report", () => {
    const win = makeWindow();
    startWatching("d-f", "C:\\lib-f", win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    fsMock.statSync.mockReturnValue(fileStats(5_000, 77));
    onEvent("change", "same.png");
    settle();
    expect(messages("new-images-detected")).toHaveLength(1);

    // A repeated event for a byte-identical file (an antivirus touch, a
    // duplicated OS notification) must not force-reindex — downstream that
    // drops the image's annotation stamps.
    onEvent("change", "same.png");
    settle();
    expect(messages("new-images-detected")).toHaveLength(1);
  });

  it("reports an overwritten file again when its contents change", () => {
    const win = makeWindow();
    startWatching("d-g", "C:\\lib-g", win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    fsMock.statSync.mockReturnValue(fileStats(5_000, 77));
    onEvent("change", "edit.png");
    settle();

    fsMock.statSync.mockReturnValue(fileStats(9_000, 88));
    onEvent("change", "edit.png");
    settle();

    expect(messages("new-images-detected")).toHaveLength(2);
  });

  it("batches a burst of writes into one message", () => {
    const win = makeWindow();
    startWatching("d-h", "C:\\lib-h", win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    fsMock.statSync.mockReturnValue(fileStats(5_000, 10));
    for (let i = 0; i < 25; i += 1) {
      onEvent("change", `gen-${i}.png`);
    }
    settle();

    const detected = messages("new-images-detected");
    expect(detected).toHaveLength(1);
    expect(detected[0].files).toHaveLength(25);
  });

  it("stops reporting once the watcher is stopped", () => {
    const win = makeWindow();
    startWatching("d-i", "C:\\lib-i", win);
    const handle = fsMock.watch.mock.results[0].value;
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    fsMock.statSync.mockReturnValue(fileStats(5_000, 10));
    onEvent("change", "late.png");
    stopWatching("d-i");
    settle();

    expect(handle.close).toHaveBeenCalled();
    expect(getWatcherStatus("d-i")).toEqual({ active: false });
    expect(messages("new-images-detected")).toHaveLength(0);
    expect(messages("images-deleted")).toHaveLength(0);
  });

  it("skips the subtrees chokidar's ignored config excludes", () => {
    const win = makeWindow();
    startWatching("d-ign", "C:\\lib-ign", win);
    const onEvent = fsMock.watch.mock.calls[0][2] as (eventType: string, filename: string) => void;

    // The native watch filters on extension alone, so a library that contains
    // one of these trees would otherwise report every image in it as new.
    onEvent("change", "node_modules/pkg/logo.png");
    onEvent("change", "thumbnails/t1.webp");
    onEvent("change", "sub/.git/icon.jpg");
    settle();

    expect(fsMock.statSync).not.toHaveBeenCalled();
    expect(messages("new-images-detected")).toHaveLength(0);
  });
});

describe("the persisted baseline across sessions", () => {
  const dir = "C:\\lib-baseline";
  const baselinePath = "C:\\cache\\watcher-baseline\\lib-baseline.json";

  let endSession: (() => void) | null = null;

  /**
   * A fresh module instance is a fresh app run: `lastReported` starts empty
   * again, while the baseline file on `disk` carries over. That is the exact
   * situation the baseline exists for — the first event of a session for a file
   * the library already indexed.
   */
  async function startSession() {
    vi.resetModules();
    const fresh = await import("../../electron/fileWatcher.mjs");
    endSession = () => fresh.stopAllWatchers();
    fresh.startWatching("d-b", dir, makeWindow(), baselinePath);
  }

  function lastHandler() {
    const calls = fsMock.watch.mock.calls;
    return calls[calls.length - 1][2] as (eventType: string, filename: string) => void;
  }

  afterEach(() => {
    endSession?.();
    endSession = null;
  });

  it("reports a file it has never seen", async () => {
    await startSession();

    fsMock.statSync.mockReturnValue(fileStats(5_000, 77));
    lastHandler()("change", "cat.png");
    settle();

    expect(messages("new-images-detected")).toHaveLength(1);
  });

  it("stays quiet for a file whose stamp has not moved since the last run", async () => {
    fsMock.statSync.mockReturnValue(fileStats(5_000, 77));
    await startSession();
    lastHandler()("change", "cat.png");
    settle();
    expect(messages("new-images-detected")).toHaveLength(1);
    endSession?.();

    // Next run: the same event, the same bytes. A re-hydrated OneDrive
    // placeholder, a backup tool restoring a timestamp or an attribute-only
    // notification must not look like a change — and must not cost a re-index.
    await startSession();
    lastHandler()("change", "cat.png");
    settle();

    expect(messages("new-images-detected")).toHaveLength(1);
  });

  it("reports the file again once its contents move", async () => {
    fsMock.statSync.mockReturnValue(fileStats(5_000, 77));
    await startSession();
    lastHandler()("change", "cat.png");
    settle();
    endSession?.();

    await startSession();
    fsMock.statSync.mockReturnValue(fileStats(9_000, 88));
    lastHandler()("change", "cat.png");
    settle();

    const detected = messages("new-images-detected");
    expect(detected).toHaveLength(2);
    expect(detected[1].files[0]).toMatchObject({ name: "cat.png", size: 88, forceReindex: true });
  });

  it("re-reports an image whose sidecar JSON changed, even with the image untouched", async () => {
    // The sidecar branch exists to pick metadata up for an image that is
    // already indexed, so its own stamp is not evidence of anything — and the
    // previous session already baselined that stamp.
    const imagePath = path.join(dir, "cat.png");
    fsMock.existsSync.mockImplementation((p: string) => p === imagePath);
    fsMock.statSync.mockReturnValue(fileStats(5_000, 42));

    await startSession();
    lastHandler()("change", "cat.json");
    settle();
    expect(messages("new-images-detected")).toHaveLength(1);
    endSession?.();

    // The image must be classified as sidecar-triggered on every pass of the
    // stability wait, not only the first one that saw the .json.
    await startSession();
    lastHandler()("change", "cat.json");
    settle();

    expect(messages("new-images-detected")).toHaveLength(2);
  });

  it("forgets a deleted path, so a file restored with old timestamps is new again", async () => {
    fsMock.statSync.mockReturnValue(fileStats(5_000, 77));
    await startSession();
    lastHandler()("change", "cat.png");
    settle();
    expect(messages("new-images-detected")).toHaveLength(1);

    fsMock.statSync.mockImplementation(() => {
      throw enoent();
    });
    lastHandler()("rename", "cat.png");
    vi.advanceTimersByTime(500);
    expect(messages("images-deleted")).toHaveLength(1);
    endSession?.();

    // Restored from a backup: same mtime, same size, but the library dropped it
    // when it vanished — so it has to be reported, not silently ignored.
    await startSession();
    fsMock.statSync.mockReturnValue(fileStats(5_000, 77));
    lastHandler()("change", "cat.png");
    settle();

    expect(messages("new-images-detected")).toHaveLength(2);
  });
});
