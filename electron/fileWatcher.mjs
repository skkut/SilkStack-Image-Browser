import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs';

// Active watchers: directoryId -> watcher instance
const activeWatchers = new Map();

// Pending files for batching (directoryId -> Map(filePath -> { type: 'add' | 'unlink', forceReindex }))
const pendingFiles = new Map();
const processingTimeouts = new Map();

const WATCHER_READY_TIMEOUT_MS = 10000;

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

const sendWatcherDebug = (mainWindow, message) => {
  console.log(message);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('watcher-debug', { message });
  }
};

/**
 * Start watching a directory.
 */
export function startWatching(directoryId, dirPath, mainWindow) {
  if (activeWatchers.has(directoryId)) {
    return { success: true };
  }

  try {
    const usePolling = shouldUsePolling(dirPath);
    if (usePolling) {
      const driveMatch = /^[a-zA-Z]:/.exec(dirPath);
      const driveLabel = driveMatch ? driveMatch[0].toLowerCase() : 'network';

    }

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
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 100
      },
      depth: 99,
      ...(usePolling ? { usePolling: true, interval: 1000, binaryInterval: 1000 } : {})
    });

    const readyTimeout = setTimeout(() => {
      sendWatcherDebug(mainWindow, `[FileWatcher] Watcher timeout - assuming active for ${directoryId}`);
    }, WATCHER_READY_TIMEOUT_MS);



    watcher.on('ready', () => {
      clearTimeout(readyTimeout);
    });

    const enqueueImage = (imagePath, type = 'add', forceReindex = false) => {
      sendWatcherDebug(mainWindow, `[FileWatcher] File ${type} detected: ${imagePath}`);
      if (!pendingFiles.has(directoryId)) {
        pendingFiles.set(directoryId, new Map());
      }
      sendWatcherDebug(mainWindow, `[FileWatcher] Adding image (${type}) to batch: ${imagePath}`);
      const pendingMap = pendingFiles.get(directoryId);
      const existing = pendingMap.get(imagePath);
      pendingMap.set(imagePath, { 
        type,
        forceReindex: Boolean(existing?.forceReindex || forceReindex) 
      });

      if (processingTimeouts.has(directoryId)) {
        clearTimeout(processingTimeouts.get(directoryId));
      }

      processingTimeouts.set(directoryId, setTimeout(() => {
        processBatch(directoryId, dirPath, mainWindow);
      }, 500));
    };

    watcher.on('add', (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.mkv', '.mov', '.avi'];

      if (ext === '.json') {
        const basePath = filePath.slice(0, -ext.length);
        const matches = imageExts
          .map((imageExt) => `${basePath}${imageExt}`)
          .filter((candidate) => fs.existsSync(candidate));
        if (matches.length === 0) {
          return;
        }
        matches.forEach((match) => enqueueImage(match, true));
        return;
      }

      if (!imageExts.includes(ext)) {
        return;
      }

      enqueueImage(filePath, 'add', false);
    });

    watcher.on('unlink', (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm', '.mkv', '.mov', '.avi'];

      // Also watch for JSON sidecar deletions if they exist, but usually we care about the image
      if (!imageExts.includes(ext) && ext !== '.json') {
        return;
      }

      enqueueImage(filePath, 'unlink', false);
    });

    watcher.on('error', (error) => {
      if (isPermissionError(error)) {
        sendWatcherDebug(mainWindow, `[FileWatcher] Watcher permission error for ${directoryId}: ${error.message || error}`);
        return;
      }

      console.error(`Watcher error for ${directoryId}:`, error);
      sendWatcherDebug(mainWindow, `[FileWatcher] Watcher error for ${directoryId}: ${error.message || error}`);

      const errorMessage = error instanceof Error ? error.message : String(error);
      mainWindow.webContents.send('watcher-error', {
        directoryId,
        error: errorMessage
      });

      stopWatching(directoryId);
    });

    activeWatchers.set(directoryId, watcher);


    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { success: false, error: errorMessage };
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

/**
 * Process a batch of detected files.
 */
function processBatch(directoryId, dirPath, mainWindow) {
  const files = pendingFiles.get(directoryId);

  if (!files || files.size === 0) return;

  sendWatcherDebug(mainWindow, `[FileWatcher] Processing batch for ${directoryId}, ${files.size} changes`);

  const addedFiles = [];
  const deletedFiles = [];

  for (const [filePath, info] of files.entries()) {
    if (info.type === 'unlink') {
      deletedFiles.push(filePath);
      continue;
    }

    // Process additions
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        addedFiles.push({
          name: path.basename(filePath),
          path: filePath,
          lastModified: stats.birthtimeMs ?? stats.mtimeMs,
          size: stats.size,
          type: path.extname(filePath).slice(1),
          forceReindex: info.forceReindex === true
        });
      }
    } catch (err) {
      console.error(`Error getting stats for ${filePath}:`, err);
    }
  }

  if (addedFiles.length > 0) {
    sendWatcherDebug(mainWindow, `[FileWatcher] Sending ${addedFiles.length} new files to renderer for directory ${directoryId}`);
    mainWindow.webContents.send('new-images-detected', {
      directoryId,
      files: addedFiles
    });
  }

  if (deletedFiles.length > 0) {
    sendWatcherDebug(mainWindow, `[FileWatcher] Sending ${deletedFiles.length} deleted files to renderer for directory ${directoryId}`);
    mainWindow.webContents.send('images-deleted', {
      directoryId,
      paths: deletedFiles
    });
  }

  pendingFiles.delete(directoryId);
  processingTimeouts.delete(directoryId);
}
