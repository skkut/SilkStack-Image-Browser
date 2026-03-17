/**
 * Copy to ComfyUI Hook
 * Copies workflow JSON to clipboard for manual import into ComfyUI
 */

import { useState, useCallback } from 'react';
import { IndexedImage } from '../types';
import { formatMetadataForComfyUI } from '../utils/comfyUIFormatter';
import { useImageStore } from '../store/useImageStore';
import { extractRawMetadataFromFile } from '../services/fileIndexer';

interface CopyStatus {
  success: boolean;
  message: string;
}

export function useCopyToComfyUI() {
  const [isCopying, setIsCopying] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus | null>(null);

  const copyToComfyUI = useCallback(async (image: IndexedImage) => {
    const metadata = image.metadata?.normalizedMetadata;

    if (!metadata || !metadata.prompt) {
      setCopyStatus({
        success: false,
        message: 'No metadata available for this image',
      });
      setTimeout(() => setCopyStatus(null), 5000);
      return;
    }

    setIsCopying(true);
    setCopyStatus(null);

    try {
      // 1. Try to get raw workflow/prompt from root metadata first (Highest fidelity)
      // ComfyUI metadata often has 'workflow' or 'prompt' at the root
      let workflowJSON = '';
      let rawMetadata = image.metadata as any;
      
      if (!rawMetadata.workflow && !rawMetadata.prompt) {
        try {
          const dir = useImageStore.getState().directories.find(d => d.id === image.directoryId);
          if (dir && dir.path && window.electronAPI) {
            const relativePath = image.id.split('::')[1] || image.name;
            const pathResult = await window.electronAPI.joinPaths(dir.path, relativePath);
            if (pathResult.success && pathResult.path) {
              const fetchedMeta = await extractRawMetadataFromFile(pathResult.path);
              if (fetchedMeta) {
                rawMetadata = fetchedMeta;
              }
            }
          }
        } catch (err) {
          console.error('Failed to lazy load raw metadata:', err);
        }
      }

      if (rawMetadata.workflow) {
        workflowJSON = JSON.stringify(rawMetadata.workflow, null, 2);
      } else if (rawMetadata.prompt) {
        workflowJSON = JSON.stringify(rawMetadata.prompt, null, 2);
      } else if (metadata.workflow) {
        // Fallback to normalized metadata if it somehow stuck there
        workflowJSON = JSON.stringify(metadata.workflow, null, 2);
      } else {
        // 2. Fallback: Reconstruct workflow from metadata (Lower fidelity)
        workflowJSON = formatMetadataForComfyUI(metadata);
      }

      // Copy to clipboard
      await navigator.clipboard.writeText(workflowJSON);

      setCopyStatus({
        success: true,
        message: 'Workflow copied! Switch to ComfyUI and press Ctrl+V to paste.',
      });

      // Clear status after 5 seconds
      setTimeout(() => setCopyStatus(null), 5000);
    } catch (error: any) {
      // Handle clipboard API errors (e.g., HTTP context, permissions)
      const errorMessage = error.message?.includes('clipboard')
        ? 'Clipboard access denied. Please use HTTPS or localhost.'
        : `Error: ${error.message}`;

      setCopyStatus({
        success: false,
        message: errorMessage,
      });

      setTimeout(() => setCopyStatus(null), 5000);
    } finally {
      setIsCopying(false);
    }
  }, []);

  return {
    copyToComfyUI,
    isCopying,
    copyStatus,
  };
}
