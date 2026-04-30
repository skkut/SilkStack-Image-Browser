import React, { useEffect, useState, FC, useCallback, useRef } from "react";
import { type IndexedImage, type BaseMetadata, type LoRAInfo } from "../types";
import { FileOperations } from "../services/fileOperations";
import { copyImageToClipboard, showInExplorer, getAspectRatio } from "../utils/imageUtils";
import {
  Copy,
  Pencil,
  Trash2,
  ChevronDown,
  ChevronRight,
  Folder,
  Star,
  X,
  Zap,
  ArrowUp,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Repeat,
  PanelRightClose,
  PanelRightOpen,
  ZoomIn,
  ZoomOut,
  Maximize,
  Minimize,
} from "lucide-react";
import hotkeyManager from "../services/hotkeyManager";
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
  onAutoTagRemoved?: (imageId: string, tag: string) => void;
  onFavoriteToggled?: (imageId: string) => void;
  isStandaloneWindow?: boolean;
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

// Helper component for consistently rendering metadata items
const MetadataItem: FC<{
  label: string;
  value?: string | number | any[];
  isPrompt?: boolean;
  onCopy?: (value: string) => void;
}> = ({ label, value, isPrompt = false, onCopy }) => {
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
    <div className="bg-gray-900/50 p-3 rounded-md border border-gray-700/50 relative group">
      <div className="flex justify-between items-start">
        <p className="font-semibold text-gray-400 text-xs uppercase tracking-wider">
          {label}
        </p>
        {onCopy && (
          <button
            onClick={() => onCopy(displayValue)}
            className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-50"
            title={`Copy ${label}`}
          >
            <Copy className="w-4 h-4" />
          </button>
        )}
      </div>
      {isPrompt ? (
        <pre className="text-gray-200 whitespace-pre-wrap break-words font-mono text-sm mt-1">
          {displayValue}
        </pre>
      ) : (
        <p className="text-gray-200 break-words font-mono text-sm mt-1">
          {displayValue}
        </p>
      )}
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
}> = ({ src, poster, onContextMenu }) => {
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
  onAutoTagRemoved,
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
  const [showRawMetadata, setShowRawMetadata] = useState(false);

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
  const [showDetails, setShowDetails] = useState(true);
  const [showPerformance, setShowPerformance] = useState(true);
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

  const canDragExternally =
    typeof window !== "undefined" && !!window.electronAPI?.startFileDrag;

  // Zoom and pan states
  const [zoom, setZoom] = useState(1);
  const [displayedZoomPercentage, setDisplayedZoomPercentage] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

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

    const observer = new ResizeObserver(() => {
      updateZoomPercentage();
    });
    
    if (imgRef.current) {
      observer.observe(imgRef.current);
    }
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    
    return () => observer.disconnect();
  }, [updateZoomPercentage]);

  // Clamp pan so the image can't be dragged past its own edges.
  // Uses actual rendered image size (object-contain may make it narrower/shorter
  // than the container) for per-axis accuracy.
  const clampPan = useCallback(
    (x: number, y: number, currentZoom: number): { x: number; y: number } => {
      if (!containerRef.current || !imgRef.current || currentZoom <= 1)
        return { x: 0, y: 0 };
      const { clientWidth: cw, clientHeight: ch } = containerRef.current;
      const { clientWidth: iw, clientHeight: ih } = imgRef.current;
      // The scaled image must stay large enough to fill the viewport edge-to-edge.
      // maxPan = half of (scaled image size - container size), floored at 0.
      const maxX = Math.max(0, (iw * currentZoom - cw) / 2);
      const maxY = Math.max(0, (ih * currentZoom - ch) / 2);
      return {
        x: Math.max(-maxX, Math.min(maxX, x)),
        y: Math.max(-maxY, Math.min(maxY, y)),
      };
    },
    [],
  );




  // Annotations hooks
  const toggleFavorite = useImageStore((state) => state.toggleFavorite);
  const addTagToImage = useImageStore((state) => state.addTagToImage);
  const removeTagFromImage = useImageStore((state) => state.removeTagFromImage);
  const removeAutoTagFromImage = useImageStore(
    (state) => state.removeAutoTagFromImage,
  );
  const availableTags = useImageStore((state) => state.availableTags);



  // Get live tags and favorite status from store instead of props
  // imageFromStore, isVideo, and preferredThumbnailUrl are defined above

  const currentTags = imageFromStore?.tags || image.tags || [];
  const currentAutoTags = imageFromStore?.autoTags || image.autoTags || [];
  const currentIsFavorite =
    imageFromStore?.isFavorite ?? image.isFavorite ?? false;


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

  const effectiveDuration = (nMeta as any)?.video?.duration_seconds;

  const videoInfo = (nMeta as any)?.video;
  const motionModel = (nMeta as any)?.motion_model;

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
          "fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg z-50";
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
        "fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg z-50";
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
        "fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded shadow-lg z-50";
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

  const showInFolder = () => {
    hideContextMenu();
    if (!directoryPath) {
      alert("Cannot determine file location: directory path is missing.");
      return;
    }
    // The showInExplorer utility can handle the full path directly
    showInExplorer(`${directoryPath}/${image.name}`);
  };

  // Reset zoom and pan when image changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [image.id]);

  // Reset zoom and pan when entering/exiting fullscreen
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [isFullscreen]);

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

      setZoom((prevZoom) => {
        // Slow down the zoom speed significantly
        // Standard mouse wheel delta is ~100.
        // Cap max deltaY to ensure fast scrolls don't skip entirely out of bounds.
        const normalizedDeltaY = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 150);
        const delta = normalizedDeltaY * -0.0025; // Zoom by 0.25x max per standard click
        
        const newZoom = Math.min(Math.max(MIN_ZOOM, prevZoom + delta), MAX_ZOOM); // Min 1x, Max 7.5x

        if (newZoom === prevZoom) return prevZoom;

        // Schedule pan correctly based on exact prev values
        setPan((prevPan) => {
          if (newZoom === 1) {
            return { x: 0, y: 0 };
          }
          const ratio = newZoom / prevZoom;
          const rawPx = prevPan.x * ratio + mx * (1 - ratio);
          const rawPy = prevPan.y * ratio + my * (1 - ratio);
          return clampPan(rawPx, rawPy, newZoom);
        });

        return newZoom;
      });
    },
    [clampPan],
  );

  // Pan handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Don't start dragging if clicking zoom controls or other interactive elements
      if ((e.target as HTMLElement).closest(".zoom-controls")) {
        return;
      }

      if (zoom > 1 && e.button === 0) {
        setIsDragging(true);
        setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
        e.preventDefault();
      }
    },
    [zoom, pan],
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
      if (isDragging && zoom > 1) {
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
    [isDragging, dragStart, zoom, clampPan, triggerExternalDrag],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleMouseLeaveContainer = useCallback(() => {
    if (isDragging && zoom > 1) {
      // If we leave the container while panning, trigger the file drag
      triggerExternalDrag();
    } else {
      handleMouseUp();
    }
  }, [isDragging, zoom, triggerExternalDrag, handleMouseUp]);

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
    const newZoom = Math.min(zoom + 0.5, MAX_ZOOM);
    if (newZoom === zoom) return;

    setZoom(newZoom);
    if (newZoom === 1) {
      setPan({ x: 0, y: 0 });
    } else {
      const ratio = newZoom / zoom;
      setPan((prev) => clampPan(prev.x * ratio, prev.y * ratio, newZoom));
    }
  };

  const handleZoomOut = () => {
    const newZoom = Math.max(zoom - 0.5, 1);
    if (newZoom === zoom) return;

    setZoom(newZoom);
    if (newZoom === 1) {
      setPan({ x: 0, y: 0 });
    } else {
      const ratio = newZoom / zoom;
      setPan((prev) => clampPan(prev.x * ratio, prev.y * ratio, newZoom));
    }
  };

  const handleResetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
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

      // Alt+Enter = Toggle fullscreen (works in both grid and modal)
      if (event.key === "Enter" && event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        toggleFullscreen(); // Toggle fullscreen ON/OFF
        return;
      }

      // Escape = Exit fullscreen first, then close modal
      if (event.key === "Escape") {
        event.stopPropagation(); // Prevent global hotkeys (closing sidebar)
        if (isFullscreen) {
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
    onClose,
    onNavigateNext,
    onNavigatePrevious,
    toggleFullscreen,
  ]);

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

  const handleRemoveAutoTag = (tag: string) => {
    if (onAutoTagRemoved) {
      onAutoTagRemoved(image.id, tag);
    } else {
      removeAutoTagFromImage(image.id, tag);
    }
  };

  const handlePromoteAutoTag = async (tag: string) => {
    // Add as manual tag and remove from auto-tags
    if (onTagAdded) {
      onTagAdded(image.id, tag);
    } else {
      await addTagToImage(image.id, tag);
    }

    if (onAutoTagRemoved) {
      onAutoTagRemoved(image.id, tag);
    } else {
      removeAutoTagFromImage(image.id, tag);
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

  return (
    <div
      className={`${
        isStandaloneWindow ? "w-full h-full relative flex-col items-stretch" : "fixed inset-0 flex items-center justify-center z-[1000]"
      } transition-all duration-300 ${
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
          <div className="px-4 flex items-center text-xs font-semibold text-gray-400">
            SilkStack Viewer
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1 pr-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <button
              onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
              className="text-gray-400 hover:text-gray-50 rounded px-2 py-1 transition-colors"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(); }}
              disabled={isIndexing}
              className={`rounded px-2 py-1 transition-colors ${
                isIndexing
                  ? "text-gray-600 cursor-not-allowed"
                  : "text-gray-400 hover:text-red-400 hover:bg-gray-900/80"
              }`}
              title={isIndexing ? "Cannot delete during indexing" : "Delete image"}
            >
              <Trash2 size={14} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setIsSidebarCollapsed(!isSidebarCollapsed); }}
              className="text-gray-400 hover:text-gray-50 rounded px-2 py-1 transition-colors"
              title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
              {isSidebarCollapsed ? (
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
        className={`${
          isFullscreen
            ? "w-full h-full rounded-none"
            : isStandaloneWindow ? "flex-1 w-full rounded-none overflow-hidden"
            : "w-full h-full max-w-[98vw] max-h-[98vh] bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden ring-1 ring-gray-50/10"
        } relative group/modal flex flex-col md:flex-row transition-all duration-300 animate-in fade-in zoom-in-95`}
        onClick={(e) => {
          e.stopPropagation();
          hideContextMenu();
        }}
      >
        {/* Image Display Section */}
        <div
          id="image-zoom-container"
          ref={containerRef}
          className={`w-full ${isFullscreen ? "h-full" : isSidebarCollapsed ? "h-full md:w-full" : "md:w-3/4 h-1/2 md:h-full"} bg-gray-950 flex items-center justify-center ${isFullscreen ? "p-0" : "p-2"} relative group overflow-hidden transition-[width] duration-300`}
          onMouseDown={isVideo ? undefined : handleMouseDown}
          onMouseMove={isVideo ? undefined : handleMouseMove}
          onMouseUp={isVideo ? undefined : handleMouseUp}
          onMouseLeave={isVideo ? undefined : handleMouseLeaveContainer}
          style={{
            cursor:
              !isVideo && zoom > 1
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
              />
            ) : (
              <img
                ref={imgRef}
                src={imageUrl}
                alt={image.name}
                className="max-w-full max-h-full object-contain select-none"
                onContextMenu={handleContextMenu}
                onDragStart={handleDragStart}
                onLoad={updateZoomPercentage}
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transition: isDragging ? "none" : "transform 0.1s ease-out",
                }}
                draggable={canDragExternally && zoom === 1}
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
            <div
              className="zoom-controls absolute bottom-4 right-4 flex items-center gap-2 bg-gray-950/60 rounded-lg p-2 backdrop-blur-sm border border-gray-50/20 opacity-0 group-hover/modal:opacity-100 transition-opacity z-50"
              onMouseDown={(e) => e.stopPropagation()}
              onMouseMove={(e) => e.stopPropagation()}
              onMouseUp={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
            >
              <button
                onClick={handleZoomOut}
                disabled={zoom <= 1}
                className="text-gray-50 p-1 hover:bg-gray-50/20 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Zoom Out"
              >
                <ZoomOut className="h-5 w-5" />
              </button>
              <input
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step="0.1"
                value={zoom}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const newZoom = parseFloat(e.target.value);
                  if (newZoom === zoom) return;
                  setZoom(newZoom);
                  if (newZoom === MIN_ZOOM) {
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
                disabled={zoom <= 1}
                className="text-gray-50 px-2 py-1 hover:bg-gray-50/20 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-all text-xs font-medium"
                title="Reset Zoom"
              >
                Reset
              </button>
            </div>
          )}

          {(!isStandaloneWindow || isFullscreen) && (
            <div className={`absolute top-4 ${isSidebarCollapsed ? "right-14" : "right-4"} flex items-center gap-2`}>
              <button
                onClick={toggleFullscreen}
                className="bg-gray-950/60 text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity"
                title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
              </button>
              <button
                onClick={handleDelete}
                disabled={isIndexing}
                className={`bg-gray-950/60 text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity ${
                  isIndexing
                    ? "text-gray-600 cursor-not-allowed"
                    : "text-gray-400 hover:text-red-400 hover:bg-gray-900/80"
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
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                className="bg-gray-950/60 text-gray-50 rounded-full p-2 opacity-0 group-hover/modal:opacity-100 transition-opacity"
                aria-label={
                  isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"
                }
                title={
                  isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"
                }
              >
                {isSidebarCollapsed ? (
                  <PanelRightOpen className="w-4 h-4" />
                ) : (
                  <PanelRightClose className="w-4 h-4" />
                )}
              </button>
            </div>
          )}
        </div>

        {/* Metadata Panel */}
        <div
          className={`w-full ${isSidebarCollapsed ? "hidden" : "md:w-1/4 h-1/2 md:h-full"} p-6 overflow-y-auto space-y-4 ${isFullscreen ? "bg-gray-900/80 backdrop-blur-md" : ""}`}
        >
          <div>
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
            <p className="text-xs text-blue-400 font-mono break-all">
              {new Date(image.lastModified).toLocaleString()}
            </p>
          </div>

          {/* Annotations Section */}
          <div className="bg-gray-900/50 p-3 rounded-lg border border-gray-700/50 space-y-2">
            {/* Favorite and Tags Row */}
            <div className="flex items-start gap-3">
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
                    className="w-full bg-gray-700/50 text-gray-200 border border-gray-600 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
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
                          className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex justify-between items-center"
                        >
                          <span>{tag.name}</span>
                          <span className="text-xs text-gray-500">
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
                    {currentTags.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => handleRemoveTag(tag)}
                        className="flex items-center gap-1 bg-blue-600/20 border border-blue-500/50 text-blue-300 px-2 py-0.5 rounded-full text-xs hover:bg-red-600/20 hover:border-red-500/50 hover:text-red-300 transition-all"
                        title="Click to remove"
                      >
                        {tag}
                        <X size={12} />
                      </button>
                    ))}
                  </div>
                )}


                {currentAutoTags && currentAutoTags.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-purple-300">
                      Auto tags
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {currentAutoTags.map((tag) => (
                        <div
                          key={`auto-${tag}`}
                          className="inline-flex items-center bg-purple-600/20 border border-purple-500/40 rounded-full overflow-hidden"
                        >
                          <button
                            onClick={() => handlePromoteAutoTag(tag)}
                            className="px-2 py-0.5 text-purple-300 hover:bg-blue-600/30 hover:text-blue-200 transition-all"
                            title="Promote to manual tag"
                          >
                            <ArrowUp size={12} />
                          </button>
                          <span className="text-purple-300 text-xs">{tag}</span>
                          <button
                            onClick={() => handleRemoveAutoTag(tag)}
                            className="px-2 py-0.5 text-purple-300 hover:bg-red-600/30 hover:text-red-200 transition-all"
                            title="Remove auto-tag"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {nMeta ? (
            <div className="space-y-4">
              {/* Prompt Section - Always Visible */}
              <div className="space-y-3">
                <MetadataItem
                  label="Prompt"
                  value={effectiveMetadata?.prompt}
                  isPrompt
                  onCopy={() =>
                    copyToClipboard(effectiveMetadata?.prompt || "", "Prompt")
                  }
                />
                <MetadataItem
                  label="Negative Prompt"
                  value={effectiveMetadata?.negativePrompt}
                  isPrompt
                  onCopy={() =>
                    copyToClipboard(
                      effectiveMetadata?.negativePrompt || "",
                      "Negative Prompt",
                    )
                  }
                />


                <div className="grid grid-cols-2 gap-3">
                  <MetadataItem
                    label="Dimensions"
                    value={nMeta.width && nMeta.height ? `${nMeta.width}x${nMeta.height}` : undefined}
                  />
                  <MetadataItem
                    label="Megapixels"
                    value={
                      effectiveMetadata.width && effectiveMetadata.height
                        ? `${((effectiveMetadata.width * effectiveMetadata.height) / 1_000_000).toFixed(2)} MP`
                        : undefined
                    }
                  />
                  <MetadataItem
                    label="Aspect Ratio"
                    value={
                      getAspectRatio(effectiveMetadata.width, effectiveMetadata.height) ||
                      undefined
                    }
                  />
                </div>
              </div>

              {/* Details Section - Collapsible */}
              <div>
                <button
                  onClick={() => setShowDetails(!showDetails)}
                  className="text-gray-300 text-sm w-full text-left py-2 border-t border-gray-700 flex items-center justify-between hover:text-gray-50 transition-colors"
                >
                  <span className="font-semibold">Generation Details</span>
                  {showDetails ? (
                    <ChevronDown size={16} />
                  ) : (
                    <ChevronRight size={16} />
                  )}
                </button>
                {showDetails && (
                  <div className="space-y-3 mt-3">
                    <MetadataItem
                      label="Model"
                      value={nMeta.model}
                      onCopy={(v) => copyToClipboard(v, "Model")}
                    />
                    {nMeta.generator && (
                      <MetadataItem label="Generator" value={nMeta.generator} />
                    )}
                    {((nMeta as any).vae || (nMeta as any).vaes?.[0]?.name) && (
                      <MetadataItem
                        label="VAE"
                        value={
                          (nMeta as any).vae || (nMeta as any).vaes?.[0]?.name
                        }
                      />
                    )}
                    {nMeta.loras && nMeta.loras.length > 0 && (
                      <MetadataItem
                        label="LoRAs"
                        value={nMeta.loras.map(formatLoRA).join(", ")}
                      />
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <MetadataItem
                        label="Steps"
                        value={effectiveMetadata?.steps}
                      />
                      <MetadataItem
                        label="CFG Scale"
                        value={effectiveMetadata?.cfg_scale}
                      />
                      {nMeta.clip_skip && nMeta.clip_skip > 1 && (
                        <MetadataItem
                          label="Clip Skip"
                          value={nMeta.clip_skip}
                        />
                      )}
                      <MetadataItem
                        label="Seed"
                        value={nMeta.seed}
                        onCopy={(v) => copyToClipboard(v, "Seed")}
                      />
                      <MetadataItem label="Sampler" value={nMeta.sampler} />
                      <MetadataItem
                        label="Scheduler"
                        value={effectiveMetadata?.scheduler}
                      />
                      {(nMeta as any).denoise != null &&
                        (nMeta as any).denoise < 1 && (
                          <MetadataItem
                            label="Denoise"
                            value={(nMeta as any).denoise}
                          />
                        )}
                    </div>
                    {videoInfo && (
                      <div className="grid grid-cols-2 gap-2">
                        <MetadataItem
                          label="Frames"
                          value={videoInfo.frame_count}
                        />
                        <MetadataItem
                          label="FPS"
                          value={
                            videoInfo.frame_rate != null
                              ? Number(videoInfo.frame_rate).toFixed(2)
                              : undefined
                          }
                        />
                        {effectiveDuration != null && (
                          <MetadataItem
                            label="Duration"
                            value={formatDurationSeconds(
                              Number(effectiveDuration),
                            )}
                          />
                        )}
                        <MetadataItem
                          label="Video Codec"
                          value={videoInfo.codec}
                        />
                        <MetadataItem
                          label="Video Format"
                          value={(() => {
                            if (!videoInfo.format) return undefined;
                            const formats = videoInfo.format.split(",");
                            const ext = image.name
                              .split(".")
                              .pop()
                              ?.toLowerCase();
                            if (ext && formats.includes(ext)) return ext;
                            return formats[0];
                          })()}
                        />
                      </div>
                    )}
                    {motionModel?.name && (
                      <MetadataItem
                        label="Motion Model"
                        value={motionModel.name}
                      />
                    )}
                    {motionModel?.hash && (
                      <MetadataItem
                        label="Motion Model Hash"
                        value={motionModel.hash}
                      />
                    )}

                  </div>
                )}
              </div>

              {/* Performance Section - Collapsible */}
              {nMeta && nMeta._analytics && (
                <div>
                  <button
                    onClick={() => setShowPerformance(!showPerformance)}
                    className="text-gray-300 text-sm w-full text-left py-2 border-t border-gray-700 flex items-center justify-between hover:text-gray-50 transition-colors"
                  >
                    <span className="font-semibold flex items-center gap-2">
                      <Zap
                        size={16}
                        className="text-yellow-400"
                      />
                      Performance
                    </span>
                    {showPerformance ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )}
                  </button>

                  {showPerformance && (
                    <div className="space-y-3 mt-3">
                      {/* Tier 1: CRITICAL */}
                      <div className="grid grid-cols-2 gap-2">
                        {nMeta._analytics.generation_time_ms != null &&
                          nMeta._analytics.generation_time_ms > 0 && (
                            <MetadataItem
                              label="Generation Time"
                              value={formatGenerationTime(
                                nMeta._analytics.generation_time_ms,
                              )}
                            />
                          )}
                        {nMeta._analytics.vram_peak_mb != null && (
                          <MetadataItem
                            label="VRAM Peak"
                            value={formatVRAM(
                              nMeta._analytics.vram_peak_mb,
                              nMeta._analytics.gpu_device,
                            )}
                          />
                        )}
                      </div>

                      {nMeta._analytics.gpu_device && (
                        <MetadataItem
                          label="GPU Device"
                          value={nMeta._analytics.gpu_device}
                        />
                      )}

                      {/* Tier 2: VERY USEFUL */}
                      <div className="grid grid-cols-2 gap-2">
                        {nMeta._analytics.steps_per_second != null && (
                          <MetadataItem
                            label="Speed"
                            value={`${nMeta._analytics.steps_per_second.toFixed(2)} steps/s`}
                          />
                        )}
                        {nMeta._analytics.comfyui_version && (
                          <MetadataItem
                            label="ComfyUI"
                            value={nMeta._analytics.comfyui_version}
                          />
                        )}
                      </div>

                      {/* Tier 3: NICE-TO-HAVE (small text) */}
                      {(nMeta._analytics.torch_version ||
                        nMeta._analytics.python_version) && (
                        <div className="text-xs text-gray-400 border-t border-gray-700/50 pt-2 space-y-1">
                          {nMeta._analytics.torch_version && (
                            <div>PyTorch: {nMeta._analytics.torch_version}</div>
                          )}
                          {nMeta._analytics.python_version && (
                            <div>Python: {nMeta._analytics.python_version}</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded-lg text-sm">
              No normalized metadata available.
            </div>
          )}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={() =>
                copyToClipboard(
                  JSON.stringify(image.metadata, null, 2),
                  "Raw Metadata",
                )
              }
              className="w-full justify-center bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-200 flex items-center gap-2"
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
              className="w-full justify-center bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-600 px-3 py-2 rounded-lg text-xs font-medium transition-colors flex items-center gap-2"
            >
              Show in Folder
            </button>

          </div>

          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-lg flex items-center gap-2">
                Generation Data
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowRawMetadata(!showRawMetadata)}
                  className="text-xs text-gray-400 hover:text-gray-50 underline"
                >
                  {showRawMetadata ? "Show Parsed" : "Show JSON"}
                </button>
              </div>
            </div>
            {showRawMetadata && (
              <pre className="bg-black/50 p-2 rounded-lg text-xs text-gray-300 whitespace-pre-wrap break-all max-h-64 overflow-y-auto mt-2">
                {JSON.stringify(image.metadata, null, 2)}
              </pre>
            )}
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
