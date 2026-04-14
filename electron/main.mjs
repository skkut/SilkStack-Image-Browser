import electron from "electron";
const {
  app,
  BrowserWindow,
  shell,
  dialog,
  ipcMain,
  nativeTheme,
  Menu,
  nativeImage,
} = electron;
// console.log('📦 Loaded electron module');

import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import * as fileWatcher from "./fileWatcher.mjs";
import archiver from "archiver";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Simple development check
const isDev =
  process.env.NODE_ENV === "development" ||
  !app.isPackaged ||
  process.argv.includes("--dev");

// Separate user data for development to prevent conflicts
if (isDev) {
  const userDataPath = app.getPath("userData");
  app.setPath("userData", `${userDataPath} (Dev)`);
}

// Parser version - increment when parser logic changes
// This ensures cache is invalidated when parsing rules change
const PARSER_VERSION = 4; // v4: Added Eff. Loader SDXL, DF_Text_Box, and Unpack SDXL Tuple nodes for better SDXL workflow support

// Get platform-specific icon
function getIconPath() {
  const root = app.getAppPath();
  if (process.platform === "win32") {
    // For Windows, use the .ico file
    return path.join(root, "public", "icon.ico");
  } else if (process.platform === "darwin") {
    // macOS prefers high-resolution PNG or ICNS
    return path.join(root, "public", "SilkStack 1024.png");
  } else {
    // Linux and others
    return path.join(root, "public", "SilkStack 512.png");
  }
}

const execFileAsync = promisify(execFile);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi"]);

const getMimeTypeFromName = (name) => {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mkv")) return "video/x-matroska";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  return "application/octet-stream";
};

const parseFrameRate = (value) => {
  if (typeof value !== "string" || !value.includes("/")) {
    return null;
  }
  const [num, den] = value.split("/").map((part) => Number(part));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return null;
  }
  return num / den;
};

const buildVideoInfoFromProbe = (stream, format) => {
  const frameRate =
    parseFrameRate(stream?.r_frame_rate) ??
    parseFrameRate(stream?.avg_frame_rate);
  const frameCount =
    typeof stream?.nb_frames === "string"
      ? Number(stream.nb_frames)
      : stream?.nb_frames;
  const durationValue =
    typeof format?.duration === "string"
      ? Number(format.duration)
      : format?.duration;

  return {
    frame_rate: Number.isFinite(frameRate) ? frameRate : null,
    frame_count: Number.isFinite(frameCount) ? frameCount : null,
    duration_seconds: Number.isFinite(durationValue) ? durationValue : null,
    width: typeof stream?.width === "number" ? stream.width : null,
    height: typeof stream?.height === "number" ? stream.height : null,
    codec: stream?.codec_name || null,
    format: format?.format_name || null,
  };
};

async function readVideoMetadataWithFfprobe(filePath) {
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      filePath,
    ],
    { encoding: "utf8" },
  );

  const output = typeof stdout === "string" ? stdout : stdout.toString("utf8");
  const payload = JSON.parse(output);
  const format = payload?.format ?? {};
  const tags = format.tags ?? {};
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const videoStream =
    streams.find((stream) => stream?.codec_type === "video") ?? {};

  return {
    comment: tags.comment,
    description: tags.description,
    title: tags.title,
    video: buildVideoInfoFromProbe(videoStream, format),
  };
}

let mainWindow;
let skippedVersions = new Set();

// --- Zoom Management ---
const ZOOM_STEP = 0.1;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

function getSafeWebContents() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow.webContents;
  }
  return null;
}

function setZoomFactor(factor) {
  const contents = getSafeWebContents();
  if (!contents) return;

  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));
  contents.setZoomFactor(clamped);
}

function resetZoom() {
  setZoomFactor(1);
}

function adjustZoom(delta) {
  const contents = getSafeWebContents();
  if (!contents) return;

  const currentZoom = contents.getZoomFactor();
  setZoomFactor(currentZoom + delta);
}

const zoomMenuItems = [
  {
    label: "Reset Zoom",
    accelerator: "CmdOrCtrl+0",
    click: resetZoom,
  },
  {
    label: "Zoom In",
    accelerator: "CmdOrCtrl+=",
    click: () => adjustZoom(ZOOM_STEP),
  },
  {
    label: "Zoom In (+)",
    accelerator: "CmdOrCtrl+Plus",
    visible: false,
    click: () => adjustZoom(ZOOM_STEP),
  },
  {
    label: "Zoom In (Numpad)",
    accelerator: "CmdOrCtrl+numadd",
    visible: false,
    click: () => adjustZoom(ZOOM_STEP),
  },
  {
    label: "Zoom Out",
    accelerator: "CmdOrCtrl+-",
    click: () => adjustZoom(-ZOOM_STEP),
  },
  {
    label: "Zoom Out (Numpad)",
    accelerator: "CmdOrCtrl+numsub",
    visible: false,
    click: () => adjustZoom(-ZOOM_STEP),
  },
];

// --- Settings Management ---
const settingsPath = path.join(app.getPath("userData"), "settings.json");

async function readSettings() {
  try {
    const data = await fs.readFile(settingsPath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    // If file doesn't exist or is invalid, return empty object
    return {};
  }
}

async function saveSettings(settings) {
  try {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error("Error saving settings:", error);
  }
}

async function getCacheRootPath() {
  const settings = await readSettings();
  if (
    settings &&
    typeof settings.cachePath === "string" &&
    settings.cachePath.trim().length > 0
  ) {
    return settings.cachePath;
  }
  return app.getPath("userData");
}
// --- End Settings Management ---

// --- Application Menu ---
function createApplicationMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Add Folder...",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("menu-add-folder");
            }
          },
        },
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("menu-open-settings");
            }
          },
        },
        { type: "separator" },
        {
          label: "Exit",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",
          click: () => {
            app.quit();
          },
        },
      ],
    },

    {
      label: "View",
      submenu: [
        {
          label: "Toggle Grid/List View",
          accelerator: "CmdOrCtrl+L",
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("menu-toggle-view");
            }
          },
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        { type: "separator" },
        ...zoomMenuItems,
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },

    {
      label: "Help",
      submenu: [
        {
          label: "Documentation",
          click: async () => {
            await shell.openExternal(
              "https://github.com/skkut/silkstack#readme",
            );
          },
        },
        {
          label: "Report Bug",
          click: async () => {
            await shell.openExternal(
              "https://github.com/skkut/silkstack/issues/new",
            );
          },
        },
        {
          label: "View on GitHub",
          click: async () => {
            await shell.openExternal("https://github.com/skkut/silkstack");
          },
        },
        { type: "separator" },
        {
          label: `About SilkStack Image Browser`,
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("menu-open-about");
            }
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
// --- End Application Menu ---

// Auto-updater removed

function createWindow(startupDirectory = null) {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    icon: getIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      webSecurity: true,
      preload: path.join(__dirname, "preload.js"),
    },
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f3f4f6',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000',
      height: 44,
    },
    show: false, // Don't show until ready
  });

  // Create application menu
  createApplicationMenu();

  // Ensure zoom starts at the default level
  resetZoom();

  // Set window title to include version (keeps it accurate across builds)
  try {
    const appVersion = app.getVersion();
    mainWindow.setTitle(`SilkStack Image Browser`);
  } catch (e) {
    // Fallback if app.getVersion is not available
    mainWindow.setTitle("SilkStack Image Browser");
  }

  // Add Dev indicator to title
  if (isDev) {
    console.log("🔧 Setting initial dev title");
    mainWindow.setTitle("SilkStack Image Browser - Dev");
  }

  // Prevent index.html title from overriding the Dev suffix
  mainWindow.on("page-title-updated", (e, title) => {
    if (isDev) {
      e.preventDefault();
      mainWindow.setTitle(`${title} - Dev`);
    }
  });

  // Load the app
  if (isDev && !process.argv.includes("--dist")) {
    mainWindow.loadURL("http://localhost:5173");
  } else {
    // In production or --dist mode, load from the build output
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  // Show window when ready
  mainWindow.once("ready-to-show", () => {
    mainWindow.maximize();
    mainWindow.show();

    // If a startup directory was provided via CLI, send it to the renderer
    if (startupDirectory) {
      console.log("Sending startup directory to renderer:", startupDirectory);
      mainWindow.webContents.send("load-directory-from-cli", startupDirectory);
    }

    // Check for updates in production (REMOVED checkForUpdatesAndNotify to prevent auto-download)
    // Update check is handled in the setTimeout above with checkForUpdates()
  });

  // Open DevTools in development
  // if (isDev) {
  //   mainWindow.webContents.openDevTools();
  // }

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const isZoomModifier = input.control || input.meta;
    if (!isZoomModifier) return;

    const key = input.key?.toLowerCase();
    if (key === "0" || input.code === "Digit0" || input.code === "Numpad0") {
      event.preventDefault();
      resetZoom();
      return;
    }

    if (key === "+" || key === "=" || input.code === "NumpadAdd") {
      event.preventDefault();
      adjustZoom(ZOOM_STEP);
      return;
    }

    if (key === "-" || input.code === "NumpadSubtract") {
      event.preventDefault();
      adjustZoom(-ZOOM_STEP);
    }
  });

  // Handle window closed
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Track fullscreen state changes and notify renderer
  // These events work on macOS, Windows, and Linux
  mainWindow.on("enter-full-screen", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("fullscreen-changed", { isFullscreen: true });
    }
  });

  mainWindow.on("leave-full-screen", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("fullscreen-changed", {
        isFullscreen: false,
      });
    }
  });

  // Additional event for Windows/Linux compatibility
  // Some window managers may not fire enter/leave-full-screen consistently
  let lastKnownFullscreenState = false;
  mainWindow.on("resize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const currentFullscreenState = mainWindow.isFullScreen();
      // Only send if the state actually changed to avoid excessive updates
      if (currentFullscreenState !== lastKnownFullscreenState) {
        lastKnownFullscreenState = currentFullscreenState;
        mainWindow.webContents.send("fullscreen-state-check", {
          isFullscreen: currentFullscreenState,
        });
      }
    }
  });
}

// App event handlers
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      
      const args = commandLine.slice(app.isPackaged ? 1 : 2);
      let potentialPath = null;
      const dirFlagIndex = args.indexOf("--dir");
      
      if (dirFlagIndex !== -1 && args[dirFlagIndex + 1]) {
        potentialPath = args[dirFlagIndex + 1];
      } else {
        potentialPath = args.find((arg) => !arg.startsWith("--"));
      }
      
      if (potentialPath) {
        const fullPath = path.resolve(potentialPath);
        fs.stat(fullPath)
          .then(stats => {
            if (stats.isDirectory()) {
              mainWindow.webContents.send("load-directory-from-cli", fullPath);
            }
          })
          .catch(err => {
            console.warn(`Error checking startup path from second instance: ${err.message}`);
          });
      }
    }
  });
}

app.whenReady().then(async () => {
  // Listen for theme changes and notify renderer
  nativeTheme.on("updated", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const isDark = nativeTheme.shouldUseDarkColors;
      mainWindow.setBackgroundColor(isDark ? '#0a0a0a' : '#ffffff');
      
      // Update title bar overlay to match new theme
      mainWindow.setTitleBarOverlay({
        color: isDark ? '#1a1a1a' : '#f3f4f6',
        symbolColor: isDark ? '#ffffff' : '#000000',
        height: 44
      });

      mainWindow.webContents.send("theme-updated", {
        shouldUseDarkColors: isDark,
      });
    }
  });

  let startupDirectory = null;

  // Check for a directory path provided as a command-line argument
  // In dev, args start at index 2 (`electron . /path`); in packaged app, at index 1 (`app.exe /path`)
  const args = process.argv.slice(app.isPackaged ? 1 : 2);

  // Support both --dir flag and direct path
  let potentialPath = null;
  const dirFlagIndex = args.indexOf("--dir");

  if (dirFlagIndex !== -1 && args[dirFlagIndex + 1]) {
    // Use --dir flag value
    potentialPath = args[dirFlagIndex + 1];
  } else {
    // Fall back to first non-flag argument
    potentialPath = args.find((arg) => !arg.startsWith("--"));
  }

  if (potentialPath) {
    const fullPath = path.resolve(potentialPath);
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        startupDirectory = fullPath;
        console.log("Startup directory specified:", startupDirectory);
      } else {
        console.warn(`Provided startup path is not a directory: ${fullPath}`);
      }
    } catch (error) {
      console.warn(
        `Error checking startup path "${fullPath}": ${error.message}`,
      );
    }
  }

  // Setup IPC handlers for file operations BEFORE creating window
  setupFileOperationHandlers();

  createWindow(startupDirectory);
});

// Setup IPC handlers for file operations
// Store allowed directory paths for security
const allowedDirectoryPaths = new Set();

// Helper function for recursive file search
async function getFilesRecursively(directory, baseDirectory) {
  const files = [];
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await getFilesRecursively(fullPath, baseDirectory)));
      } else if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();
        const isImage =
          lowerName.endsWith(".png") ||
          lowerName.endsWith(".jpg") ||
          lowerName.endsWith(".jpeg") ||
          lowerName.endsWith(".webp") ||
          lowerName.endsWith(".gif");
        const isVideo = Array.from(VIDEO_EXTENSIONS).some((ext) =>
          lowerName.endsWith(ext),
        );
        if (isImage || isVideo) {
          const stats = await fs.stat(fullPath);
          const fileType = getMimeTypeFromName(lowerName);
          files.push({
            name: path.relative(baseDirectory, fullPath).replace(/\\/g, "/"),
            lastModified: stats.birthtimeMs,
            size: stats.size,
            type: fileType,
            birthtimeMs: stats.birthtimeMs,
          });
        }
      }
    }
  } catch (error) {
    // Ignore errors from directories we can't read, e.g. permissions
    console.warn(`Could not read directory ${directory}: ${error.message}`);
  }
  return files;
}

function setupFileOperationHandlers() {
  // Security helper to check if a file path is within one of the allowed directories
  const isPathAllowed = (filePath) => {
    if (!filePath || typeof filePath !== 'string') return false;
    if (allowedDirectoryPaths.size === 0) return false;
    const normalizedFilePath = path.normalize(filePath);
    return Array.from(allowedDirectoryPaths).some((allowedPath) =>
      normalizedFilePath.startsWith(allowedPath),
    );
  };
  const userDataPath = path.normalize(app.getPath("userData"));
  const isInternalPath = (filePath) => {
    if (!filePath) return false;
    const normalized = path.normalize(filePath);
    return (
      normalized === userDataPath ||
      normalized.startsWith(userDataPath + path.sep)
    );
  };
  const isAllowedOrInternal = (filePath) =>
    isPathAllowed(filePath) || isInternalPath(filePath);
  const normalizeNameKey = (name) => name.toLowerCase();
  const getUniqueName = (name, usedNames) => {
    const parsed = path.parse(name);
    let candidate = name;
    let counter = 2;
    while (usedNames.has(normalizeNameKey(candidate))) {
      candidate = `${parsed.name} (${counter})${parsed.ext}`;
      counter += 1;
    }
    usedNames.add(normalizeNameKey(candidate));
    return candidate;
  };

  // --- Settings IPC ---
  ipcMain.handle("get-settings", async () => {
    const settings = await readSettings();
    return settings;
  });

  ipcMain.handle("save-settings", async (event, newSettings) => {
    const currentSettings = await readSettings();
    const mergedSettings = { ...currentSettings, ...newSettings };
    await saveSettings(mergedSettings);
  });

  ipcMain.handle("get-default-cache-path", () => {
    try {
      // Define a specific subfolder for the cache
      const cachePath = path.join(app.getPath("userData"), "ImageMetaHubCache");
      return { success: true, path: cachePath };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-user-data-path", () => {
    return app.getPath("userData");
  });

  ipcMain.handle("get-theme", () => {
    return {
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    };
  });

  ipcMain.handle("get-app-version", () => {
    return app.getVersion();
  });
  // --- End Settings IPC ---

  // --- Cache IPC Handlers ---
  const getCacheFilePath = async (cacheId) => {
    const safeCacheId = cacheId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const rootPath = await getCacheRootPath();
    return path.join(rootPath, `${safeCacheId}.json`);
  };

  ipcMain.handle("get-cached-data", async (event, cacheId) => {
    const filePath = await getCacheFilePath(cacheId);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data);

      // Check parser version - if mismatch, invalidate cache
      if (parsed.parserVersion !== PARSER_VERSION) {
        console.log(
          `⚠️ Cache version mismatch for ${cacheId}: stored=${parsed.parserVersion}, current=${PARSER_VERSION}. Invalidating cache to force re-parse.`,
        );
        return { success: true, data: null }; // Return null to force re-parse with new parser
      }

      return { success: true, data: parsed };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { success: true, data: null }; // File not found is not an error
      }
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-cache-summary", async (event, cacheId) => {
    const filePath = await getCacheFilePath(cacheId);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return { success: true, data: JSON.parse(data) };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { success: true, data: null };
      }
      return { success: false, error: error.message };
    }
  });

  const CHUNK_SIZE = 5000; // Store 5000 images per chunk file

  ipcMain.handle("cache-data", async (event, { cacheId, data }) => {
    const safeCacheId = cacheId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const { metadata, ...cacheRecord } = data;
    const rootPath = await getCacheRootPath();
    const cacheDir = path.join(rootPath, "json_cache");
    await fs.mkdir(cacheDir, { recursive: true });

    // Write chunk files
    const chunkCount = Math.ceil(metadata.length / CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const chunk = metadata.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const chunkPath = path.join(cacheDir, `${safeCacheId}_${i}.json`);
      await fs.writeFile(chunkPath, JSON.stringify(chunk));
    }

    // Write main cache record (without metadata) with parser version
    const mainCachePath = await getCacheFilePath(cacheId);
    cacheRecord.chunkCount = chunkCount;
    cacheRecord.parserVersion = PARSER_VERSION; // Add parser version
    await fs.writeFile(mainCachePath, JSON.stringify(cacheRecord, null, 2));

    return { success: true };
  });

  ipcMain.handle("prepare-cache-write", async (event, { cacheId }) => {
    try {
      const safeCacheId = cacheId.replace(/[^a-zA-Z0-9-_]/g, "_");
      const rootPath = await getCacheRootPath();
      const cacheDir = path.join(rootPath, "json_cache");
      await fs.mkdir(cacheDir, { recursive: true });

      try {
        const files = await fs.readdir(cacheDir);
        await Promise.all(
          files
            .filter((file) => file.startsWith(`${safeCacheId}_`))
            .map((file) =>
              fs.unlink(path.join(cacheDir, file)).catch((err) => {
                if (err.code !== "ENOENT") throw err;
              }),
            ),
        );
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "write-cache-chunk",
    async (event, { cacheId, chunkIndex, data }) => {
      try {
        const safeCacheId = cacheId.replace(/[^a-zA-Z0-9-_]/g, "_");
        const rootPath = await getCacheRootPath();
        const cacheDir = path.join(rootPath, "json_cache");
        await fs.mkdir(cacheDir, { recursive: true });
        const chunkPath = path.join(
          cacheDir,
          `${safeCacheId}_${chunkIndex}.json`,
        );
        await fs.writeFile(chunkPath, JSON.stringify(data));
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle("finalize-cache-write", async (event, { cacheId, record }) => {
    try {
      const mainCachePath = await getCacheFilePath(cacheId);
      // Add parser version to cache record
      const recordWithVersion = { ...record, parserVersion: PARSER_VERSION };
      await fs.writeFile(
        mainCachePath,
        JSON.stringify(recordWithVersion, null, 2),
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-cache-chunk", async (event, { cacheId, chunkIndex }) => {
    const safeCacheId = cacheId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const rootPath = await getCacheRootPath();
    const cacheDir = path.join(rootPath, "json_cache");
    const chunkPath = path.join(cacheDir, `${safeCacheId}_${chunkIndex}.json`);
    try {
      const data = await fs.readFile(chunkPath, "utf-8");
      return { success: true, data: JSON.parse(data) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("clear-cache-data", async (event, cacheId) => {
    const safeCacheId = cacheId.replace(/[^a-zA-Z0-9-_]/g, "_");
    const rootPath = await getCacheRootPath();
    const cacheDir = path.join(rootPath, "json_cache");
    const mainCachePath = await getCacheFilePath(cacheId);

    try {
      // Delete main cache file
      await fs.unlink(mainCachePath).catch((err) => {
        if (err.code !== "ENOENT") throw err;
      });

      // Delete chunk files
      const files = await fs.readdir(cacheDir);
      for (const file of files) {
        if (file.startsWith(`${safeCacheId}_`)) {
          await fs.unlink(path.join(cacheDir, file));
        }
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // --- Thumbnail Cache IPC Handlers ---
  const getThumbnailCachePath = async (thumbnailId) => {
    const rootPath = await getCacheRootPath();
    const cacheDir = path.join(rootPath, "thumbnails");
    await fs.mkdir(cacheDir, { recursive: true });

    // Use MD5 hash for long IDs to avoid Windows MAX_PATH (260 char) limit
    // Windows path limit includes the full path, not just the filename
    // Reserve ~100 chars for the base path, leaving ~160 for the filename
    const MAX_FILENAME_LENGTH = 160;

    let safeId;
    if (thumbnailId.length > MAX_FILENAME_LENGTH) {
      // Use MD5 hash for very long IDs (32 hex chars)
      const hash = crypto.createHash("md5").update(thumbnailId).digest("hex");
      safeId = hash;
    } else {
      // For shorter IDs, just sanitize special characters
      safeId = thumbnailId.replace(/[^a-zA-Z0-9-_]/g, "_");
    }

    return path.join(cacheDir, `${safeId}.webp`);
  };

  ipcMain.handle("get-thumbnail", async (event, thumbnailId) => {
    const filePath = await getThumbnailCachePath(thumbnailId);
    try {
      const data = await fs.readFile(filePath);
      return { success: true, data };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { success: true, data: null }; // Not an error
      }
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("cache-thumbnail", async (event, { thumbnailId, data }) => {
    const filePath = await getThumbnailCachePath(thumbnailId);
    try {
      await fs.writeFile(filePath, data);
      return { success: true };
    } catch (error) {
      // Log the error with context for debugging
      const isPathTooLong =
        error.code === "ENAMETOOLONG" ||
        error.message?.includes("path too long");
      const isPermissionError =
        error.code === "EACCES" || error.code === "EPERM";

      if (isPathTooLong) {
        console.error(
          `Thumbnail path too long (this should not happen with hashing):`,
          {
            thumbnailIdLength: thumbnailId.length,
            filePathLength: filePath.length,
            error: error.message,
          },
        );
      } else if (!isPermissionError) {
        console.error("Error caching thumbnail:", error);
      }

      return { success: false, error: error.message, errorCode: error.code };
    }
  });

  ipcMain.handle("delete-thumbnails-batch", async (event, thumbnailIds) => {
    try {
      if (!Array.isArray(thumbnailIds)) return { success: false, error: "Invalid argument" };
      let deletedCount = 0;
      for (const id of thumbnailIds) {
        const filePath = await getThumbnailCachePath(id);
        await fs.unlink(filePath).catch(err => {
          if (err.code !== "ENOENT") console.warn(`Failed to delete thumbnail ${id}:`, err);
        });
        deletedCount++;
      }
      return { success: true, deletedCount };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("clear-metadata-cache", async () => {
    try {
      const rootPath = await getCacheRootPath();
      const cacheDir = path.join(rootPath, "json_cache");
      if (fs.existsSync(cacheDir)) {
        await fs.promises.rm(cacheDir, { recursive: true, force: true });
        await fs.promises.mkdir(cacheDir, { recursive: true });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("clear-thumbnail-cache", async () => {
    try {
      const rootPath = await getCacheRootPath();
      const cacheDir = path.join(rootPath, "thumbnails");
      if (fs.existsSync(cacheDir)) {
        await fs.promises.rm(cacheDir, { recursive: true, force: true });
        await fs.promises.mkdir(cacheDir, { recursive: true });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Delete all cache files and folders (but not userData itself, as app is using it)
  ipcMain.handle("delete-cache-folder", async () => {
    try {
      const userDataDir = app.getPath("userData");
      try {
        const files = await fs.readdir(userDataDir);

        // Delete each file/folder inside userData
        for (const file of files) {
          const filePath = path.join(userDataDir, file);
          const stat = await fs.stat(filePath);

          if (stat.isDirectory()) {
            // Recursively delete directories
            await fs.rm(filePath, { recursive: true, force: true });
          } else {
            // Delete files
            await fs.unlink(filePath);
          }
        }
      } catch (error) {
        // If userData doesn't exist or can't be read, that's fine (already clean)
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      return { success: true, needsRestart: true };
    } catch (error) {
      console.error("Error deleting cache folder:", error);
      return { success: false, error: error.message, needsRestart: false };
    }
  });

  // Restart the application (used after cache reset)
  ipcMain.handle("restart-app", async () => {
    try {
      console.log("🔄 Restarting application...");
      app.relaunch();
      app.quit();
      return { success: true };
    } catch (error) {
      console.error("Error restarting app:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("exit-app", () => {
    app.quit();
  });

  ipcMain.handle("minimize-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
  });

  ipcMain.handle("close-window", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.close();
  });

  ipcMain.handle("execute-edit-action", (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    switch (action) {
      case "undo": win.webContents.undo(); break;
      case "redo": win.webContents.redo(); break;
      case "cut": win.webContents.cut(); break;
      case "copy": win.webContents.copy(); break;
      case "paste": win.webContents.paste(); break;
      case "selectAll": win.webContents.selectAll(); break;
      case "toggleDevTools": win.webContents.toggleDevTools(); break;
      case "zoomIn": adjustZoom(ZOOM_STEP); break;
      case "zoomOut": adjustZoom(-ZOOM_STEP); break;
      case "resetZoom": resetZoom(); break;
    }
  });

  // --- End Thumbnail Cache IPC Handlers ---
  // --- End Cache IPC Handlers ---

  // Handle updating the set of allowed directories for file operations
  ipcMain.handle("update-allowed-paths", (event, paths) => {
    try {
      if (!Array.isArray(paths)) {
        return {
          success: false,
          error: "Invalid paths provided. Must be an array.",
        };
      }

      // Normalize and sort paths to reliably compare them
      const normalizedNewPaths = paths.map((p) => path.normalize(p)).sort();
      const normalizedCurrentPaths = Array.from(allowedDirectoryPaths).sort();

      // Skip if the paths haven't changed to prevent log spam
      if (
        normalizedNewPaths.length === normalizedCurrentPaths.length &&
        normalizedNewPaths.every((p, i) => p === normalizedCurrentPaths[i])
      ) {
        return { success: true };
      }

      allowedDirectoryPaths.clear();
      for (const normalized of normalizedNewPaths) {
        allowedDirectoryPaths.add(normalized);
        console.log("[Main] Added allowed directory:", normalized);
      }
      console.log(
        "[Main] Total allowed directories:",
        allowedDirectoryPaths.size,
      );
      return { success: true };
    } catch (error) {
      console.error("Error updating allowed paths:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on("start-file-drag", async (event, payload) => {
    try {
      const directoryPath = payload?.directoryPath;
      const relativePath = payload?.relativePath;
      const id = payload?.id;
      const lastModified = payload?.lastModified;

      if (!directoryPath || !relativePath) {
        return;
      }

      const fullPath = path.resolve(directoryPath, relativePath);
      if (!isPathAllowed(fullPath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to drag file outside of allowed directories.",
        );
        return;
      }

      let dragIcon;

      // Try to use cached thumbnail if ID and lastModified are provided
      if (id && lastModified) {
        try {
          // Construct thumbnail key: ${id}-${lastModified}
          const thumbnailKey = `${id}-${lastModified}`;
          const thumbnailPath = await getThumbnailCachePath(thumbnailKey);

          // Check if thumbnail exists
          try {
            await fs.access(thumbnailPath);

            // Read file into buffer
            const buffer = await fs.readFile(thumbnailPath);

            // Try Data URL approach first (better WebP support)
            const dataUrl = `data:image/webp;base64,${buffer.toString("base64")}`;
            dragIcon = nativeImage.createFromDataURL(dataUrl);

            // If DataURL failed, try direct buffer
            if (dragIcon.isEmpty()) {
              dragIcon = nativeImage.createFromBuffer(buffer);
            }

            if (!dragIcon.isEmpty()) {
              // console.log("[Drag] Using cached thumbnail:", thumbnailPath);
            }
          } catch (err) {
            // Thumbnail doesn't exist or read failed, will fall back
          }
        } catch (error) {
          console.error("[Drag] Error resolving thumbnail path:", error);
        }
      }

      // Fallback: If thumbnail failed or wasn't available, resize the full image
      if (!dragIcon || dragIcon.isEmpty()) {
        const fileIcon = nativeImage.createFromPath(fullPath);

        if (fileIcon && !fileIcon.isEmpty()) {
          // Resize to a reasonable thumbnail size (e.g., 256x256) to avoid dragging huge images
          dragIcon = fileIcon.resize({
            width: 256,
            height: 256,
            quality: "best",
          });
        } else {
          dragIcon = nativeImage.createFromPath(getIconPath());
        }
      }

      event.sender.startDrag({ file: fullPath, icon: dragIcon });
    } catch (error) {
      console.error("Error starting file drag:", error);
    }
  });

  // Handle directory selection for Electron
  ipcMain.handle("show-directory-dialog", async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ["openDirectory"],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const selectedPath = result.filePaths[0];
      // NOTE: Don't update currentDirectoryPath here - this is for export destination selection
      // currentDirectoryPath should remain as the source directory

      return {
        success: true,
        path: selectedPath,
        name: path.basename(selectedPath),
      };
    } catch (error) {
      console.error("Error showing directory dialog:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("show-save-dialog", async (event, options = {}) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow, options);
      if (result.canceled) {
        return { success: true, canceled: true };
      }
      return { success: true, canceled: false, path: result.filePath };
    } catch (error) {
      console.error("Error showing save dialog:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle file deletion (move to trash)
  ipcMain.handle("trash-file", async (event, filePath) => {
    try {
      if (!isPathAllowed(filePath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to trash file outside of allowed directories.",
        );
        return {
          success: false,
          error:
            "Access denied: Cannot trash files outside of the allowed directories.",
        };
      }

      console.log("Attempting to trash file:", filePath);
      await shell.trashItem(filePath);
      return { success: true };
    } catch (error) {
      console.error("Error trashing file:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle file renaming
  ipcMain.handle("rename-file", async (event, oldPath, newPath) => {
    try {
      if (!isAllowedOrInternal(oldPath) || !isAllowedOrInternal(newPath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to rename file outside of allowed directories.",
        );
        return {
          success: false,
          error:
            "Access denied: Cannot rename files outside of the allowed directories.",
        };
      }

      console.log("Attempting to rename file:", oldPath, "to", newPath);
      await fs.rename(oldPath, newPath);
      return { success: true };
    } catch (error) {
      console.error("Error renaming file:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle batch file moving
  ipcMain.handle("move-files", async (event, args) => {
    try {
      const { files, targetDir } = args;
      if (!files || !Array.isArray(files) || !targetDir) {
        return { success: false, error: "Invalid arguments" };
      }

      if (!isPathAllowed(targetDir)) {
        return {
          success: false,
          error: "Access denied: Target directory not allowed",
        };
      }

      const results = [];
      const sourceDirectories = new Set();
      const usedNames = new Set();

      // Pre-populate used names from target directory to avoid collisions with existing files
      try {
        const existing = await fs.readdir(targetDir);
        existing.forEach((name) => usedNames.add(normalizeNameKey(name)));
      } catch (err) {
        // If we can't read target dir, we might have issues, but let's try to proceed or fail individual files
        console.error(
          "Error reading target directory for collision check:",
          err,
        );
      }

      // Helper for robust file moving (handles cross-device moves)
      const moveFile = async (src, dest) => {
        try {
          await fs.rename(src, dest);
        } catch (err) {
          if (err.code === 'EXDEV') {
            // Cross-device move: copy and unlink
            await fs.copyFile(src, dest);
            await fs.unlink(src);
          } else {
            throw err;
          }
        }
      };

      for (const file of files) {
        const { sourcePath, name } = file;

        if (!isPathAllowed(sourcePath)) {
          results.push({ sourcePath, success: false, error: "Access denied" });
          continue;
        }

        try {
          const sourceDir = path.dirname(sourcePath);
          sourceDirectories.add(sourceDir);

          // Determine unique target name
          const uniqueName = getUniqueName(name, usedNames);
          const targetPath = path.join(targetDir, uniqueName);

          await moveFile(sourcePath, targetPath);
          results.push({ sourcePath, targetPath, success: true });
        } catch (err) {
          console.error(`Error moving file ${sourcePath}:`, err);
          results.push({ sourcePath, success: false, error: err.message });
        }
      }

      return {
        success: true,
        results,
        sourceDirectories: Array.from(sourceDirectories),
      };
    } catch (error) {
      console.error("Error moving files:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle show item in folder
  ipcMain.handle("show-item-in-folder", async (event, filePath) => {
    try {
      if (!isPathAllowed(filePath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to show item outside of allowed directories.",
        );
        return {
          success: false,
          error:
            "Access denied: Cannot show items outside of the allowed directories.",
        };
      }

      const normalizedFilePath = path.normalize(filePath);
      console.log("📂 Attempting to show item in folder:", normalizedFilePath);

      // Verify the file exists before trying to show it
      try {
        await fs.access(normalizedFilePath);
        console.log("✅ File exists:", normalizedFilePath);
      } catch (accessError) {
        console.error(
          "❌ File does not exist:",
          normalizedFilePath,
          accessError,
        );
        return {
          success: false,
          error: `File does not exist: ${normalizedFilePath}`,
        };
      }

      shell.showItemInFolder(normalizedFilePath);
      console.log("✅ shell.showItemInFolder called for:", normalizedFilePath);

      return { success: true };
    } catch (error) {
      console.error("❌ Error showing item in folder:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle open directory directly
  ipcMain.handle("open-directory", async (event, dirPath) => {
    try {
      if (!isPathAllowed(dirPath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to open directory outside of allowed directories.",
        );
        return {
          success: false,
          error:
            "Access denied: Cannot open directories outside of the allowed directories.",
        };
      }

      const normalizedPath = path.normalize(dirPath);
      console.log("📂 Attempting to open directory:", normalizedPath);

      // Verify the directory exists before trying to open it
      try {
        const stats = await fs.stat(normalizedPath);
        if (!stats.isDirectory()) {
          return { success: false, error: "Path is not a directory" };
        }
      } catch (accessError) {
        return {
          success: false,
          error: `Directory does not exist: ${normalizedPath}`,
        };
      }

      const errorMessage = await shell.openPath(normalizedPath);
      if (errorMessage) {
        return { success: false, error: errorMessage };
      }
      console.log("✅ shell.openPath called for:", normalizedPath);

      return { success: true };
    } catch (error) {
      console.error("❌ Error opening directory:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("is-dev", () => isDev);

  // Handle open cache location (without security restrictions since it's app's internal cache)
  ipcMain.handle("open-cache-location", async (event, cachePath) => {
    try {
      const normalizedCachePath = path.normalize(cachePath);
      const parentPath = path.dirname(normalizedCachePath);
      console.log("📂 Opening cache parent directory:", parentPath);

      shell.showItemInFolder(parentPath);
      console.log("✅ shell.showItemInFolder called for:", parentPath);

      return { success: true };
    } catch (error) {
      console.error("❌ Error opening cache location:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("list-subfolders", async (event, folderPath) => {
    try {
      if (!isPathAllowed(folderPath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to list subfolders outside of allowed directories.",
        );
        return {
          success: false,
          error:
            "Access denied: Cannot list subfolders outside of the allowed directories.",
        };
      }

      const normalizedPath = path.normalize(folderPath);


      // Verify the folder exists
      try {
        const stats = await fs.stat(normalizedPath);
        if (!stats.isDirectory()) {
          console.error("❌ Path is not a directory:", normalizedPath);
          return { success: false, error: "Path is not a directory" };
        }
      } catch (accessError) {
        console.error("❌ Folder does not exist:", normalizedPath, accessError);
        return {
          success: false,
          error: `Folder does not exist: ${normalizedPath}`,
        };
      }

      // Read directory and filter to only directories
      const entries = await fs.readdir(normalizedPath, { withFileTypes: true });
      const subfolders = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.join(normalizedPath, entry.name),
        }));


      return { success: true, subfolders };
    } catch (error) {
      console.error("❌ Error listing subfolders:", error);
      return { success: false, error: error.message };
    }
  });

  // TEST ONLY: Simulate update available dialog
  ipcMain.handle("test-update-dialog", async () => {
    if (!mainWindow) {
      return { success: false, error: "Main window not available" };
    }

    // Simulate update info
    const mockUpdateInfo = {
      version: pkg.version,
      releaseNotes: `## [0.13.0] - Release

### Major Performance Improvements
- **3-5x Faster Loading**: Batch IPC operations reduce 1000+ calls to a single batch
- **40-60% Fewer Re-renders**: Granular Zustand selectors optimize component updates
- **Phase B Optimizations**: Metadata enrichment now ~13ms per file (down from ~30ms)
- **Smoother Navigation**: Bounded thumbnail queue with stale request cancellation

### New Features
- **Comparison Modes**: Slider and hover modes for side-by-side image comparison
- **Component Memoization**: Sidebar and preview components prevent unnecessary re-renders
- **Optimized Rendering**: Improved grid and table view performance for large datasets`,
    };

    // Extract and format changelog
    let changelogText = "No release notes available.";

    if (mockUpdateInfo.releaseNotes) {
      changelogText = mockUpdateInfo.releaseNotes
        .replace(/#{1,6}\s/g, "") // Remove markdown headers
        .replace(/\*\*/g, "") // Remove bold markers
        .replace(/\*/g, "•") // Convert asterisks to bullets
        .replace(/<[^>]*>/g, "") // Remove HTML tags
        .trim();
    }

    // Limit changelog length
    if (changelogText.length > 500) {
      changelogText = changelogText.substring(0, 497) + "...";
    }

    const result = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "🎉 Update Available (TEST)",
      message: `Version ${mockUpdateInfo.version} is ready to download!`,
      detail: `What's new:\n\n${changelogText}\n\nWould you like to download this update now?`,
      buttons: ["Download Now", "Download Later", "Skip this version"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });

    return { success: true, response: result.response };
  });

  // Handle listing directory files
  ipcMain.handle(
    "list-directory-files",
    async (event, { dirPath, recursive = false }) => {
      try {
        if (!dirPath) {
          return { success: false, error: "No directory path provided" };
        }

        let imageFiles = [];

        if (recursive) {
          imageFiles = await getFilesRecursively(dirPath, dirPath);
        } else {
          const files = await fs.readdir(dirPath, { withFileTypes: true });

          for (const file of files) {
            if (file.isFile()) {
              const name = file.name.toLowerCase();
              const isImage =
                name.endsWith(".png") ||
                name.endsWith(".jpg") ||
                name.endsWith(".jpeg") ||
                name.endsWith(".webp");
              const isVideo = Array.from(VIDEO_EXTENSIONS).some((ext) =>
                name.endsWith(ext),
              );
              if (isImage || isVideo) {
                const filePath = path.join(dirPath, file.name);
                const stats = await fs.stat(filePath);
                const fileType = getMimeTypeFromName(name);
                imageFiles.push({
                  name: file.name, // name is already relative for top-level
                  lastModified: stats.birthtimeMs,
                  size: stats.size,
                  type: fileType,
                  birthtimeMs: stats.birthtimeMs,
                });
              }
            }
          }
        }

        return { success: true, files: imageFiles };
      } catch (error) {
        console.error("Error listing directory files:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // ============================================================
  // File Watching Handlers
  // ============================================================

  ipcMain.handle("start-watching-directory", async (event, args) => {
    const { directoryId, dirPath } = args;

    if (!directoryId || !dirPath) {
      return { success: false, error: "Missing required parameters" };
    }

    // Validar se o path está permitido
    if (!isPathAllowed(dirPath)) {
      return { success: false, error: "Path not allowed" };
    }

    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (!mainWindow) {
      return { success: false, error: "No window available" };
    }

    return fileWatcher.startWatching(directoryId, dirPath, mainWindow);
  });

  ipcMain.handle("checkDirectoryConnection", async (event, dirPath) => {
    try {
      await fs.access(dirPath);
      return { success: true, isConnected: true };
    } catch (error) {
      // If access fails, we assume it's disconnected (or at least not accessible)
      return { success: true, isConnected: false };
    }
  });

  ipcMain.handle("stop-watching-directory", async (event, args) => {
    const { directoryId } = args;

    if (!directoryId) {
      return { success: false, error: "Missing directoryId" };
    }

    return fileWatcher.stopWatching(directoryId);
  });

  ipcMain.handle("get-watcher-status", async (event, args) => {
    const { directoryId } = args;

    if (!directoryId) {
      return { success: false, active: false };
    }

    const status = fileWatcher.getWatcherStatus(directoryId);
    return { success: true, ...status };
  });

  // Handle reading file content
  ipcMain.handle("read-file", async (event, filePath) => {
    try {
      if (!filePath) {
        return { success: false, error: "No file path provided" };
      }

      if (!isAllowedOrInternal(filePath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to read file outside of allowed directories.",
        );
        console.error("  [read-file] Requested path:", filePath);
        console.error(
          "  [read-file] Normalized path:",
          path.normalize(filePath),
        );
        console.error(
          "  [read-file] Allowed directories:",
          Array.from(allowedDirectoryPaths),
        );
        return {
          success: false,
          error: "Access denied",
          errorType: "PERMISSION_DENIED",
        };
      }

      const data = await fs.readFile(filePath);
      // console.log('Read file:', filePath, 'Size:', data.length); // Commented out to reduce console noise

      return { success: true, data: data };
    } catch (error) {
      // Classify the error type for better handling in the frontend
      const isFileNotFound =
        error.code === "ENOENT" || error.message?.includes("no such file");
      const isPermissionError =
        error.code === "EACCES" || error.code === "EPERM";

      // Only log non-ENOENT errors to avoid spam when cache is stale
      if (!isFileNotFound) {
        console.error("Error reading file:", filePath, error);
      }

      return {
        success: false,
        error: error.message,
        errorType: isFileNotFound
          ? "FILE_NOT_FOUND"
          : isPermissionError
            ? "PERMISSION_ERROR"
            : "UNKNOWN_ERROR",
        errorCode: error.code,
      };
    }
  });

  ipcMain.handle("read-video-metadata", async (event, args) => {
    try {
      const filePath = args?.filePath;
      if (!filePath) {
        return { success: false, error: "No file path provided" };
      }

      if (!isPathAllowed(filePath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to read file outside of allowed directories.",
        );
        console.error("  [read-video-metadata] Requested path:", filePath);
        console.error(
          "  [read-video-metadata] Normalized path:",
          path.normalize(filePath),
        );
        console.error(
          "  [read-video-metadata] Allowed directories:",
          Array.from(allowedDirectoryPaths),
        );
        return {
          success: false,
          error: "Access denied",
          errorType: "PERMISSION_DENIED",
        };
      }

      const metadata = await readVideoMetadataWithFfprobe(filePath);
      return { success: true, ...metadata };
    } catch (error) {
      const isBinaryMissing =
        error?.code === "ENOENT" || error?.message?.includes("ffprobe");
      return {
        success: false,
        error: isBinaryMissing
          ? "FFPROBE_NOT_FOUND"
          : error?.message || String(error),
      };
    }
  });

  // Handle getting skipped versions
  ipcMain.handle("get-skipped-versions", () => {
    return { success: true, skippedVersions: Array.from(skippedVersions) };
  });

  // Handle clearing skipped versions
  ipcMain.handle("clear-skipped-versions", () => {
    const count = skippedVersions.size;
    skippedVersions.clear();
    console.log("Cleared", count, "skipped versions");
    return { success: true, clearedCount: count };
  });

  // Handle skipping a specific version
  ipcMain.handle("skip-version", (event, version) => {
    if (version) {
      skippedVersions.add(version);
      console.log("Manually skipped version:", version);
      return { success: true };
    }
    return { success: false, error: "Version not provided" };
  });

  // Handle toggling fullscreen
  ipcMain.handle("toggle-fullscreen", () => {
    if (mainWindow) {
      const isFullscreen = !mainWindow.isFullScreen();
      mainWindow.setFullScreen(isFullscreen);
      return { success: true, isFullscreen };
    }
    return { success: false, error: "Main window not available" };
  });

  // Handle setting window controls visibility
  ipcMain.handle("set-window-controls-visibility", (event, visible) => {
    if (!mainWindow) return { success: false, error: "Main window not available" };

    if (process.platform === "darwin") {
      mainWindow.setWindowButtonVisibility(visible);
    } else if (process.platform === "win32") {
      if (visible) {
        mainWindow.setTitleBarOverlay({
          height: 32,
          color: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#f3f4f6',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000',
        });
      } else {
        // Decide to hide it completely by setting height to 0 and colors to transparent
        mainWindow.setTitleBarOverlay({
          height: 0,
          color: '#00000000', // Using ARGB/RGBA transparent hex if supported, or 'transparent'
          symbolColor: '#00000000',
        });
      }
    }
    return { success: true };
  });

  // Handle reading multiple files in a batch
  ipcMain.handle("read-files-batch", async (event, filePaths) => {
    try {
      if (!Array.isArray(filePaths) || filePaths.length === 0) {
        return { success: false, error: "No file paths provided" };
      }

      // --- SECURITY CHECK ---
      for (const filePath of filePaths) {
        if (!isPathAllowed(filePath)) {
          console.error(
            "SECURITY VIOLATION: Attempted to read file outside of allowed directories.",
          );
          console.error("  Requested path:", filePath);
          console.error("  Normalized path:", path.normalize(filePath));
          console.error(
            "  Allowed directories:",
            Array.from(allowedDirectoryPaths),
          );
          return {
            success: false,
            error:
              "Access denied: Cannot read files outside of the allowed directories.",
          };
        }
      }
      // --- END SECURITY CHECK ---

      const promises = filePaths.map((filePath) => fs.readFile(filePath));
      const results = await Promise.allSettled(promises);

      const data = results.map((result, index) => {
        if (result.status === "fulfilled") {
          return { success: true, data: result.value, path: filePaths[index] };
        } else {
          if (!result.reason.message?.includes("ENOENT")) {
            console.error(
              "Error reading file in batch:",
              filePaths[index],
              result.reason,
            );
          }
          return {
            success: false,
            error: result.reason.message,
            path: filePaths[index],
          };
        }
      });

      return { success: true, files: data };
    } catch (error) {
      console.error("Error in read-files-batch handler:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "read-files-head-batch",
    async (event, { filePaths, maxBytes }) => {
      const start = performance.now();
      try {
        if (!Array.isArray(filePaths) || filePaths.length === 0) {
          return { success: false, error: "No file paths provided" };
        }

        // --- SECURITY CHECK ---
        for (const filePath of filePaths) {
          if (!isPathAllowed(filePath)) {
            console.error(
              "SECURITY VIOLATION: Attempted to read file outside of allowed directories.",
            );
            console.error("  Requested path:", filePath);
            console.error("  Normalized path:", path.normalize(filePath));
            console.error(
              "  Allowed directories:",
              Array.from(allowedDirectoryPaths),
            );
            return {
              success: false,
              error:
                "Access denied: Cannot read files outside of the allowed directories.",
            };
          }
        }
        // --- END SECURITY CHECK ---

        const FALLBACK_HEAD_BYTES = 256 * 1024;
        const MAX_HEAD_BYTES = 2 * 1024 * 1024;
        const requestedBytes =
          typeof maxBytes === "number" ? maxBytes : FALLBACK_HEAD_BYTES;
        const safeBytes = Math.max(1, Math.min(requestedBytes, MAX_HEAD_BYTES));

        // Use Synchronous operations to bypass UV Threadpool overhead
        // This emulates the performance characteristics of PowerShell/CMD
        const results = new Array(filePaths.length);

        let totalOpenTime = 0;
        let totalReadTime = 0;

        for (let i = 0; i < filePaths.length; i++) {
          const filePath = filePaths[i];

          // Yield every 5 files to prevent Main Process freeze
          if (i > 0 && i % 5 === 0) {
            await new Promise((resolve) => setImmediate(resolve));
          }

          try {
            const t0 = performance.now();
            const fd = fsSync.openSync(filePath, "r");
            const t1 = performance.now();
            totalOpenTime += t1 - t0;

            try {
              const buffer = Buffer.allocUnsafe(safeBytes);
              // readSync returns bytesRead directly
              const bytesRead = fsSync.readSync(fd, buffer, 0, safeBytes, 0);
              const t2 = performance.now();
              totalReadTime += t2 - t1;

              results[i] = {
                status: "fulfilled",
                value: {
                  success: true,
                  data: buffer.subarray(0, bytesRead),
                  bytesRead,
                  path: filePath,
                },
              };
            } finally {
              fsSync.closeSync(fd);
            }
          } catch (error) {
            results[i] = { status: "rejected", reason: error };
          }
        }

        console.log(
          `[Main] Batch(${filePaths.length}) - Sync Open: ${totalOpenTime.toFixed(1)}ms, Sync Read: ${totalReadTime.toFixed(1)}ms`,
        );

        const data = results.map((result, index) => {
          if (result.status === "fulfilled") {
            return result.value;
          }
          if (!result.reason.message?.includes("ENOENT")) {
            console.error(
              "Error reading file head in batch:",
              filePaths[index],
              result.reason,
            );
          }
          return {
            success: false,
            error: result.reason.message,
            path: filePaths[index],
          };
        });

        const response = {
          success: true,
          files: data,
          debug: {
            totalTime: performance.now() - start,
            openTime: totalOpenTime,
            readTime: totalReadTime,
            avgPerFile: (totalOpenTime + totalReadTime) / filePaths.length,
            concurrency: 1,
          },
        };

        return response;
      } catch (error) {
        console.error("Error in read-files-head-batch handler:", error);
        return { success: false, error: error.message };
      }
    },
  );

  ipcMain.handle(
    "read-files-tail-batch",
    async (event, { filePaths, maxBytes }) => {
      try {
        if (!Array.isArray(filePaths) || filePaths.length === 0) {
          return { success: false, error: "No file paths provided" };
        }

        // --- SECURITY CHECK ---
        for (const filePath of filePaths) {
          if (!isPathAllowed(filePath)) {
            console.error(
              "SECURITY VIOLATION: Attempted to read file outside of allowed directories.",
            );
            console.error("  Requested path:", filePath);
            console.error("  Normalized path:", path.normalize(filePath));
            console.error(
              "  Allowed directories:",
              Array.from(allowedDirectoryPaths),
            );
            return {
              success: false,
              error:
                "Access denied: Cannot read files outside of the allowed directories.",
            };
          }
        }
        // --- END SECURITY CHECK ---

        const FALLBACK_TAIL_BYTES = 256 * 1024;
        const MAX_TAIL_BYTES = 2 * 1024 * 1024;
        const requestedBytes =
          typeof maxBytes === "number" ? maxBytes : FALLBACK_TAIL_BYTES;
        const safeBytes = Math.max(1, Math.min(requestedBytes, MAX_TAIL_BYTES));

        const promises = filePaths.map(async (filePath) => {
          const handle = await fs.open(filePath, "r");
          try {
            const stats = await handle.stat();
            const fileSize = stats.size ?? 0;
            const readSize = Math.min(safeBytes, fileSize);
            const start = Math.max(0, fileSize - readSize);
            const buffer = Buffer.allocUnsafe(readSize);
            const { bytesRead } = await handle.read(buffer, 0, readSize, start);
            return {
              success: true,
              data: buffer.subarray(0, bytesRead),
              bytesRead,
              path: filePath,
            };
          } finally {
            await handle.close();
          }
        });
        const results = await Promise.allSettled(promises);

        const data = results.map((result, index) => {
          if (result.status === "fulfilled") {
            return result.value;
          }
          if (!result.reason.message?.includes("ENOENT")) {
            console.error(
              "Error reading file tail in batch:",
              filePaths[index],
              result.reason,
            );
          }
          return {
            success: false,
            error: result.reason.message,
            path: filePaths[index],
          };
        });

        return { success: true, files: data };
      } catch (error) {
        console.error("Error in read-files-tail-batch handler:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Handle getting file statistics (creation date, etc.)
  ipcMain.handle("get-file-stats", async (event, filePath) => {
    try {
      if (!filePath) {
        return { success: false, error: "No file path provided" };
      }

      // --- SECURITY CHECK ---
      if (!isPathAllowed(filePath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to get stats for file outside of allowed directories.",
        );
        return {
          success: false,
          error:
            "Access denied: Cannot get stats for files outside of the selected directory.",
        };
      }
      // --- END SECURITY CHECK ---

      const stats = await fs.stat(filePath);
      return {
        success: true,
        stats: {
          size: stats.size,
          birthtime: stats.birthtime,
          birthtimeMs: stats.birthtimeMs,
          mtime: stats.mtime,
          mtimeMs: stats.mtimeMs,
          ctime: stats.ctime,
          ctimeMs: stats.ctimeMs,
        },
      };
    } catch (error) {
      console.error("Error getting file stats:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle path joining
  ipcMain.handle("join-paths", async (event, ...paths) => {
    try {
      if (!paths || paths.length === 0) {
        return { success: false, error: "No paths provided to join" };
      }
      // Use path.resolve to ensure we get an absolute path
      const joinedPath = path.resolve(...paths);
      return { success: true, path: joinedPath };
    } catch (error) {
      console.error("Error joining paths:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle batch path joining - optimized for processing multiple paths at once
  ipcMain.handle("join-paths-batch", async (event, { basePath, fileNames }) => {
    try {
      if (!basePath) {
        return { success: false, error: "No base path provided" };
      }
      if (!Array.isArray(fileNames) || fileNames.length === 0) {
        return { success: false, error: "No file names provided" };
      }

      // Process all paths in a single call
      const paths = fileNames.map((fileName) =>
        path.resolve(basePath, fileName),
      );
      return { success: true, paths };
    } catch (error) {
      console.error("Error joining paths in batch:", error);
      return { success: false, error: error.message };
    }
  });

  // Handle writing file content
  ipcMain.handle("write-file", async (event, filePath, data) => {
    try {
      if (!filePath) {
        return { success: false, error: "No file path provided" };
      }

      if (!data) {
        return { success: false, error: "No data provided" };
      }

      // --- SECURITY CHECK ---
      // For write operations, we need to be more careful about where files can be written
      // We'll allow writing to any directory the user has selected via the directory dialog
      // This is more permissive than read operations but still controlled
      const normalizedFilePath = path.normalize(filePath);

      // Check if the target directory is within the current directory or a user-selected export directory
      // For now, we'll allow writing to any directory (since users explicitly choose export locations)
      // But we should add additional validation in the future if needed

      console.log("Writing file to:", normalizedFilePath, "Size:", data.length);

      await fs.writeFile(normalizedFilePath, data);
      return { success: true };
    } catch (error) {
      console.error("Error writing file:", error);
      return { success: false, error: error.message };
    }
  });



  ipcMain.handle("delete-file", async (event, filePath) => {
    try {
      if (!isInternalPath(filePath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to delete file outside userData.",
        );
        return {
          success: false,
          error: "Access denied: Cannot delete files outside userData.",
        };
      }
      await fs.unlink(filePath);
      return { success: true };
    } catch (error) {
      if (error.code === "ENOENT") {
        return { success: true };
      }
      console.error("Error deleting file:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.on("start-file-drag", async (event, args) => {
    const { files, directoryPath, relativePath } = args;
    
    let filePaths = [];
    
    if (files && Array.isArray(files) && files.length > 0) {
        filePaths = files;
    } else if (directoryPath && relativePath) {
        filePaths = [path.join(directoryPath, relativePath)];
    }
    
    if (filePaths.length === 0) return;
    
    const primaryFile = filePaths[0];
    
    // Create icon with robust fallback (using primary file)
    let icon;
    try {
       // Try image path first
       icon = await nativeImage.createThumbnailFromPath(primaryFile, { width: 64, height: 64 });
       if (icon.isEmpty()) throw new Error("Empty thumbnail");
    } catch (e) {
       console.log('[Main] Thumbnail generation failed, using fallback:', e);
       try {
           // Fallback to app logo
           icon = nativeImage.createFromPath(path.join(__dirname, 'public', 'logo1.png'));
           if (icon.isEmpty()) {
                // Base64 transparent 1x1 pixel png as ultimate fallback
                const buffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
                icon = nativeImage.createFromBuffer(buffer);
           }
       } catch (err) {
           icon = nativeImage.createEmpty(); 
       }
    }

    try {
        // Electron startDrag API requires 'files' for arrays and 'file' for single string
        // Note: 'files' was added in newer Electron versions, but 'file' taking array is deprecated/invalid
        const dragOptions = { icon };
        
        if (filePaths.length > 1) {
            dragOptions.files = filePaths;
            // Some older docs say 'file' is required, but for multi-file it's 'files'
            // To be safe and compliant with the error message "Must specify either 'file' or 'files' option":
            // We set 'files'. If we set 'file' it must be a string.
            // Let's set 'file' to the first file as a fallback if 'files' is ignored, 
            // but the error suggests we shouldn't pass both if it causes confusion, 
            // OR the error was because I passed an array to 'file'.
            // Let's try passing ONLY 'files' for multiple.
        } else {
            dragOptions.file = filePaths[0];
        }

        event.sender.startDrag(dragOptions);
    } catch (err) {
        console.error('[Main] Failed to start native drag:', err);
    }
  });

  ipcMain.handle("ensure-directory", async (event, dirPath) => {
    try {
      if (!isInternalPath(dirPath)) {
        console.error(
          "SECURITY VIOLATION: Attempted to create directory outside userData.",
        );
        return {
          success: false,
          error: "Access denied: Cannot create directories outside userData.",
        };
      }
      await fs.mkdir(dirPath, { recursive: true });
      return { success: true };
    } catch (error) {
      console.error("Error ensuring directory:", error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("open-external", async (event, url) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      console.error(`[IPC] Failed to open external URL: ${url}`, error);
      return { success: false, error: error.message };
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Stop all file watchers before quitting
  fileWatcher.stopAllWatchers();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Error handling
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
