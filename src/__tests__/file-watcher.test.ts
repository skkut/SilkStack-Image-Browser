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

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  sends = [];
  fsMock.watch.mockReset();
  fsMock.statSync.mockReset();
  fsMock.existsSync.mockReset();
  chokidarMock.watch.mockReset();

  fsMock.watch.mockImplementation(() => makeWatcher());
  chokidarMock.watch.mockImplementation(() => makeWatcher());
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
});
