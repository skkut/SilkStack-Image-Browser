import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';

/**
 * File watching for library folders.
 *
 * Two implementations, chosen per directory:
 *
 *  1. Native recursive `fs.watch` (Windows/macOS, local paths). ONE OS handle
 *     for the whole tree and no startup crawl.
 *  2. chokidar — everywhere else (Linux has no recursive fs.watch, UNC paths and
 *     IMH_FORCE_POLLING need polling, and an offline drive throws where chokidar
 *     waits quietly). Behavior there is unchanged.
 *
 * Why the split. chokidar 5 attaches an `fs.watch` handle to EVERY FILE, not
 * just every directory (`handler.js` `_handleFile` → `_watchWithNodeFs` →
 * `fs.watch(file)`), and builds that tree in a startup crawl. Measured on
 * 20,000 files (tmp/watch-bench.mjs, `process.getActiveResourcesInfo()`):
 *
 *     chokidar, current options .... 3128 ms, 20401 handles, 333 MB RSS
 *     chokidar, every option removed  3098 ms, 20401 handles, 324 MB RSS
 *     native recursive fs.watch ......   0 ms,     1 handle,  35 MB RSS
 *
 * Every chokidar option measured within 2% of the others, so none of them is
 * the lever: `awaitWriteFinish` cannot even fire during the crawl (index.js
 * `_emit` gates it on `_readyEmitted`), and `depth` is unreachable at 99. The
 * crawl itself is the cost, and in the running app it lands on top of the first
 * index — 14.1 s "Indexed in" with the watcher versus 3.1 s without.
 *
 * What the app actually needs from a watcher is deltas: which paths changed.
 * The renderer already knows every image it has indexed, so "did this change?"
 * is answered by comparing the on-disk stat against what the renderer holds —
 * no per-file OS watches and no crawl are required.
 *
 * That comparison only lives as long as the process, though: at every app start
 * the first event for a file the library already holds looks like a new one (a
 * OneDrive re-hydration, a backup tool restoring timestamps, an attribute-only
 * notification). So the stamps outlive the session in a baseline — one JSON per
 * directory, `<cacheRoot>/watcher-baseline/<dir>.json`, whose path main.mjs
 * passes to startWatching(). An event whose stamp is already in the baseline is
 * dropped rather than sent to the renderer as new; a path that vanished drops
 * out, so a file restored with its old timestamps is reported again. A sidecar
 * JSON is exempt: it is re-read on purpose, because it can carry new metadata
 * for an image whose own bytes never moved.
 */

// Active watchers: directoryId -> watcher instance (fs.FSWatcher | chokidar)
const activeWatchers = new Map();

// Pending paths per directory: directoryId -> Map(filePath -> write-stability record)
const pendingFiles = new Map();
const processingTimeouts = new Map();

/**
 * The last stat we reported per path, as "mtimeMs:size".
 *
 * Two jobs: it stops a repeated event for an unchanged file from force-
 * reindexing it (which drops that image's annotations downstream), and it
 * stops a burst of events for one write from being reported more than once.
 * Only paths that actually changed ever enter this map.
 */
const lastReported = new Map();
const MAX_TRACKED_PATHS = 100000;

const WATCHER_READY_TIMEOUT_MS = 10000;
const BATCH_DEBOUNCE_MS = 500;

/**
 * A file must hold the same size+mtime this long before its events are
 * reported, so a half-written file is never indexed (this replaces chokidar's
 * `awaitWriteFinish`, which only applied AFTER its crawl anyway). The clock
 * starts at the batch pass that first sees the path, so a new file is reported
 * ~2.5 s after the write starts — 500 ms batching plus this — which is the
 * latency the relocation registry in src/services/imageRelocation.ts expects.
 */
const WRITE_STABILITY_MS = 2000;
const STABILITY_RECHECK_MS = 400;

/**
 * Subtrees chokidar's `ignored` globs skip. The native recursive watch filters
 * on file extension alone, so without this list a library containing (say) a
 * `node_modules` or a stray `thumbnails` folder would report every image in it
 * as new. Segments match exactly, like the globs they mirror.
 */
const IGNORED_DIR_SEGMENTS = new Set([
  '.thumbnails',
  'thumbnails',
  '.cache',
  'node_modules',
  '.git',
]);

/**
 * The stamp each path had when it was last reported, carried across sessions in
 * one small JSON file per directory (written beside the metadata cache).
 *
 * `lastReported` cannot answer "did this file change?" for a session's FIRST
 * event on a path — it starts empty — so every event the OS delivers for a file
 * the library already indexed (OneDrive re-hydrating a placeholder, a backup
 * tool restoring a timestamp, an attribute-only notification) was reported as a
 * change, and the renderer honours a report with a full re-index. The baseline
 * remembers what the file looked like when it was last reported, so an event
 * that moved neither mtime nor size is recognised as nothing having happened.
 *
 * A stamp match is the same evidence the cache diff uses, and it errs the safe
 * way: anything that touches mtime or size is still reported.
 */
const baselines = new Map(); // directoryId -> Map(filePath -> "mtimeMs:size")
const baselinePaths = new Map(); // directoryId -> persistence path (absent: none)
const baselineTimers = new Map(); // directoryId -> pending debounced write
const dirtyBaselines = new Set(); // directoryIds with unwritten changes

const BASELINE_WRITE_DEBOUNCE_MS = 1500;
const BASELINE_VERSION = 1;
const MAX_BASELINE_PATHS = 100000;

const isInIgnoredSubtree = (dirPath, filePath) => {
  const relative = path.relative(dirPath, filePath);
  if (!relative || relative.startsWith('..')) {
    return false;
  }
  const segments = relative.split(/[\\/]/);
  segments.pop(); // the file itself is never an ignored directory
  return segments.some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
};

function loadBaseline(directoryId, baselinePath) {
  const stamps = new Map();
  baselines.set(directoryId, stamps);

  if (!baselinePath) {
    return; // No persistence configured — the in-memory map still dedupes.
  }
  baselinePaths.set(directoryId, baselinePath);

  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));
    if (parsed?.v === BASELINE_VERSION && parsed.stamps) {
      for (const [filePath, stamp] of Object.entries(parsed.stamps)) {
        if (typeof stamp === 'string') {
          stamps.set(filePath, stamp);
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // A first run has no baseline to read; anything else is worth knowing
      // about but never fatal — an empty baseline only means a noisy first
      // session, which is the behavior we had before it existed.
      console.error(`[FileWatcher] Could not read baseline for ${directoryId}:`, error);
    }
  }
}

/**
 * Persist one directory's baseline. Written synchronously (tmp file + rename)
 * on purpose: a deferred async write can land *after* a later mutation has
 * already been flushed — resurrecting an entry for a file that was deleted in
 * between — and the map is small enough that the debounce above is the only
 * throttle this needs. The rename keeps a half-written file from reading back
 * as "everything changed".
 */
function writeBaseline(directoryId) {
  const baselinePath = baselinePaths.get(directoryId);
  const stamps = baselines.get(directoryId);
  if (!baselinePath || !stamps) {
    return;
  }
  dirtyBaselines.delete(directoryId);

  const tempPath = `${baselinePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify({ v: BASELINE_VERSION, stamps: Object.fromEntries(stamps) }));
    fs.renameSync(tempPath, baselinePath);
  } catch (error) {
    console.error(`[FileWatcher] Could not write baseline for ${directoryId}:`, error);
  }
}

function noteBaselineChange(directoryId) {
  if (!baselinePaths.has(directoryId)) {
    return;
  }
  dirtyBaselines.add(directoryId);
  if (baselineTimers.has(directoryId)) {
    clearTimeout(baselineTimers.get(directoryId));
  }
  baselineTimers.set(
    directoryId,
    setTimeout(() => {
      baselineTimers.delete(directoryId);
      writeBaseline(directoryId);
    }, BASELINE_WRITE_DEBOUNCE_MS),
  );
}

/** Keep the persisted map bounded without re-reporting the whole library. */
function trimBaseline(stamps) {
  if (stamps.size <= MAX_BASELINE_PATHS) {
    return;
  }
  // Map iteration is insertion order, i.e. report order: the oldest half is
  // the coldest. Clearing outright would re-report every path once.
  const target = MAX_BASELINE_PATHS / 2;
  for (const filePath of stamps.keys()) {
    if (stamps.size <= target) {
      break;
    }
    stamps.delete(filePath);
  }
}

function forgetBaseline(directoryId) {
  const timer = baselineTimers.get(directoryId);
  if (timer) {
    clearTimeout(timer);
    baselineTimers.delete(directoryId);
  }
  if (dirtyBaselines.has(directoryId)) {
    writeBaseline(directoryId);
  }
  baselines.delete(directoryId);
  baselinePaths.delete(directoryId);
  dirtyBaselines.delete(directoryId);
}

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp4',
  '.webm',
  '.mkv',
  '.mov',
  '.avi',
]);

const shouldUsePolling = (dirPath) => {
  if (process.env.IMH_FORCE_POLLING === 'true') {
    return true;
  }
  return dirPath.startsWith('\\\\');
};

const isPermissionError = (error) => {
  const code = error?.code;
  return code === 'EPERM' || code === 'EACCES';
};

const errorMessageOf = (error) => (error instanceof Error ? error.message : String(error));

const sendWatcherDebug = (mainWindow, message) => {
  console.log(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('watcher-debug', { message });
  }
};

const sendToRenderer = (mainWindow, channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
};

/**
 * Native recursive fs.watch exists on Windows and macOS. UNC/network paths and
 * forced polling stay on chokidar, whose polling implementation is the only
 * thing that works there. The platform check is a pre-filter only — the call
 * itself is wrapped in try/catch at the call site, so an unsupported or
 * unreachable path degrades to chokidar instead of failing.
 */
const canUseNativeRecursiveWatch = (dirPath) => {
  if (shouldUsePolling(dirPath)) {
    return false;
  }
  return process.platform === 'win32' || process.platform === 'darwin';
};

const isWatchedExtension = (ext) => ext === '.json' || IMAGE_EXTENSIONS.has(ext);

/**
 * Queue a path that the OS says changed. Deliberately no I/O here: a burst of
 * events during a write is coalesced by the batch timer, and everything that
 * needs a stat (does it still exist? is it still being written?) happens once,
 * per path, in processBatch.
 */
function enqueuePath(directoryId, dirPath, mainWindow, filePath) {
  let pending = pendingFiles.get(directoryId);
  if (!pending) {
    pending = new Map();
    pendingFiles.set(directoryId, pending);
  }
  if (!pending.has(filePath)) {
    pending.set(filePath, { stamp: null, seenAt: 0 });
  }

  if (processingTimeouts.has(directoryId)) {
    clearTimeout(processingTimeouts.get(directoryId));
  }
  processingTimeouts.set(
    directoryId,
    setTimeout(() => {
      processingTimeouts.delete(directoryId);
      processBatch(directoryId, dirPath, mainWindow);
    }, BATCH_DEBOUNCE_MS),
  );
}

/**
 * Report a path if it is a settled image file, a settled write, a deletion, or
 * nothing worth mentioning. Shared by both watchers.
 *
 * `previous` holds the write-stability records carried over from the last pass
 * and `deferred` collects the ones that are still settling. They are separate
 * maps on purpose: the clock for a file has to survive from pass to pass, and
 * `deferred` starts empty every time.
 */
function classifyPath(
  directoryId,
  filePath,
  now,
  previous,
  addedFiles,
  deletedFiles,
  deferred,
  { fromSidecar = false } = {},
) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Gone before we looked: a delete, a rename-away, or a create that was
      // undone inside the batch window. All three mean "this path is not there".
      lastReported.delete(filePath);
      // Its baseline is worthless now, and dropping it is what lets a file
      // re-created with the same timestamps (restored from a backup) be
      // reported as the new file it is.
      if (baselines.get(directoryId)?.delete(filePath)) {
        noteBaselineChange(directoryId);
      }
      deletedFiles.push(filePath);
    } else {
      // EPERM/EBUSY/… — unreadable right now. Retrying forever would spin, so
      // drop it; the next event for this path picks it up again.
      console.error(`Error getting stats for ${filePath}:`, error);
    }
    return;
  }

  if (!stats.isFile()) {
    return;
  }

  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const record = previous.get(filePath) ?? { stamp, seenAt: now };

  // A sidecar-triggered path is classified here as its image, and then waits
  // out the stability gate — during which the pending key becomes the image
  // path, so the next pass arrives through the plain-image branch and loses the
  // flag. Carry it on the record, the only thing that survives the wait.
  if (fromSidecar) {
    record.fromSidecar = true;
  }

  if (record.stamp !== stamp) {
    // Still growing: restart the stability clock.
    record.stamp = stamp;
    record.seenAt = now;
  }

  const settledFor = now - record.seenAt;
  if (settledFor < WRITE_STABILITY_MS) {
    deferred.set(filePath, record);
    return;
  }

  const baseline = baselines.get(directoryId);
  // A sidecar JSON is re-read on purpose: it can carry metadata for an image
  // whose own bytes never moved, and that is the whole point of that branch.
  if (!fromSidecar && !record.fromSidecar && baseline?.get(filePath) === stamp) {
    // Reported in this state already, possibly in an earlier session: the
    // event moved neither mtime nor size, so nothing about the file changed.
    return;
  }

  if (lastReported.get(filePath) === stamp) {
    return;
  }
  if (lastReported.size > MAX_TRACKED_PATHS) {
    lastReported.clear();
  }
  lastReported.set(filePath, stamp);

  if (baseline) {
    baseline.set(filePath, stamp);
    trimBaseline(baseline);
    noteBaselineChange(directoryId);
  }

  addedFiles.push({
    name: path.basename(filePath),
    path: filePath,
    lastModified: stats.birthtimeMs ?? stats.mtimeMs,
    size: stats.size,
    type: path.extname(filePath).slice(1),
    // Every reported image is force-reindexed: for a path the renderer already
    // holds this drops the stale entry (and its annotation stamps) so the new
    // content is re-indexed — the same outcome the old 'change'/'replace' event
    // types produced. For a genuinely new path the renderer finds no stale id
    // and simply adds it.
    forceReindex: true,
  });
}

/**
 * Resolve the pending paths for one directory into renderer messages.
 */
function processBatch(directoryId, dirPath, mainWindow) {
  const pending = pendingFiles.get(directoryId);

  if (!pending || pending.size === 0) {
    pendingFiles.delete(directoryId);
    return;
  }

  const now = Date.now();
  const addedFiles = [];
  const deletedFiles = [];
  const deferred = new Map();

  for (const filePath of pending.keys()) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.json') {
      // A sidecar JSON holds the metadata for the image beside it. Any change
      // to it (or its arrival) means the image may need re-reading.
      const basePath = filePath.slice(0, -ext.length);
      for (const imageExt of IMAGE_EXTENSIONS) {
        const candidate = `${basePath}${imageExt}`;
        if (fs.existsSync(candidate)) {
          classifyPath(directoryId, candidate, now, pending, addedFiles, deletedFiles, deferred, {
            fromSidecar: true,
          });
        }
      }
      continue;
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      classifyPath(directoryId, filePath, now, pending, addedFiles, deletedFiles, deferred);
    }
  }

  if (deletedFiles.length > 0) {
    sendWatcherDebug(
      mainWindow,
      `[FileWatcher] Sending ${deletedFiles.length} deleted files to renderer for directory ${directoryId}`,
    );
    sendToRenderer(mainWindow, 'images-deleted', { directoryId, paths: deletedFiles });
  }

  if (addedFiles.length > 0) {
    sendWatcherDebug(
      mainWindow,
      `[FileWatcher] Sending ${addedFiles.length} new files to renderer for directory ${directoryId}`,
    );
    sendToRenderer(mainWindow, 'new-images-detected', { directoryId, files: addedFiles });
  }

  if (deferred.size > 0) {
    pendingFiles.set(directoryId, deferred);
    processingTimeouts.set(
      directoryId,
      setTimeout(() => {
        processingTimeouts.delete(directoryId);
        processBatch(directoryId, dirPath, mainWindow);
      }, STABILITY_RECHECK_MS),
    );
  } else {
    pendingFiles.delete(directoryId);
  }
}

function handleWatcherError(directoryId, mainWindow, error) {
  if (isPermissionError(error)) {
    sendWatcherDebug(
      mainWindow,
      `[FileWatcher] Watcher permission error for ${directoryId}: ${error.message || error}`,
    );
    return;
  }

  console.error(`Watcher error for ${directoryId}:`, error);
  sendWatcherDebug(mainWindow, `[FileWatcher] Watcher error for ${directoryId}: ${error.message || error}`);
  sendToRenderer(mainWindow, 'watcher-error', {
    directoryId,
    error: errorMessageOf(error),
  });
  stopWatching(directoryId);
}

/**
 * One OS handle for the whole tree, watching subtrees recursively. No crawl:
 * the indexer owns the initial listing, the watcher only reports deltas.
 */
function startNativeRecursiveWatcher(directoryId, dirPath, mainWindow) {
  const watcher = fs.watch(dirPath, { recursive: true, persistent: true }, (_eventType, filename) => {
    // `filename` is relative to dirPath and may be absent on some platforms —
    // without it there is no path to classify, and chokidar is the fallback for
    // platforms that behave that way.
    if (!filename) {
      return;
    }
    const filePath = path.join(dirPath, filename.toString());
    if (!isWatchedExtension(path.extname(filePath).toLowerCase())) {
      return;
    }
    if (isInIgnoredSubtree(dirPath, filePath)) {
      return;
    }
    enqueuePath(directoryId, dirPath, mainWindow, filePath);
  });

  watcher.on('error', (error) => handleWatcherError(directoryId, mainWindow, error));

  sendWatcherDebug(
    mainWindow,
    `[FileWatcher] Native recursive watch active for ${directoryId} (${dirPath}) — 1 handle, no startup crawl`,
  );

  return watcher;
}

/**
 * The previous implementation, kept for the platforms and path types where the
 * native recursive watch does not apply. Events are routed through the same
 * classify/batch path as the native watcher, so both report identically.
 */
function startChokidarWatcher(directoryId, dirPath, mainWindow) {
  const usePolling = shouldUsePolling(dirPath);

  const watcher = chokidar.watch(dirPath, {
    ignored: [
      '**/.thumbnails/**',
      '**/thumbnails/**',
      '**/.cache/**',
      '**/node_modules/**',
      '**/.git/**',
    ],
    persistent: true,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    depth: 99,
    ...(usePolling ? { usePolling: true, interval: 1000, binaryInterval: 1000 } : {}),
  });

  const readyTimeout = setTimeout(() => {
    sendWatcherDebug(mainWindow, `[FileWatcher] Watcher timeout - assuming active for ${directoryId}`);
  }, WATCHER_READY_TIMEOUT_MS);

  watcher.on('ready', () => {
    clearTimeout(readyTimeout);
  });

  // add/change/unlink all mean "this path may differ now" — whether it is an
  // add, an overwrite or a delete is decided by stat'ing it at batch time.
  watcher.on('all', (_event, filePath) => {
    if (typeof filePath !== 'string') {
      return;
    }
    if (!isWatchedExtension(path.extname(filePath).toLowerCase())) {
      return;
    }
    enqueuePath(directoryId, dirPath, mainWindow, filePath);
  });

  watcher.on('error', (error) => handleWatcherError(directoryId, mainWindow, error));

  return watcher;
}

/**
 * Start watching a directory.
 *
 * `baselinePath` is where the cross-session "already reported" record is kept
 * (one JSON file per directory, beside the metadata cache). Omitting it simply
 * disables persistence — the watcher still dedupes within the session.
 */
export function startWatching(directoryId, dirPath, mainWindow, baselinePath) {
  if (activeWatchers.has(directoryId)) {
    return { success: true };
  }

  loadBaseline(directoryId, baselinePath);

  try {
    let watcher;

    if (canUseNativeRecursiveWatch(dirPath)) {
      try {
        watcher = startNativeRecursiveWatcher(directoryId, dirPath, mainWindow);
      } catch (error) {
        // An offline/unreachable drive throws ENOENT here where chokidar simply
        // waits (see the watcher-reinstate comment in src/App.tsx), and a
        // platform without recursive support throws too. Either way, degrade.
        sendWatcherDebug(
          mainWindow,
          `[FileWatcher] Native watch unavailable for ${dirPath} (${error?.code || errorMessageOf(error)}); using chokidar`,
        );
        watcher = startChokidarWatcher(directoryId, dirPath, mainWindow);
      }
    } else {
      watcher = startChokidarWatcher(directoryId, dirPath, mainWindow);
    }

    activeWatchers.set(directoryId, watcher);

    return { success: true };
  } catch (error) {
    forgetBaseline(directoryId);
    return { success: false, error: errorMessageOf(error) };
  }
}

/**
 * Stop watching a directory.
 */
export function stopWatching(directoryId) {
  const watcher = activeWatchers.get(directoryId);

  if (watcher) {
    watcher.close();
    activeWatchers.delete(directoryId);

    if (processingTimeouts.has(directoryId)) {
      clearTimeout(processingTimeouts.get(directoryId));
      processingTimeouts.delete(directoryId);
    }
    pendingFiles.delete(directoryId);
  }

  // Flushes any debounced write before the map goes away (a no-op when this
  // directory never started a watcher).
  forgetBaseline(directoryId);

  return { success: true };
}

/**
 * Stop all watchers (called on app quit).
 */
export function stopAllWatchers() {
  for (const [directoryId] of activeWatchers) {
    stopWatching(directoryId);
  }
}

/**
 * Get watcher status.
 */
export function getWatcherStatus(directoryId) {
  return { active: activeWatchers.has(directoryId) };
}
