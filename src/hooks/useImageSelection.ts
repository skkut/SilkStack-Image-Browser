import { useCallback, useRef } from 'react';
import { useImageStore } from '../store/useImageStore';
import { IndexedImage } from '../types';
import { FileOperations } from '../services/fileOperations';
import {
    COMPACT_MODE_STORAGE_KEY,
    COMPACT_PANEL_STORAGE_KEY,
    COMPACT_SCALE_STORAGE_KEY,
    SIDEBAR_SHARE_STORAGE_KEY,
    clampSidebarShare,
    clampUserScale,
    compactSidebarWidth,
    computeCompactContentSize,
    parseDimensionsString,
} from '../utils/windowSizing';

import { useSettingsStore } from '../store/useSettingsStore';

/**
 * What the open-hint contributes to the viewer payload. Every field is optional
 * because the common case contributes nothing at all — see below — and readers
 * spread this into the payload rather than branching on it.
 */
export type CompactOpenHint = {
    /** Set only when a remembered compact mode says the window opens in it. */
    compact?: true;
    /**
     * The window's content size, when the stored dimensions allowed one. Absent
     * for a file the indexer could not measure: the window still opens compact,
     * it just opens at the default size and lets the viewer apply the fit once
     * it has the decoded bitmap.
     */
    compactContentWidth?: number;
    compactContentHeight?: number;
};

/**
 * When compact mode was left on, size the viewer window before it is ever
 * shown — otherwise it flashes at full size until the first image decodes.
 * The stored "WxH" string is enough to compute the shape; the viewer re-applies
 * the real size once it has the decoded bitmap. Returns `{}` in the common
 * (non-compact) case, so the payload is unchanged.
 *
 * The size carries the metadata panel when one was left docked, so a window
 * that is going to have a panel opens *with* it rather than opening as the
 * picture alone and widening a moment later. The viewer derives its own panel
 * state from the same flag, so the two agree about the frame without either
 * telling the other.
 */
export function compactOpenHint(image: IndexedImage): CompactOpenHint {
    if (localStorage.getItem(COMPACT_MODE_STORAGE_KEY) !== 'true') return {};

    const dimensions = parseDimensionsString(image.dimensions);
    const userScale = clampUserScale(
        Number(localStorage.getItem(COMPACT_SCALE_STORAGE_KEY)),
    );
    const availWidth = window.screen?.availWidth || window.innerWidth;
    const availHeight = window.screen?.availHeight || window.innerHeight;
    // Reserved against the *work area*, matching the viewer, which measures a
    // compact panel against the screen rather than the frame — the frame is the
    // picture's size, and the panel holds text whose needs do not follow it.
    //
    // Only an explicit 'true' reserves, matching the viewer: a key that was
    // never written reads as absent, which is "never asked" and means the panel
    // stays off. A share that was never dragged reads as `Number(null)` = 0,
    // which `clampSidebarShare` turns into the default rather than the floor.
    const reserved =
        localStorage.getItem(COMPACT_PANEL_STORAGE_KEY) === 'true'
            ? compactSidebarWidth(
                  availWidth,
                  clampSidebarShare(
                      Number(localStorage.getItem(SIDEBAR_SHARE_STORAGE_KEY)),
                  ),
              )
            : 0;
    const size = dimensions
        ? computeCompactContentSize(
              dimensions.width,
              dimensions.height,
              availWidth,
              availHeight,
              userScale,
              1,
              reserved,
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
        selectedImages,
        setSelectedImage,
        toggleImageSelection,
        selectSingleImage,
        selectImageRange,
        clearImageSelection,
        removeImage,
        setError,
        setFocusedImageIndex,
    } = useImageStore();

    // ── Stabilize the click callback ──────────────────────────────────
    // filteredImages and selectedImages change on almost every store update.
    // If handleImageSelection depends on them directly (via useCallback deps),
    // it changes identity on every render, which cascades through ImageGrid →
    // itemData → every react-window row re-rendering. Refs break this chain:
    // the callback identity is stable while always reading the latest values
    // from the store snapshot.
    const filteredImagesRef = useRef(filteredImages);
    filteredImagesRef.current = filteredImages;
    const selectedImagesRef = useRef(selectedImages);
    selectedImagesRef.current = selectedImages;

    const handleImageSelection = useCallback((
        image: IndexedImage,
        event: React.MouseEvent,
        displayOrder?: string[],
    ) => {
        const currentFiltered = filteredImagesRef.current;
        const currentSelectedImages = selectedImagesRef.current;

        // The cards the grid is showing, in layout order. With stacking on this
        // is NOT filteredImages — a stack is a single card and the stacking hook
        // re-sorts the items — so both the focused index and the Shift+click run
        // have to be measured here. Callers that render a plain list omit it.
        const order = displayOrder ?? currentFiltered.map(img => img.id);

        // Update focused index. It indexes the rendered list: itemsToRender
        // [focusedImageIndex] and the arrow-key walk both read it, so using the
        // library index here would focus the wrong card once stacks collapse.
        const displayIndex = order.indexOf(image.id);
        if (displayIndex !== -1) {
            setFocusedImageIndex(displayIndex);
        }

        // Shift+click extends the selection from the anchor (the last image
        // picked) to the clicked one. Purely additive — the range is unioned
        // into the existing selection, so Shift never drops an image and never
        // opens the viewer. With nothing selected there is no run to draw, so
        // it falls through to the plain click below.
        if (event.shiftKey && currentSelectedImages.size > 0) {
            selectImageRange(image.id, order);
            return;
        }

        // The viewer carries the filtered list, so its index is a filtered one.
        const clickedIndex = currentFiltered.findIndex(img => img.id === image.id);

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
                selectSingleImage(image.id);

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
                selectSingleImage(image.id);
            }
        }
    }, [toggleImageSelection, clearImageSelection, setSelectedImage, selectSingleImage, selectImageRange, setFocusedImageIndex]);

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