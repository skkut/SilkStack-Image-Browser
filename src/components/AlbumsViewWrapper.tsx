import React, { useCallback, useMemo } from 'react';
import type { IndexedImage } from '../types';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { thumbnailManager } from '../services/thumbnailManager';
import { useAiFeaturesEnabled } from '../services/aiFeatureAccess';
import { useContextMenu } from '../hooks/useContextMenu';
import { compactOpenHint } from '../hooks/useImageSelection';
import { safeLazy } from '../utils/safeLazy';
import ImageContextMenu from './ImageContextMenu';

// Lazy-load the package's AlbumsView when AI features are available. The
// compile-time ternary lets Vite/Rolldown tree-shake the import() entirely
// when VITE_AI_FEATURES_AVAILABLE is false.
const AlbumsViewInner = import.meta.env.VITE_AI_FEATURES_AVAILABLE
  ? safeLazy(
      () => import('@ai-images-browser/ai-intelligence'),
      'AlbumsView',
      (mod) => (mod as any).AlbumsView,
    )
  : null;

/** Strip non-serializable handles before sending an image list to a child window. */
function serializeImage(image: IndexedImage): Record<string, unknown> {
  const serializable: Record<string, unknown> = { ...image };
  delete serializable.handle;
  delete serializable.thumbnailHandle;
  return serializable;
}

/**
 * Bridges the app's Zustand stores to the module's AlbumsView.
 *
 * The module owns albums end-to-end (storage + UI). The open tree supplies
 * only what it uniquely has:
 *  - the full library image list (NOT the filtered list — albums are curated
 *    collections and must not change when a sidebar filter does),
 *  - thumbnail generation (the file handles live here),
 *  - the image viewer, wired with the album's own order as the navigation
 *    list so prev/next never leave the album,
 *  - the shared right-click menu.
 */
const AlbumsViewWrapper: React.FC = () => {
  const aiFeaturesEnabled = useAiFeaturesEnabled();
  const images = useImageStore((state) => state.images);
  const directories = useImageStore((state) => state.directories);
  const isLoading = useImageStore((state) => state.isLoading);
  const indexingState = useImageStore((state) => state.indexingState);
  const setSelectedImage = useImageStore((state) => state.setSelectedImage);
  const selectSingleImage = useImageStore((state) => state.selectSingleImage);
  const setClusterNavigationContext = useImageStore(
    (state) => state.setClusterNavigationContext,
  );

  const alwaysShowFilenames = useSettingsStore((state) => state.alwaysShowFilenames);
  const thumbnailsDisabled = useSettingsStore((state) => state.disableThumbnails);
  const libraryImageSize = useSettingsStore((state) => state.viewZoomLevels.library);

  const {
    contextMenu,
    showContextMenu,
    copyPrompt,
    copyNegativePrompt,
    copySeed,
    copyImage,
    copyModel,
    copyPath,
    showInFolder,
    openWithNativeViewer,
    copyRawMetadata,
    openStackInNewWindow,
    selectAllInStack,
  } = useContextMenu();

  const handleRequestThumbnail = useCallback((imageId: string) => {
    const current = useImageStore.getState().images.find((image) => image.id === imageId);
    if (current) {
      void thumbnailManager.ensureThumbnail(current);
    }
  }, []);

  // The Add photos picker follows the library's connected-drive rule: a
  // detached folder contributes nothing. Existing album entries are left
  // alone by the module (see AlbumsView's prop docs).
  const unavailableDirectoryIds = useMemo(
    () =>
      new Set(
        directories
          .filter((directory) => directory.isConnected === false)
          .map((directory) => directory.id),
      ),
    [directories],
  );

  const handleImageClick = useCallback(
    (
      image: { id: string },
      _event: React.MouseEvent,
      sequence: Array<{ id: string }>,
    ) => {
      const store = useImageStore.getState();
      const byId = new Map(store.images.map((candidate) => [candidate.id, candidate]));
      const clicked = byId.get(image.id);
      if (!clicked) return;

      const ordered = sequence
        .map((candidate) => byId.get(candidate.id))
        .filter((candidate): candidate is IndexedImage => Boolean(candidate));
      const navigationList = ordered.length > 0 ? ordered : [clicked];
      const index = Math.max(
        0,
        navigationList.findIndex((candidate) => candidate.id === clicked.id),
      );

      // The modal (browser) and the viewer window's next/previous IPC both read
      // this context, so navigation stays inside the album.
      setClusterNavigationContext(navigationList);
      setSelectedImage(clicked);
      selectSingleImage(clicked.id);

      if (window.electronAPI?.openImageViewer) {
        const directoryPath =
          store.directories.find((directory) => directory.id === clicked.directoryId)?.path ??
          '';
        window.electronAPI
          .openImageViewer({
            imageId: clicked.id,
            directoryPath,
            currentIndex: index,
            totalImages: navigationList.length,
            imageList: navigationList.map(serializeImage),
            ...compactOpenHint(clicked),
          })
          .then((result) => {
            if (result?.success && result.windowId !== undefined) {
              window.dispatchEvent(
                new CustomEvent('viewer-window-opened', {
                  detail: { windowId: result.windowId },
                }),
              );
            }
          })
          .catch(() => {
            // Ignore errors from window opening.
          });
      }
    },
    [selectSingleImage, setClusterNavigationContext, setSelectedImage],
  );

  const handleContextMenu = useCallback(
    (image: { id: string }, event: React.MouseEvent) => {
      const store = useImageStore.getState();
      const concrete = store.images.find((candidate) => candidate.id === image.id);
      if (!concrete) return;
      const directoryPath = store.directories.find(
        (directory) => directory.id === concrete.directoryId,
      )?.path;
      showContextMenu(event, concrete, directoryPath);
    },
    [showContextMenu],
  );

  if (!aiFeaturesEnabled || !AlbumsViewInner) {
    return null;
  }

  const Inner = AlbumsViewInner;

  return (
    <>
      <Inner
        images={images as any}
        onImageClick={handleImageClick}
        onContextMenu={handleContextMenu}
        onRequestThumbnail={handleRequestThumbnail}
        thumbnailsDisabled={thumbnailsDisabled}
        alwaysShowFilenames={alwaysShowFilenames}
        imageSize={libraryImageSize}
        libraryLoading={isLoading || indexingState === 'indexing'}
        unavailableDirectoryIds={unavailableDirectoryIds}
      />

      <ImageContextMenu
        contextMenu={contextMenu}
        onCopyImage={copyImage}
        onCopyPrompt={copyPrompt}
        onCopyNegativePrompt={copyNegativePrompt}
        onCopySeed={copySeed}
        onCopyModel={copyModel}
        onCopyRawMetadata={copyRawMetadata}
        onCopyPath={copyPath}
        onOpenWithNativeViewer={openWithNativeViewer}
        onShowInFolder={showInFolder}
        onOpenStackInNewWindow={openStackInNewWindow}
        onSelectAllInStack={selectAllInStack}
      />
    </>
  );
};

export default AlbumsViewWrapper;
