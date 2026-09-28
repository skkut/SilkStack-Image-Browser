import React, { useEffect, useLayoutEffect, useState, FC, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { type IndexedImage, type BaseMetadata, type LoRAInfo } from "../types";
import { FileOperations } from "../services/fileOperations";
import { copyImageToClipboard, showInExplorer, openInNativeViewer, getAspectRatio } from "../utils/imageUtils";
import { getImageAbsolutePath, quotePathForClipboard } from "../utils/pathUtils";
import { extractRawMetadataFromFile } from "../services/fileIndexer";
import {
  Copy,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronUp,
  Folder,
  Star,
  X,
  Zap,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Repeat,
  Search,
  PanelRightClose,
  PanelRightOpen,
  ZoomIn,
  ZoomOut,
  Maximize,
  Minimize,
  ExternalLink,
  Frame,
  Tag,
  Info,
  MessageSquare,
  SlidersHorizontal,
  Code,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import hotkeyManager from "../services/hotkeyManager";
import {
  computeCompactContentSize,
  compactPinnedSize,
  compactMinUserScale,
  compactWindowMinimumScale,
  compactPanAxes,
  compactSidebarWidth,
  clampUserScale,
  clampSidebarShare,
  boundSidebarShare,
  roundSidebarShare,
  userScaleFromResize,
  COMPACT_MODE_STORAGE_KEY,
  COMPACT_SCALE_STORAGE_KEY,
  DEFAULT_SIDEBAR_SHARE,
  MIN_SIDEBAR_SHARE,
  MAX_SIDEBAR_SHARE,
  SIDEBAR_SHARE_STORAGE_KEY,
  COMPACT_SCALE_EPSILON,
  COMPACT_RESIZE_TOLERANCE,
  COMPACT_GROW_SETTLE_MS,
  COMPACT_GROW_MAX_STEP,
  COMPACT_GROW_STEP_MS,
} from "../utils/windowSizing";
import ImageMinimap from "./ImageMinimap";
import type { Point } from "../utils/minimapGeometry";
import { useImageStore } from "../store/useImageStore";
import { useSettingsStore } from "../store/useSettingsStore";



interface ImageModalProps {
  image: IndexedImage;
  onClose: () => void;
  onImageDeleted?: (imageId: string) => void;
  onImageRenamed?: (imageId: string, newName: string) => void;
  currentIndex?: number;
  totalImages?: number;
  onNavigateNext?: () => void;
  onNavigatePrevious?: () => void;
  directoryPath?: string;
  isIndexing?: boolean;
  nextImage?: IndexedImage | null;
  previousImage?: IndexedImage | null;
  onTagAdded?: (imageId: string, tag: string) => void;
  onTagRemoved?: (imageId: string, tag: string) => void;
  onFavoriteToggled?: (imageId: string) => void;
  isStandaloneWindow?: boolean;
}

/**
 * The pane and the image's laid-out size at scale 1 — what the minimap maps
 * from, and what `clampPan` works in. All four are 0 until the elements exist.
 */
interface ViewMetrics {
  viewportWidth: number;
  viewportHeight: number;
  imageWidth: number;
  imageHeight: number;
}

// Helper function to format LoRA with weight
const formatLoRA = (lora: string | LoRAInfo): string => {
  if (typeof lora === "string") {
    return lora;
  }

  const name = lora.name || lora.model_name || "Unknown LoRA";
  const weight = lora.weight ?? lora.model_weight;

  if (weight !== undefined && weight !== null) {
    return `${name} (${weight})`;
  }

  return name;
};

// Escapes regex-special characters so a user query is always matched as a
// literal phrase (e.g. "cat.on" must not behave as a wildcard).
const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Format file size: "123.4 KB", "5.2 MB", "1.8 GB"
const formatFileSize = (bytes?: number): string | undefined => {
  if (bytes == null || bytes <= 0) return undefined;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  } else {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
};

// Format generation time: 87ms, 1.5s, or 2m 15s
const formatGenerationTime = (ms: number): string => {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

const formatDurationSeconds = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

// Format VRAM: "8.0 GB / 24 GB (33%)" or "8.0 GB"
const formatVRAM = (vramMb: number, gpuDevice?: string | null): string => {
  const vramGb = vramMb / 1024;

  // Known GPU VRAM mappings
  const gpuVramMap: Record<string, number> = {
    "4090": 24,
    "3090": 24,
    "3080": 10,
    "3070": 8,
    "3060": 12,
    A100: 40,
    A6000: 48,
    V100: 16,
  };

  let totalVramGb: number | null = null;
  if (gpuDevice) {
    for (const [model, vram] of Object.entries(gpuVramMap)) {
      if (gpuDevice.includes(model)) {
        totalVramGb = vram;
        break;
      }
    }
  }

  if (totalVramGb !== null && vramGb <= totalVramGb) {
    const percentage = ((vramGb / totalVramGb) * 100).toFixed(0);
    return `${vramGb.toFixed(1)} GB / ${totalVramGb} GB (${percentage}%)`;
  }

  return `${vramGb.toFixed(1)} GB`;
};

const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mkv", ".mov", ".avi"];

const MAX_ZOOM = 10;
const MIN_ZOOM = 1;

// A wheel event's own unit. `deltaY` is ~100 a detent on every mouse this has
// been tried on, which is what makes 100 the natural denominator for a step
// expressed per detent.
const WHEEL_DETENT = 100;

// What one detent does to the magnification *below the fit*: ×1.2 in, ÷1.2 out.
// Chosen to sit inside COMPACT_GROW_MAX_STEP, the largest single resize the paced
// growth will draw, because a shrink has no pacing to fall back on. It also
// lands close to the 1.11–1.24 a detent measures on the growth side, so the
// gesture does not change shape as it crosses the fit.
const COMPACT_ZOOM_OUT_RATE = 1.2;

/**
 * One step of the shrink gesture, as a proportion of the size it is applied to
 * (positive `notches` to enlarge). Used for the step that resizes the window.
 *
 * Proportional, and deliberately so: an absolute 0.25 the buttons use above the
 * fit would ask a 40%-of-screen window for half its width in a single commit,
 * the largest resize this mode can draw, while a growth of that size would have
 * been split across a flick by the paced growth. A shrink cannot be paced — a
 * frame left larger than the picture it holds is the band this mode exists to
 * prevent — so the only lever left on the way down is how far one step goes. A
 * ratio also keeps the steps feeling even as the size falls, and stays inside
 * `COMPACT_GROW_MAX_STEP`, the largest resize a paced growth will draw.
 *
 * A fast flick arrives as one event with a delta well past a detent, and 1.2^1.5
 * is over that ceiling, so a step counts one detent at most.
 */
const compactStepRate = (notches: number): number =>
  Math.pow(COMPACT_ZOOM_OUT_RATE, Math.max(-1, Math.min(1, notches)));

/**
 * The magnification one step away from `zoom`, a step being `notches` detents of
 * the wheel (positive to zoom in). Floored at the fit, because below it the
 * *window* is what shrinks and that is not the magnification's business.
 *
 * Above the fit the step is the absolute one the mode has always had — half a
 * magnification a button press, a quarter a detent — because that is the feel
 * that has been lived with. Approaching the fit from above it turns proportional,
 * so the step that lands on 1 is not the largest resize of the gesture.
 */
const stepZoom = (zoom: number, notches: number): number => {
  // Decided by where the step lands, not by where it starts: an absolute 0.25
  // off anything below COMPACT_GROW_MAX_STEP moves the frame further than the
  // paced growth is ever allowed to move it. The ceiling exists because the cost
  // of a resize is how far it moved, and it has to hold at the boundary too.
  const proportional =
    zoom < 1 || (notches < 0 && zoom < COMPACT_GROW_MAX_STEP);
  const next = proportional
    ? zoom * compactStepRate(notches)
    : zoom + notches * 0.25;
  return Math.min(Math.max(1, next), MAX_ZOOM);
};

const isVideoFileName = (
  fileName: string,
  fileType?: string | null,
): boolean => {
  if (fileType && fileType.startsWith("video/")) {
    return true;
  }
  const lower = fileName.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const resolveImageMimeType = (fileName: string): string => {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith(".mp4")) return "video/mp4";
  if (lowerName.endsWith(".webm")) return "video/webm";
  if (lowerName.endsWith(".mkv")) return "video/x-matroska";
  if (lowerName.endsWith(".mov")) return "video/quicktime";
  if (lowerName.endsWith(".avi")) return "video/x-msvideo";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".gif")) return "image/gif";
  return "image/png";
};

const createImageUrlFromFileData = (
  data: unknown,
  fileName: string,
): { url: string; revoke: boolean } => {
  const mimeType = resolveImageMimeType(fileName);

  if (typeof data === "string") {
    return { url: `data:${mimeType};base64,${data}`, revoke: false };
  }

  if (data instanceof ArrayBuffer) {
    const blob = new Blob([data], { type: mimeType });
    return { url: URL.createObjectURL(blob), revoke: true };
  }

  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const safeView = new Uint8Array(view);
    const blob = new Blob([safeView], { type: mimeType });
    return { url: URL.createObjectURL(blob), revoke: true };
  }

  if (
    data &&
    typeof data === "object" &&
    "data" in data &&
    Array.isArray((data as { data: unknown }).data)
  ) {
    const view = new Uint8Array((data as { data: number[] }).data);
    const blob = new Blob([view], { type: mimeType });
    return { url: URL.createObjectURL(blob), revoke: true };
  }

  throw new Error("Unknown file data format.");
};

// ── Metadata sidebar primitives ─────────────────────────────────────────────
// The panel is a stack of collapsible group cards; each card is one surface
// holding flat label/value rows. The rows replaced a bordered tile per item,
// which nested a card inside a card once the groups existed and read as noise.
//
// Colour rule for the whole panel: src/styles/themes.css remaps the gray scale
// per theme and INVERTS it for light (gray-900 is near-black in dark, a light
// surface in light), so a gray token over a gray token is correct in both
// themes by construction. A gray token over a FIXED colour is not — there the
// text has to be literal, which is why the search hit below sets text-black.
//
// Type rule: the panel reads at text-sm, a step up from the app's dense 12px
// chrome, and is set entirely in the UI font — the monospace the values and
// prompts used to carry read as a console dump rather than a panel. The four
// <pre> blocks (two prompts, two raw-JSON views) each need an explicit
// `font-sans` to get there: deleting the `font-mono` class is NOT enough,
// because Tailwind's preflight sets a monospace family on the `pre` ELEMENT,
// and that element rule outlives every class removed from it. They wrap to the
// card's width, so the column alignment monospace would have bought is already
// spent anyway.
// Labels are gray-400 rather than gray-500 because the card surface puts
// gray-500 at about 3.6:1 in dark, under the 4.5:1 floor for body text, where
// gray-400 reaches about 6.8:1 dark and 7.6:1 light — the inverted scale makes
// the one token the better choice on both themes at once.

/** The uniform hover/focus reveal for a row's copy button. */
const COPY_REVEAL =
  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 transition-opacity text-gray-500 hover:text-gray-200";

/**
 * One label/value line in a group card. Renders nothing at all without a
 * value — callers rely on absent fields disappearing rather than leaving an
 * empty row, and the container's `divide-y` counts only rendered children, so
 * a skipped row leaves no stray divider.
 */
const MetaRow: FC<{
  label: string;
  value?: string | number | any[];
  onCopy?: (value: string) => void;
}> = ({ label, value, onCopy }) => {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    return null;
  }

  const displayValue = Array.isArray(value) ? value.join(", ") : String(value);

  return (
    <div className="group/row flex items-start justify-between gap-3 px-3 py-1.5 hover:bg-gray-700/20 transition-colors">
      <span className="text-sm text-gray-400 shrink-0 pt-px">{label}</span>
      <span className="flex items-start gap-1.5 min-w-0 justify-end">
        <span className="text-sm text-gray-200 break-words text-right min-w-0">
          {displayValue}
        </span>
        {onCopy && (
          <button
            onClick={() => onCopy(displayValue)}
            className={`shrink-0 ${COPY_REVEAL}`}
            title={`Copy ${label}`}
            aria-label={`Copy ${label}`}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        )}
      </span>
    </div>
  );
};

/**
 * A prompt, given the full width of the card rather than a label/value row —
 * it is prose, not a value. Owns the search-hit highlighting that Ctrl+F
 * counts, so its <pre> must stay mounted whenever the Prompt group is open.
 */
const PromptBlock: FC<{
  label: string;
  value?: string;
  onCopy?: (value: string) => void;
  highlight?: string; // literal phrase to highlight (Prompt only, for now)
}> = ({ label, value, onCopy, highlight }) => {
  if (!value) return null;

  // Split on the literal (case-insensitive) phrase, keeping the matched
  // substrings via the capture group — odd indexes are matches, so text is
  // reproduced verbatim with no whitespace/case loss. A zero-match or empty
  // query leaves the plain-text path intact (an empty "" capture regex would
  // split every single character).
  const matchParts = highlight
    ? value.split(new RegExp(`(${escapeRegExp(highlight)})`, "gi"))
    : null;
  const hasMatches = matchParts !== null && matchParts.length > 1;

  return (
    <div className="group/row px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-gray-400">
          {label}
        </span>
        {onCopy && (
          <button
            onClick={() => onCopy(value)}
            className={COPY_REVEAL}
            title={`Copy ${label}`}
            aria-label={`Copy ${label}`}
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <pre className="text-sm text-gray-200 whitespace-pre-wrap break-words font-sans mt-1">
        {/* The mark's text-black is literal, not a gray token: the gray scale
            is theme-inverted (gray-900 is near-white in light mode), so no gray
            token stays readable on this fixed yellow. */}
        {hasMatches
          ? matchParts!.map((part, i) =>
              i % 2 === 1 ? (
                <mark
                  key={`m${i}`}
                  className="search-hit bg-yellow-300 text-black rounded-[2px] px-px"
                >
                  {part}
                </mark>
              ) : (
                part
              ),
            )
          : value}
      </pre>
    </div>
  );
};

/** The six metadata groups, in the order the panel renders them. */
type MetadataGroupKey =
  | "tags"
  | "imageInfo"
  | "prompt"
  | "generation"
  | "performance"
  | "raw";

const METADATA_GROUPS_STORAGE_KEY = "image_modal_metadata_groups";

/** How the Raw data group displays the file's unparsed metadata. */
type MetadataViewMode = "parsed" | "json" | "fulljson";

/** The raw-data views, in the order the group's segmented control shows them. */
const METADATA_VIEW_MODES: ReadonlyArray<readonly [MetadataViewMode, string]> = [
  ["parsed", "Parsed"],
  ["json", "JSON"],
  ["fulljson", "Full JSON"],
];

/** Before it had groups the panel showed everything, so that is the default. */
const DEFAULT_METADATA_GROUPS: Record<MetadataGroupKey, boolean> = {
  tags: true,
  imageInfo: true,
  prompt: true,
  generation: true,
  performance: true,
  raw: true,
};

/**
 * Read the persisted group state, merged key by key over the defaults.
 *
 * Merging rather than replacing means a record written by an older build — or
 * truncated — can neither hide a group nor leave one `undefined`, which React
 * would render as closed. A missing key, unparseable JSON (a bare `getItem`
 * mock returns `undefined`, and `JSON.parse(undefined)` throws) or absent
 * storage all fall back to all-open.
 */
const readExpandedGroups = (): Record<MetadataGroupKey, boolean> => {
  const fallback = { ...DEFAULT_METADATA_GROUPS };
  try {
    const raw = localStorage.getItem(METADATA_GROUPS_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return fallback;
    const merged = { ...fallback };
    for (const key of Object.keys(fallback) as MetadataGroupKey[]) {
      const stored = (parsed as Record<string, unknown>)[key];
      if (typeof stored === "boolean") merged[key] = stored;
    }
    return merged;
  } catch {
    return fallback;
  }
};

/**
 * One collapsible group: a header that is the whole disclosure control, and a
 * body that animates open. Mirrors the Models/LoRAs/Schedulers sections in
 * Sidebar.tsx, with `initial={false}` so opening the viewer does not fire six
 * simultaneous expand animations behind the image.
 */
const MetadataGroup: FC<{
  title: string;
  icon?: React.ReactNode;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, icon, count, open, onToggle, children }) => {
  return (
    <div className="bg-gray-900/50 rounded-lg border border-gray-700/50">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        // The accessible name is the visible text — deliberately no aria-label,
        // which would collide with the icon buttons' labels the tests query by.
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left rounded-lg hover:bg-gray-700/30 transition-colors"
      >
        {icon}
        <span className="text-sm font-semibold uppercase tracking-wide text-gray-400">
          {title}
        </span>
        {count !== undefined && count > 0 && (
          <span className="text-xs leading-none bg-gray-700/60 text-gray-400 px-1.5 py-0.5 rounded-full">
            {count}
          </span>
        )}
        <ChevronDown
          size={14}
          className={`ml-auto shrink-0 text-gray-500 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          // The clip belongs to the animation, not to a class. AnimatePresence
          // renders the exiting child from the element it cached at removal, so
          // a className keyed on `open` never updates on the way out — the rows
          // would spill past the shrinking card for the whole collapse. Driving
          // overflow through initial/exit/animate applies it inline instead,
          // and `transitionEnd` releases it only once the box has settled open.
          //
          // Releasing it is not cosmetic: the tag autocomplete is absolutely
          // positioned below a body that, on an image with no tags, is a single
          // row tall, and a clip that outlived the animation would slice the
          // suggestions to a sliver.
          <motion.div
            initial={{ height: 0, opacity: 0, overflow: "hidden" }}
            animate={{
              height: "auto",
              opacity: 1,
              transitionEnd: { overflow: "visible" },
            }}
            exit={{ height: 0, opacity: 0, overflow: "hidden" }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div className="pb-1.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

// Helper to format time
const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const VideoPlayer: React.FC<{
  src: string;
  poster?: string;
  onContextMenu?: React.MouseEventHandler;
  /** Reports the decoded track size — used to shape a compact window. */
  onNaturalDimensions?: (width: number, height: number) => void;
}> = ({ src, poster, onContextMenu, onNaturalDimensions }) => {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  // State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isHovering, setIsHovering] = useState(false);

  // Persistent state
  const [volume, setVolume] = useState(() => {
    const saved = localStorage.getItem("video_player_volume");
    return saved ? parseFloat(saved) : 1;
  });
  const [isMuted, setIsMuted] = useState(() => {
    return localStorage.getItem("video_player_muted") === "true";
  });
  const [isLooping, setIsLooping] = useState(() => {
    return localStorage.getItem("video_player_loop") === "true";
  });

  // Apply properties when video ref changes or state changes
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = isMuted;
      videoRef.current.loop = isLooping;
    }
  }, [volume, isMuted, isLooping]);

  useEffect(() => {
    localStorage.setItem("video_player_volume", volume.toString());
    localStorage.setItem("video_player_muted", isMuted.toString());
    localStorage.setItem("video_player_loop", isLooping.toString());
  }, [volume, isMuted, isLooping]);

  const togglePlay = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(console.error);
      } else {
        videoRef.current.pause();
      }
    }
  }, []);

  const toggleMute = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsMuted((prev) => !prev);
  }, []);

  const toggleLoop = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsLooping((prev) => !prev);
  }, []);

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration);
      // Auto-enable loop for short videos (< 5s) if not manually set?
      // For now, respect user preference only to avoid confusion.
      const { videoWidth, videoHeight } = videoRef.current;
      if (videoWidth > 0 && videoHeight > 0) {
        onNaturalDimensions?.(videoWidth, videoHeight);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVol = parseFloat(e.target.value);
    setVolume(newVol);
    if (newVol > 0 && isMuted) {
      setIsMuted(false);
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full flex items-center justify-center bg-black group/video"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      onClick={togglePlay}
      onContextMenu={onContextMenu}
    >
      <video
        ref={videoRef}
        src={src}
        className="max-w-full max-h-full object-contain"
        poster={poster}
        autoPlay
        playsInline
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
      />

      {/* Center Play Button Overlay (only when paused and not hovering controls) */}
      {!isPlaying && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className="bg-black/50 backdrop-blur-sm rounded-full p-4 text-white hover:bg-black/70 transition-all pointer-events-auto cursor-pointer transform hover:scale-110"
            onClick={togglePlay}
          >
            <Play size={48} fill="currentColor" />
          </div>
        </div>
      )}

      {/* Controls Overlay */}
      <div
        className={`absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-300 ${isHovering || !isPlaying ? "opacity-100" : "opacity-0"}`}
        onClick={(e) => e.stopPropagation()} // Prevent clicking controls from toggling play
      >
        {/* Progress Bar */}
        <div className="w-full mb-2 flex items-center gap-2 group/progress">
          <span className="text-xs font-mono text-gray-300">
            {formatTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={handleSeek}
            className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer hover:h-2 transition-all accent-blue-500"
          />
          <span className="text-xs font-mono text-gray-300">
            {formatTime(duration)}
          </span>
        </div>

        {/* Buttons Row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={togglePlay}
              className="text-white hover:text-blue-400 transition-colors"
            >
              {isPlaying ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" />
              )}
            </button>

            <div className="flex items-center gap-2 group/volume">
              <button
                onClick={toggleMute}
                className="text-white hover:text-blue-400 transition-colors"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX size={20} />
                ) : (
                  <Volume2 size={20} />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={handleVolumeChange}
                className="w-0 overflow-hidden group-hover/volume:w-20 transition-all duration-300 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button
              onClick={toggleLoop}
              className={`transition-colors ${isLooping ? "text-blue-400" : "text-gray-400 hover:text-white"}`}
              title={isLooping ? "Loop On" : "Loop Off"}
            >
              <Repeat size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Every axis pannable — the answer wherever the pane does not follow the zoom
 * (the ordinary modal, fullscreen), and the fallback when a compact frame cannot
 * be measured. A shared frozen value rather than a fresh object, because it is
 * the answer on every wheel tick of every ordinary zoom.
 */
const ALL_AXES_PANNABLE = Object.freeze({ width: true, height: true });

/**
 * The screen area a compact window may occupy.
 *
 * Read rather than captured, so a window moved to another display re-reads the
 * one it is on — and defined once, because every compact size is measured
 * against it: the frame the window is shaped to, the pinned size the picture is
 * laid out at, and the question of which axes can still be panned all have to be
 * answering about the same screen or they disagree about where the frame stops.
 */
const compactAvailSize = (): { width: number; height: number } => ({
  width: window.screen?.availWidth || window.innerWidth,
  height: window.screen?.availHeight || window.innerHeight,
});

/**
 * Drop a frame growth that is still waiting to be sent.
 *
 * Called wherever the reason for waiting has gone — the mode was left, the
 * window went fullscreen, or a change arrived that supersedes it. A growth that
 * outlives its magnification would resize the window to a size the user has
 * already zoomed away from.
 *
 * Takes the two refs structurally rather than as React ref types, so it can live
 * outside the component and stay a stable value for an effect to use.
 */
const cancelCompactGrow = (
  timerRef: { current: number | undefined },
  sendRef: { current: (() => void) | null },
): void => {
  window.clearTimeout(timerRef.current);
  timerRef.current = undefined;
  sendRef.current = null;
};

/**
 * How long the docked panel's contents take to fade in and out, in ms.
 *
 * Two things keep to it: the transition on the panel's contents and the wait
 * before a closing panel is taken off the window. Skipping the fade on the way
 * out and shrinking at once would take the panel's right edge away while its
 * contents sat still, which reads as the panel being eaten rather than
 * withdrawn. Keep in sync with the `duration-200` on those contents.
 */
const COMPACT_PANEL_FADE_MS = 200;
/** The same fade, plus a beat, so the panel outlives its own contents. */
const COMPACT_PANEL_COLLAPSE_MS = COMPACT_PANEL_FADE_MS + 40;

/**
 * Drop a panel collapse that is still waiting, and forget the panel with it.
 *
 * Called where the wait has lost its meaning — the mode was left, so there is no
 * compact frame to shrink and nothing for the fade to be about. The panel has to
 * go *now* rather than when the timer would have fired, because the next compact
 * window is shaped around the picture and only the picture.
 *
 * Takes the ref and the two setters structurally rather than as React types, so
 * it can live outside the component the way `cancelCompactGrow` does.
 */
const resetCompactPanel = (
  timerRef: { current: number | undefined },
  setOpen: (open: boolean) => void,
  setReady: (ready: boolean) => void,
): void => {
  window.clearTimeout(timerRef.current);
  timerRef.current = undefined;
  setOpen(false);
  setReady(false);
};

/**
 * The picture and the metadata panel, as one width split in two.
 *
 * The split is read from `--sidebar-share`, a custom property the viewer body
 * sets inline from the user's stored share. A custom property rather than a
 * plain inline width because an inline style cannot be responsive, and the
 * split is `md:`-only: below `md` the body stacks, with the panel full-width
 * beneath the picture.
 *
 * The pane takes `100% - share` rather than a second number, so the two cannot
 * disagree. They used to be a hand-typed pair that had to sum to 1 — a mistake
 * that overflows the frame and pushes the picture past the edge of the window,
 * rather than merely looking wrong. Deriving one from the other retires it.
 *
 * The fallback is the net under that. An unresolved custom property makes the
 * declaration invalid at computed-value time, so the width falls back to `auto`
 * and the panel sizes to its own text; the fallback turns that into a panel of
 * roughly the right shape. It is read *only* if the body's style has gone
 * missing, so keep it in step with `DEFAULT_SIDEBAR_SHARE` — a stale one is
 * invisible rather than wrong, which is exactly why it is worth a comment.
 *
 * Compact mode sizes its docked panel from the frame's own rule
 * (`compactSidebarWidth`) and ignores these.
 *
 * Written as plain strings, never template literals: Tailwind finds candidate
 * classes by scanning this file's raw text, so a class assembled at runtime is a
 * class that never gets generated.
 */
const SIDEBAR_WIDTH = "md:w-[var(--sidebar-share,30%)]";
const PANE_WIDTH = "md:w-[calc(100%_-_var(--sidebar-share,30%))]";

const ImageModal: React.FC<ImageModalProps> = ({
  image,
  onClose,
  onImageDeleted,
  onImageRenamed,
  currentIndex = 0,
  totalImages = 0,
  onNavigateNext,
  onNavigatePrevious,
  directoryPath,
  isIndexing = false,
  nextImage,
  previousImage,
  onTagAdded,
  onTagRemoved,
  onFavoriteToggled,
  isStandaloneWindow = false,
}) => {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Cache for preloaded images: imageId -> objectUrl
  const [imageCache, setImageCache] = useState<Map<string, string>>(new Map());

  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState(
    image.name.replace(/\.(png|jpg|jpeg|webp|mp4|webm|mkv|mov|avi)$/i, ""),
  );
  const [metadataViewMode, setMetadataViewMode] =
    useState<MetadataViewMode>("parsed");
  const [fullRawMetadata, setFullRawMetadata] = useState<any>(null);
  const [isLoadingFullJson, setIsLoadingFullJson] = useState(false);

  // ... (rest of the component state)

  // Helper function to load a single image
  const loadImageToUrl = useCallback(
    async (img: IndexedImage, dirPath: string): Promise<string | null> => {
      try {
        const primaryHandle = img.handle;
        const fallbackHandle = img.thumbnailHandle;
        const fileHandle =
          primaryHandle && typeof primaryHandle.getFile === "function"
            ? primaryHandle
            : fallbackHandle && typeof fallbackHandle.getFile === "function"
              ? fallbackHandle
              : null;

        if (fileHandle) {
          const file = await fileHandle.getFile();
          return URL.createObjectURL(file);
        }

        // Fallback to Electron API
        if (window.electronAPI) {
          const pathResult = await window.electronAPI.joinPaths(
            dirPath,
            img.name,
          );
          if (pathResult.success && pathResult.path) {
            const fileResult = await window.electronAPI.readFile(
              pathResult.path,
            );
            if (fileResult.success && fileResult.data) {
              const { url } = createImageUrlFromFileData(
                fileResult.data,
                img.name,
              );
              return url;
            }
          }
        }
      } catch (error) {
        console.warn(`Failed to preload image ${img.name}:`, error);
      }
      return null;
    },
    [],
  );

  const imageFromStore = useImageStore(
    (state) =>
      state.images.find((img) => img.id === image.id) ||
      state.filteredImages.find((img) => img.id === image.id),
  );
  const isVideo = isVideoFileName(image.name, image.fileType);
  const preferredThumbnailUrl =
    imageFromStore?.thumbnailUrl ?? image.thumbnailUrl;

  useEffect(() => {
    let isMounted = true;
    let currentUrl: string | null = null;
    const hasPreview = Boolean(preferredThumbnailUrl);

    // Check if we have the image in cache
    if (imageCache.has(image.id)) {
      setImageUrl(imageCache.get(image.id)!);
    } else {
      // If not in cache, show thumbnail first (existing behavior)
      setImageUrl(isVideo ? null : (preferredThumbnailUrl ?? null));
    }

    const loadAndPreload = async () => {
      if (!directoryPath) return;

      // 1. Load current image if not cached
      if (!imageCache.has(image.id)) {
        const url = await loadImageToUrl(image, directoryPath);
        if (isMounted && url) {
          setImageUrl(url);
          currentUrl = url;
          setImageCache((prev) => {
            const newCache = new Map(prev);
            newCache.set(image.id, url);
            return newCache;
          });
        }
      } else {
        currentUrl = imageCache.get(image.id)!;
      }

      // 2. Preload adjacent images
      const imagesToPreload = [nextImage, previousImage].filter(
        Boolean,
      ) as IndexedImage[];

      for (const img of imagesToPreload) {
        if (
          !imageCache.has(img.id) &&
          !isVideoFileName(img.name, img.fileType)
        ) {
          // Add a small delay/yield to let the UI breathe if needed,
          // but async nature helps.
          const url = await loadImageToUrl(img, directoryPath);
          if (isMounted && url) {
            setImageCache((prev) => {
              const newCache = new Map(prev);
              newCache.set(img.id, url);
              return newCache;
            });
          }
        }
      }

      // 3. Cleanup cache (keep only current, next, previous)
      setImageCache((prev) => {
        const keepIds = new Set(
          [image.id, nextImage?.id, previousImage?.id].filter(Boolean),
        );
        if (prev.size > keepIds.size + 2) {
          // Allow a tiny buffer
          const newCache = new Map();
          prev.forEach((url, id) => {
            if (keepIds.has(id as string)) {
              newCache.set(id, url);
            } else {
              URL.revokeObjectURL(url);
            }
          });
          return newCache;
        }
        return prev;
      });
    };

    loadAndPreload();

    return () => {
      isMounted = false;
      // We don't revoke currentUrl here because it might be in the cache for next render
      // Cleanup happens in the cache trimming logic or component unmount
    };
  }, [
    image.id,
    directoryPath,
    preferredThumbnailUrl,
    isVideo,
    nextImage,
    previousImage,
    loadImageToUrl,
  ]);


  // Use a ref to track cache for cleanup on unmount
  const cacheRef = useRef(imageCache);
  useEffect(() => {
    cacheRef.current = imageCache;
  }, [imageCache]);

  useEffect(() => {
    return () => {
      cacheRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    visible: boolean;
  }>({ x: 0, y: 0, visible: false });
  // Which metadata groups are open. Persisted so the panel comes back as it was
  // left; all-open by default, which is what the panel showed before it had
  // groups. Replaces the two single-purpose flags the old Generation details
  // and Performance sections carried.
  const [expandedGroups, setExpandedGroups] = useState<
    Record<MetadataGroupKey, boolean>
  >(readExpandedGroups);

  /**
   * The share of its room the metadata panel takes, dragged by its inner edge.
   *
   * One number for both viewers — the ordinary one reads it against the modal
   * body, a compact window against the display's work area — and one number is
   * the point: "the panel gets a third of the room" is a statement each mode can
   * keep on its own terms, even though the two rectangles are not the same. The
   * alternative, a share of the compact *frame*, would size the panel to the
   * picture and hand a small file a panel too narrow to read.
   *
   * Persisted and read the way the sidebar flag is, so a viewer opens at the
   * width it was left. `Number(null)` is 0, which `clampSidebarShare` reads as
   * "never chosen" and answers with the default.
   */
  const [sidebarShare, setSidebarShare] = useState(() =>
    clampSidebarShare(Number(localStorage.getItem(SIDEBAR_SHARE_STORAGE_KEY))),
  );

  // The share the panel is being dragged towards, or null when no drag is
  // running. Kept apart from the stored one so the layout can follow the pointer
  // while the committed value stands still. Committing per mousemove would write
  // to localStorage per frame and, in compact mode, send a window resize per
  // frame across an IPC round trip — the flicker the mode's pacing exists to
  // avoid. A drag ends by committing once.
  //
  // React state rather than a DOM write, because the pane's ResizeObserver
  // re-renders mid-drag and would lay the panel back out from the old value.
  const [dragShare, setDragShare] = useState<number | null>(null);

  // A drag in flight, holding the measurement base captured at mousedown. Read
  // once and held: in compact mode this gesture is resizing the very container
  // the base comes from, so re-measuring mid-drag would have the panel chasing
  // its own tail.
  const [sidebarDrag, setSidebarDrag] = useState<{
    startX: number;
    startShare: number;
    base: number;
  } | null>(null);

  // What the panel is laid out at. Only the *layout* reads this; every reader
  // that describes the window reads `sidebarShare` itself, because a window
  // sized from a value still under the pointer would be reshaped per frame.
  const resolvedSidebarShare = dragShare ?? sidebarShare;

  // Written when a drag ends, which is the only time the stored share moves.
  // Declared above the sidebar flag's write so that flag stays the last setItem
  // in any commit that changes both — find-in-prompt asserts the ordering of the
  // commit Ctrl+F triggers.
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_SHARE_STORAGE_KEY, String(sidebarShare));
    } catch {
      /* storage full or unavailable — the panel still resizes, it just forgets */
    }
  }, [sidebarShare]);

  // Writes through on the click rather than in an effect. An effect would also
  // fire for the auto-expand Ctrl+F performs, persisting a state the user never
  // chose — quitting mid-search would then forget their layout. It also keeps
  // this write on the click path only, so the sidebar flag's setItem remains
  // the last one in the commit Ctrl+F triggers (find-in-prompt asserts that).
  const toggleMetadataGroup = (key: MetadataGroupKey) => {
    const next = { ...expandedGroups, [key]: !expandedGroups[key] };
    setExpandedGroups(next);
    try {
      localStorage.setItem(METADATA_GROUPS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage full or unavailable — the panel still works, it just forgets */
    }
  };
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem("image_modal_sidebar_collapsed");
    return saved === "true";
  });

  useEffect(() => {
    localStorage.setItem(
      "image_modal_sidebar_collapsed",
      String(isSidebarCollapsed),
    );
  }, [isSidebarCollapsed]);

  // Compact ("frame the image") mode: the viewer window reshapes itself to the
  // current image's aspect ratio. Persisted like the sidebar flag, so a new
  // viewer window opens in whichever mode was last used. Gated on
  // isStandaloneWindow: the browser-hosted modal has no toggle button (and no
  // window to reshape), so inheriting the flag would hide its sidebar for good.
  const [isCompactMode, setIsCompactMode] = useState(() => {
    return (
      isStandaloneWindow &&
      localStorage.getItem(COMPACT_MODE_STORAGE_KEY) === "true"
    );
  });

  // How much smaller than the best fit the user wants the window, set by
  // dragging a compact window by hand. Persisted with the mode, so a reduction
  // survives into the next image and the next window. `Number(null)` is 0,
  // which clampUserScale reads as "unset" and returns 1.
  const [compactUserScale, setCompactUserScale] = useState(() => {
    if (!isStandaloneWindow) return 1;
    return clampUserScale(Number(localStorage.getItem(COMPACT_SCALE_STORAGE_KEY)));
  });

  // Whether the metadata panel is docked inside the compact window. Deliberately
  // not persisted: entering the mode starts as the image alone — there has to be
  // a window shaped to the picture before there is anything to dock beside it —
  // and the persisted sidebar flag stays the ordinary viewer's business. The
  // button presses that do write it are made while compact, and mirror into that
  // flag so leaving the mode agrees with what was on screen.
  const [compactPanelOpen, setCompactPanelOpen] = useState(false);

  // Whether the docked panel's contents may be shown yet. The panel is rendered
  // in the same commit that asks the window to grow, and the window takes an IPC
  // round trip to do it; until the reply says it has, the contents are held
  // transparent — so what fades in is a panel already sitting in a frame of its
  // own size, rather than one that jumps sideways as the frame grows under it.
  const [compactPanelReady, setCompactPanelReady] = useState(false);

  // A collapse waiting for its fade to finish. Its presence doubles as "a
  // collapse is in flight", which is what tells a reply landing meanwhile not to
  // fade the contents back in.
  const compactPanelTimerRef = useRef<number | undefined>(undefined);

  // The panel width the last size request was shaped for. A change here is a
  // panel toggle — the one resize that has to keep the frame's left edge, since
  // the panel is docked on the right and growing about the centre would slide the
  // picture sideways by half the panel's width.
  const compactReservedRef = useRef(0);

  // ---- Find-in-prompt (Ctrl+F) state ----
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0); // 0-based into <mark> nodes
  const [matchCount, setMatchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const promptSectionRef = useRef<HTMLDivElement>(null); // wraps the Prompt item
  const sidebarAutoExpandedRef = useRef(false); // Ctrl+F expanded the sidebar
  const sidebarUserToggledRef = useRef(false); // user toggled sidebar mid-search
  // Ctrl+F reopens the Prompt group too: the <mark> hits it counts live in that
  // group's <pre>, so a collapsed group would leave the counter reading 0 / 0.
  // Recorded only so closeSearch can put it back — and never persisted, since
  // the stored value is the user's own choice, not the search's.
  const promptGroupWasClosedRef = useRef(false);
  // The same record for a compact window, whose panel is its own state: Ctrl+F
  // docked the panel, so closing the search takes it back off.
  const compactPanelAutoOpenedRef = useRef(false);

  /**
   * Dock or undock the metadata panel inside the compact window.
   *
   * Opening is immediate: the panel is rendered, and the size request that grows
   * the window to hold it goes out, in the same commit — the contents stay
   * transparent until the reply says the frame has taken its new size (see
   * `compactPanelReady`).
   *
   * Closing is sequenced, and the order is the whole point. Shrinking first would
   * take the panel's right edge away while its contents sat still, which reads as
   * the panel being eaten rather than withdrawn; so the contents fade out, and
   * only then is the panel taken off the window and the frame shrunk back to the
   * picture.
   */
  const setCompactPanel = useCallback((open: boolean) => {
    window.clearTimeout(compactPanelTimerRef.current);
    // A collapse caught before its fade finished. Nothing was ever taken off the
    // window: the panel is still docked and the frame is still the one shaped
    // for it, so the contents may come straight back. Waiting for a reply to
    // "make room" would wait forever — the request it would make is the size
    // already in force, which the sizing rule recognises and does not resend.
    const collapseCancelled = compactPanelTimerRef.current !== undefined;
    compactPanelTimerRef.current = undefined;
    if (open) {
      setCompactPanelOpen(true);
      if (collapseCancelled) setCompactPanelReady(true);
      return;
    }
    setCompactPanelReady(false);
    compactPanelTimerRef.current = window.setTimeout(() => {
      compactPanelTimerRef.current = undefined;
      setCompactPanelOpen(false);
    }, COMPACT_PANEL_COLLAPSE_MS);
  }, []);

  // Manual sidebar toggle (buttons) — remembers user intent so closeSearch
  // doesn't undo a manual collapse/expand made while the search was open.
  const toggleSidebar = useCallback(() => {
    sidebarUserToggledRef.current = true;
    // Compact hides the panel whatever the flag says, so the button reads
    // "Expand" there. What it offers is now the panel *in* the compact window:
    // the picture keeps the size it has and the window grows by the panel's
    // width to hold it, which is the one thing the press used to undo by leaving
    // the mode and re-fitting the window to the app's ordinary viewer.
    //
    // The persisted flag is mirrored rather than left alone, so the ordinary
    // viewer the user returns to shows what was last on screen. Entering the mode
    // still writes nothing — see the init above — so the preference itself is
    // never rewritten by a mode the user only visited.
    if (isCompactMode) {
      const open = !compactPanelOpen;
      setCompactPanel(open);
      setIsSidebarCollapsed(!open);
      return;
    }
    setIsSidebarCollapsed((c) => !c);
  }, [isCompactMode, compactPanelOpen, setCompactPanel]);

  useEffect(() => {
    // Only the standalone viewer owns this preference — see the init above.
    if (!isStandaloneWindow) return;
    localStorage.setItem(
      COMPACT_MODE_STORAGE_KEY,
      String(isCompactMode),
    );
  }, [isCompactMode, isStandaloneWindow]);

  useEffect(() => {
    if (!isStandaloneWindow) return;
    localStorage.setItem(
      COMPACT_SCALE_STORAGE_KEY,
      String(compactUserScale),
    );
  }, [compactUserScale, isStandaloneWindow]);

  // Fullscreen owns the whole window, so leave it before reshaping and let the
  // resize effect re-apply the compact size when fullscreen ends.
  const toggleCompactMode = useCallback(() => {
    if (!isCompactMode && isFullscreen) {
      window.electronAPI?.toggleFullscreen?.().then((result) => {
        if (result?.success) setIsFullscreen(result.isFullscreen);
      });
      setIsFullscreen(false);
    }
    setIsCompactMode((c) => !c);
  }, [isCompactMode, isFullscreen]);

  // A window sized for a 100%-scale image cannot hold a zoomed one — start
  // each compact session from a clean 1x view, and from the image alone: the
  // window has to be shaped to the picture before there is anything to dock
  // beside it. A collapse still waiting from the last session is dropped with
  // it, or it would hide a panel this render has not opened yet.
  useEffect(() => {
    if (!isCompactMode) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    resetCompactPanel(
      compactPanelTimerRef,
      setCompactPanelOpen,
      setCompactPanelReady,
    );
  }, [isCompactMode]);

  // A collapse still waiting when the viewer goes away would fire against a
  // panel that is no longer there.
  useEffect(
    () => () =>
      resetCompactPanel(
        compactPanelTimerRef,
        setCompactPanelOpen,
        setCompactPanelReady,
      ),
    [],
  );

  const openSearch = useCallback(() => {
    sidebarUserToggledRef.current = false;
    // The Prompt group holds the marks the search counts, so it has to be open
    // for the counter to mean anything. Done before the compact window's early
    // return below, because that window carries the same panel. The functional
    // form keeps this callback identity-stable — the keydown effect's deps
    // document that requirement.
    setExpandedGroups((prev) => {
      if (prev.prompt) {
        promptGroupWasClosedRef.current = false; // open already: no restore owed
        return prev;
      }
      promptGroupWasClosedRef.current = true;
      return { ...prev, prompt: true };
    });
    // Find-in-prompt lives in the metadata panel — which a compact window now
    // carries too, so searching opens the panel rather than leaving the mode.
    if (isCompactMode) {
      compactPanelAutoOpenedRef.current = !compactPanelOpen;
      setCompactPanel(true);
      setIsSearchOpen(true);
      return;
    }
    // Expand only when we're the one doing it; recorded for restore-on-close.
    setIsSidebarCollapsed((collapsed) => {
      sidebarAutoExpandedRef.current = collapsed;
      return false;
    });
    setIsSearchOpen(true);
  }, [isCompactMode, compactPanelOpen, setCompactPanel]);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery("");
    setActiveMatch(0);
    setMatchCount(0);
    // The panel the search was opened in goes back to what it was, on the same
    // terms as the ordinary viewer's sidebar: only if we were the one who
    // expanded it.
    if (
      compactPanelAutoOpenedRef.current &&
      !sidebarUserToggledRef.current
    ) {
      setCompactPanel(false);
    }
    compactPanelAutoOpenedRef.current = false;
    // Restore the pre-search collapsed state unless the user toggled manually.
    if (sidebarAutoExpandedRef.current && !sidebarUserToggledRef.current) {
      setIsSidebarCollapsed(true);
    }
    sidebarAutoExpandedRef.current = false;
    sidebarUserToggledRef.current = false;
    // Same for the Prompt group. No user-toggled guard is needed: the only
    // restore we owe is "close it", and a user who closed it mid-search has
    // already arrived there. A user who opened it cannot have — we opened it.
    if (promptGroupWasClosedRef.current) {
      promptGroupWasClosedRef.current = false;
      setExpandedGroups((prev) =>
        prev.prompt ? { ...prev, prompt: false } : prev,
      );
    }
  }, [setCompactPanel]);

  // Cycle with wrap-around; no-op when there is nothing to cycle.
  const goToMatch = (delta: number) => {
    if (matchCount <= 0) return;
    setActiveMatch((a) => (a + delta + matchCount) % matchCount);
  };

  const handleSearchQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setActiveMatch(0);
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Never reaches the window handler → closes only the search.
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      goToMatch(e.shiftKey ? -1 : 1);
    }
  };

  const canDragExternally =
    typeof window !== "undefined" && !!window.electronAPI?.startFileDrag;

  // Zoom and pan states
  const [zoom, setZoom] = useState(1);
  const [displayedZoomPercentage, setDisplayedZoomPercentage] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  // A live minimap drag: the image drops its easing so the picture keeps up with
  // the box rather than trailing it.
  const [isMinimapDragging, setIsMinimapDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // What the minimap maps from: the pane and the image's laid-out size at scale 1.
  // Refs do not re-render and `scale()` leaves clientWidth alone, so this is synced
  // from the observer below rather than read during render.
  const [viewMetrics, setViewMetrics] = useState<ViewMetrics | null>(null);

  // The geometry the last dispatch was built from. The "nothing moved" test has to
  // happen *here*, before dispatching, and not inside the updater: an updater that
  // returns the previous object still enqueues an update, and this runs from a
  // layout effect — where React skips its same-value eager bailout while the fiber
  // has work pending. Every commit would then schedule the next one, and 50 nested
  // updates arrive in a single burst (entering or leaving compact mode is exactly
  // that: the reshape, the sidebar flip and the resize all land together). That is
  // the "Maximum update depth exceeded" the dep-less layout effect below used to
  // throw. Comparing first means a commit that moved nothing dispatches nothing.
  const viewMetricsRef = useRef<ViewMetrics | null>(null);

  const syncViewMetrics = useCallback(() => {
    const viewportWidth = containerRef.current?.clientWidth ?? 0;
    const viewportHeight = containerRef.current?.clientHeight ?? 0;
    const imageWidth = imgRef.current?.clientWidth ?? 0;
    const imageHeight = imgRef.current?.clientHeight ?? 0;
    const previous = viewMetricsRef.current;
    if (
      previous &&
      previous.viewportWidth === viewportWidth &&
      previous.viewportHeight === viewportHeight &&
      previous.imageWidth === imageWidth &&
      previous.imageHeight === imageHeight
    ) {
      return;
    }
    const next = { viewportWidth, viewportHeight, imageWidth, imageHeight };
    viewMetricsRef.current = next;
    setViewMetrics(next);
  }, []);

  // Whether the picture is actually bigger than the pane showing it. In the
  // ordinary modal that is the same statement as "zoomed", but a compact window
  // grows with the zoom, so a magnified image can still fit it exactly — and
  // then a grab cursor, a drag, or a map whose box covers the whole picture
  // would all promise something the pane cannot do. Unmeasured counts as
  // overflowing, which is how the pane behaved before there was a mode to grow.
  const imageOverflowsPane =
    !viewMetrics ||
    viewMetrics.imageWidth * zoom > viewMetrics.viewportWidth + 1 ||
    viewMetrics.imageHeight * zoom > viewMetrics.viewportHeight + 1;
  // Panning moves the picture inside the pane, so what it needs is somewhere to
  // move it to — and in a compact window that is the *pane*, which the docked
  // panel can crop the picture to even at 1x. So the mode reads the pane's own
  // answer, where a bare `zoom > 1` would refuse to pan a picture the user can
  // only half see. (Outside the mode the pane is a fixed share of the app window,
  // so a magnified picture is always bigger than it and the two readings agree.)
  const canPan = isCompactMode ? imageOverflowsPane : zoom > 1;

  // The minimap earns its place only once the picture is bigger than the pane
  // holding it — a picture the pane fits draws a box that is the whole map — and
  // only once the pane and image have both been measured, which is what keeps it
  // off the pre-load skeleton. `canPan` is that statement in both its meanings,
  // including a compact pane the docked panel has cropped at 1x, where the map
  // is the only thing that says where the part that is off-screen went.
  const showMinimap =
    !isVideo &&
    canPan &&
    Boolean(imageUrl) &&
    Boolean(viewMetrics) &&
    viewMetrics!.imageWidth > 0 &&
    viewMetrics!.imageHeight > 0 &&
    viewMetrics!.viewportWidth > 0 &&
    viewMetrics!.viewportHeight > 0;

  // Calculate true zoom percentage based on rendered size vs natural size
  const updateZoomPercentage = useCallback(() => {
    if (!imgRef.current) return;
    const img = imgRef.current;
    if (img && img.naturalWidth) {
      const baseScale = img.clientWidth / img.naturalWidth;
      const currentTrueZoom = Math.round(zoom * baseScale * 100);
      setDisplayedZoomPercentage(currentTrueZoom);
    }
  }, [zoom]);

  useEffect(() => {
    updateZoomPercentage();
    syncViewMetrics();

    const observer = new ResizeObserver(() => {
      updateZoomPercentage();
      syncViewMetrics();
      // A compact window resized to follow the zoom moves the pane out from
      // under the picture: what filled it a moment ago no longer does, and a pan
      // held against the old edge would show a band of background. Re-clamp
      // against the pane as it is now. Handing back the object React already has
      // is the bail-out this needs — the callback runs on every frame of a
      // resize, and almost every one of them moves nothing.
      //
      // Flushed, not scheduled. A resize observation is delivered before the
      // frame is painted but from outside React's event system, so the render it
      // schedules waits for the next task — which is after this paint. The pan
      // would then be corrected in the *following* frame: one more step of the
      // picture, arriving after the one the window just made, which is exactly
      // the kind of late second motion the zoom was making feel jerky. Flushed
      // here, the corrected pan is painted with the pane that caused it. The
      // bail-out above keeps that flush free of a re-render when nothing moved.
      flushSync(() => {
        setPan((prev) => {
          const next = clampPan(prev.x, prev.y, zoom);
          return next.x === prev.x && next.y === prev.y ? prev : next;
        });
      });
    });

    if (imgRef.current) {
      observer.observe(imgRef.current);
    }
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => observer.disconnect();
    // `zoom` is here for the pan clamp above, and rebuilds the observer on every
    // zoom step — which it already did, since `updateZoomPercentage` is rebuilt
    // for the same reason. `clampPan` is deliberately left out: it is a stable
    // useCallback reading only refs, and it is declared below this effect, so
    // naming it in the deps would read it in its temporal dead zone.
  }, [updateZoomPercentage, syncViewMetrics, imageUrl, zoom]);

  // The observer is asynchronous and only fires on a size *change*; this catches
  // the first measurement after the image element appears, before the browser
  // paints. Deliberately dependency-less, which is only safe because
  // `syncViewMetrics` compares before it dispatches: a commit that moved nothing
  // writes no state, so this costs one layout read per render and nothing else.
  // (An always-dispatching version of this effect is what threw "Maximum update
  // depth exceeded" — see the note on `viewMetricsRef`.)
  useLayoutEffect(() => {
    syncViewMetrics();
  });

  // Clamp pan so the image can't be dragged past its own edges.
  // Uses actual rendered image size (object-contain may make it narrower/shorter
  // than the container) for per-axis accuracy.
  const clampPan = useCallback(
    (x: number, y: number, currentZoom: number): { x: number; y: number } => {
      if (!containerRef.current || !imgRef.current) return { x: 0, y: 0 };
      const { clientWidth: cw, clientHeight: ch } = containerRef.current;
      const { clientWidth: iw, clientHeight: ih } = imgRef.current;
      // The scaled image must stay large enough to fill the viewport edge-to-edge.
      // maxPan = half of (scaled image size - container size), floored at 0.
      //
      // A picture no bigger than its pane has nowhere to go, and the two lines
      // below already say so — they come out at 0 exactly then. The `zoom <= 1`
      // test that used to stand in front of them was reading the same thing in
      // the ordinary viewer, where the pane is a fixed share of the app window
      // and so a magnified picture is always the bigger of the two. A compact
      // pane is the case where the two part: the metadata panel crops it, and
      // the picture overflowing it at 1x is the whole point of docking one.
      const maxX = Math.max(0, (iw * currentZoom - cw) / 2);
      const maxY = Math.max(0, (ih * currentZoom - ch) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y)),
      };
    },
    [],
  );

  // Moves the pane and hands back where it actually landed. The minimap anchors a
  // drag on the returned value, so a jump or drag that the clamp trims keeps the
  // box under the cursor instead of a bit of slack away from it.
  const applyPan = useCallback(
    (x: number, y: number): Point => {
      const applied = clampPan(x, y, zoom);
      // Handing back the previous object is React's bail-out, and it matters here:
      // a drag held against an edge lands on the same pair every frame, and the
      // picture has nothing to redraw for it. (Safe from a frame callback — the
      // layout-effect caveat that rules this out for syncViewMetrics does not
      // apply, since no fiber work is pending when this runs.)
      setPan((prev) =>
        prev.x === applied.x && prev.y === applied.y ? prev : applied,
      );
      return applied;
    },
    [clampPan, zoom],
  );




  // Annotations hooks
  const toggleFavorite = useImageStore((state) => state.toggleFavorite);
  const addTagToImage = useImageStore((state) => state.addTagToImage);
  const removeTagFromImage = useImageStore((state) => state.removeTagFromImage);
  const availableTags = useImageStore((state) => state.availableTags);



  // Get live tags and favorite status from store instead of props
  // imageFromStore, isVideo, and preferredThumbnailUrl are defined above

  const currentTags = imageFromStore?.tags || image.tags || [];
  const currentAutoTags = imageFromStore?.autoTags || image.autoTags || [];
  const currentMetadataTags = imageFromStore?.metadataTags || image.metadataTags || [];
  const currentIsFavorite =
    imageFromStore?.isFavorite ?? image.isFavorite ?? false;

  const getTagSource = (tag: string): 'manual' | 'auto' | 'metadata' => {
    if (currentMetadataTags.includes(tag)) return 'metadata';
    if (currentAutoTags.includes(tag)) return 'auto';
    return 'manual';
  };


  // State for tag input
  const [tagInput, setTagInput] = useState("");
  const [showTagAutocomplete, setShowTagAutocomplete] = useState(false);

  // Full screen toggle - calls Electron API for actual fullscreen
  const toggleFullscreen = useCallback(async () => {
    if (window.electronAPI?.toggleFullscreen) {
      const result = await window.electronAPI.toggleFullscreen();
      if (result.success) {
        setIsFullscreen(result.isFullscreen);
      }
    }
  }, []);

  // Listen for fullscreen changes from Electron
  useEffect(() => {
    // Listen for fullscreen-changed events from Electron (when user presses F11 or uses menu)
    const unsubscribeFullscreenChanged =
      window.electronAPI?.onFullscreenChanged?.((data) => {
        setIsFullscreen(data.isFullscreen);
      });

    // Listen for fullscreen-state-check events (periodic check for state changes)
    const unsubscribeFullscreenStateCheck =
      window.electronAPI?.onFullscreenStateCheck?.((data) => {
        setIsFullscreen(data.isFullscreen);
      });

    return () => {
      unsubscribeFullscreenChanged?.();
      unsubscribeFullscreenStateCheck?.();
    };
  }, []);

  // Initialize fullscreen mode from sessionStorage (backward compatibility)
  useEffect(() => {
    const shouldStartFullscreen =
      sessionStorage.getItem("openImageFullscreen") === "true";
    if (shouldStartFullscreen) {
      sessionStorage.removeItem("openImageFullscreen");
      setTimeout(() => {
        if (window.electronAPI?.toggleFullscreen) {
          window.electronAPI.toggleFullscreen().then((result) => {
            if (result?.success) {
              setIsFullscreen(result.isFullscreen);
            }
          });
        }
      }, 100);
    }
  }, []);

  // Effective metadata for display
  const nMeta: BaseMetadata | undefined = image.metadata?.normalizedMetadata;
  const effectiveMetadata = nMeta;

  // File-level dimensions: prefer normalized metadata, fall back to the
  // "WxH" string the indexer stores (read from the actual file bytes — e.g.
  // MP4 tkhd track headers — so it exists even without generation metadata).
  const [fileWidth, fileHeight]: [number | null, number | null] = (() => {
    if (nMeta?.width && nMeta?.height) return [nMeta.width, nMeta.height];
    const match = image.dimensions?.match(/(\d+)\s*x\s*(\d+)/i);
    if (match && Number(match[1]) > 0 && Number(match[2]) > 0) {
      return [Number(match[1]), Number(match[2])];
    }
    return [null, null];
  })();

  const effectiveDuration = (nMeta as any)?.video?.duration_seconds;

  // Intrinsic size of the current image, used to shape a compact window.
  // Derived during render rather than seeded by an effect: an effect would fire
  // the resize below once with the *previous* image's size on every navigation.
  const metadataSize =
    fileWidth && fileHeight ? { width: fileWidth, height: fileHeight } : null;
  // Tagged with the image it was measured from, so a measurement taken before
  // the navigation can never be attributed to the new image.
  const [decodedSize, setDecodedSize] = useState<{
    imageId: string;
    width: number;
    height: number;
  } | null>(null);
  const naturalSize =
    decodedSize && decodedSize.imageId === image.id ? decodedSize : metadataSize;
  // Primitive deps: `naturalSize` is a fresh object each render.
  const naturalWidth = naturalSize?.width ?? null;
  const naturalHeight = naturalSize?.height ?? null;

  // The <img> renders the 512px-capped thumbnail before the full-size blob
  // arrives, so its `naturalWidth` is not the file's dimensions. Only learn a
  // size from the full-resolution URL, or the window reshapes twice per image.
  const isThumbnailShown =
    imageUrl != null && imageUrl === preferredThumbnailUrl;

  const handleImageLoad = useCallback(() => {
    updateZoomPercentage();
    // The picture has laid out by now, so this is where the minimap learns the
    // size it maps from — including the swap to the full-resolution blob.
    syncViewMetrics();
    if (isThumbnailShown) return;
    const img = imgRef.current;
    const width = img?.naturalWidth ?? 0;
    const height = img?.naturalHeight ?? 0;
    if (width <= 0 || height <= 0) return;
    setDecodedSize((prev) =>
      prev?.imageId === image.id && prev.width === width && prev.height === height
        ? prev
        : { imageId: image.id, width, height },
    );
  }, [updateZoomPercentage, isThumbnailShown, image.id]);

  const handleVideoDimensions = useCallback(
    (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      setDecodedSize((prev) =>
        prev?.imageId === image.id &&
        prev.width === width &&
        prev.height === height
          ? prev
          : { imageId: image.id, width, height },
      );
    },
    [image.id],
  );

  // Compact mode is a window feature — it needs a standalone viewer window and
  // the Electron bridge; the browser-hosted modal has neither.
  const setViewerCompactMode = isStandaloneWindow
    ? window.electronAPI?.setViewerCompactMode
    : undefined;

  // The content size last requested from the main process. Resize events near
  // this size are the ones we caused; anything else is the user dragging an edge.
  const compactAppliedRef = useRef<{ width: number; height: number } | null>(
    null,
  );

  // The image whose fit the window is showing. A re-fit *for the same image* is
  // the follow-up to the user's own drag; a re-fit for a different image is a
  // fresh fit. Told apart here rather than in the main process, which cannot
  // see why a size was sent.
  const compactFitKeyRef = useRef<string | null>(null);

  // The magnification the window is showing. A re-fit at the same zoom is the
  // follow-up to a drag; one at a different zoom is the user magnifying, and the
  // frame has to grow about its centre rather than from a corner.
  const compactZoomRef = useRef(1);

  // Whether the window's current size is one the user's own hand set. A re-fit
  // that follows a hand-drag keeps the frame where they put it, while any size
  // the viewer's controls produced — a wheel step, the reset, a fill-the-screen
  // request — is a fresh fit and re-centres. Needed as its own flag because a
  // size step writes the same remembered factor a drag does, which leaves the two
  // indistinguishable by the time the re-fit is sent.
  const compactHandSizedRef = useRef(false);

  // The last thing we asked the main process for. A capped window computes the
  // same size at every step of a wheel flick or a slider drag — the frame has
  // stopped growing and only the picture is moving — and the main process is on
  // the far side of an IPC round trip, so it is not asked twice.
  const compactRequestKeyRef = useRef<string | null>(null);

  // Counts requests, so a reply can be recognised as the answer to the one still
  // in flight rather than to an older one that crossed it.
  const compactRequestIdRef = useRef(0);

  // A growth of the frame, waiting for the magnification to settle before it is
  // sent. One wheel flick is a dozen steps; each would otherwise be a window
  // resize, and a resize cannot be shown for ~50ms (measured) — further apart
  // than the steps arrive, so the picture never settles while the gesture lasts.
  // The send is held as a closure rather than as a size, so whichever step is
  // last is the one that goes out.
  const compactGrowTimerRef = useRef<number | undefined>(undefined);
  const compactGrowSendRef = useRef<(() => void) | null>(null);

  // The size the picture is laid out at while the frame is compact — the fixed
  // shape the window grows around, with the zoom left out of it for the
  // transform to supply. Null in every other mode, where the image sizes itself.
  //
  // Deliberately measured against the *whole* work area, panel or no panel: this
  // is the picture, and the picture is not a function of the metadata panel. That
  // one decision is what makes the window grow by exactly the panel's width to
  // hold it, and what makes a display with no room left crop the pane rather than
  // rescale the file.
  const compactAvail =
    isCompactMode && !isFullscreen ? compactAvailSize() : null;
  const compactPin = compactAvail
    ? compactPinnedSize(
        naturalWidth,
        naturalHeight,
        compactAvail.width,
        compactAvail.height,
        compactUserScale,
      )
    : null;

  // The width the docked panel is laid out at inside a compact frame — 0
  // whenever there is no panel to make room for. Read rather than written into
  // `compactPin`: the panel never resizes the picture.
  //
  // Measured against the *work area* rather than the frame, which is what keeps
  // the panel readable for a small file. The resolved share, so the panel
  // follows the pointer for the length of a drag; the frame itself is shaped
  // from the committed share instead, because a window resized once per
  // mousemove is a window resized faster than it can be drawn.
  const compactPanelWidth =
    compactAvail && compactPanelOpen
      ? compactSidebarWidth(compactAvail.width, resolvedSidebarShare)
      : 0;
  const compactPanelDocked = compactPanelWidth > 0;

  // The smallest the remembered window size may be left at, for this image on
  // this display: 40% of the screen on the frame's longest side, or the window
  // manager's own floor, whichever is larger. Below it the window would be
  // smaller than the window manager will make it, and the frame it actually got
  // would be larger than the picture meant to fill it — the band this whole mode
  // is built to avoid.
  //
  // A floor on the *gesture*, never on the sizing: `computeCompactContentSize` is
  // handed whatever size factor it is given and answers honestly, because
  // clamping there would size a frame the picture cannot cover.
  //
  // 1 wherever there is no compact frame to shrink — outside the mode, in
  // fullscreen (where the window is the screen and its size is not the picture's
  // business), and before the image has loaded.
  const minUserScale =
    compactAvail && naturalWidth && naturalHeight
      ? compactMinUserScale(
          naturalWidth,
          naturalHeight,
          compactAvail.width,
          compactAvail.height,
        )
      : 1;

  // The magnification the frame should hold. Flattened to 1 outside the mode so
  // that wheeling the ordinary modal does not re-run the reshape effect for an
  // answer that never changes — it would tell the main process the compact mode
  // is off once per wheel tick.
  const compactZoom = isCompactMode ? zoom : 1;

  // Bumped when the user asks the OS to maximise the compact window. It is a
  // request to re-apply at the maximum, not merely to change the remembered
  // size: at the maximum already, the size is unchanged, and the window still
  // has to be brought back out of its maximised state.
  const [compactFillRequest, setCompactFillRequest] = useState(0);

  useEffect(() => {
    if (!isStandaloneWindow || !isCompactMode) return;
    // The main process converts the OS's fill-the-screen gesture into this,
    // because a window shaped to its image has no screen-filling shape.
    return window.electronAPI?.onViewerCompactFillScreen?.(() => {
      compactHandSizedRef.current = false;
      setCompactUserScale(1);
      // The gesture lands the window on the compact maximum, which is the fit at
      // 1x — a magnification on top of that has no frame to live in, and the
      // resize effect would ask for one the main process has just refused.
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setCompactFillRequest((n) => n + 1);
    });
  }, [isStandaloneWindow, isCompactMode]);

  // Reshape the window whenever the image, the mode, the magnification, or the
  // fullscreen state changes. Re-running on `image.id` is what makes
  // next/previous re-fit; re-running on the zoom is what lets the frame grow with
  // the picture until the work area stops it.
  //
  // A *layout* effect, so the request is on its way before the frame this render
  // is about is painted. The picture's magnification and the window's size are
  // committed by two different mechanisms — a CSS transform and a window-manager
  // call — and the only thing that can hold them together is the timing: from a
  // passive effect the message leaves after the paint, so the window is
  // guaranteed to be a frame behind the picture, every step of a zoom. Sent
  // here, the main process applies it (≈1.7ms, measured) inside the same frame.
  // Nothing in the effect reads layout or sets state, so it costs no re-render.
  useLayoutEffect(() => {
    if (!setViewerCompactMode) return;

    if (!isCompactMode) {
      cancelCompactGrow(compactGrowTimerRef, compactGrowSendRef);
      compactAppliedRef.current = null;
      compactFitKeyRef.current = null;
      compactZoomRef.current = 1;
      compactHandSizedRef.current = false;
      compactRequestKeyRef.current = null;
      setViewerCompactMode({ enabled: false });
      return;
    }
    // Fullscreen owns the window size; the compact size is re-applied on exit.
    // The last request is forgotten with it — the size that comes back is not a
    // repeat of one the fullscreen window overrode, it is that answer again.
    if (isFullscreen || !naturalWidth || !naturalHeight) {
      cancelCompactGrow(compactGrowTimerRef, compactGrowSendRef);
      compactRequestKeyRef.current = null;
      return;
    }

    const { width: availWidth, height: availHeight } = compactAvailSize();

    // The magnification this request is about. A window is only ever shaped for
    // the image it is showing, and effects run in declaration order — so on
    // navigation this one runs before the reset below and would otherwise size
    // the *new* image's frame from the *outgoing* image's zoom, flashing a
    // wrongly-shaped window before correcting itself. A fresh fit is 1x by
    // construction, which is what "frame window to image" means.
    const requestedZoom =
      compactFitKeyRef.current === image.id ? compactZoom : 1;

    // The panel the window is shaped around. The **committed** share, not the
    // resolved one: this effect reshapes the window across an IPC round trip,
    // and a drag runs at pointer speed, so reading the live value here would
    // send a resize per frame and tear down the listener rebuilding with it.
    // The layout reads the resolved share; this deliberately does not, and the
    // two meet at the mousedown that commits.
    //
    // A panel whose width changed since the last request is a toggle or a
    // finished drag, and either way decides the anchor further down.
    const reserved = compactPanelDocked
      ? compactSidebarWidth(availWidth, sidebarShare)
      : 0;

    const size = computeCompactContentSize(
      naturalWidth,
      naturalHeight,
      availWidth,
      availHeight,
      compactUserScale,
      requestedZoom,
      reserved,
    );
    if (!size) return;

    // The largest this window may ever be: the fit at scale 1, plus whatever the
    // docked panel takes — the maximum has to cover the panel too, or the OS's
    // own maximise would land on a frame the panel no longer fits in. The main
    // process hands it to the window manager as the window's maximum, and Windows
    // consults that maximum *before* it commits a maximise — so the maximise
    // gesture lands on the compact maximum directly, and the work-area-sized
    // frame it would otherwise paint on the way is never drawn.
    const ceiling = computeCompactContentSize(
      naturalWidth,
      naturalHeight,
      availWidth,
      availHeight,
      1,
      1,
      reserved,
    );

    // Everything this request would say, as one value. A window that has already
    // grown as far as the work area allows computes the same size at every step
    // of a wheel flick or a slider drag — the frame has stopped growing and only
    // the picture is moving — yet this effect re-runs on each of those steps,
    // across an IPC round trip. Saying it once is enough. The image is in the key
    // because the same numbers for another picture are a fresh fit, and the
    // counter because a fill-the-screen request has to go out even when the size
    // it asks for is the one already in force.
    // The reservation is in the key as well as the sizes it produces: on a
    // display with no room to grow, docking the panel leaves the window exactly
    // the size it already is — and that request still has to go out, because the
    // reply is what tells the panel its frame is ready (see `compactPanelReady`).
    const requestKey = [
      image.id,
      size.contentWidth,
      size.contentHeight,
      ceiling?.contentWidth,
      ceiling?.contentHeight,
      compactFillRequest,
      reserved,
    ].join(":");

    // Recorded whether or not the message goes out: what the next re-fit has to
    // know is what the window is showing *now*, and a step that sent nothing —
    // because the frame was already as large as it can be — still moved the
    // magnification the next request has to divide out.
    const previousFit = compactFitKeyRef.current;
    const previousZoom = compactZoomRef.current;
    compactFitKeyRef.current = image.id;
    compactZoomRef.current = requestedZoom;

    if (compactRequestKeyRef.current === requestKey) {
      // Nothing to send — the frame already has the size this asks for. A docked
      // panel is still owed the "your frame is ready" the reply would have
      // brought, or it would sit transparent until something else moved. (The
      // mode's own paths all send a request when a panel appears, so this is the
      // net under them rather than a route it takes: a panel left invisible has
      // no other way back.)
      if (reserved > 0 && compactPanelTimerRef.current === undefined) {
        setCompactPanelReady(true);
      }
      return;
    }
    compactRequestKeyRef.current = requestKey;

    // Centre everything the viewer itself asked for, and leave a window the
    // user's hand sized where their hand left it. "keep" holds the frame's
    // top-left, which is right for the re-fit that follows a hand-drag and only
    // for it: the window is already where they put it, while the anchor the main
    // process holds for it is the *previous* fit's centre, so re-centring would
    // visibly undo the drag a moment later. Everything else is a fresh fit — a
    // new image, entering the mode, the wheel's magnification, or a size one of
    // the viewer's own controls set. The magnification is the one that must not
    // keep the corner: the frame is growing, and a window held by its top-left
    // would crawl the picture across the screen as the user scrolls. (Nor does
    // "center" mean "back to the app window" — the main process anchors on where
    // a window the user moved by hand is *now*, so a size step keeps that.)
    //
    // Docking or undocking the panel joins the hand-drag on the "keep" side, and
    // for a sharper reason than any of the above: the panel hangs off the frame's
    // right-hand side, so a window grown about its centre moves the *picture*
    // sideways by half the panel's width. Holding the left edge is what keeps a
    // panel toggle from touching a single pixel of the picture.
    const panelToggled = compactReservedRef.current !== reserved;
    compactReservedRef.current = reserved;
    const anchor: "center" | "keep" =
      panelToggled ||
      (previousFit === image.id &&
        previousZoom === requestedZoom &&
        compactHandSizedRef.current)
        ? "keep"
        : "center";

    // `requested` is the size this call sends, which is the fit the magnification
    // asks for except when a paced growth is on its way there a step at a time.
    const send = (
      requested: { contentWidth: number; contentHeight: number } = size,
    ) => {
      // Record what we asked for *before* the IPC round-trip: the resize event
      // it triggers has to be recognisable as ours.
      compactAppliedRef.current = {
        width: requested.contentWidth,
        height: requested.contentHeight,
      };
      // Which request this reply will belong to, so one that an older zoom step
      // left in flight can be recognised when it lands.
      const requestId = ++compactRequestIdRef.current;

      setViewerCompactMode({
        enabled: true,
        ...requested,
        maxContentWidth: ceiling?.contentWidth,
        maxContentHeight: ceiling?.contentHeight,
        anchor,
      })?.then((result) => {
        // …and correct it to the size the window actually took. The window
        // manager overrules the request in two places: below its floor it widens
        // a window narrower than the top bar (see COMPACT_MIN_WIDTH), and above
        // the work area it caps a large one. Left uncorrected, a size we never
        // took is the one thing the resize effect below reads as a hand-drag.
        if (!result?.success) return;
        // A docked panel is owed the frame this reply describes before its own
        // contents are allowed in: the panel is rendered transparent until the
        // window has taken the size that holds it, so what the user sees is one
        // resize with the contents fading in behind it, rather than a panel
        // drawn in a window that has not grown yet. Skipped while a collapse is
        // in flight — the pending timer means the panel is on its way out, and a
        // slow reply landing mid-fade must not bring it back.
        if (reserved > 0 && compactPanelTimerRef.current === undefined) {
          setCompactPanelReady(true);
        }
        if (!result.contentWidth || !result.contentHeight) return;
        // Holding an arrow key down can outrun the round-trip, and a reply that
        // lands after the viewer has moved on describes a window that is no
        // longer on screen.
        if (compactRequestIdRef.current !== requestId) return;
        if (compactFitKeyRef.current !== image.id) return;
        compactAppliedRef.current = {
          width: result.contentWidth,
          height: result.contentHeight,
        };
      });
    };

    // A magnification *growing* the frame waits for the gesture to finish; every
    // other change goes out at once. The gesture this guards against is a wheel
    // flick or a slider drag — many magnification steps a few tens of
    // milliseconds apart, each of which would otherwise be its own window
    // resize, and a resize cannot be shown for ~50ms (measured). At speed the
    // resizes arrive faster than they can be presented and the picture never
    // settles for the length of the gesture, which is the flicker. Coalesced,
    // the gesture is pure magnification — a change the compositor can make
    // without touching the window at all — and one resize lands at the end.
    //
    // Growth only, and only when the image is the one already on screen: a
    // navigation, a hand-drag's follow-up re-fit and the fill-the-screen gesture
    // are single discrete changes with no second step coming to coalesce with,
    // so deferring them would only make the frame look late. A shrink is sent at
    // once for the same reason it has no partner — and because leaving the frame
    // larger than the picture would show the background this mode exists to keep
    // out of sight.
    const appliedBefore = compactAppliedRef.current;
    const grows =
      appliedBefore !== null &&
      previousFit === image.id &&
      previousZoom !== requestedZoom &&
      size.contentWidth * size.contentHeight >
        appliedBefore.width * appliedBefore.height;

    if (!grows) {
      // A growth still waiting describes a magnification the user has already
      // left — navigating, dragging, or shrinking past it must not have that
      // older size land on top of the newer one a moment later.
      cancelCompactGrow(compactGrowTimerRef, compactGrowSendRef);
      send();
      return;
    }

    // Runs the growth that was due, and then keeps running it until the frame is
    // as large as the magnification needs, in steps of at most
    // COMPACT_GROW_MAX_STEP. A coalesced flick asks for a resize of x2.4 at once,
    // and the cost of a resize is proportional to how far it moves (see
    // COMPACT_GROW_MAX_STEP), so the one place the mode draws its biggest flash is
    // the growth that coalescing just built. Stepped, the flick lands as a few
    // resizes no larger than the ones the gesture itself was making.
    //
    // Reads the applied size rather than the target so each step is measured from
    // where the frame actually is — including a step the window manager overruled
    // — and is therefore never more than the cap however the gesture got here.
    const growOneStep = () => {
      const applied = compactAppliedRef.current;
      const toGo = applied
        ? Math.min(
            size.contentWidth / applied.width,
            size.contentHeight / applied.height,
          )
        : 0;
      if (!applied || !Number.isFinite(toGo) || toGo <= COMPACT_GROW_MAX_STEP) {
        send();
        return;
      }
      send({
        contentWidth: Math.round(applied.width * COMPACT_GROW_MAX_STEP),
        contentHeight: Math.round(applied.height * COMPACT_GROW_MAX_STEP),
      });
      // The rest of the way once this step has had time to reach the screen. The
      // continuation goes in the same two refs the settle uses, so every path
      // that abandons a waiting growth — navigating, hand-dragging, shrinking,
      // leaving the mode — abandons the rest of this one with it.
      compactGrowSendRef.current = growOneStep;
      compactGrowTimerRef.current = window.setTimeout(() => {
        compactGrowTimerRef.current = undefined;
        const pending = compactGrowSendRef.current;
        compactGrowSendRef.current = null;
        pending?.();
      }, COMPACT_GROW_STEP_MS);
    };

    // Replaces whatever was waiting: of a flick's worth of steps only the last
    // magnification is worth a resize, and the wait restarts with it.
    window.clearTimeout(compactGrowTimerRef.current);
    compactGrowSendRef.current = growOneStep;
    compactGrowTimerRef.current = window.setTimeout(() => {
      compactGrowTimerRef.current = undefined;
      const pending = compactGrowSendRef.current;
      compactGrowSendRef.current = null;
      pending?.();
    }, COMPACT_GROW_SETTLE_MS);
  }, [
    setViewerCompactMode,
    isCompactMode,
    isFullscreen,
    naturalWidth,
    naturalHeight,
    compactUserScale,
    // Docking or undocking the panel is a resize like any other, and the only
    // thing that changes in this effect for it — the sizes it computes are a
    // function of the reservation, so leaving this out would dock a panel into a
    // window that was never asked to make room for it.
    compactPanelDocked,
    // The reservation is read *inside* this effect and is not otherwise visible
    // to it. While the panel's width was a constant that was safe — the value
    // could not change without `compactPanelDocked` changing with it — but it is
    // user state now, and a width this effect cannot see is a window shaped for
    // the panel the user used to have. It is the *committed* share on purpose:
    // the live one belongs to the layout, and reshaping the window at pointer
    // speed is the flicker the pacing above exists to prevent.
    sidebarShare,
    compactFillRequest,
    image.id,
    // Through `compactZoom`, not `zoom`: outside the mode the magnification is
    // none of this effect's business, and reading it raw would tell the main
    // process the mode is off once per wheel tick of the ordinary modal.
    compactZoom,
  ]);

  // A growth that is still waiting when the viewer goes away would fire against
  // a window that is no longer there — closing the viewer mid-flick would resize
  // whatever came next.
  useEffect(
    () => () => cancelCompactGrow(compactGrowTimerRef, compactGrowSendRef),
    [],
  );

  // Learn the user's window-size preference from a hand-dragged compact window.
  // Debounced, because a drag emits a resize event per frame, and skipped while
  // fullscreen, whose screen-sized window is not a statement about preference.
  useEffect(() => {
    if (!setViewerCompactMode || !isCompactMode || isFullscreen) return;
    if (!naturalWidth || !naturalHeight) return;

    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const applied = compactAppliedRef.current;
        if (!applied) return;

        const observedWidth = window.innerWidth;
        const observedHeight = window.innerHeight;
        // Our own resize, landing inside the frame's rounding slack.
        if (
          Math.abs(observedWidth - applied.width) <= COMPACT_RESIZE_TOLERANCE &&
          Math.abs(observedHeight - applied.height) <= COMPACT_RESIZE_TOLERANCE
        ) {
          return;
        }

        // Read the drag against the *fit* for the image on screen rather than
        // against the size we last applied. The remembered factor is then a
        // statement about this window alone: it cannot compound over successive
        // drags, and a value spoiled by a maximised window is corrected by the
        // next drag instead of pinning every image to full size for good.
        const availWidth = window.screen?.availWidth || window.innerWidth;
        const availHeight = window.screen?.availHeight || window.innerHeight;
        // A docked panel is a cost the *next* window may not be paying, so it
        // comes out of the observation the same way the padding does: what the
        // user's hand said is about the picture they were looking at, and the
        // window they were looking at was a panel's width wider for it.
        //
        // The committed share, and this listener has to be rebuilt when it
        // changes (it is listed in the deps below). A stale panel width here is
        // not a cosmetic error: the factor it produces is stored, so reading the
        // window against a panel the user has since resized would put the size
        // of every following window out by the difference, permanently.
        const reserved = compactPanelDocked
          ? compactSidebarWidth(availWidth, sidebarShare)
          : 0;
        const next = userScaleFromResize(
          naturalWidth,
          naturalHeight,
          availWidth,
          availHeight,
          observedWidth,
          observedHeight,
          // Read from the ref rather than the state: this runs on a debounce,
          // when the drag has finished and the reader is asking what the window
          // is showing *now*. A zoomed frame is a multiple of the fit before the
          // user touches anything, so without it a drag at 3x would remember
          // "three times as large" and open the next image at nine.
          compactZoomRef.current,
          reserved,
        );
        // Refused, not clamped, when it falls under the smallest frame the
        // window manager will make: a remembered size that small would have the
        // next image opened at the OS minimum — a frame wider than its picture,
        // which is the background this mode exists to keep out of sight.
        // Refusing leaves the factor alone, so nothing here re-fits anything:
        // the window the user dragged keeps the size their hand gave it, and the
        // preference stays at the last size both images could honour.
        //
        // That floor is read *without* the panel, deliberately. A docked panel
        // widens the frame the floor is about, so the true floor with one open is
        // a little lower than this — and the error is in the direction that costs
        // nothing: the drag the user made still stands, only the memory of a size
        // this small is dropped. Read with the panel it would have to be stored
        // as a share that no panel-less window could honour later.
        if (
          next <
          compactWindowMinimumScale(
            naturalWidth,
            naturalHeight,
            availWidth,
            availHeight,
          )
        ) {
          return;
        }
        if (Math.abs(next - compactUserScale) < COMPACT_SCALE_EPSILON) return;
        compactHandSizedRef.current = true;
        setCompactUserScale(next);
      }, 400);
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, [
    setViewerCompactMode,
    isCompactMode,
    isFullscreen,
    naturalWidth,
    naturalHeight,
    compactUserScale,
    compactPanelDocked,
    // The panel's width is subtracted from what this listener observes, and the
    // factor it derives is *stored*. Rebuilt when the width moves, so the
    // measurement is never taken against a panel the user has since resized —
    // which would put the remembered size of every following window out by the
    // difference, permanently.
    sidebarShare,
  ]);

  // The row the picture and the panel divide, measured as the base for a drag.
  const modalBodyRef = useRef<HTMLDivElement>(null);
  // The share the pointer is currently at, mirrored out of state so the mouseup
  // can read it without the listener being rebuilt on every move (which is what
  // keeping it only in state would cost, since the effect is keyed on the drag).
  const dragShareRef = useRef<number | null>(null);

  const endSidebarDrag = () => {
    const dragged = dragShareRef.current;
    // A drag that never moved commits nothing, so a stray click on the handle
    // leaves the stored width alone.
    if (dragged !== null) setSidebarShare(dragged);
    dragShareRef.current = null;
    setDragShare(null);
    setSidebarDrag(null);
  };

  const handleSidebarResizeStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Stops the browser starting a text selection, which would otherwise run
    // away with the gesture; the effect below also parks `user-select` for the
    // length of the drag.
    e.preventDefault();
    // The share is a fraction of *something*, and which something depends on the
    // mode. A compact window is the picture's size, so the panel is read against
    // the screen; the ordinary viewer's panel is read against the row it sits
    // in, which is why this needs the body's measured width and the compact path
    // does not.
    const base =
      isCompactMode && compactAvail
        ? compactAvail.width
        : modalBodyRef.current?.clientWidth ?? 0;
    if (!base) return;
    dragShareRef.current = null;
    setSidebarDrag({ startX: e.clientX, startShare: sidebarShare, base });
  };

  // Double-click puts the panel back to the width a fresh install gets. Both
  // modes: one stored number means one default to return to.
  const resetSidebarShare = () => {
    dragShareRef.current = null;
    setDragShare(null);
    setSidebarShare(DEFAULT_SIDEBAR_SHARE);
  };

  // The drag itself. The listeners live on the document rather than the handle,
  // because the pointer leaves a four-pixel strip immediately and the gesture
  // has to survive that — the column resize in ImageTable is the same shape.
  //
  // `mouseleave` and `blur` end the drag as well as `mouseup` does. Neither is
  // decoration: a compact window is only the picture and the panel wide, so
  // dragging the edge past the picture's far side takes the pointer out of the
  // window altogether, and a drag with no end would follow the cursor back in.
  useEffect(() => {
    if (!sidebarDrag) return;
    const { startX, startShare, base } = sidebarDrag;

    const onMove = (e: MouseEvent) => {
      // Left widens the panel, so the pointer's travel is subtracted. Bounded
      // rather than clamped: dragged past the floor this arithmetic goes
      // negative, and `clampSidebarShare` would read that as "never chosen" and
      // send the panel back to the default under the pointer.
      const next = roundSidebarShare(
        boundSidebarShare(startShare - (e.clientX - startX) / base),
      );
      dragShareRef.current = next;
      setDragShare(next);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", endSidebarDrag);
    document.addEventListener("mouseleave", endSidebarDrag);
    window.addEventListener("blur", endSidebarDrag);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", endSidebarDrag);
      document.removeEventListener("mouseleave", endSidebarDrag);
      window.removeEventListener("blur", endSidebarDrag);
    };
  }, [sidebarDrag]);

  // Whether the metadata panel is off screen. Compact mode has its own answer,
  // because its panel is per-window and starts closed: the mode is entered as the
  // picture alone, and the panel then opens *inside* the compact window (which
  // grows for it) rather than by leaving the mode for the app's own viewer size.
  // The persisted preference is still the normal view's business — the compact
  // toggle mirrors its own state into it, so what is on screen agrees with it
  // when the mode ends — and the sidebar buttons read this rather than the flag
  // alone, so they describe the panel the user can actually see.
  const sidebarHidden = isCompactMode ? !compactPanelOpen : isSidebarCollapsed;

  const videoInfo = (nMeta as any)?.video;
  const motionModel = (nMeta as any)?.motion_model;

  const analytics = nMeta?._analytics;
  // Whether the Performance group has anything to show. The section it replaces
  // gated on `_analytics` merely being present, which renders an empty box —
  // every field it reads is optional and most generators set only some.
  const hasPerformanceData = Boolean(
    analytics &&
      ((analytics.generation_time_ms != null &&
        analytics.generation_time_ms > 0) ||
        analytics.vram_peak_mb != null ||
        analytics.gpu_device ||
        analytics.steps_per_second != null ||
        analytics.comfyui_version ||
        analytics.torch_version ||
        analytics.python_version),
  );

  const copyToClipboard = (text: string, type: string) => {
    if (!text) {
      alert(`No ${type} to copy.`);
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => {
        const notification = document.createElement("div");
        notification.className =
          "fixed top-[calc(var(--header-height,44px)+12px)] right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg z-50";
        notification.textContent = `${type} copied to clipboard!`;
        document.body.appendChild(notification);
        setTimeout(() => document.body.removeChild(notification), 2000);
      })
      .catch((err) => {
        console.error(`Failed to copy ${type}:`, err);
        alert(`Failed to copy ${type}.`);
      });
  };

  const copyToClipboardElectron = async (text: string, type: string) => {
    if (!text) {
      alert(`No ${type} to copy.`);
      return;
    }

    try {
      // Usar navigator.clipboard (funciona tanto no Electron quanto no browser)
      await navigator.clipboard.writeText(text);

      const notification = document.createElement("div");
      notification.className =
        "fixed top-[calc(var(--header-height,44px)+12px)] right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg z-50";
      notification.textContent = `${type} copied to clipboard!`;
      document.body.appendChild(notification);
      setTimeout(() => document.body.removeChild(notification), 2000);
    } catch (err) {
      console.error(`Failed to copy ${type}:`, err);
      alert(`Failed to copy ${type}.`);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      visible: true,
    });
  };

  const hideContextMenu = () => {
    setContextMenu({ x: 0, y: 0, visible: false });
  };

  const copyPrompt = () => {
    copyToClipboardElectron(nMeta?.prompt || "", "Prompt");
    hideContextMenu();
  };

  const copyNegativePrompt = () => {
    copyToClipboardElectron(nMeta?.negativePrompt || "", "Negative Prompt");
    hideContextMenu();
  };

  const copySeed = () => {
    copyToClipboardElectron(String(nMeta?.seed || ""), "Seed");
    hideContextMenu();
  };

  const copyImage = async () => {
    hideContextMenu();
    if (isVideo) {
      return;
    }
    const result = await copyImageToClipboard(image);
    if (result.success) {
      const notification = document.createElement("div");
      notification.className =
        "fixed top-[calc(var(--header-height,44px)+12px)] right-4 bg-green-600 text-white px-4 py-2 rounded shadow-lg z-50";
      notification.textContent = "Image copied to clipboard!";
      document.body.appendChild(notification);
      setTimeout(() => document.body.removeChild(notification), 2000);
    } else {
      alert(`Failed to copy image to clipboard: ${result.error}`);
    }
  };

  const copyModel = () => {
    copyToClipboardElectron(nMeta?.model || "", "Model");
    hideContextMenu();
  };

  /**
   * Resolves this image's real path, or null when nothing usable is available.
   * Shared by every action that needs a location on disk, so Copy Image Path /
   * Show in Folder / Open in Native Viewer can never disagree about where the
   * file is.
   */
  const resolvePath = () => getImageAbsolutePath(image, directoryPath) || null;

  const copyPath = () => {
    const path = resolvePath();
    if (!path) {
      alert("Cannot determine file path: directory path is missing.");
      return;
    }
    copyToClipboardElectron(quotePathForClipboard(path), "Image Path");
    hideContextMenu();
  };

  const showInFolder = () => {
    hideContextMenu();
    const path = resolvePath();
    if (!path) {
      alert("Cannot determine file location: directory path is missing.");
      return;
    }
    // The showInExplorer utility can handle the full path directly
    showInExplorer(path);
  };

  const openWithNativeViewer = () => {
    hideContextMenu();
    const path = resolvePath();
    if (!path) {
      alert("Cannot determine file location: directory path is missing.");
      return;
    }
    openInNativeViewer(path);
  };

  // Reset zoom and pan when image changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // The minimap unmounts at scale 1; clearing this too means a drag that was
    // live when the image changed cannot leave the next image un-eased.
    setIsMinimapDragging(false);
  }, [image.id]);

  /**
   * Resizes the compact window by one step, for a gesture at the fit.
   *
   * The magnification is floored at the fit, so a step *out* from there has
   * nothing to move but the window — and what that leaves behind is the
   * remembered size, which is the whole point: a size the gesture merely visited
   * would be forgotten the moment the viewer moved on to the next image, and the
   * user would be back to a full-size window the next time they pressed an arrow
   * key. A step *in* from a shrunk window grows it back, and once it is at the
   * fit the magnification takes over again — so the two are one gesture, not two
   * controls that meet.
   *
   * @returns true when the step was a window resize, leaving the caller nothing
   * to do.
   */
  const stepCompactSize = useCallback(
    (notches: number): boolean => {
      if (!isCompactMode || isFullscreen || zoom !== 1 || notches === 0) {
        return false;
      }
      // Clamped at both ends: at the floor the window stops, and at the fit the
      // magnification is what grows instead.
      const next = Math.min(
        1,
        Math.max(minUserScale, compactUserScale * compactStepRate(notches)),
      );
      if (next === compactUserScale) return false;
      // A step is the viewer's own doing, not the hand's: the window shrinks or
      // grows about its centre, the way the magnification does.
      compactHandSizedRef.current = false;
      setCompactUserScale(next);
      return true;
    },
    [isCompactMode, isFullscreen, zoom, compactUserScale, minUserScale],
  );

  // Zoom handlers
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();

      let mx = 0;
      let my = 0;
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        mx = e.clientX - cx;
        my = e.clientY - cy;
      }

      // Cap max deltaY to ensure fast scrolls don't skip entirely out of bounds.
      const normalizedDeltaY = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 150);
      // Scrolling up is a negative deltaY and a positive step. `deltaY` is only
      // ever read to decide the direction and the size of a step now, so the
      // -0.0025 that used to turn it into a magnification lives in `stepZoom`.
      const notches = -normalizedDeltaY / WHEEL_DETENT;

      // At the fit the wheel resizes the window rather than magnifying the
      // picture. Handled out here rather than inside the updater below, because
      // it is a write to a different piece of state and an updater may be re-run.
      if (stepCompactSize(notches)) return;

      setZoom((prevZoom) => {
        // Floored at the fit (1), capped at 10x.
        const newZoom = stepZoom(prevZoom, notches);

        if (newZoom === prevZoom) return prevZoom;

        // Which axes the picture can still be moved along at the magnification
        // being asked for — see `compactPanAxes`. The pane cannot answer that
        // here, because the pane is the thing about to change: below the display
        // cap the compact window grows to hold the whole picture, so a pan
        // anchored on the cursor would slide the picture sideways and the resize
        // would put it back a moment later, two motions for one step of the
        // wheel. Asked of the new zoom, because that is the frame the window is
        // about to take. In fullscreen the window is not the frame, and outside
        // the mode the pane never follows the zoom, so every axis pans as it
        // always has.
        let panAxes: { width: boolean; height: boolean } = ALL_AXES_PANNABLE;
        if (
          isCompactMode &&
          !isFullscreen &&
          naturalWidth &&
          naturalHeight
        ) {
          const avail = compactAvailSize();
          panAxes = compactPanAxes(
            naturalWidth,
            naturalHeight,
            avail.width,
            avail.height,
            compactUserScale,
            newZoom,
            // The docked panel crops the picture the same way the display's edge
            // does, so its width is part of the frame the pan is clamped against
            // — an axis it has eaten is one the wheel must not anchor on. The
            // committed share, with the listener rebuilt when it moves: a wheel
            // read against a panel that has since been resized would anchor on
            // an axis the picture can no longer move along.
            compactPanelDocked ? compactSidebarWidth(avail.width, sidebarShare) : 0,
          );
        }

        // Schedule pan correctly based on exact prev values
        setPan((prevPan) => {
          // At or below 1x the whole picture is inside the pane, so there is
          // nowhere left for a pan to have carried it — below the fit, where the
          // frame is now allowed to go, there is less than that.
          if (newZoom <= 1) {
            return { x: 0, y: 0 };
          }
          const ratio = newZoom / prevZoom;
          // An axis the frame will hold whole gets no pan at all: centred is the
          // only place the picture can end up, so anchoring it on the cursor
          // there is motion with nothing to show for it.
          const rawPx = panAxes.width
            ? prevPan.x * ratio + mx * (1 - ratio)
            : 0;
          const rawPy = panAxes.height
            ? prevPan.y * ratio + my * (1 - ratio)
            : 0;
          return clampPan(rawPx, rawPy, newZoom);
        });

        return newZoom;
      });
    },
    [
      clampPan,
      isCompactMode,
      isFullscreen,
      naturalWidth,
      naturalHeight,
      compactUserScale,
      compactPanelDocked,
      // Read through `compactPanAxes`: the pan a wheel anchors on is bounded by
      // the pane, and the pane's width depends on the panel's.
      sidebarShare,
      stepCompactSize,
    ],
  );

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Don't start dragging if clicking zoom controls, the minimap, or other
      // interactive elements
      if ((e.target as HTMLElement).closest(".zoom-controls, .image-minimap")) {
        return;
      }

      // `canPan` rather than `zoom > 1`: a compact frame that grew to hold the
      // magnification has nothing to pan, and a grab that does not move the
      // picture promises otherwise.
      if (canPan && e.button === 0) {
        setIsDragging(true);
        setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
        e.preventDefault();
      }
    },
    [canPan, pan],
  );

  const triggerExternalDrag = useCallback(() => {
    if (!canDragExternally || !directoryPath) {
      return;
    }

    const [, relativeFromId] = image.id.split("::");
    const relativePath = relativeFromId || image.name;

    window.electronAPI?.startFileDrag({
      directoryPath,
      relativePath,
      id: image.id,
      lastModified: image.lastModified,
    });
    
    // Reset dragging state to stop panning
    setIsDragging(false);
  }, [canDragExternally, directoryPath, image]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging && canPan) {
        // Edge detection: if user drags near the window border while zoomed,
        // trigger external drag automatically.
        const threshold = 8;
        const isNearBorder = 
          e.clientX < threshold || 
          e.clientX > window.innerWidth - threshold ||
          e.clientY < threshold ||
          e.clientY > window.innerHeight - threshold;

        if (isNearBorder) {
          triggerExternalDrag();
          return;
        }

        const rawX = e.clientX - dragStart.x;
        const rawY = e.clientY - dragStart.y;
        setPan(clampPan(rawX, rawY, zoom));
      }
    },
    [isDragging, dragStart, canPan, zoom, clampPan, triggerExternalDrag],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeaveContainer = useCallback(() => {
    if (isDragging && canPan) {
      // If we leave the container while panning, trigger the file drag
      triggerExternalDrag();
    } else {
      handleMouseUp();
    }
  }, [isDragging, canPan, triggerExternalDrag, handleMouseUp]);

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLImageElement>) => {
      if (!canDragExternally) {
        return;
      }
      e.preventDefault();
      triggerExternalDrag();
    },
    [canDragExternally, triggerExternalDrag],
  );

  const handleZoomIn = () => {
    // At the fit a press grows the *window* back out of a shrink, and only past
    // the fit does it magnify — see `stepCompactSize`.
    if (stepCompactSize(2)) return;

    // Half a magnification a press, as it has always been.
    const newZoom = stepZoom(zoom, 2);
    if (newZoom === zoom) return;

    setZoom(newZoom);
    if (newZoom <= 1) {
      setPan({ x: 0, y: 0 });
    } else {
      const ratio = newZoom / zoom;
      setPan((prev) => clampPan(prev.x * ratio, prev.y * ratio, newZoom));
    }
  };

  const handleZoomOut = () => {
    if (stepCompactSize(-2)) return;

    const newZoom = stepZoom(zoom, -2);
    if (newZoom === zoom) return;

    setZoom(newZoom);
    if (newZoom <= 1) {
      setPan({ x: 0, y: 0 });
    } else {
      const ratio = newZoom / zoom;
      setPan((prev) => clampPan(prev.x * ratio, prev.y * ratio, newZoom));
    }
  };

  const handleResetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    // The remembered size *is* this window's size, so going back to 100% takes
    // it back too — otherwise the next image would open shrunk again with
    // nothing on screen to explain why. An explicit reset is the viewer's own
    // doing, so the frame grows about its centre rather than from a corner.
    if (isCompactMode) {
      compactHandSizedRef.current = false;
      setCompactUserScale(1);
    }
  };

  // Old useEffect removed. Logic moved to the main loading/preloading effect.
  // Kept Empty for diff cleanliness, correct implementation is above.


  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't handle navigation keys if hotkeys are paused (e.g., GenerateModal is open)
      if (hotkeyManager.areHotkeysPaused()) {
        return;
      }

      if (isRenaming) return;

      // Ctrl+F / Cmd+F = open find-in-prompt. Sits above the search-bar guard
      // so re-pressing while the input is focused re-selects the query.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (isSearchOpen) {
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        } else {
          openSearch();
        }
        return;
      }

      // Keys typed inside the search bar belong to the input: Escape/Enter are
      // stopped by its React onKeyDown, and this guard keeps arrows/Delete from
      // navigating or deleting while it has focus.
      const evTarget = event.target as HTMLElement | null;
      const inSearchBar =
        isSearchOpen && typeof evTarget?.closest === "function"
          ? !!evTarget.closest?.("[data-search-bar]")
          : false;
      if (inSearchBar) return;

      // Alt+Enter = Toggle fullscreen (works in both grid and modal)
      if (event.key === "Enter" && event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleFullscreen(); // Toggle fullscreen ON/OFF
        return;
      }

      // Escape = close the search first, then exit fullscreen, then close modal
      if (event.key === "Escape") {
        event.stopPropagation(); // Prevent global hotkeys (closing sidebar)
        if (isSearchOpen) {
          closeSearch(); // an open search is never closed by a fullscreen/modal exit
        } else if (isFullscreen) {
          // Call toggleFullscreen to actually exit Electron fullscreen
          toggleFullscreen();
        } else {
          onClose();
        }
        return;
      }

      if (event.key === "ArrowLeft") onNavigatePrevious?.();
      if (event.key === "ArrowRight") onNavigateNext?.();
      if (event.key === "Delete") handleDelete();
    };

    const handleClickOutside = () => {
      hideContextMenu();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("click", handleClickOutside);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("click", handleClickOutside);
    };
  }, [
    hideContextMenu,
    isFullscreen,
    isRenaming,
    isSearchOpen, // handler must rebind when the search bar opens/closes
    openSearch, // stable (useCallback, functional updates only)
    closeSearch, // stable (useCallback, functional updates only)
    onClose,
    onNavigateNext,
    onNavigatePrevious,
    toggleFullscreen,
  ]);

  // Focus + select after the conditional search bar mounts (an autoFocus prop
  // would not re-run when reopening the bar with an existing query).
  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
  }, [isSearchOpen]);

  // Count highlight marks, ring the active one, and scroll it into view. Runs
  // after commit so the re-split <pre> is on screen. Outline is set inline —
  // classList.toggle does not split multi-token strings. scrollIntoView is
  // typeof-guarded because jsdom (tests) does not implement it.
  useEffect(() => {
    if (!isSearchOpen) return;
    if (!searchQuery.trim() || !effectiveMetadata?.prompt) return; // JSX shows hints
    const marks = Array.from(
      promptSectionRef.current?.querySelectorAll("mark.search-hit") ?? [],
    );
    if (marks.length !== matchCount) setMatchCount(marks.length); // guarded → no loop
    if (marks.length === 0) return;
    const idx = Math.min(activeMatch, marks.length - 1);
    marks.forEach((m, i) => {
      const el = m as HTMLElement;
      if (i === idx) {
        el.style.outline = "2px solid #f59e0b";
        el.style.outlineOffset = "1px";
      } else {
        el.style.outline = "";
        el.style.outlineOffset = "";
      }
    });
    const el = marks[idx] as HTMLElement;
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [
    isSearchOpen,
    searchQuery,
    activeMatch,
    matchCount,
    effectiveMetadata?.prompt,
    image.id,
    // Re-counts when the Prompt group is expanded: collapsed, the <pre> is
    // unmounted and there is nothing to count, which would strand the counter
    // at 0 / 0 until the query changed. The effect only writes when the count
    // differs, so this cannot loop.
    expandedGroups.prompt,
  ]);

  // Navigating to another image while searching resets to the first match.
  useEffect(() => {
    if (isSearchOpen) setActiveMatch(0);
  }, [image.id, isSearchOpen]);

  // Separate effect for wheel event listener to avoid image reloading on zoom changes
  useEffect(() => {
    const imageContainer = document.getElementById("image-zoom-container");
    if (imageContainer) {
      imageContainer.addEventListener("wheel", handleWheel, { passive: false });
    }

    return () => {
      if (imageContainer) {
        imageContainer.removeEventListener("wheel", handleWheel);
      }
    };
  }, [handleWheel]);

  const handleDelete = async () => {
    const confirmOnDelete = useSettingsStore.getState().confirmOnDelete;
    const shouldDelete =
      !confirmOnDelete ||
      window.confirm(
        "Are you sure you want to delete this image? This action cannot be undone.",
      );

    if (shouldDelete) {
      const idToDelete = image.id;
      const imageToDelete = image; // Capture reference

      // Navigate to next/previous image BEFORE deletion to keep modal open
      // Check if we have other images to navigate to
      const hasMoreImages = totalImages > 1;

      if (hasMoreImages) {
        // Prefer next image, fallback to previous if at the end
        if (currentIndex < totalImages - 1) {
          onNavigateNext?.();
        } else {
          onNavigatePrevious?.();
        }
      }

      const result = await FileOperations.deleteFile(imageToDelete);
      if (result.success) {
        onImageDeleted?.(idToDelete);

        // Only close if we didn't have anywhere to navigate (last image deleted)
        if (!hasMoreImages) {
          onClose();
        }
      } else {
        alert(`Failed to delete file: ${result.error}`);
      }
    }
  };

  const confirmRename = async () => {
    if (!newName.trim() || !FileOperations.validateFilename(newName).valid) {
      alert("Invalid filename.");
      return;
    }
    const result = await FileOperations.renameFile(image, newName);
    if (result.success) {
      onImageRenamed?.(image.id, `${newName}.${image.name.split(".").pop()}`);
      setIsRenaming(false);
    } else {
      alert(`Failed to rename file: ${result.error}`);
    }
  };

  // Tag management handlers
  const handleAddTag = () => {
    if (!tagInput.trim()) return;
    if (onTagAdded) {
      onTagAdded(image.id, tagInput);
    } else {
      addTagToImage(image.id, tagInput);
    }
    setTagInput("");
    setShowTagAutocomplete(false);
  };

  const handleRemoveTag = (tag: string) => {
    if (onTagRemoved) {
      onTagRemoved(image.id, tag);
    } else {
      removeTagFromImage(image.id, tag);
    }
  };

  const handleToggleFavorite = () => {
    if (onFavoriteToggled) {
      onFavoriteToggled(image.id);
    } else {
      toggleFavorite(image.id);
    }
  };

  // Filter autocomplete tags
  const autocompleteOptions = tagInput
    ? availableTags
        .filter(
          (tag) =>
            tag.name.includes(tagInput.toLowerCase()) &&
            !currentTags.includes(tag.name),
        )
        .slice(0, 5)
    : [];

  // Fetch raw metadata from file when "Full JSON" is clicked
  const handleLoadFullJson = useCallback(async () => {
    if (metadataViewMode === "fulljson") {
      setMetadataViewMode("parsed");
      return;
    }
    setMetadataViewMode("fulljson");
    if (!fullRawMetadata && directoryPath) {
      setIsLoadingFullJson(true);
      try {
        const [, relPath] = image.id.split("::");
        const filePath = relPath || image.name;
        let fullPath = `${directoryPath}/${filePath}`;
        // Use Electron's safe path joining when available
        if (window.electronAPI?.joinPaths) {
          const result = await window.electronAPI.joinPaths(
            directoryPath,
            filePath,
          );
          if (result.success && result.path) {
            fullPath = result.path;
          }
        }
        const raw = await extractRawMetadataFromFile(fullPath);
        setFullRawMetadata(raw);
      } catch (e) {
        console.error("Failed to load raw metadata:", e);
      } finally {
        setIsLoadingFullJson(false);
      }
    }
  }, [
    metadataViewMode,
    fullRawMetadata,
    directoryPath,
    image.id,
    image.name,
  ]);

  // The Raw data group's segmented control. `handleLoadFullJson` is itself a
  // toggle — it falls back to "parsed" when already showing full JSON — so it
  // is only handed the selection when that is actually the change being made,
  // or picking "Full JSON" while already there would flip the view off.
  const selectMetadataView = (mode: MetadataViewMode) => {
    if (mode === "fulljson") {
      if (metadataViewMode !== "fulljson") void handleLoadFullJson();
      return;
    }
    setMetadataViewMode(mode);
  };

  return (
    <div
      className={`${
        isStandaloneWindow ? "w-full h-full relative flex-col items-stretch" : "fixed inset-0 flex items-center justify-center z-[1000]"
      } ${
        isFullscreen ? "bg-gray-950 p-0" : isStandaloneWindow ? "bg-gray-950 flex" : "bg-gray-950/90 backdrop-blur-md p-2 flex"
      }`}
      style={{ WebkitAppRegion: "no-drag" } as any}
      onClick={onClose}
    >
      {isStandaloneWindow && !isFullscreen && (
        <div 
          className="bg-gray-900/40 backdrop-blur-md border-b border-gray-800/60 z-[1010] select-none shadow-sm flex items-center pt-0.5 pb-0.5 shrink-0 w-full"
          style={{ height: '32px', WebkitAppRegion: 'drag' } as any}
        >
          {/* Dropped while compact: the window *is* the image, and the label is
              what pushes the buttons under the OS window controls on tall
              portrait images. The flex-1 spacer keeps the drag region. */}
          {!isCompactMode && (
            <div className="px-4 flex items-center text-xs font-semibold text-gray-400">
              SilkStack Viewer
            </div>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-1 pr-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button
              onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
              className="text-gray-400 hover:text-gray-50 hover:bg-gray-500/10 rounded-full p-1.5 transition-colors"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); toggleCompactMode(); }}
              className={`rounded-full p-1.5 transition-colors ${
                isCompactMode
                  ? "text-blue-400 bg-blue-500/15"
                  : "text-gray-400 hover:text-gray-50 hover:bg-gray-500/10"
              }`}
              title={isCompactMode ? "Exit compact mode" : "Fit window to image"}
              aria-label={isCompactMode ? "Exit compact mode" : "Fit window to image"}
              aria-pressed={isCompactMode}
            >
              <Frame size={14} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              disabled={isIndexing}
              className={`rounded-full p-1.5 transition-colors ${
                isIndexing
                  ? "text-gray-600 cursor-not-allowed"
                  : "text-gray-400 hover:text-red-400 hover:bg-red-500/10"
              }`}
              title={isIndexing ? "Cannot delete during indexing" : "Delete image"}
            >
              <Trash2 size={14} />
            </button>
            {/* Kept while compact, and it keeps the same meaning there: the
                panel opens *inside* the compact window. It docks to the right of
                the picture, the window grows by its width to hold it, and the
                picture keeps every pixel it had — the mode is not left, so the
                window the user shaped to their image is not thrown away. The
                content width it costs is why the compact floor is as wide as it
                is — see COMPACT_MIN_WIDTH. */}
            <button
              onClick={(e) => { e.stopPropagation(); toggleSidebar(); }}
              className="text-gray-400 hover:text-gray-50 hover:bg-gray-500/10 rounded-full p-1.5 transition-colors"
              aria-label={sidebarHidden ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarHidden ? "Expand Sidebar" : "Collapse Sidebar"}
            >
              {sidebarHidden ? (
                <PanelRightOpen className="w-4 h-4" />
              ) : (
                <PanelRightClose className="w-4 h-4" />
              )}
            </button>
          </div>
          {/* Right Side - Reserved for Windows Native Controls (approx 140px) */}
          <div className="w-[140px] flex-shrink-0 h-full" style={{ WebkitAppRegion: 'no-drag' } as any} />
        </div>
      )}
      <div
        data-testid="image-modal-body"
        ref={modalBodyRef}
        // The panel's share of this row, handed to both halves as a custom
        // property rather than as two widths. The panel reads it directly and
        // the pane reads `100% - share`, so the split has one edit site and the
        // two can no longer be typed out of step — they used to be a pair of
        // hand-written percentages that had to sum to 1. Declared here because
        // this element *is* the row they divide, so both inherit it and nothing
        // outside the modal can see it.
        style={
          {
            "--sidebar-share": `${(resolvedSidebarShare * 100).toFixed(2)}%`,
          } as React.CSSProperties
        }
        className={`${
          isFullscreen
            ? "w-full h-full rounded-none"
            : isStandaloneWindow ? "flex-1 w-full rounded-none overflow-hidden"
            : "w-full h-full max-w-[98vw] max-h-[98vh] bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden ring-1 ring-gray-50/10"
        } relative group/modal flex ${
          // A compact window is the picture's own size and can be narrower than
          // the `md` breakpoint, where the ordinary layout stacks the two — but
          // the pane and the panel here are a row by construction: the panel is a
          // right-hand column the window was measured around, so it has to stay
          // beside the picture whatever the window's width.
          isCompactMode ? "flex-row" : "flex-col md:flex-row"
        } animate-in fade-in zoom-in-95`}
        onClick={(e) => {
          e.stopPropagation();
          hideContextMenu();
        }}
      >
        {/* Image Display Section */}
        <div
          id="image-zoom-container"
          ref={containerRef}
          // While compact the pane takes whatever the docked panel leaves, and
          // its width is never animated: the *window* is what moves, so an eased
          // pane would trail the frame it is in. `min-w-0` is what lets it be
          // narrower than the picture — without it a flex item refuses to shrink
          // past its content, and the pinned picture would hold the pane open
          // instead of being cropped by it.
          //
          // No transition while the panel is being dragged either. A drag sets
          // the share per mousemove, so an eased width would lag the pointer by
          // up to the full duration and the handle would not sit under the
          // cursor that is holding it.
          className={`${
            isCompactMode && !isFullscreen
              ? "flex-1 min-w-0 h-full"
              : `w-full ${isFullscreen ? "h-full" : sidebarHidden ? "h-full md:w-full" : `${PANE_WIDTH} h-1/2 md:h-full`}`
          } bg-gray-950 flex items-center justify-center ${isFullscreen ? "p-0" : "p-2"} relative group overflow-hidden ${isCompactMode || sidebarDrag ? "" : "transition-[width] duration-300"}`}
          onMouseDown={isVideo ? undefined : handleMouseDown}
          onMouseMove={isVideo ? undefined : handleMouseMove}
          onMouseUp={isVideo ? undefined : handleMouseUp}
          onMouseLeave={isVideo ? undefined : handleMouseLeaveContainer}
          style={{
            // Wins over `body.style.cursor` while the panel is dragged: this is
            // an inline style on the element under the pointer for most of the
            // gesture, and the body's cursor is only what shows in the gaps.
            cursor: sidebarDrag
              ? "col-resize"
              : !isVideo && canPan
                ? isDragging
                  ? "grabbing"
                  : "grab"
                : "default",
          }}
        >
          {imageUrl ? (
            isVideo ? (
              <VideoPlayer
                key={image.id}
                src={imageUrl}
                poster={preferredThumbnailUrl ?? undefined}
                onContextMenu={handleContextMenu}
                onNaturalDimensions={handleVideoDimensions}
              />
            ) : (
              <img
                ref={imgRef}
                src={imageUrl}
                alt={image.name}
                className="max-w-full max-h-full object-contain select-none"
                onContextMenu={handleContextMenu}
                onDragStart={handleDragStart}
                onLoad={handleImageLoad}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  // Easing is for the discrete jumps (buttons, wheel); a drag has to
                  // track the pointer, and the minimap's box would otherwise lead the
                  // picture it is describing. A compact frame is the third case: the
                  // window changes size the instant the zoom does, and an eased
                  // picture would trail the frame it was just sized for — showing the
                  // background this mode exists to avoid.
                  transition:
                    isDragging || isMinimapDragging || compactPin
                      ? "none"
                      : "transform 0.1s ease-out",
                  // Laid out at the fit the frame is built around, with the zoom left
                  // to the transform above. Left to `max-w-full`, a grown container
                  // would re-lay the image out *and* the transform would scale it, the
                  // two multiplying — the picture would overshoot the frame it was
                  // just sized to fill by exactly its own magnification.
                  ...(compactPin
                    ? {
                        width: `${compactPin.width}px`,
                        height: `${compactPin.height}px`,
                        maxWidth: "none",
                        maxHeight: "none",
                      }
                    : {}),
                }}
                // At or below the fit: the whole picture is inside the window, so
                // there is nothing a pan gesture could reach and dragging the file
                // out is as valid as it is at 100%. A pane the metadata panel has
                // cropped is the exception the pan test catches — the picture does
                // overflow it, the two gestures would be fighting over the same
                // pointer, and the pan is the one the mode is for.
                draggable={canDragExternally && !canPan}
              />
            )
          ) : (
            <div className="w-full h-full animate-pulse bg-gray-700 rounded-md"></div>
          )}

          {onNavigatePrevious && (
            <button
              onClick={onNavigatePrevious}
              className="absolute left-4 top-1/2 transform -translate-y-1/2 bg-gray-950/50 text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity"
            >
              ←
            </button>
          )}
          {onNavigateNext && (
            <button
              onClick={onNavigateNext}
              className="absolute right-4 top-1/2 transform -translate-y-1/2 bg-gray-950/50 text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity"
            >
              →
            </button>
          )}

          <div className="absolute top-4 left-4 bg-gray-950/60 text-gray-50 px-3 py-1 rounded-full text-sm font-medium backdrop-blur-sm border border-gray-50/20">
            {currentIndex + 1} / {totalImages}
          </div>

          {!isVideo && (
            // The minimap and the controls share one bottom-right stack: the map
            // sits directly above the controls with no offset to keep in sync.
            // pointer-events pass through the stack's own box (the gap between the
            // two) so a pan drag started there still reaches the pane.
            <div
              className={`zoom-controls absolute bottom-4 right-4 z-50 flex flex-col items-end gap-2 pointer-events-none transition-opacity ${
                isMinimapDragging
                  ? "opacity-100"
                  : "opacity-0 group-hover/modal:opacity-100"
              }`}
            >
              {showMinimap && (
                <div className="bg-gray-950/60 backdrop-blur-sm border border-gray-50/20 rounded-lg p-1 shadow-lg pointer-events-auto">
                  <ImageMinimap
                    thumbnailUrl={preferredThumbnailUrl ?? imageUrl!}
                    imageWidth={viewMetrics!.imageWidth}
                    imageHeight={viewMetrics!.imageHeight}
                    viewportWidth={viewMetrics!.viewportWidth}
                    viewportHeight={viewMetrics!.viewportHeight}
                    zoom={zoom}
                    pan={pan}
                    onPanChange={applyPan}
                    onDragStateChange={setIsMinimapDragging}
                  />
                </div>
              )}
              <div
                className="zoom-controls flex items-center gap-2 bg-gray-950/60 rounded-lg p-2 backdrop-blur-sm border border-gray-50/20 pointer-events-auto"
                onMouseDown={(e) => e.stopPropagation()}
                onMouseMove={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                onTouchMove={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
              >
                <button
                  onClick={handleZoomOut}
                  // Dead only when neither half of the gesture has anywhere to go:
                  // the magnification is at the fit *and* the window is at its
                  // floor. Outside the mode the second half is always at 1, so
                  // this reads as the plain "already at 1x" it always did.
                  disabled={zoom <= 1 && compactUserScale <= minUserScale}
                  className="text-gray-50 p-1 hover:bg-gray-50/20 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Zoom Out"
                >
                  <ZoomOut className="h-5 w-5" />
                </button>
                <input
                  type="range"
                  // The slider is the magnification and nothing else, so it stops
                  // at the fit. The shrink gesture reads as "past the end of the
                  // slider", which a slider cannot express — the wheel and the
                  // buttons have it, and they are where the gesture was asked for.
                  min={MIN_ZOOM}
                  max={MAX_ZOOM}
                  step="0.1"
                  value={zoom}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const newZoom = Math.max(MIN_ZOOM, parseFloat(e.target.value));
                    if (newZoom === zoom) return;
                    setZoom(newZoom);
                    if (newZoom <= 1) {
                      setPan({ x: 0, y: 0 });
                    } else {
                      const ratio = newZoom / zoom;
                      setPan((prev) => clampPan(prev.x * ratio, prev.y * ratio, newZoom));
                    }
                  }}
                  className="w-32 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                  title="Adjust zoom"
                />
                <button
                  onClick={handleZoomIn}
                  disabled={zoom >= MAX_ZOOM}
                  className="text-gray-50 p-1 hover:bg-gray-50/20 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                  title="Zoom In"
                >
                  <ZoomIn className="h-5 w-5" />
                </button>
                <div className="text-gray-50 text-xs font-mono w-10 text-center">
                  {displayedZoomPercentage}%
                </div>
                <button
                  onClick={handleResetZoom}
                  // Reset goes back *to* the fit, from either side of it — which
                  // includes a window that has been shrunk, so it is live whenever
                  // either half of the gesture has something to undo. It must not
                  // be dead exactly when it is the way back out of a shrink.
                  disabled={zoom === 1 && !(isCompactMode && compactUserScale < 1)}
                  className="text-gray-50 px-2 py-1 hover:bg-gray-50/20 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-medium"
                  title="Reset Zoom"
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          {(!isStandaloneWindow || isFullscreen) && (
            <div className="absolute top-4 right-14 flex items-center gap-2">
                <button
                  onClick={toggleFullscreen}
                  className="bg-gray-950/60 text-gray-400 hover:text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity"
                  title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                >
                  {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
                </button>
                {isStandaloneWindow && (
                  <button
                    onClick={toggleCompactMode}
                    className={`rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity ${
                      isCompactMode
                        ? "bg-blue-500/20 text-blue-400"
                        : "bg-gray-950/60 text-gray-400 hover:text-gray-50"
                    }`}
                    title={isCompactMode ? "Exit compact mode" : "Fit window to image"}
                    aria-label={isCompactMode ? "Exit compact mode" : "Fit window to image"}
                    aria-pressed={isCompactMode}
                  >
                    <Frame size={16} />
                  </button>
                )}
                <button
                  onClick={handleDelete}
                  disabled={isIndexing}
                  className={`bg-gray-950/60 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity ${
                    isIndexing
                      ? "text-gray-600 cursor-not-allowed"
                      : "text-gray-400 hover:text-red-400 hover:bg-red-500/20"
                  }`}
                  title={
                    isIndexing
                      ? "Cannot delete during indexing"
                      : "Delete image"
                  }
                >
                  <Trash2 size={16} />
                </button>
                <button
                  onClick={() => toggleSidebar()}
                  className="bg-gray-950/60 text-gray-400 hover:text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity"
                  aria-label={
                    sidebarHidden ? "Expand sidebar" : "Collapse sidebar"
                  }
                  title={
                    sidebarHidden ? "Expand Sidebar" : "Collapse Sidebar"
                  }
                >
                  {sidebarHidden ? (
                    <PanelRightOpen className="w-4 h-4" />
                  ) : (
                    <PanelRightClose className="w-4 h-4" />
                  )}
                </button>
              </div>
          )}
        </div>

        {(!isStandaloneWindow || isFullscreen) && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 z-[60] bg-gray-950/60 text-gray-400 hover:text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity"
            title="Close"
          >
            <X size={16} />
          </button>
        )}

        {/* Metadata Panel */}
        <div
          data-testid="metadata-panel"
          // Docked in a compact window the panel is the column the window was
          // measured around, so its width is set here rather than in a class:
          // it is a number the sizing rule also reads, and a class cannot hold
          // one. Read against the screen and not the frame, and at the resolved
          // share so it follows the pointer during a drag; the frame catches up
          // on the mouseup. Closed, the panel is `hidden` outright: a panel
          // taking up room the window was not sized for is the picture and the
          // frame disagreeing about where the pane is.
          style={compactPanelDocked ? { width: compactPanelWidth } : undefined}
          className={`${
            isCompactMode && compactPanelDocked
              ? "shrink-0 h-full border-l border-gray-800/60"
              : `w-full ${sidebarHidden ? "hidden" : `${SIDEBAR_WIDTH} h-1/2 md:h-full`}`
          } relative flex flex-col ${isFullscreen ? "bg-gray-900/80 backdrop-blur-md" : ""}`}
        >
          {/* The panel's inner edge, and the one thing in the viewer that is
              neither picture nor metadata: a four-pixel strip of pointer. It
              carries no visible line at rest — the panel and the picture are
              already different tones and compact mode already draws a border
              here — so what it advertises itself with is the cursor and the
              highlight on hover.

              `z-20`, above the search bar's `z-10`: that bar is a later sibling
              of this handle inside the panel, so at equal depth it would paint
              over the handle's top and swallow the mousedown that starts a drag
              from up there.

              In a compact window it fades in with the rest of the panel's
              contents, because until the window has taken its size this strip
              would otherwise sit over a panel that is not there yet. Outside
              compact it is `md:`-only, since below `md` the body stacks and
              there is no vertical edge left to drag. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize metadata panel"
            aria-valuenow={Math.round(resolvedSidebarShare * 100)}
            aria-valuemin={Math.round(MIN_SIDEBAR_SHARE * 100)}
            aria-valuemax={Math.round(MAX_SIDEBAR_SHARE * 100)}
            onMouseDown={handleSidebarResizeStart}
            onDoubleClick={resetSidebarShare}
            className={`${
              isCompactMode
                ? `transition duration-200 ease-out ${
                    compactPanelReady
                      ? "opacity-100 translate-x-0"
                      : "opacity-0 -translate-x-2 pointer-events-none"
                  }`
                : "hidden md:block"
            } absolute left-0 top-0 bottom-0 w-[4px] cursor-col-resize z-20 group/resize`}
          >
            <div
              className={`absolute inset-y-0 left-0 w-px transition-colors ${
                sidebarDrag
                  ? "bg-blue-500"
                  : "bg-transparent group-hover/resize:bg-blue-500/70"
              }`}
            />
          </div>

          {isSearchOpen && (
            <div
              data-search-bar
              // Docked, the contents wait for the window to take the size that
              // holds them: held transparent and a couple of pixels left, so the
              // fade that follows is into a frame already the right size rather
              // than a panel jumping sideways as the frame grows under it. The
              // class is on both of the panel's children, so they arrive as one
              // thing — see the body below.
              className={`shrink-0 px-3 pt-3 pb-2 border-b border-gray-800/80 bg-gray-900/70 flex items-center gap-2 z-10 ${
                compactPanelDocked
                  ? `transition duration-200 ease-out ${
                      compactPanelReady
                        ? "opacity-100 translate-x-0"
                        : "opacity-0 -translate-x-2"
                    }`
                  : ""
              }`}
            >
              <Search className="w-3.5 h-3.5 text-gray-500 shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={handleSearchQueryChange}
                onKeyDown={handleSearchKeyDown}
                placeholder="Find in prompt"
                aria-label="Find in prompt"
                className="flex-1 min-w-0 bg-gray-800/70 text-gray-100 text-sm border border-gray-600 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-yellow-400/70 placeholder-gray-500"
              />
              {searchQuery.trim() !== "" && (
                <span
                  data-testid="search-counter"
                  className="text-xs text-gray-400 tabular-nums whitespace-nowrap shrink-0"
                >
                  {matchCount > 0 ? activeMatch + 1 : 0} / {matchCount}
                </span>
              )}
              {searchQuery.trim() !== "" && !effectiveMetadata?.prompt && (
                <span className="text-xs italic text-yellow-500/90 whitespace-nowrap shrink-0">
                  no prompt
                </span>
              )}
              <button
                onClick={() => goToMatch(-1)}
                disabled={matchCount === 0}
                title="Previous match (Shift+Enter)"
                aria-label="Previous match"
                className="p-1 rounded text-gray-400 hover:text-gray-50 hover:bg-gray-700/60 disabled:opacity-30 disabled:pointer-events-none"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <button
                onClick={() => goToMatch(1)}
                disabled={matchCount === 0}
                title="Next match (Enter)"
                aria-label="Next match"
                className="p-1 rounded text-gray-400 hover:text-gray-50 hover:bg-gray-700/60 disabled:opacity-30 disabled:pointer-events-none"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
              <button
                onClick={closeSearch}
                title="Close search (Esc)"
                aria-label="Close find in prompt"
                className="p-1 rounded text-gray-400 hover:text-gray-50 hover:bg-gray-700/60"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          <div
            data-testid="metadata-panel-body"
            className={`flex-1 min-h-0 overflow-y-auto space-y-4 p-6 ${
              compactPanelDocked
                ? `transition duration-200 ease-out ${
                    compactPanelReady
                      ? "opacity-100 translate-x-0"
                      : "opacity-0 -translate-x-2"
                  }`
                : ""
            }`}
          >
            {isRenaming ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="bg-gray-900 text-gray-50 border border-gray-600 rounded-lg px-2 py-1 w-full"
                  autoFocus
                  onKeyDown={(e) => e.key === "Enter" && confirmRename()}
                />
                <button
                  onClick={confirmRename}
                  className="bg-green-600 text-gray-50 px-3 py-1 rounded-lg"
                >
                  Save
                </button>
                <button
                  onClick={() => setIsRenaming(false)}
                  className="bg-gray-600 text-gray-50 px-3 py-1 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <h2 className="text-xl font-bold text-gray-100 break-all flex items-center gap-2 flex-wrap">
                <span className="break-all">{image.name}</span>
                <button
                  onClick={() => setIsRenaming(true)}
                  disabled={isIndexing}
                  className={`p-1 ${isIndexing ? "text-gray-600 cursor-not-allowed" : "text-gray-400 hover:text-orange-400"}`}
                  title={
                    isIndexing
                      ? "Cannot rename during indexing"
                      : "Rename image"
                  }
                >
                  <Pencil size={16} />
                </button>
              </h2>
            )}
            <p className="text-sm text-accent break-all">
              {new Date(image.lastModified).toLocaleString()}
            </p>

          {/* Tags. The star, input and pills stay one composition rather than
              becoming label/value rows — this is an editor, not a readout, and
              the star is the primary favourite affordance. */}
          <MetadataGroup
            title="Tags"
            icon={<Tag size={13} className="shrink-0 text-gray-500" />}
            count={currentTags?.length}
            open={expandedGroups.tags}
            onToggle={() => toggleMetadataGroup("tags")}
          >
            {/* Favorite and Tags Row */}
            <div className="flex items-start gap-3 px-3 pt-1">
              {/* Favorite Star - Discrete */}
              <button
                onClick={handleToggleFavorite}
                className={`p-1.5 rounded transition-all ${
                  currentIsFavorite
                    ? "text-yellow-400 hover:text-yellow-300"
                    : "text-gray-500 hover:text-yellow-400"
                }`}
                title={
                  currentIsFavorite
                    ? "Remove from favorites"
                    : "Add to favorites"
                }
              >
                <Star
                  className={`w-5 h-5 ${currentIsFavorite ? "fill-current" : ""}`}
                />
              </button>

              {/* Tags Pills */}
              <div className="flex-1 space-y-2">
                {/* Add Tag Input */}
                <div className="relative">
                  <input
                    type="text"
                    placeholder="Add tag..."
                    value={tagInput}
                    onChange={(e) => {
                      setTagInput(e.target.value);
                      setShowTagAutocomplete(e.target.value.length > 0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddTag();
                      }
                      if (e.key === "Escape") {
                        setTagInput("");
                        setShowTagAutocomplete(false);
                      }
                    }}
                    onFocus={() => tagInput && setShowTagAutocomplete(true)}
                    onBlur={() =>
                      setTimeout(() => setShowTagAutocomplete(false), 200)
                    }
                    className="w-full bg-gray-700/50 text-gray-200 border border-gray-600 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
                  />

                  {/* Autocomplete Dropdown */}
                  {showTagAutocomplete && autocompleteOptions.length > 0 && (
                    <div className="absolute z-10 w-full mt-1 bg-gray-800 border border-gray-600 rounded-lg shadow-lg max-h-32 overflow-y-auto">
                      {autocompleteOptions.map((tag) => (
                        <button
                          key={tag.name}
                          onClick={() => {
                            if (onTagAdded) {
                              onTagAdded(image.id, tag.name);
                            } else {
                              addTagToImage(image.id, tag.name);
                            }
                            setTagInput("");
                            setShowTagAutocomplete(false);
                          }}
                          className="w-full text-left px-2 py-1.5 text-sm text-gray-200 hover:bg-gray-700 flex justify-between items-center"
                        >
                          <span>{tag.name}</span>
                          <span className="text-xs text-gray-400">
                            ({tag.count})
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Current Tags */}
                {currentTags && currentTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {currentTags.map((tag) => {
                      const source = getTagSource(tag);
                      const colors = source === 'auto'
                        ? 'bg-cyan-600/20 border border-cyan-500/50 text-cyan-700 dark:text-cyan-300'
                        : source === 'metadata'
                        ? 'bg-emerald-600/20 border border-emerald-500/50 text-emerald-700 dark:text-emerald-300'
                        : 'bg-blue-600/20 border border-blue-500/50 text-blue-700 dark:text-blue-300';
                      return (
                        <span
                          key={tag}
                          className={`flex items-center gap-1 ${colors} px-2 py-0.5 rounded-full text-sm transition-all`}
                          title={`${tag} (${source})`}
                        >
                          {tag}
                          <button
                            onClick={() => handleRemoveTag(tag)}
                            className="hover:text-red-600 dark:hover:text-red-300 transition-colors"
                            title="Remove tag"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

              </div>
            </div>
          </MetadataGroup>

          {/* Image info — always visible. Resolution/megapixels/aspect ratio come
              from the file itself (actual dimensions), not from generation
              metadata, so they must not depend on nMeta. */}
          <MetadataGroup
            title="Image info"
            icon={<Info size={13} className="shrink-0 text-gray-500" />}
            open={expandedGroups.imageInfo}
            onToggle={() => toggleMetadataGroup("imageInfo")}
          >
            <div className="divide-y divide-gray-700/40">
              <MetaRow
                label="Dimensions"
                value={fileWidth && fileHeight ? `${fileWidth}x${fileHeight}` : undefined}
              />
              <MetaRow
                label="Megapixels"
                value={
                  fileWidth && fileHeight
                    ? `${((fileWidth * fileHeight) / 1_000_000).toFixed(2)} MP`
                    : undefined
                }
              />
              <MetaRow
                label="Aspect Ratio"
                value={
                  getAspectRatio(fileWidth ?? undefined, fileHeight ?? undefined) ||
                  undefined
                }
              />
              <MetaRow label="File Size" value={formatFileSize(image.fileSize)} />
            </div>
          </MetadataGroup>

          {nMeta ? (
            <>
              {/* Prompt. The ref stays on the wrapper holding both blocks:
                  Ctrl+F counts every mark under it, and only the positive
                  prompt gets the highlight — the count has to stay exactly the
                  matches in one prompt. */}
              <MetadataGroup
                title="Prompt"
                icon={<MessageSquare size={13} className="shrink-0 text-gray-500" />}
                open={expandedGroups.prompt}
                onToggle={() => toggleMetadataGroup("prompt")}
              >
                <div className="divide-y divide-gray-700/40" ref={promptSectionRef}>
                  <PromptBlock
                    label="Prompt"
                    value={effectiveMetadata?.prompt}
                    highlight={
                      isSearchOpen && searchQuery !== ""
                        ? searchQuery
                        : undefined
                    }
                    onCopy={() =>
                      copyToClipboard(effectiveMetadata?.prompt || "", "Prompt")
                    }
                  />
                  <PromptBlock
                    label="Negative Prompt"
                    value={effectiveMetadata?.negativePrompt}
                    onCopy={() =>
                      copyToClipboard(
                        effectiveMetadata?.negativePrompt || "",
                        "Negative Prompt",
                      )
                    }
                  />
                </div>
              </MetadataGroup>

              {/* Generation details — the model and the sampling parameters. */}
              <MetadataGroup
                title="Generation details"
                icon={
                  <SlidersHorizontal size={13} className="shrink-0 text-gray-500" />
                }
                open={expandedGroups.generation}
                onToggle={() => toggleMetadataGroup("generation")}
              >
                <div className="divide-y divide-gray-700/40">
                  <MetaRow
                    label="Model"
                    value={nMeta.model}
                    onCopy={(v) => copyToClipboard(v, "Model")}
                  />
                  {((nMeta as any).vae || (nMeta as any).vaes?.[0]?.name) && (
                    <MetaRow
                      label="VAE"
                      value={(nMeta as any).vae || (nMeta as any).vaes?.[0]?.name}
                    />
                  )}
                  {/* MetaRow drops an empty value, so the old explicit guards are
                      not needed for these two — `[].join()` is "" and undefined
                      passes through. */}
                  <MetaRow label="Generator" value={nMeta.generator} />
                  <MetaRow
                    label="LoRAs"
                    value={nMeta.loras?.map(formatLoRA).join(", ")}
                  />
                  <MetaRow label="Steps" value={effectiveMetadata?.steps} />
                  <MetaRow
                    label="CFG Scale"
                    value={effectiveMetadata?.cfg_scale}
                  />
                  <MetaRow
                    label="Clip Skip"
                    value={
                      nMeta.clip_skip && nMeta.clip_skip > 1
                        ? nMeta.clip_skip
                        : undefined
                    }
                  />
                  <MetaRow
                    label="Seed"
                    value={nMeta.seed}
                    onCopy={(v) => copyToClipboard(v, "Seed")}
                  />
                  <MetaRow label="Sampler" value={nMeta.sampler} />
                  <MetaRow
                    label="Scheduler"
                    value={effectiveMetadata?.scheduler}
                  />
                  <MetaRow
                    label="Denoise"
                    value={
                      (nMeta as any).denoise != null &&
                      (nMeta as any).denoise < 1
                        ? (nMeta as any).denoise
                        : undefined
                    }
                  />
                  {/* A fragment, so the rows stay direct children of the
                      divide-y container and are divided like the rest. */}
                  {videoInfo && (
                    <>
                      <MetaRow label="Frames" value={videoInfo.frame_count} />
                      <MetaRow
                        label="FPS"
                        value={
                          videoInfo.frame_rate != null
                            ? Number(videoInfo.frame_rate).toFixed(2)
                            : undefined
                        }
                      />
                      <MetaRow
                        label="Duration"
                        value={
                          effectiveDuration != null
                            ? formatDurationSeconds(Number(effectiveDuration))
                            : undefined
                        }
                      />
                      <MetaRow label="Video Codec" value={videoInfo.codec} />
                      <MetaRow
                        label="Video Format"
                        value={(() => {
                          if (!videoInfo.format) return undefined;
                          const formats = videoInfo.format.split(",");
                          const ext = image.name.split(".").pop()?.toLowerCase();
                          if (ext && formats.includes(ext)) return ext;
                          return formats[0];
                        })()}
                      />
                    </>
                  )}
                    <MetaRow label="Motion Model" value={motionModel?.name} />
                    <MetaRow
                      label="Motion Model Hash"
                      value={motionModel?.hash}
                    />
                  </div>
                </MetadataGroup>

              {/* Performance — hardware and timing, when the file carries any. */}
              {analytics && hasPerformanceData && (
                <MetadataGroup
                  title="Performance"
                  icon={
                    <Zap
                      size={13}
                      className="shrink-0 text-yellow-600 dark:text-yellow-400"
                    />
                  }
                  open={expandedGroups.performance}
                  onToggle={() => toggleMetadataGroup("performance")}
                >
                  <div className="divide-y divide-gray-700/40">
                    <MetaRow
                      label="Generation Time"
                      value={
                        analytics.generation_time_ms != null &&
                        analytics.generation_time_ms > 0
                          ? formatGenerationTime(analytics.generation_time_ms)
                          : undefined
                      }
                    />
                    <MetaRow
                      label="VRAM Peak"
                      value={
                        analytics.vram_peak_mb != null
                          ? formatVRAM(
                              analytics.vram_peak_mb,
                              analytics.gpu_device,
                            )
                          : undefined
                      }
                    />
                    <MetaRow label="GPU Device" value={analytics.gpu_device} />
                    <MetaRow
                      label="Speed"
                      value={
                        analytics.steps_per_second != null
                          ? `${analytics.steps_per_second.toFixed(2)} steps/s`
                          : undefined
                      }
                    />
                    <MetaRow label="ComfyUI" value={analytics.comfyui_version} />
                    <MetaRow label="PyTorch" value={analytics.torch_version} />
                    <MetaRow label="Python" value={analytics.python_version} />
                  </div>
                </MetadataGroup>
              )}
            </>
          ) : (
            // The yellow is a FIXED wash, so its text is paired per theme with a
            // `dark:` variant rather than a gray token — the gray scale inverts
            // in light mode and would leave pale-on-pale here.
            <div className="bg-yellow-500/10 border border-yellow-500/40 text-yellow-700 dark:text-yellow-300 px-4 py-3 rounded-lg text-sm">
              No normalized metadata available.
            </div>
          )}
          {/* Raw data — the file's unparsed metadata. Deliberately outside the
              nMeta branch: a file whose metadata failed to normalize is exactly
              when reading it raw is worth something. */}
          <MetadataGroup
            title="Raw data"
            icon={<Code size={13} className="shrink-0 text-gray-500" />}
            open={expandedGroups.raw}
            onToggle={() => toggleMetadataGroup("raw")}
          >
            <div className="px-3">
              {/* A segmented control rather than the two underline links this
                  replaced: with the section collapsed to a header, three named
                  views say which one is showing; "Show Parsed" said only what
                  the other button would do. */}
              <div className="inline-flex rounded-lg bg-gray-800/60 p-0.5">
                {METADATA_VIEW_MODES.map(([mode, label]) => (
                  <button
                    key={mode}
                    onClick={() => selectMetadataView(mode)}
                    aria-pressed={metadataViewMode === mode}
                    className={`px-2.5 py-1 rounded-md text-sm font-medium transition-colors ${
                      metadataViewMode === mode
                        ? "bg-gray-700 text-gray-100"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {metadataViewMode === "parsed" && (
                <p className="mt-2 text-sm text-gray-400">
                  The parsed metadata is in the sections above. Choose JSON for
                  the raw file metadata.
                </p>
              )}
            </div>
            {metadataViewMode === "json" && (
              <div className="relative px-3 pt-2">
                {/* bg-gray-950, not bg-black/50: this well has to invert with
                    the theme. black/50 over a light panel leaves text-gray-300
                    (dark slate there) dark-on-dark. gray-950 is the deepest
                    surface of whichever theme is active, so the token pair
                    stays readable both ways. */}
                <pre className="bg-gray-950/70 border border-gray-800/60 scrollbar-thin p-2 pr-8 rounded-lg text-sm font-sans text-gray-300 whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                  {JSON.stringify(image.metadata, null, 2)}
                </pre>
                <button
                  onClick={() =>
                    copyToClipboard(
                      JSON.stringify(image.metadata, null, 2),
                      "JSON",
                    )
                  }
                  className="absolute top-4 right-5 bg-gray-700/80 hover:bg-gray-600 text-gray-300 hover:text-gray-50 p-1 rounded transition-all duration-200"
                  title="Copy JSON"
                >
                  <Copy className="w-3 h-3" />
                </button>
              </div>
            )}
            {metadataViewMode === "fulljson" && (
              <>
                {isLoadingFullJson ? (
                  <div className="mx-3 mt-2 bg-gray-950/70 border border-gray-800/60 p-4 rounded-lg text-sm text-gray-400 text-center animate-pulse">
                    Loading raw metadata from file...
                  </div>
                ) : fullRawMetadata ? (
                  <div className="relative px-3 pt-2">
                    <pre className="bg-gray-950/70 border border-gray-800/60 scrollbar-thin p-2 pr-8 rounded-lg text-sm font-sans text-gray-300 whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                      {JSON.stringify(fullRawMetadata, null, 2)}
                    </pre>
                    <button
                      onClick={() =>
                        copyToClipboard(
                          JSON.stringify(fullRawMetadata, null, 2),
                          "Full JSON",
                        )
                      }
                      className="absolute top-4 right-5 bg-gray-700/80 hover:bg-gray-600 text-gray-300 hover:text-gray-50 p-1 rounded transition-all duration-200"
                      title="Copy Full JSON"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="mx-3 mt-2 bg-yellow-500/10 border border-yellow-500/40 text-yellow-700 dark:text-yellow-300 px-3 py-2 rounded-lg text-sm">
                    Unable to load raw metadata. The file may not contain
                    embedded metadata, or the format is not supported.
                  </div>
                )}
              </>
            )}
          </MetadataGroup>

          {/* File actions — not metadata, so not a group: always reachable. */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() =>
                copyToClipboard(
                  JSON.stringify(image.metadata, null, 2),
                  "Raw Metadata",
                )
              }
              // text-accent, not text-blue-300: accent is remapped per theme,
              // blue-300 is a raw palette value that goes near-white on the
              // pale wash this button uses in light mode.
              className="w-full justify-center bg-blue-500/10 hover:bg-blue-500/20 text-accent border border-blue-500/30 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-2"
            >
              Copy Raw Metadata
            </button>
            <button
              onClick={async () => {
                if (!directoryPath) {
                  alert(
                    "Cannot determine file location: directory path is missing.",
                  );
                  return;
                }
                await showInExplorer(`${directoryPath}/${image.name}`);
              }}
              className="w-full justify-center bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-600 px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
            >
              Show in Folder
            </button>
          </div>
          </div>
        </div>


      </div>


      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          className="fixed z-[60] bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={copyImage}
            className={`w-full text-left px-4 py-2 text-sm text-gray-200 transition-colors flex items-center gap-2 ${isVideo ? "opacity-50 cursor-not-allowed" : "hover:bg-gray-700 hover:text-gray-50"}`}
            disabled={isVideo}
          >
            <Copy className="w-4 h-4" />
            Copy to Clipboard
          </button>

          <div className="border-t border-gray-600 my-1"></div>

          <button
            onClick={copyPrompt}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-gray-50 transition-colors flex items-center gap-2"
            disabled={!nMeta?.prompt}
          >
            <Copy className="w-4 h-4" />
            Copy Prompt
          </button>
          <button
            onClick={copyNegativePrompt}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-gray-50 transition-colors flex items-center gap-2"
            disabled={!nMeta?.negativePrompt}
          >
            <Copy className="w-4 h-4" />
            Copy Negative Prompt
          </button>
          <button
            onClick={copySeed}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-gray-50 transition-colors flex items-center gap-2"
            disabled={!nMeta?.seed}
          >
            <Copy className="w-4 h-4" />
            Copy Seed
          </button>
          <button
            onClick={copyModel}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-gray-50 transition-colors flex items-center gap-2"
            disabled={!nMeta?.model}
          >
            <Copy className="w-4 h-4" />
            Copy Model
          </button>

          <div className="border-t border-gray-600 my-1"></div>

          <button
            onClick={copyPath}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-gray-50 transition-colors flex items-center gap-2"
          >
            <Copy className="w-4 h-4" />
            Copy Image Path
          </button>

          <button
            onClick={openWithNativeViewer}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-gray-50 transition-colors flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Open in Native Viewer
          </button>

          <button
            onClick={showInFolder}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-gray-50 transition-colors flex items-center gap-2"
          >
            <Folder className="w-4 h-4" />
            Show in Folder
          </button>
        </div>
      )}
    </div>
  );
};

// Wrap with React.memo to prevent re-renders during Phase B metadata updates
// Custom comparator: only compare image.id, onClose, and isIndexing
// This prevents flickering when the image object reference changes but the ID stays the same
export default React.memo(ImageModal, (prevProps, nextProps) => {
  // Return true if props are EQUAL (skip re-render)
  // Return false if props are DIFFERENT (re-render)

  // Helper to compare tag arrays
  const tagsEqual = (tags1?: string[], tags2?: string[]) => {
    if (!tags1 && !tags2) return true;
    if (!tags1 || !tags2) return false;
    if (tags1.length !== tags2.length) return false;
    return tags1.every((tag, index) => tag === tags2[index]);
  };

  const propsEqual =
    prevProps.image.id === nextProps.image.id &&
    prevProps.image.isFavorite === nextProps.image.isFavorite &&
    tagsEqual(prevProps.image.tags, nextProps.image.tags) &&
    prevProps.onClose === nextProps.onClose &&
    prevProps.onImageDeleted === nextProps.onImageDeleted &&
    prevProps.onImageRenamed === nextProps.onImageRenamed &&
    prevProps.currentIndex === nextProps.currentIndex &&
    prevProps.totalImages === nextProps.totalImages &&
    prevProps.onNavigateNext === nextProps.onNavigateNext &&
    prevProps.onNavigatePrevious === nextProps.onNavigatePrevious &&
    prevProps.directoryPath === nextProps.directoryPath &&
    prevProps.isIndexing === nextProps.isIndexing;

  return propsEqual; // true = skip re-render, false = re-render
});
