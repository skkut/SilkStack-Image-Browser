import { type IndexedImage } from '../types';
import { getImageAbsolutePath, quotePathForClipboard } from './pathUtils';

// Utility functions for image operations

export interface OperationResult {
  success: boolean;
  error?: string;
}

/**
 * Copies an image to the clipboard using the Clipboard API.
 *
 * Chromium (Electron) only accepts `image/png` (and `image/webp`) for
 * `ClipboardItem` writes — `image/jpeg` is rejected with "Type Image/jpeg
 * not supported on write". Files in any other image format are therefore
 * re-encoded to PNG via a canvas before being written.
 * @param image - The IndexedImage object containing the file handle
 * @returns Promise with operation result
 */
export const copyImageToClipboard = async (image: IndexedImage): Promise<OperationResult> => {
  try {
    const file = await image.handle.getFile();

    // PNG and WebP are natively writable — no re-encoding needed.
    if (file.type === 'image/png' || file.type === 'image/webp') {
      const blob = new Blob([file], { type: file.type });
      await navigator.clipboard.write([new ClipboardItem({ [file.type]: blob })]);
      return { success: true };
    }

    if (!file.type.startsWith('image/')) {
      return { success: false, error: 'Only image files can be copied to the clipboard.' };
    }

    // Re-encode to PNG — the format Chromium always supports on clipboard writes.
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return { success: false, error: 'Failed to prepare image for clipboard.' };
    }
    ctx.drawImage(bitmap, 0, 0);
    const pngBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png')
    );
    if (!pngBlob) {
      return { success: false, error: 'Failed to encode image as PNG.' };
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return { success: true };
  } catch (error) {
    console.error('Failed to copy image to clipboard:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
};

/**
 * Shows the image file in the system's file explorer
 * @param imageOrPath - The IndexedImage object or full file path string
 * @returns Promise with operation result
 */
export const showInExplorer = async (imageOrPath: IndexedImage | string): Promise<OperationResult> => {
  try {
    // Check if running in Electron
    if (typeof window !== 'undefined' && (window as any).electronAPI && (window as any).electronAPI.showItemInFolder) {
      // Electron: use shell.showItemInFolder()
      let fullPath: string;
      
      if (typeof imageOrPath === 'string') {
        // Direct path provided - use it as-is
        fullPath = imageOrPath;
      } else {
        // IndexedImage provided - construct path
        let directoryPath = localStorage.getItem('invokeai-electron-directory-path');

        // Try sessionStorage as fallback if localStorage is null
        if (!directoryPath) {
          directoryPath = sessionStorage.getItem('invokeai-electron-directory-path');
        }

        fullPath = directoryPath ? `${directoryPath}\\${imageOrPath.name}` : imageOrPath.name;
      }
      
      const result = await (window as any).electronAPI.showItemInFolder(fullPath);

      if (result.success) {
        // File opened successfully
      } else {
        console.error('❌ Failed to open file in explorer:', result.error);
      }
      return result;
    } else {
      // Web: show helpful message with path
      if (typeof imageOrPath === 'string') {
        const message = `File location: ${imageOrPath}\n\n` +
          `In the web version, you can:\n` +
          `1. Copy this path\n` +
          `2. Navigate to the file location\n\n` +
          `For full file explorer integration, use the desktop app.`;

        alert(message);

        // Also copy the path to clipboard for convenience
        try {
          await navigator.clipboard.writeText(imageOrPath);
        } catch (clipboardError) {
          // Ignore clipboard errors
        }

        return { success: true };
      } else {
        const directoryContext = imageOrPath.directoryName ? `\nDirectory: ${imageOrPath.directoryName}` : '';
        const message = `File location: ${imageOrPath.id}${directoryContext}\n\n` +
          `In the web version, you can:\n` +
          `1. Copy this relative path\n` +
          `2. Navigate to your selected folder${imageOrPath.directoryName ? ` (${imageOrPath.directoryName})` : ''}\n` +
          `3. Find the file using this path\n\n` +
          `For full file explorer integration, use the desktop app.`;

        alert(message);

        // Also copy the path to clipboard for convenience
        try {
          await navigator.clipboard.writeText(imageOrPath.id);
        } catch (clipboardError) {
          // Ignore clipboard errors
        }

        return { success: true };
      }
    }
  } catch (error) {
    console.error('❌ Failed to show in explorer:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
};

/**
 * Opens the image file in the OS native viewer (default application for the file type)
 * @param imageOrPath - The IndexedImage object or full file path string
 * @returns Promise with operation result
 */
export const openInNativeViewer = async (imageOrPath: IndexedImage | string): Promise<OperationResult> => {
  try {
    // Check if running in Electron
    if (typeof window !== 'undefined' && (window as any).electronAPI && (window as any).electronAPI.openFile) {
      // Electron: use shell.openPath() via openFile IPC
      let fullPath: string;

      if (typeof imageOrPath === 'string') {
        // Direct path provided - use it as-is
        fullPath = imageOrPath;
      } else {
        // IndexedImage provided - construct path
        let directoryPath = localStorage.getItem('invokeai-electron-directory-path');

        // Try sessionStorage as fallback if localStorage is null
        if (!directoryPath) {
          directoryPath = sessionStorage.getItem('invokeai-electron-directory-path');
        }

        fullPath = directoryPath ? `${directoryPath}\\${imageOrPath.name}` : imageOrPath.name;
      }

      const result = await (window as any).electronAPI.openFile(fullPath);

      if (!result.success) {
        console.error('❌ Failed to open file in native viewer:', result.error);
      }
      return result;
    } else {
      // Web: show helpful message
      let pathDisplay: string;
      if (typeof imageOrPath === 'string') {
        pathDisplay = imageOrPath;
      } else {
        pathDisplay = imageOrPath.id;
      }

      const message = `Cannot open in native viewer from the web version.\n\n` +
        `File: ${pathDisplay}\n\n` +
        `This feature is only available in the desktop app.\n` +
        `Use "Show in Folder" to locate the file, then open it manually.`;

      alert(message);
      return { success: false, error: 'Not available in web version' };
    }
  } catch (error) {
    console.error('❌ Failed to open in native viewer:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
};

/**
 * Copies the image's absolute file path to clipboard, enclosed in double
 * quotes — see `quotePathForClipboard`.
 *
 * Path resolution is delegated to `getImageAbsolutePath` so this agrees with
 * the context menu's Copy Image Path / Show in Folder actions. Callers that
 * know the image's directory should pass it — without one, resolution falls
 * back to whatever the image itself carries.
 * @param image - The IndexedImage object containing the file path
 * @param directoryPath - The image's directory on disk, when known
 * @returns Promise with operation result
 */
export const copyFilePathToClipboard = async (
  image: IndexedImage,
  directoryPath?: string
): Promise<OperationResult> => {
  try {
    // Ensure document has focus before clipboard operation
    if (document.hidden || !document.hasFocus()) {
      window.focus();
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const filePath = getImageAbsolutePath(image, directoryPath);
    if (!filePath) {
      return { success: false, error: 'Could not determine the file path for this image' };
    }

    await navigator.clipboard.writeText(quotePathForClipboard(filePath));

    return { success: true };
  } catch (error) {
    console.error('❌ Failed to copy file path:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred'
    };
  }
};

/**
 * Calculates the aspect ratio of an image and returns it as a string (e.g., "3:2")
 * @param width - Image width
 * @param height - Image height
 * @returns Aspect ratio string or null if inputs are invalid
 */
export const getAspectRatio = (width?: number, height?: number): string | null => {
  if (!width || !height || isNaN(width) || isNaN(height)) return null;

  const gcd = (a: number, b: number): number => {
    return b === 0 ? a : gcd(b, a % b);
  };

  const common = gcd(width, height);
  const rWidth = width / common;
  const rHeight = height / common;

  return `${rWidth}:${rHeight}`;
};