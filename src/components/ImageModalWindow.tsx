import React, { useEffect, useState, useCallback } from "react";
import { type IndexedImage } from "../types";
import ImageModal from "./ImageModal";

/**
 * ImageModalWindow - A wrapper component that renders ImageModal inside a child Electron window.
 * Navigation is fully self-contained: the window receives a snapshot of the image list at open
 * time and navigates within it locally, without round-trips to the main window.
 * Actions (delete, rename, favorite, tags) are still forwarded to the main window for grid sync.
 */
const ImageModalWindow: React.FC = () => {
  const [imageList, setImageList] = useState<IndexedImage[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [directoryPath, setDirectoryPath] = useState("");

  // Derive the current / next / previous images from local state
  const image = imageList[currentIndex] ?? null;
  const nextImage = currentIndex < imageList.length - 1 ? imageList[currentIndex + 1] : null;
  const previousImage = currentIndex > 0 ? imageList[currentIndex - 1] : null;

  // Apply theme on mount
  useEffect(() => {
    const applyTheme = (systemShouldUseDark: boolean) => {
      if (systemShouldUseDark) {
        document.documentElement.classList.add("dark");
        document.documentElement.setAttribute("data-theme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        document.documentElement.setAttribute("data-theme", "light");
      }
    };

    if (window.electronAPI) {
      window.electronAPI.getTheme().then(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });

      const unsubscribe = window.electronAPI.onThemeUpdated(
        ({ shouldUseDarkColors }) => {
          applyTheme(shouldUseDarkColors);
        }
      );

      return () => {
        if (unsubscribe) unsubscribe();
      };
    } else {
      applyTheme(
        window.matchMedia("(prefers-color-scheme: dark)").matches
      );
    }
  }, []);

  // Helper: reconstruct an IndexedImage with a mock handle for Electron
  const reconstructImage = (raw: any): IndexedImage => ({
    ...raw,
    handle: {
      name: raw.name,
      kind: "file" as const,
    } as unknown as FileSystemFileHandle,
  });

  // Listen for image data updates from the main window
  useEffect(() => {
    if (!window.electronAPI?.onImageViewerUpdate) return;

    const unsubscribe = window.electronAPI.onImageViewerUpdate((data) => {
      if (data.imageList && Array.isArray(data.imageList) && data.imageList.length > 0) {
        // Use the full list for self-contained navigation
        const reconstructed = data.imageList.map(reconstructImage);
        setImageList(reconstructed);
        setCurrentIndex(data.currentIndex ?? 0);
        setDirectoryPath(data.directoryPath ?? "");
      } else if (data.image) {
        // Fallback: single-image update (e.g. from a delete action refresh)
        const reconstructed = reconstructImage(data.image);
        // Replace the matching image in the list, or use a single-item list
        setImageList((prev) => {
          const idx = prev.findIndex((img) => img.id === reconstructed.id);
          if (idx !== -1) {
            const updated = [...prev];
            updated[idx] = reconstructed;
            return updated;
          }
          return [reconstructed];
        });
        if (data.currentIndex !== undefined) {
          setCurrentIndex(data.currentIndex);
        }
        if (data.directoryPath !== undefined) {
          setDirectoryPath(data.directoryPath);
        }
      }
    });

    return () => unsubscribe();
  }, []);

  // Signal that the viewer is ready to receive data
  useEffect(() => {
    if (window.electronAPI?.imageViewerReady) {
      window.electronAPI.imageViewerReady();
    }
  }, []);

  const handleClose = useCallback(() => {
    if (window.electronAPI?.imageViewerClose) {
      window.electronAPI.imageViewerClose();
    }
    window.close();
  }, []);

  // Self-contained navigation: advance the local index
  const handleNavigateNext = useCallback(() => {
    setCurrentIndex((idx) => Math.min(idx + 1, imageList.length - 1));
  }, [imageList.length]);

  const handleNavigatePrevious = useCallback(() => {
    setCurrentIndex((idx) => Math.max(idx - 1, 0));
  }, []);

  const handleImageDeleted = useCallback((imageId: string) => {
    if (window.electronAPI?.imageViewerAction) {
      window.electronAPI.imageViewerAction({
        type: "delete",
        imageId,
      });
    }
    // Remove the deleted image from the local list and keep index in range
    setImageList((prev) => {
      const deletedIdx = prev.findIndex((img) => img.id === imageId);
      if (deletedIdx === -1) return prev;
      const updated = prev.filter((img) => img.id !== imageId);
      // Adjust currentIndex after removal — done via a separate setState
      setCurrentIndex((ci) => {
        if (deletedIdx < ci) return ci - 1;
        return Math.min(ci, Math.max(0, updated.length - 1));
      });
      return updated;
    });
  }, []);

  const handleImageRenamed = useCallback(
    (imageId: string, newName: string) => {
      if (window.electronAPI?.imageViewerAction) {
        window.electronAPI.imageViewerAction({
          type: "rename",
          imageId,
          newName,
        });
      }
    },
    []
  );

  // Show loading state while waiting for image data
  if (!image) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-400">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-gray-600 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm">Loading image...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-gray-950">
      <ImageModal
        image={image}
        onClose={handleClose}
        onImageDeleted={handleImageDeleted}
        onImageRenamed={handleImageRenamed}
        currentIndex={currentIndex}
        totalImages={imageList.length}
        onNavigateNext={handleNavigateNext}
        onNavigatePrevious={handleNavigatePrevious}
        directoryPath={directoryPath}
        isIndexing={false}
        nextImage={nextImage}
        previousImage={previousImage}
      />
    </div>
  );
};

export default ImageModalWindow;
