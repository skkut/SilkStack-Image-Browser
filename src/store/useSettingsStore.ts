import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';

// --- Electron IPC-based storage for Zustand ---
// This storage adapter will be used if the app is running in Electron.
const electronStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (window.electronAPI) {
      const settings = await window.electronAPI.getSettings();

      // If settings is empty (e.g., after cache reset), return null
      // This forces Zustand to use default values instead of merging with {}
      if (!settings || Object.keys(settings).length === 0) {
        console.log('📋 Settings file is empty or missing, using defaults');
        return null;
      }

      return JSON.stringify({ state: settings });
    }
    return null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (window.electronAPI) {
      const { state } = JSON.parse(value);
      await window.electronAPI.saveSettings(state);
    }
  },
  removeItem: async (name: string): Promise<void> => {
    // This would clear all settings, which is probably not what we want.
    // For now, it's a no-op.
    console.warn('Clearing all settings is not implemented.');
  },
};

import { Keymap } from '../types';

const detectDefaultIndexingConcurrency = (): number => {
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    const cores = navigator.hardwareConcurrency;
    if (Number.isFinite(cores) && cores > 0) {
      return Math.max(1, Math.min(16, Math.floor(cores)));
    }
  }
  return 8;
};

const defaultIndexingConcurrency = detectDefaultIndexingConcurrency();

// Define the state shape
interface SettingsState {
  // App settings
  sortOrder: 'asc' | 'desc';
  scanSubfolders: boolean;
  imageSize: number;

  viewMode: 'grid' | 'list';
  keymap: Keymap;
  indexingConcurrency: number;
  disableThumbnails: boolean;
  showFilenames: boolean;
  showFullFilePath: boolean;
  globalAutoWatch: boolean;
  doubleClickToOpen: boolean;
  sensitiveTags: string[];
  blurSensitiveImages: boolean;
  enableSafeMode: boolean;
  displayStarredFirst: boolean;
  confirmOnDelete: boolean;

  // A1111 Integration settings
  a1111ServerUrl: string;
  a1111AutoStart: boolean;
  a1111LastConnectionStatus: 'unknown' | 'connected' | 'error';

  // ComfyUI Integration settings
  comfyUIServerUrl: string;
  comfyUILastConnectionStatus: 'unknown' | 'connected' | 'error';

  // Actions
  setSortOrder: (order: 'asc' | 'desc') => void;
  toggleScanSubfolders: () => void;
  setImageSize: (size: number) => void;

  toggleViewMode: () => void;
  updateKeybinding: (scope: string, action: string, keybinding: string) => void;
  resetKeymap: () => void;
  setIndexingConcurrency: (value: number) => void;
  setDisableThumbnails: (value: boolean) => void;
  setShowFilenames: (value: boolean) => void;
  setShowFullFilePath: (value: boolean) => void;
  toggleGlobalAutoWatch: () => void;
  setDoubleClickToOpen: (value: boolean) => void;
  setSensitiveTags: (tags: string[]) => void;
  setBlurSensitiveImages: (value: boolean) => void;
  setEnableSafeMode: (value: boolean) => void;
  setDisplayStarredFirst: (value: boolean) => void;
  setA1111ServerUrl: (url: string) => void;
  toggleA1111AutoStart: () => void;
  setA1111ConnectionStatus: (status: 'unknown' | 'connected' | 'error') => void;
  setComfyUIServerUrl: (url: string) => void;
  setComfyUIConnectionStatus: (status: 'unknown' | 'connected' | 'error') => void;
  setConfirmOnDelete: (value: boolean) => void;
  resetState: () => void;
}

// Check if running in Electron
const isElectron = !!window.electronAPI;

import { getDefaultKeymap } from '../services/hotkeyConfig';

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      // Initial state
      sortOrder: 'desc',
      scanSubfolders: true,
      imageSize: 320, // Default to maximum zoom
    
      viewMode: 'grid',
      keymap: getDefaultKeymap(),
      indexingConcurrency: defaultIndexingConcurrency,
      disableThumbnails: false,
      showFilenames: false,
      showFullFilePath: false,
      globalAutoWatch: true,
      doubleClickToOpen: false,
      sensitiveTags: ['nsfw', 'private', 'hidden'],
      blurSensitiveImages: true,
      enableSafeMode: true,
      displayStarredFirst: false,
      confirmOnDelete: true,

      // A1111 Integration initial state
      a1111ServerUrl: 'http://127.0.0.1:7860',
      a1111AutoStart: false,
      a1111LastConnectionStatus: 'unknown',

      // ComfyUI Integration initial state
      comfyUIServerUrl: 'http://127.0.0.1:8188',
      comfyUILastConnectionStatus: 'unknown',

      // Actions
      setSortOrder: (order) => set({ sortOrder: order }),
      toggleScanSubfolders: () => set((state) => ({ scanSubfolders: !state.scanSubfolders })),
      setImageSize: (size) => set({ imageSize: size }),
    
      toggleViewMode: () => set((state) => ({ viewMode: state.viewMode === 'grid' ? 'list' : 'grid' })),
      setIndexingConcurrency: (value) =>
        set({
          indexingConcurrency: Number.isFinite(value)
            ? Math.max(1, Math.floor(value))
            : 1,
        }),
      setDisableThumbnails: (value) => set({ disableThumbnails: !!value }),
      setShowFilenames: (value) => set({ showFilenames: !!value }),
      setShowFullFilePath: (value) => set({ showFullFilePath: !!value }),
      toggleGlobalAutoWatch: () => set((state) => ({ globalAutoWatch: !state.globalAutoWatch })),
      setDoubleClickToOpen: (value) => set({ doubleClickToOpen: !!value }),
      setSensitiveTags: (tags) => {
        const normalized = (Array.isArray(tags) ? tags : [])
          .map(tag => (typeof tag === 'string' ? tag.trim().toLowerCase() : ''))
          .filter(Boolean);
        set({ sensitiveTags: normalized });
      },
      setBlurSensitiveImages: (value) => set({ blurSensitiveImages: !!value }),
      setEnableSafeMode: (value) => set({ enableSafeMode: !!value }),
      setDisplayStarredFirst: (value) => set({ displayStarredFirst: !!value }),
      setConfirmOnDelete: (value) => set({ confirmOnDelete: !!value }),
      updateKeybinding: (scope, action, keybinding) =>
        set((state) => ({
          keymap: {
            ...state.keymap,
            [scope]: {
              ...(state.keymap[scope] as object),
              [action]: keybinding,
            },
          },
        })),
      resetKeymap: () => set({ keymap: getDefaultKeymap() }),

      // A1111 Integration actions
      setA1111ServerUrl: (url) => set({ a1111ServerUrl: url }),
      toggleA1111AutoStart: () => set((state) => ({ a1111AutoStart: !state.a1111AutoStart })),
      setA1111ConnectionStatus: (status) => set({ a1111LastConnectionStatus: status }),

      // ComfyUI Integration actions
      setComfyUIServerUrl: (url) => set({ comfyUIServerUrl: url }),
      setComfyUIConnectionStatus: (status) => set({ comfyUILastConnectionStatus: status }),

      resetState: () => set({
        sortOrder: 'desc',
        scanSubfolders: true,
        imageSize: 320,
      
        viewMode: 'grid',
        keymap: getDefaultKeymap(),
        indexingConcurrency: defaultIndexingConcurrency,
        disableThumbnails: false,
        showFilenames: false,
        showFullFilePath: false,
        globalAutoWatch: true,
        doubleClickToOpen: false,
        sensitiveTags: ['nsfw', 'private', 'hidden'],
        blurSensitiveImages: true,
        enableSafeMode: true,
        displayStarredFirst: false,
        a1111ServerUrl: 'http://127.0.0.1:7860',
        a1111AutoStart: false,
        a1111LastConnectionStatus: 'unknown',
        comfyUIServerUrl: 'http://127.0.0.1:8188',
        comfyUILastConnectionStatus: 'unknown',
        confirmOnDelete: true,
      }),
    }),
    {
      name: 'image-metahub-settings',
      storage: createJSONStorage(() => isElectron ? electronStorage : localStorage),
      onRehydrateStorage: () => (state) => {

        if (state && typeof state.showFilenames !== 'boolean') {
          state.showFilenames = false;
        }

        if (state && typeof state.showFullFilePath !== 'boolean') {
          state.showFullFilePath = false;
        }

        if (state && !Array.isArray(state.sensitiveTags)) {
          state.sensitiveTags = ['nsfw', 'private', 'hidden'];
        }

        if (state && typeof state.blurSensitiveImages !== 'boolean') {
          state.blurSensitiveImages = true;
        }

        if (state && typeof state.enableSafeMode !== 'boolean') {
          state.enableSafeMode = true;
        }

        if (state && typeof state.displayStarredFirst !== 'boolean') {
          state.displayStarredFirst = false;
        }

        if (state && typeof state.confirmOnDelete !== 'boolean') {
          state.confirmOnDelete = true;
        }
      },
    }
  )
);
