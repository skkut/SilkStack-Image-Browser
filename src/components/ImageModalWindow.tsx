import React, { useEffect, useState, useCallback } from "react";
import { type IndexedImage } from "../types";
import ImageModal from "./ImageModal";

/**
 * ImageModalWindow - A wrapper component that renders ImageModal inside a child Electron window.
 * It communicates with the main window via IPC to receive image data and send actions.
 */
const ImageModalWindow: React.FC = () => {
  const [image, setImage] = useState<IndexedImage | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [totalImages, setTotalImages] = useState(0);
  const [directoryPath, setDirectoryPath] = useState("");
  const [nextImage, setNextImage] = useState<IndexedImage | null>(null);
  const [previousImage, setPreviousImage] = useState<IndexedImage | null>(null);

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

  // Listen for image data updates from main window
  useEffect(() => {
    if (!window.electronAPI?.onImageViewerUpdate) return;

    const unsubscribe = window.electronAPI.onImageViewerUpdate((data) => {
      if (data.image) {
        // Reconstruct the IndexedImage with a mock handle for Electron
        const reconstructedImage: IndexedImage = {
          ...data.image,
          handle: {
            name: data.image.name,
            kind: "file" as const,
          } as unknown as FileSystemFileHandle,
        };
        setImage(reconstructedImage);
        setCurrentIndex(data.currentIndex ?? 0);
        setTotalImages(data.totalImages ?? 0);
        setDirectoryPath(data.directoryPath ?? "");

        if (data.nextImage) {
          setNextImage({
            ...data.nextImage,
            handle: {
              name: data.nextImage.name,
              kind: "file" as const,
            } as unknown as FileSystemFileHandle,
          });
        } else {
          setNextImage(null);
        }

        if (data.previousImage) {
          setPreviousImage({
            ...data.previousImage,
            handle: {
              name: data.previousImage.name,
              kind: "file" as const,
            } as unknown as FileSystemFileHandle,
          });
        } else {
          setPreviousImage(null);
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

  const handleNavigateNext = useCallback(() => {
    if (window.electronAPI?.imageViewerNavigate) {
      window.electronAPI.imageViewerNavigate("next");
    }
  }, []);

  const handleNavigatePrevious = useCallback(() => {
    if (window.electronAPI?.imageViewerNavigate) {
      window.electronAPI.imageViewerNavigate("previous");
    }
  }, []);

  const handleImageDeleted = useCallback((imageId: string) => {
    if (window.electronAPI?.imageViewerAction) {
      window.electronAPI.imageViewerAction({
        type: "delete",
        imageId,
      });
    }
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
        totalImages={totalImages}
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
