import { useState, useEffect, useCallback } from 'react';
import { type IndexedImage } from '../types';
import { copyImageToClipboard, showInExplorer, copyFilePathToClipboard } from '../utils/imageUtils';
import { useSettingsStore } from '../store/useSettingsStore';

interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
  image?: IndexedImage;
  directoryPath?: string;
}

const showNotification = (message: string) => {
  const notification = document.createElement('div');
  notification.className = 'fixed top-4 right-4 bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg z-50';
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

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [contextMenu.visible, hideContextMenu]);


  const showContextMenu = (e: React.MouseEvent, image: IndexedImage, directoryPath?: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      visible: true,
      image,
      directoryPath
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
    const result = await copyImageToClipboard(contextMenu.image);
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

  const showInFolder = () => {
    if (!contextMenu.image || !contextMenu.directoryPath) {
      alert('Cannot determine file location: directory path is missing.');
      return;
    }
    hideContextMenu();
    showInExplorer(`${contextMenu.directoryPath}/${contextMenu.image.name}`);
  };



  const copyRawMetadata = () => {
    if (!contextMenu.image || !contextMenu.image.metadata) return;
    const metadataString = JSON.stringify(contextMenu.image.metadata, null, 2);
    copyToClipboardElectron(metadataString, 'Raw Metadata');
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
    showInFolder,
    copyRawMetadata
  };
};
