import React, { useEffect, useState, FC } from 'react';
import { ChevronDown, ChevronRight, Star, X, ArrowUp } from 'lucide-react';
import { useImageStore } from '../store/useImageStore';
import { type IndexedImage, type BaseMetadata, type LoRAInfo } from '../types';
import { getAspectRatio } from '../utils/imageUtils';


// Helper function to format LoRA with weight
const formatLoRA = (lora: string | LoRAInfo): string => {
  if (typeof lora === 'string') {
    return lora;
  }

  const name = lora.name || lora.model_name || 'Unknown LoRA';
  const weight = lora.weight ?? lora.model_weight;

  if (weight !== undefined && weight !== null) {
    return `${name} (${weight})`;
  }

  return name;
};



const formatDurationSeconds = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];

const isVideoFileName = (fileName: string, fileType?: string | null): boolean => {
  if (fileType && fileType.startsWith('video/')) {
    return true;
  }
  const lower = fileName.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

const resolveImageMimeType = (fileName: string): string => {
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.mp4')) return 'video/mp4';
  if (lowerName.endsWith('.webm')) return 'video/webm';
  if (lowerName.endsWith('.mkv')) return 'video/x-matroska';
  if (lowerName.endsWith('.mov')) return 'video/quicktime';
  if (lowerName.endsWith('.avi')) return 'video/x-msvideo';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  return 'image/png';
};

const createImageUrlFromFileData = (data: unknown, fileName: string): { url: string; revoke: boolean } => {
  const mimeType = resolveImageMimeType(fileName);

  if (typeof data === 'string') {
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

  if (data && typeof data === 'object' && 'data' in data && Array.isArray((data as { data: unknown }).data)) {
    const view = new Uint8Array((data as { data: number[] }).data);
    const blob = new Blob([view], { type: mimeType });
    return { url: URL.createObjectURL(blob), revoke: true };
  }

  throw new Error('Unknown file data format.');
};

// Helper component from ImageModal.tsx
const MetadataItem: FC<{ label: string; value?: string | number | any[]; isPrompt?: boolean; onCopy?: (value: string) => void }> = ({ label, value, isPrompt = false, onCopy }) => {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return null;
  }

  const displayValue = Array.isArray(value) ? value.join(', ') : String(value);

  return (
    <div className="bg-gray-900/50 p-3 rounded-md border border-gray-700/50 relative group">
      <div className="flex justify-between items-start">
        <p className="font-semibold text-gray-400 text-xs uppercase tracking-wider">{label}</p>
        {onCopy && (
            <button onClick={() => onCopy(displayValue)} className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-50" title={`Copy ${label}`}>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M7 3a1 1 0 011-1h6a1 1 0 110 2H8a1 1 0 01-1-1zM5 5a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2H5z"></path></svg>
            </button>
        )}
      </div>
      {isPrompt ? (
        <pre className="text-gray-200 whitespace-pre-wrap break-words font-mono text-sm mt-1">{displayValue}</pre>
      ) : (
        <p className="text-gray-200 break-words font-mono text-sm mt-1">{displayValue}</p>
      )}
    </div>
  );
};

const ImagePreviewSidebar: React.FC = () => {
  const {
    previewImage,
    setPreviewImage,
    directories,
    toggleFavorite,
    addTagToImage,
    removeTagFromImage,
    removeAutoTagFromImage,
    availableTags
  } = useImageStore();
  const previewImageFromStore = useImageStore((state) => {
    if (!state.previewImage) return null;
    const id = state.previewImage.id;
    return state.images.find(img => img.id === id) ||
      state.filteredImages.find(img => img.id === id) ||
      null;
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [showTagAutocomplete, setShowTagAutocomplete] = useState(false);


  const activeImage = previewImageFromStore || previewImage;
  const isVideo = !!activeImage && isVideoFileName(activeImage.name, activeImage.fileType);
  const preferredThumbnailUrl = activeImage?.thumbnailUrl ?? null;

  useEffect(() => {
    let isMounted = true;
    let createdUrl: string | null = null;

    if (!activeImage) {
      setImageUrl(null);
      return () => {
        isMounted = false;
        if (createdUrl) {
          URL.revokeObjectURL(createdUrl);
        }
      };
    }

    const hasPreview = Boolean(preferredThumbnailUrl);
    setImageUrl(isVideo ? null : preferredThumbnailUrl);

    const loadImage = async () => {
      if (!isMounted) return;

      const directoryPath = directories.find(d => d.id === activeImage.directoryId)?.path;

      const setResolvedUrl = (url: string, revoke: boolean) => {
        if (!isMounted) return;
        if (createdUrl) {
          URL.revokeObjectURL(createdUrl);
          createdUrl = null;
        }
        if (revoke) {
          createdUrl = url;
        }
        setImageUrl(url);
      };

      try {
        const primaryHandle = activeImage.thumbnailHandle;
        const fallbackHandle = activeImage.handle;
        const fileHandle =
          primaryHandle && typeof primaryHandle.getFile === 'function'
            ? primaryHandle
            : fallbackHandle && typeof fallbackHandle.getFile === 'function'
              ? fallbackHandle
              : null;
        if (fileHandle) {
          const file = await fileHandle.getFile();
          if (isMounted) {
            const url = URL.createObjectURL(file);
            setResolvedUrl(url, true);
          }
          return;
        }
        throw new Error('Image handle is not a valid FileSystemFileHandle.');
      } catch (handleError) {
        const message = handleError instanceof Error ? handleError.message : String(handleError);
        console.warn(`Could not load image with FileSystemFileHandle: ${message}. Attempting Electron fallback.`);
        if (isMounted && window.electronAPI && directoryPath) {
          try {
            const pathResult = await window.electronAPI.joinPaths(directoryPath, activeImage.name);
            if (!pathResult.success || !pathResult.path) {
              throw new Error(pathResult.error || 'Failed to construct image path.');
            }
            const fileResult = await window.electronAPI.readFile(pathResult.path);
            if (fileResult.success && fileResult.data && isMounted) {
              const { url, revoke } = createImageUrlFromFileData(fileResult.data, activeImage.name);
              setResolvedUrl(url, revoke);
            } else {
              throw new Error(fileResult.error || 'Failed to read file via Electron API.');
            }
          } catch (electronError) {
            console.error('Electron fallback failed:', electronError);
            if (isMounted && !hasPreview) setImageUrl(null);
          }
        } else if (isMounted && !hasPreview) {
          setImageUrl(null);
        }
      }
    };

    loadImage();

    return () => {
      isMounted = false;
      if (createdUrl) {
        // Small delay to ensure image is no longer being used before revoking
        setTimeout(() => {
          URL.revokeObjectURL(createdUrl);
        }, 100);
      }
    };
  }, [activeImage?.id, activeImage?.handle, activeImage?.thumbnailHandle, activeImage?.name, activeImage?.directoryId, directories, preferredThumbnailUrl, isVideo]);
  if (!activeImage) {
    return null;
  }

  const nMeta: BaseMetadata | undefined = activeImage.metadata?.normalizedMetadata;
  const videoInfo = (nMeta as any)?.video;
  const motionModel = (nMeta as any)?.motion_model;

  const copyToClipboard = (text: string, type: string) => {
    if(!text) return;
    navigator.clipboard.writeText(text).then(() => {
      // You can add a notification here if you want
    }).catch(err => {
      console.error(`Failed to copy ${type}:`, err);
    });
  };

  // Tag management handlers
  const handleAddTag = () => {
    if (!tagInput.trim() || !activeImage) return;
    addTagToImage(activeImage.id, tagInput);
    setTagInput('');
    setShowTagAutocomplete(false);
  };

  const handleRemoveTag = (tag: string) => {
    if (!activeImage) return;
    removeTagFromImage(activeImage.id, tag);
  };

  const handleRemoveAutoTag = (tag: string) => {
    if (!activeImage) return;
    removeAutoTagFromImage(activeImage.id, tag);
  };

  const handlePromoteAutoTag = async (tag: string) => {
    if (!activeImage) return;
    // Add as manual tag and remove from auto-tags
    await addTagToImage(activeImage.id, tag);
    removeAutoTagFromImage(activeImage.id, tag);
  };

  const handleToggleFavorite = () => {
    if (!activeImage) return;
    toggleFavorite(activeImage.id);
  };

  // Filter autocomplete tags
  const autocompleteOptions = tagInput && activeImage
    ? availableTags
        .filter(tag =>
          tag.name.includes(tagInput.toLowerCase()) &&
          !(activeImage.tags || []).includes(tag.name)
        )
        .slice(0, 5)
    : [];

  return (
    <div 
      data-area="preview" 
      tabIndex={-1} 
      className="fixed right-0 bg-gray-950 border-l border-gray-700 z-40 flex flex-col shadow-xl transition-all duration-300"
      style={{ 
        top: 'var(--header-height, 44px)', 
        height: 'calc(100% - var(--header-height, 44px))',
        width: '24rem' // w-96
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-700">
        <h2 className="text-lg font-semibold text-gray-200">Image Preview</h2>
        <button
          onClick={() => setPreviewImage(null)}
          className="text-gray-400 hover:text-gray-50 transition-colors"
          title="Close preview"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto scrollbar-adaptive p-4 space-y-4">
        {/* Image */}
        <div className="bg-gray-950 flex items-center justify-center rounded-lg">
          {imageUrl ? (
            isVideo ? (
              <video
                src={imageUrl}
                className="max-w-full max-h-96 object-contain"
                controls
                playsInline
                poster={preferredThumbnailUrl ?? undefined}
              />
            ) : (
              <img src={imageUrl} alt={activeImage.name} className="max-w-full max-h-96 object-contain" />
            )
          ) : (
            <div className="w-full h-64 animate-pulse bg-gray-700 rounded-md"></div>
          )}
        </div>

        {/* Metadata */}
        <div>
          <h2 className="text-lg font-bold text-gray-100 break-all mb-1">{activeImage.name}</h2>
          <p className="text-xs text-blue-400 font-mono break-all">{new Date(activeImage.lastModified).toLocaleString()}</p>
        </div>

        {/* Annotations Section */}
        <div className="bg-gray-900/50 p-3 rounded-lg border border-gray-700/50 space-y-2">
          {/* Favorite and Tags Row */}
          <div className="flex items-start gap-3">
            {/* Favorite Star - Discrete */}
            <button
              onClick={handleToggleFavorite}
              className={`p-1.5 rounded transition-all ${
                activeImage.isFavorite
                  ? 'text-yellow-400 hover:text-yellow-300'
                  : 'text-gray-500 hover:text-yellow-400'
              }`}
              title={activeImage.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Star className={`w-5 h-5 ${activeImage.isFavorite ? 'fill-current' : ''}`} />
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
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                    if (e.key === 'Escape') {
                      setTagInput('');
                      setShowTagAutocomplete(false);
                    }
                  }}
                  onFocus={() => tagInput && setShowTagAutocomplete(true)}
                  onBlur={() => setTimeout(() => setShowTagAutocomplete(false), 200)}
                  className="w-full bg-gray-700/50 text-gray-200 border border-gray-600 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
                />

                {/* Autocomplete Dropdown */}
                {showTagAutocomplete && autocompleteOptions.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-gray-800 border border-gray-600 rounded-lg shadow-lg max-h-32 overflow-y-auto">
                    {autocompleteOptions.map(tag => (
                      <button
                        key={tag.name}
                        onClick={() => {
                          addTagToImage(activeImage.id, tag.name);
                          setTagInput('');
                          setShowTagAutocomplete(false);
                        }}
                        className="w-full text-left px-2 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex justify-between items-center"
                      >
                        <span>{tag.name}</span>
                        <span className="text-xs text-gray-500">({tag.count})</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Current Tags */}
              {activeImage.tags && activeImage.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {activeImage.tags.map(tag => (
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


              {activeImage.autoTags && activeImage.autoTags.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-purple-300">Auto tags</p>
                  <div className="flex flex-wrap gap-1.5">
                    {activeImage.autoTags.map(tag => (
                      <div key={`auto-${tag}`} className="inline-flex items-center bg-purple-600/20 border border-purple-500/40 rounded-full overflow-hidden">
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
          <>
            <h3 className="text-base font-semibold text-gray-300 border-b border-gray-600 pb-2">Metadata</h3>
            <div className="space-y-3">
              <MetadataItem label="Format" value={nMeta.format} onCopy={(v) => copyToClipboard(v, "Format")} />
              <MetadataItem label="Prompt" value={nMeta.prompt} isPrompt onCopy={(v) => copyToClipboard(v, "Prompt")} />
              <MetadataItem label="Negative Prompt" value={nMeta.negativePrompt} isPrompt onCopy={(v) => copyToClipboard(v, "Negative Prompt")} />
              <MetadataItem label="Model" value={nMeta.model} onCopy={(v) => copyToClipboard(v, "Model")} />
              {((nMeta as any).vae || (nMeta as any).vaes?.[0]?.name) && (
                <MetadataItem label="VAE" value={(nMeta as any).vae || (nMeta as any).vaes?.[0]?.name} />
              )}

              <div className="grid grid-cols-2 gap-2 text-sm">
                  <MetadataItem label="Steps" value={nMeta.steps} />
                  <MetadataItem label="CFG Scale" value={nMeta.cfgScale} />
                  <MetadataItem label="Seed" value={nMeta.seed} />
                  <MetadataItem label="Dimensions" value={nMeta.width && nMeta.height ? `${nMeta.width}x${nMeta.height}` : undefined} />
                  <MetadataItem label="Megapixels" value={nMeta.width && nMeta.height ? `${((nMeta.width * nMeta.height) / 1_000_000).toFixed(2)} MP` : undefined} />
                  <MetadataItem label="Aspect Ratio" value={getAspectRatio(nMeta.width, nMeta.height) || undefined} />
                  <MetadataItem label="Sampler" value={nMeta.sampler} />
                  <MetadataItem label="Scheduler" value={nMeta.scheduler} />
                  {(nMeta as any).denoise != null && (nMeta as any).denoise < 1 && (
                    <MetadataItem label="Denoise" value={(nMeta as any).denoise} />
                  )}
              </div>
              {videoInfo && (
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <MetadataItem label="Frames" value={videoInfo.frame_count} />
                  <MetadataItem label="FPS" value={videoInfo.frame_rate != null ? Number(videoInfo.frame_rate).toFixed(2) : undefined} />
                  {videoInfo.duration_seconds != null && (
                    <MetadataItem label="Duration" value={formatDurationSeconds(Number(videoInfo.duration_seconds))} />
                  )}
                  <MetadataItem label="Video Codec" value={videoInfo.codec} />
                  <MetadataItem label="Video Format" value={videoInfo.format} />
                </div>
              )}
              {motionModel?.name && (
                <MetadataItem label="Motion Model" value={motionModel.name} />
              )}
              {motionModel?.hash && (
                <MetadataItem label="Motion Model Hash" value={motionModel.hash} />
              )}
              {(nMeta as any)?._metahub_pro?.project_name && (
                <MetadataItem label="Project" value={(nMeta as any)._metahub_pro.project_name} />
              )}
            </div>

            {nMeta.loras && nMeta.loras.length > 0 && (
               <>
                  <h3 className="text-base font-semibold text-gray-300 pt-2 border-b border-gray-600 pb-2">LoRAs</h3>
                  <MetadataItem label="LoRAs" value={nMeta.loras.map(formatLoRA).join(', ')} />
               </>
            )}




          </>
        ) : (
          <div className="bg-yellow-900/50 border border-yellow-700 text-yellow-300 px-4 py-3 rounded-lg text-sm">
              No normalized metadata available.
          </div>
        )}
      </div>
    </div>
  );
};

// Memoize to prevent unnecessary re-renders
export default React.memo(ImagePreviewSidebar);
