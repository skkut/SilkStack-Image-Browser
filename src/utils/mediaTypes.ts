// Media-type detection shared by the grids, the hover preview and the modal.
//
// Detection keys off the file NAME, not the blob's MIME type. On the desktop
// build the file handles are mocks whose `getFile()` reports every non-PNG
// file as image/jpeg (see useImageLoader's Electron handle factories), so the
// extension is the only signal that survives to the renderer intact. The
// `fileType` argument is still honoured first when present, because records
// written by the indexer carry a real MIME type.

export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.avi'];

/**
 * True when the file is a video container the app can hand to a <video>.
 * @param fileName - File name (or path — only the tail is inspected).
 * @param fileType - Optional MIME type from the index; wins when it is a video.
 */
export const isVideoFileName = (
  fileName?: string | null,
  fileType?: string | null,
): boolean => {
  if (fileType && fileType.startsWith('video/')) {
    return true;
  }
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

/**
 * True when the file is an animated GIF. GIFs are indexed as images (their
 * thumbnail is a still first frame), so they are handled separately from video
 * wherever a still frame would otherwise be shown.
 */
export const isGifFileName = (
  fileName?: string | null,
  fileType?: string | null,
): boolean => {
  if (fileType === 'image/gif') return true;
  if (!fileName) return false;
  return fileName.toLowerCase().endsWith('.gif');
};

/**
 * True when the file has motion to show — a video, or an animated GIF.
 */
export const isAnimatedMedia = (
  fileName?: string | null,
  fileType?: string | null,
): boolean => isVideoFileName(fileName, fileType) || isGifFileName(fileName, fileType);

/**
 * MIME type for a Blob assembled from a file's raw bytes.
 *
 * `Blob.type` is what the media pipeline uses to pick a demuxer, and the
 * Electron handles hand back a wrong-or-absent type, so it is derived from the
 * name here instead. Unknown extensions fall back to image/png, matching the
 * rest of the app (anything reaching this point has already been indexed).
 * @param fileName - File name the bytes came from.
 */
export const resolveMediaMimeType = (fileName?: string | null): string => {
  const lowerName = (fileName ?? '').toLowerCase();
  if (lowerName.endsWith('.mp4')) return 'video/mp4';
  if (lowerName.endsWith('.webm')) return 'video/webm';
  if (lowerName.endsWith('.mkv')) return 'video/x-matroska';
  if (lowerName.endsWith('.mov')) return 'video/quicktime';
  if (lowerName.endsWith('.avi')) return 'video/x-msvideo';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.gif')) return 'image/gif';
  return 'image/png';
};
