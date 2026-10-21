import { useState, useEffect, useCallback } from 'react';
import { type IndexedImage } from '../types';
import { copyImageToClipboard, showInExplorer, openInNativeViewer } from '../utils/imageUtils';
import { getImageAbsolutePath, quotePathForClipboard } from '../utils/pathUtils';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';
import { openStackInNewWindow, resolveStackForImage, canOpenStackWindow } from '../services/stackWindowService';

/**
 * One entry of the selection a surface had when its menu opened.
 *
 * The directory path is optional because most images resolve through their
 * file handle; it is what the popped-out stack window supplies from its
 * payload, since that window has no directory store to look one up in.
 */
export interface ContextMenuSelectionItem {
  image: IndexedImage;
  directoryPath?: string;
}

export interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
  image?: IndexedImage;
  directoryPath?: string;
  /**
   * The surface's multi-selection, snapshotted when the menu opened. Actions
   * that can act on several images (Copy Image Paths) read it; every other
   * action still targets `image` alone. Absent means the surface had nothing
   * selected beyond the right-clicked image.
   */
  selectedImages?: readonly ContextMenuSelectionItem[];
  /**
   * Whether the right-clicked image is part of a stack, and this build can pop
   * one out. Resolved once, when the menu opens — the menu itself is not
   * reactive, so a value computed at render time would go stale behind it.
   */
  canOpenStackInNewWindow?: boolean;
}

const showNotification = (message: string) => {
  const notification = document.createElement('div');
  notification.className = 'fixed top-[calc(var(--header-height,44px)+12px)] right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg z-50';
  notification.textContent = message;
  document.body.appendChild(notification);
  setTimeout(() => {
    if (document.body.contains(notification)) {
      document.body.removeChild(notification);
    }
  }, 2000);
};

export const useContextMenu = () => {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    x: 0,
    y: 0,
    visible: false
  });

  const hideContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (contextMenu.visible) {
        const target = event.target as HTMLElement;
        if (!target.closest('.context-menu-class')) {
          hideContextMenu();
        }
      }
    };

    // Close on Escape too. The handler is shared by every view that mounts
    // the hook, so it must only intercept the press while THIS menu is
    // actually visible — otherwise stopPropagation would swallow Escape for
    // window-level handlers (e.g. App's stack-view close) even when no menu
    // is open. Esc closes the menu first; a subsequent Esc (menu closed)
    // passes through and closes the stack.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (contextMenu.visible && event.key === 'Escape') {
        event.stopPropagation();
        hideContextMenu();
      }
    };

    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu.visible, hideContextMenu]);


  const showContextMenu = (
    e: React.MouseEvent,
    image: IndexedImage,
    directoryPath?: string,
    selectedImages?: readonly ContextMenuSelectionItem[],
  ) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      visible: true,
      image,
      directoryPath,
      selectedImages,
      // Read imperatively: this decides whether one menu item is rendered, and
      // subscribing to the whole image list for it would re-render every view
      // that mounts this hook on every indexing batch.
      canOpenStackInNewWindow: canOpenStackWindow()
        && !!resolveStackForImage(image, useImageStore.getState().images, useImageStore.getState().annotations),
    });
  };

  const copyToClipboardElectron = (text: string, label: string) => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        showNotification(`${label} copied to clipboard!`);
      }).catch(err => {
        console.error('Failed to copy to clipboard:', err);
        alert(`Failed to copy ${label} to clipboard`);
      });
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        showNotification(`${label} copied to clipboard!`);
      } catch (err) {
        console.error('Fallback copy failed:', err);
        alert(`Failed to copy ${label} to clipboard`);
      }
      document.body.removeChild(textArea);
    }
    hideContextMenu();
  };

  const copyPrompt = () => {
    const prompt = contextMenu.image?.prompt || (contextMenu.image?.metadata as any)?.prompt;
    if (!prompt) return;
    copyToClipboardElectron(prompt, 'Prompt');
  };

  const copyNegativePrompt = () => {
    const negativePrompt = contextMenu.image?.negativePrompt || (contextMenu.image?.metadata as any)?.negativePrompt;
    if (!negativePrompt) return;
    copyToClipboardElectron(negativePrompt, 'Negative Prompt');
  };

  const copySeed = () => {
    const seed = contextMenu.image?.seed || (contextMenu.image?.metadata as any)?.seed;
    if (!seed) return;
    copyToClipboardElectron(String(seed), 'Seed');
  };

  const copyImage = async () => {
    if (!contextMenu.image) return;
    hideContextMenu();
    const result = await copyImageToClipboard(contextMenu.image, contextMenu.directoryPath);
    if (result.success) {
      showNotification('Image copied to clipboard!');
    } else {
      alert(`Failed to copy image to clipboard: ${result.error}`);
    }
  };

  const copyModel = () => {
    const model = contextMenu.image?.models?.[0] || (contextMenu.image?.metadata as any)?.model;
    if (!model) return;
    copyToClipboardElectron(model, 'Model');
  };

  /**
   * Resolves this image's real path, or null when nothing usable is available.
   * Shared by every action that needs a location on disk, so Copy Image Path /
   * Show in Folder / Open in Native Viewer can never disagree about where the
   * file is.
   */
  const resolvePath = () =>
    getImageAbsolutePath(contextMenu.image, contextMenu.directoryPath) || null;

  /**
   * The images a path action should act on: the whole selection when the
   * right-clicked image is part of a multi-selection, otherwise just that
   * image. Right-clicking outside the selection must not act on files the
   * user did not point at — Windows Explorer resets the selection there for
   * the same reason; this menu cannot, so it narrows the action instead.
   */
  const pathTargets = (): readonly ContextMenuSelectionItem[] => {
    const target = contextMenu.image;
    if (!target) return [];
    const selection = contextMenu.selectedImages;
    if (selection && selection.length > 1 && selection.some((item) => item.image.id === target.id)) {
      return selection;
    }
    return [{ image: target, directoryPath: contextMenu.directoryPath }];
  };

  /**
   * Resolves one path-target to its absolute path. The directory the surface
   * handed over wins; otherwise the store's directory map is used, since a
   * handle-less image (a stack-window payload) cannot resolve on its own.
   */
  const resolveTargetPath = ({ image, directoryPath }: ContextMenuSelectionItem): string => {
    const directory = directoryPath
      ?? useImageStore.getState().directories.find((dir) => dir.id === image.directoryId)?.path;
    return getImageAbsolutePath(image, directory);
  };

  const copyPath = () => {
    const paths = pathTargets()
      .map(resolveTargetPath)
      .filter((path) => path.length > 0);

    if (paths.length === 0) {
      alert('Cannot determine file path: directory path is missing.');
      return;
    }

    // One quoted path per line, as Explorer's "Copy as path" does. Joined with
    // a bare newline — no commas or semicolons — so shells and scripts read it
    // as a plain path list.
    const label = paths.length > 1 ? `${paths.length} Image Paths` : 'Image Path';
    copyToClipboardElectron(paths.map(quotePathForClipboard).join('\n'), label);
  };

  const showInFolder = () => {
    const path = resolvePath();
    if (!path) {
      alert('Cannot determine file location: directory path is missing.');
      return;
    }
    hideContextMenu();
    showInExplorer(path);
  };

  const openWithNativeViewer = () => {
    const path = resolvePath();
    if (!path) {
      alert('Cannot determine file location: directory path is missing.');
      return;
    }
    hideContextMenu();
    openInNativeViewer(path);
  };


  const copyRawMetadata = () => {
    if (!contextMenu.image || !contextMenu.image.metadata) return;
    const metadataString = JSON.stringify(contextMenu.image.metadata, null, 2);
    copyToClipboardElectron(metadataString, 'Raw Metadata');
  };

  /**
   * Pop the right-clicked image's stack out into its own window.
   *
   * Membership is resolved from the live store at click time, not from the
   * flag that decided the item was visible — the two are the same instant in
   * practice, and resolving here means the window matches the stack as it
   * stands rather than as it stood when the menu opened.
   */
  const openStackInNewWindowFromMenu = () => {
    const image = contextMenu.image;
    if (!image) return;
    hideContextMenu();

    const store = useImageStore.getState();
    const stack = resolveStackForImage(image, store.images, store.annotations);
    if (stack) {
      void openStackInNewWindow(stack, store.directories);
    }
  };

  return {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    copyPrompt,
    copyNegativePrompt,
    copySeed,
    copyImage,
    copyModel,
    copyPath,
    showInFolder,
    openWithNativeViewer,
    copyRawMetadata,
    openStackInNewWindow: openStackInNewWindowFromMenu,
  };
};
