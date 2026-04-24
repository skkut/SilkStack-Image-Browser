import { useCallback } from 'react';
import { useImageStore } from '../store/useImageStore';
import { IndexedImage } from '../types';
import { FileOperations } from '../services/fileOperations';

import { useSettingsStore } from '../store/useSettingsStore';

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

    const handleImageSelection = useCallback((image: IndexedImage, event: React.MouseEvent) => {
        // Update focused index
        const clickedIndex = filteredImages.findIndex(img => img.id === image.id);
        if (clickedIndex !== -1) {
            setFocusedImageIndex(clickedIndex);
        }

        if (event.shiftKey && selectedImage) {
            const lastSelectedIndex = filteredImages.findIndex(img => img.id === selectedImage.id);
            const clickedIndex = filteredImages.findIndex(img => img.id === image.id);
            if (lastSelectedIndex !== -1 && clickedIndex !== -1) {
                const start = Math.min(lastSelectedIndex, clickedIndex);
                const end = Math.max(lastSelectedIndex, clickedIndex);
                const rangeIds = filteredImages.slice(start, end + 1).map(img => img.id);
                const newSelection = new Set(selectedImages);
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
                const imageListSnapshot = filteredImages.map(({ handle, thumbnailHandle, ...rest }) => rest);

                // Set selectedImage in store so main window highlights the image in the grid
                setSelectedImage(image);
                useImageStore.setState({ selectedImages: new Set([image.id]) });

                // Always open a new viewer window — multiple windows can be open simultaneously
                window.electronAPI.openImageViewer({
                    imageId: image.id,
                    directoryPath,
                    currentIndex: clickedIndex,
                    totalImages: filteredImages.length,
                    imageList: imageListSnapshot,
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
    }, [filteredImages, selectedImage, selectedImages, toggleImageSelection, clearImageSelection, setSelectedImage, setFocusedImageIndex]);

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