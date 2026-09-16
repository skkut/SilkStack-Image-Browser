import { useCallback, useRef } from 'react';
import { useImageStore } from '../store/useImageStore';
import { IndexedImage } from '../types';
import { FileOperations } from '../services/fileOperations';
import {
    COMPACT_MODE_STORAGE_KEY,
    COMPACT_SCALE_STORAGE_KEY,
    clampUserScale,
    computeCompactContentSize,
    parseDimensionsString,
} from '../utils/windowSizing';

import { useSettingsStore } from '../store/useSettingsStore';

/**
 * When compact mode was left on, size the viewer window before it is ever
 * shown — otherwise it flashes at full size until the first image decodes.
 * The stored "WxH" string is enough to compute the shape; the viewer re-applies
 * the real size once it has the decoded bitmap. Returns `{}` in the common
 * (non-compact) case, so the payload is unchanged.
 */
function compactOpenHint(image: IndexedImage) {
    if (localStorage.getItem(COMPACT_MODE_STORAGE_KEY) !== 'true') return {};

    const dimensions = parseDimensionsString(image.dimensions);
    const userScale = clampUserScale(
        Number(localStorage.getItem(COMPACT_SCALE_STORAGE_KEY)),
    );
    const size = dimensions
        ? computeCompactContentSize(
              dimensions.width,
              dimensions.height,
              window.screen?.availWidth || window.innerWidth,
              window.screen?.availHeight || window.innerHeight,
              userScale,
          )
        : null;

    return {
        compact: true,
        ...(size && {
            compactContentWidth: size.contentWidth,
            compactContentHeight: size.contentHeight,
        }),
    };
}

export function useImageSelection() {
    const {
        images,
        filteredImages,
        selectedImage,
        selectedImages,
        setSelectedImage,
        toggleImageSelection,
        clearImageSelection,
        removeImage,
        setError,
        setFocusedImageIndex,
    } = useImageStore();

    // ── Stabilize the click callback ──────────────────────────────────
    // filteredImages, selectedImage, and selectedImages change on almost every
    // store update.  If handleImageSelection depends on them directly (via
    // useCallback deps), it changes identity on every render, which cascades
    // through ImageGrid → itemData → every react-window row re-rendering.
    // Refs break this chain: the callback identity is stable while always
    // reading the latest values from the store snapshot.
    const filteredImagesRef = useRef(filteredImages);
    filteredImagesRef.current = filteredImages;
    const selectedImageRef = useRef(selectedImage);
    selectedImageRef.current = selectedImage;
    const selectedImagesRef = useRef(selectedImages);
    selectedImagesRef.current = selectedImages;

    const handleImageSelection = useCallback((image: IndexedImage, event: React.MouseEvent) => {
        const currentFiltered = filteredImagesRef.current;
        const currentSelectedImage = selectedImageRef.current;
        const currentSelectedImages = selectedImagesRef.current;

        // Update focused index
        const clickedIndex = currentFiltered.findIndex(img => img.id === image.id);
        if (clickedIndex !== -1) {
            setFocusedImageIndex(clickedIndex);
        }

        if (event.shiftKey && currentSelectedImage) {
            const lastSelectedIndex = currentFiltered.findIndex(img => img.id === currentSelectedImage.id);
            const clickedIdx = currentFiltered.findIndex(img => img.id === image.id);
            if (lastSelectedIndex !== -1 && clickedIdx !== -1) {
                const start = Math.min(lastSelectedIndex, clickedIdx);
                const end = Math.max(lastSelectedIndex, clickedIdx);
                const rangeIds = currentFiltered.slice(start, end + 1).map(img => img.id);
                const newSelection = new Set(currentSelectedImages);
                rangeIds.forEach(id => newSelection.add(id));
                useImageStore.setState({ selectedImages: newSelection });
                return;
            }
        }

        if (event.ctrlKey || event.metaKey) {
            toggleImageSelection(image.id);
        } else {
            // Single selection: open viewer window in Electron, or in-app modal in browser
            if (window.electronAPI?.openImageViewer) {
                // Find directory path for this image
                const directories = useImageStore.getState().directories;
                const directory = directories.find(d => d.id === image.directoryId);
                const directoryPath = directory?.path || '';

                // Serialize the current filtered list (strip non-serializable handles)
                const imageListSnapshot = currentFiltered.map(({ handle, thumbnailHandle, ...rest }) => rest);

                // Set selectedImage in store so main window highlights the image in the grid
                setSelectedImage(image);
                useImageStore.setState({ selectedImages: new Set([image.id]) });

                // Always open a new viewer window — multiple windows can be open simultaneously
                window.electronAPI.openImageViewer({
                    imageId: image.id,
                    directoryPath,
                    currentIndex: clickedIndex,
                    totalImages: currentFiltered.length,
                    imageList: imageListSnapshot,
                    ...compactOpenHint(image),
                }).then((result) => {
                    if (result?.success && result.windowId !== undefined) {
                        // Dispatch a DOM event so App.tsx can track this window ID
                        window.dispatchEvent(new CustomEvent('viewer-window-opened', { detail: { windowId: result.windowId } }));
                    }
                }).catch(() => {
                    // Ignore errors from window opening
                });
            } else {
                // Browser fallback: use in-app modal
                setSelectedImage(image);
                useImageStore.setState({ selectedImages: new Set([image.id]) });
            }
        }
    }, [toggleImageSelection, clearImageSelection, setSelectedImage, setFocusedImageIndex]);

    const handleDeleteSelectedImages = useCallback(async () => {
        if (selectedImages.size === 0) return;

        const confirmOnDelete = useSettingsStore.getState().confirmOnDelete;
        if (confirmOnDelete) {
            const confirmMessage = `Are you sure you want to delete ${selectedImages.size} image(s)?`;
            if (!window.confirm(confirmMessage)) return;
        }

        const imagesToDelete = Array.from(selectedImages);
        for (const imageId of imagesToDelete) {
            const image = images.find(img => img.id === imageId);
            if (image) {
                try {
                    const result = await FileOperations.deleteFile(image);
                    if (result.success) {
                        removeImage(imageId);
                    } else {
                        setError(`Failed to delete ${image.name}: ${result.error}`);
                    }
                } catch (err) {
                    setError(`Error deleting ${image.name}: ${err instanceof Error ? err.message : 'Unknown error'}`);
                }
            }
        }
        clearImageSelection();
    }, [selectedImages, images, removeImage, setError, clearImageSelection]);

    return { handleImageSelection, handleDeleteSelectedImages, clearSelection: clearImageSelection };
}