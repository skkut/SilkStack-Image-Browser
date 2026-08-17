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

import { Keymap, StackGroupByDimension } from '../types';
import type { LicenseState, LicenseStatus } from '../services/licenseService';
import { getDefaultLicenseState } from '../services/licenseService';
import { AI_DEVICE_PREFERENCES, type AiDevicePreference } from '../services/gpuPreference';

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
  sortOrder: 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random' | 'relevance';
  scanSubfolders: boolean;
  imageSize: number; // For backward compatibility
  viewZoomLevels: {
    library: number;
    smart: number;
    model: number;
  };

  viewMode: 'grid' | 'list';
  keymap: Keymap;
  indexingConcurrency: number;
  disableThumbnails: boolean;
  globalAutoWatch: boolean;
  sensitiveTags: string[];
  blurSensitiveImages: boolean;
  enableSafeMode: boolean;
  displayStarredFirst: boolean;
  confirmOnDelete: boolean;
  disableAiFallback: boolean;
  aiDevicePreference: AiDevicePreference;
  /** The specific detected GPU the user picked in Settings (gpuDeviceKey,
   *  e.g. 'NVIDIA|GeForce RTX 3060'), or 'auto' when no specific card was
   *  chosen. The effective Chromium hint lives in aiDevicePreference (a GPU
   *  selection maps to its class — WebGPU cannot target an adapter by name). */
  aiDeviceTarget: string;
  /** User-selected semantic embedding model id (Settings → AI Intelligence); '' = module default. */
  aiEmbeddingModel: string;
  /** User-selected auto-tagging chat model id (Settings → AI Intelligence); '' = module default. */
  aiTagModel: string;

  // A1111 Integration settings
  a1111ServerUrl: string;
  a1111AutoStart: boolean;
  a1111LastConnectionStatus: 'unknown' | 'connected' | 'error';

  // ComfyUI Integration settings
  comfyUIServerUrl: string;
  comfyUILastConnectionStatus: 'unknown' | 'connected' | 'error';

  isSidebarCollapsed: boolean;
  isStackingEnabled: boolean;
  stackGroupByDimensions: StackGroupByDimension[];
  isSemanticSearchEnabled: boolean;
  semanticRerankEnabled: boolean;

  // License / Premium feature state
  licenseKey: string;
  licenseStatus: LicenseStatus;
  licenseEmail: string;
  licensePurchaseDate: string | null;
  licenseLastValidated: number;
  licenseStamp: string;

  // Actions
  setSortOrder: (order: 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random') => void;
  toggleScanSubfolders: () => void;
  setImageSize: (size: number) => void;
  setViewZoomLevel: (view: 'library' | 'smart' | 'model', size: number) => void;

  toggleViewMode: () => void;
  updateKeybinding: (scope: string, action: string, keybinding: string) => void;
  resetKeymap: () => void;
  setIndexingConcurrency: (value: number) => void;
  setDisableThumbnails: (value: boolean) => void;
  toggleGlobalAutoWatch: () => void;
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
  setDisableAiFallback: (value: boolean) => void;
  setAiDevicePreference: (value: AiDevicePreference) => void;
  setAiDeviceTarget: (value: string) => void;
  setAiEmbeddingModel: (value: string) => void;
  setAiTagModel: (value: string) => void;
  setSidebarCollapsed: (value: boolean) => void;
  setStackingEnabled: (enabled: boolean) => void;
  setStackGroupByDimensions: (dimensions: StackGroupByDimension[]) => void;
  setSemanticSearchEnabled: (enabled: boolean) => void;
  setSemanticRerankEnabled: (enabled: boolean) => void;
  setLicenseState: (state: Partial<LicenseState>) => void;
  clearLicense: () => void;
  resetState: () => void;
}

// Check if running in Electron.
// Guard against missing `window` — this module may be imported in a Web Worker
// context (e.g. by the auto-tagging worker via aiBridge → aiFeatureAccess),
// where `window` is undefined and `self` is the global scope.
const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

import { getDefaultKeymap } from '../services/hotkeyConfig';

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      // Initial state
      sortOrder: 'date-desc',
      scanSubfolders: true,
      imageSize: 320, // Default to maximum zoom
      viewZoomLevels: {
        library: 320,
        smart: 320,
        model: 320,
      },
    
      viewMode: 'grid',
      keymap: getDefaultKeymap(),
      indexingConcurrency: defaultIndexingConcurrency,
      disableThumbnails: false,
      globalAutoWatch: true,
      sensitiveTags: ['nsfw', 'private', 'hidden'],
      blurSensitiveImages: true,
      enableSafeMode: true,
      displayStarredFirst: false,
      confirmOnDelete: true,
      disableAiFallback: false,
      aiDevicePreference: 'auto',
      aiDeviceTarget: 'auto', // 'auto' = no specific detected GPU chosen
      aiEmbeddingModel: '', // '' = the module's default embedding model
      aiTagModel: '', // '' = the module's default auto-tag model

      // A1111 Integration initial state
      a1111ServerUrl: 'http://127.0.0.1:7860',
      a1111AutoStart: false,
      a1111LastConnectionStatus: 'unknown',

      // ComfyUI Integration initial state
      comfyUIServerUrl: 'http://127.0.0.1:8188',
      comfyUILastConnectionStatus: 'unknown',

      isSidebarCollapsed: true,
      isStackingEnabled: true,
      stackGroupByDimensions: ['prompt'],

      // Semantic search — premium, opt-in. Off until the user enables it
      // in Settings (requires a valid license + the ai-intelligence module).
      isSemanticSearchEnabled: false,
      semanticRerankEnabled: false,

      // License state — starts as "unchecked" until user enters a key
      ...getDefaultLicenseState(),

      // Actions
      setSortOrder: (order) => set({ sortOrder: order }),
      toggleScanSubfolders: () => set((state) => ({ scanSubfolders: !state.scanSubfolders })),
      setImageSize: (size) => set({ imageSize: size }),
      setViewZoomLevel: (view, size) => set((state) => ({
        viewZoomLevels: {
          ...state.viewZoomLevels,
          [view]: size,
        },
        // Also update legacy imageSize for now to keep global consistency if needed, 
        // though components will prefer viewZoomLevels
        imageSize: view === 'library' ? size : state.imageSize
      })),
    
      toggleViewMode: () => set((state) => ({ viewMode: state.viewMode === 'grid' ? 'list' : 'grid' })),
      setIndexingConcurrency: (value) =>
        set({
          indexingConcurrency: Number.isFinite(value)
            ? Math.max(1, Math.floor(value))
            : 1,
        }),
      setDisableThumbnails: (value) => set({ disableThumbnails: !!value }),
      toggleGlobalAutoWatch: () => set((state) => ({ globalAutoWatch: !state.globalAutoWatch })),
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
      setDisableAiFallback: (value) => set({ disableAiFallback: !!value }),
      setAiDevicePreference: (value) => set({ aiDevicePreference: value }),
      setAiDeviceTarget: (value) => set({ aiDeviceTarget: value }),
      setAiEmbeddingModel: (value) => set({ aiEmbeddingModel: value }),
      setAiTagModel: (value) => set({ aiTagModel: value }),
      setSidebarCollapsed: (value) => set({ isSidebarCollapsed: !!value }),
      setStackingEnabled: (enabled) => set({ isStackingEnabled: enabled }),
      setStackGroupByDimensions: (dimensions) => set({ stackGroupByDimensions: dimensions }),
      setSemanticSearchEnabled: (enabled) => set({ isSemanticSearchEnabled: enabled }),
      setSemanticRerankEnabled: (enabled) => set({ semanticRerankEnabled: enabled }),
      setLicenseState: (partial) => set(partial),
      clearLicense: () => set(getDefaultLicenseState()),
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
        sortOrder: 'date-desc',
        scanSubfolders: true,
        imageSize: 320,
        viewZoomLevels: {
          library: 320,
          smart: 320,
          model: 320,
        },
      
        viewMode: 'grid',
        keymap: getDefaultKeymap(),
        indexingConcurrency: defaultIndexingConcurrency,
        disableThumbnails: false,
        globalAutoWatch: true,
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
        disableAiFallback: false,
        aiDevicePreference: 'auto',
        aiDeviceTarget: 'auto',
        aiEmbeddingModel: '',
        aiTagModel: '',
        isSidebarCollapsed: true,
        isStackingEnabled: false,
        isSemanticSearchEnabled: false,
        semanticRerankEnabled: false,
        ...getDefaultLicenseState(),
      }),
    }),
    {
      name: 'image-metahub-settings',
      storage: createJSONStorage(() => isElectron ? electronStorage : localStorage),
      onRehydrateStorage: () => (state) => {



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

        if (state && typeof state.disableAiFallback !== 'boolean') {
          state.disableAiFallback = false;
        }

        if (state && !AI_DEVICE_PREFERENCES.includes(state.aiDevicePreference)) {
          // New pref (ships after users exist) — backfill anything unknown.
          state.aiDevicePreference = 'auto';
        }

        if (state && typeof state.isSidebarCollapsed !== 'boolean') {
          state.isSidebarCollapsed = true;
        }

        if (state && typeof state.isStackingEnabled !== 'boolean') {
          // Fall back to localStorage (synchronous backup), then default to true.
          // Stacking should be ON by default — it's the primary library view mode.
          try {
            const backup = localStorage.getItem('silkstack-stacking-enabled');
            state.isStackingEnabled = backup !== null ? backup === 'true' : true;
          } catch {
            state.isStackingEnabled = true;
          }
        }

        if (state && !Array.isArray(state.stackGroupByDimensions)) {
          state.stackGroupByDimensions = ['prompt'];
        }

        if (state && typeof state.isSemanticSearchEnabled !== 'boolean') {
          // Premium, opt-in feature — never default it on for existing users.
          state.isSemanticSearchEnabled = false;
        }

        if (state && typeof state.semanticRerankEnabled !== 'boolean') {
          state.semanticRerankEnabled = false;
        }

        // License state migration — ensure all fields exist
        if (state) {
          if (typeof state.licenseKey !== 'string') state.licenseKey = '';
          if (typeof state.licenseStatus !== 'string') state.licenseStatus = 'unchecked';
          if (typeof state.licenseEmail !== 'string') state.licenseEmail = '';
          if (state.licensePurchaseDate === undefined) state.licensePurchaseDate = null;
          if (typeof state.licenseLastValidated !== 'number') state.licenseLastValidated = 0;
          if (typeof state.licenseStamp !== 'string') state.licenseStamp = '';
        }
      },
    }
  )
);

/**
 * @deprecated Import from '../services/aiFeatureAccess' instead.
 * The authoritative stamp-validating check lives there.
 */
