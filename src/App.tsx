import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useImageStore } from './store/useImageStore';
import { useSettingsStore } from './store/useSettingsStore';
import { useImageLoader } from './hooks/useImageLoader';
import { useImageSelection } from './hooks/useImageSelection';
import { useHotkeys } from './hooks/useHotkeys';
import { useContextMenu } from './hooks/useContextMenu';
import { Directory, IndexedImage } from './types';
import { X, ArrowLeft, Copy, ExternalLink, Folder } from 'lucide-react';

import FolderSelector from './components/FolderSelector';
import ImageGrid from './components/ImageGrid';
import ImageModal from './components/ImageModal';
import Sidebar from './components/Sidebar';
import BrowserCompatibilityWarning from './components/BrowserCompatibilityWarning';

import Toast from './components/Toast';
import SettingsModal from './components/SettingsModal';

import Footer from './components/Footer';
import cacheManager from './services/cacheManager';
import DirectoryList from './components/DirectoryList';
import ImagePreviewSidebar from './components/ImagePreviewSidebar';
import CommandPalette from './components/CommandPalette';
import HotkeyHelp from './components/HotkeyHelp';
import Stacks from './components/SmartLibrary';
import { ModelView } from './components/ModelView';
import GridToolbar from './components/GridToolbar';
import TopMenuBar from './components/TopMenuBar';

import ImageTable from './components/ImageTable';
import SimilarityStackExpandedView from './components/SimilarityStackExpandedViewWrapper';

import { normalizePath } from './utils/pathUtils';
import { useAiFeaturesEnabled } from './services/aiFeatureAccess';
import { fetchMainProcessGpuInfo } from './services/mainProcessGpu';

export default function App() {
  // Runtime gate: AI features (Stacks view, smart stacking, auto-tag)
  // are visible only when the module exists AND premium is active.
  const aiFeaturesEnabled = useAiFeaturesEnabled();
  // --- Hooks ---
  const { 
    handleSelectFolder, 
    handleUpdateFolder, 
    handleLoadFromStorage, 
    handleRemoveDirectory, 
    loadDirectory, 
    processNewWatchedFiles, 
    processDeletedWatchedFiles 
  } = useImageLoader();
  const { handleImageSelection, handleDeleteSelectedImages, clearSelection } = useImageSelection();

  // --- Zustand Store State (Granular Selectors for Performance) ---
  // Data selectors
  const filteredImages = useImageStore((state) => state.filteredImages);
  const selectionTotalImages = useImageStore((state) => state.selectionTotalImages);
  const selectionDirectoryCount = useImageStore((state) => state.selectionDirectoryCount);
  const directories = useImageStore((state) => state.directories);
  const selectedImages = useImageStore((state) => state.selectedImages);
  const selectedImage = useImageStore((state) => state.selectedImage);
  const previewImage = useImageStore((state) => state.previewImage);
  const clustersCount = useImageStore((state) => state.clusters.length);

  // Right-click context menu — same hook + menu as the grid/table/stacks view.
  // Covers the library tab's stack drill-down (SimilarityStackExpandedView).
  const {
    contextMenu,
    showContextMenu,
    hideContextMenu,
    copyPrompt,
    copyNegativePrompt,
    copySeed,
    copyImage,
    copyModel,
    showInFolder,
    openWithNativeViewer,
    copyRawMetadata
  } = useContextMenu();

  const handleContextMenu = useCallback((image: IndexedImage, e: React.MouseEvent) => {
    const directoryPath = directories.find(d => d.id === image.directoryId)?.path;
    showContextMenu(e, image, directoryPath);
  }, [directories, showContextMenu]);

  // Loading & progress selectors
  const indexingState = useImageStore((state) => state.indexingState);
  const enrichmentProgress = useImageStore((state) => state.enrichmentProgress);
  const focusedImageIndex = useImageStore((state) => state.focusedImageIndex);

  // Status selectors
  const error = useImageStore((state) => state.error);
  const success = useImageStore((state) => state.success);

  // Filter state selectors
  const searchQuery = useImageStore((state) => state.searchQuery);
  const scanSubfolders = useImageStore((state) => state.scanSubfolders);
  const excludedFolders = useImageStore((state) => state.excludedFolders);
  const availableModels = useImageStore((state) => state.availableModels);
  const availableLoras = useImageStore((state) => state.availableLoras);
  const availableSchedulers = useImageStore((state) => state.availableSchedulers);
  const availableDimensions = useImageStore((state) => state.availableDimensions);
  const availableAspectRatios = useImageStore((state) => state.availableAspectRatios);
  const selectedModels = useImageStore((state) => state.selectedModels);
  const selectedLoras = useImageStore((state) => state.selectedLoras);
  const selectedSchedulers = useImageStore((state) => state.selectedSchedulers);
  const advancedFilters = useImageStore((state) => state.advancedFilters);

  // Folder selection selectors
  const selectedFolders = useImageStore((state) => state.selectedFolders);
  const isFolderSelectionLoaded = useImageStore((state) => state.isFolderSelectionLoaded);
  const includeSubfolders = useImageStore((state) => state.includeSubfolders);

  // Modal state selectors

  const setStackingEnabled = useImageStore((state) => state.setStackingEnabled);
  const undoAvailable = useImageStore((state) => state.undoAvailable);
  const libraryStackContext = useImageStore((state) => state.libraryStackContext);
  const setLibraryStackContext = useImageStore((state) => state.setLibraryStackContext);
  const isAnnotationsLoaded = useImageStore((state) => state.isAnnotationsLoaded);
  const refreshingDirectories = useImageStore((state) => state.refreshingDirectories);

  // Action selectors
  const addDirectory = useImageStore((state) => state.addDirectory);
  const setSearchQuery = useImageStore((state) => state.setSearchQuery);
  const setSelectedFilters = useImageStore((state) => state.setSelectedFilters);
  const setAdvancedFilters = useImageStore((state) => state.setAdvancedFilters);
  const setSelectedImage = useImageStore((state) => state.setSelectedImage);
  const setPreviewImage = useImageStore((state) => state.setPreviewImage);
  const removeImage = useImageStore((state) => state.removeImage);
  const updateImage = useImageStore((state) => state.updateImage);
  const toggleAutoWatch = useImageStore((state) => state.toggleAutoWatch);
  const toggleFolderSelection = useImageStore((state) => state.toggleFolderSelection);
  const clearFolderSelection = useImageStore((state) => state.clearFolderSelection);
  const isFolderSelected = useImageStore((state) => state.isFolderSelected);
  const toggleIncludeSubfolders = useImageStore((state) => state.toggleIncludeSubfolders);
  const resetState = useImageStore((state) => state.resetState);
  const setSuccess = useImageStore((state) => state.setSuccess);
  const setError = useImageStore((state) => state.setError);
  const handleNavigateNext = useImageStore((state) => state.handleNavigateNext);
  const handleNavigatePrevious = useImageStore((state) => state.handleNavigatePrevious);
  const clusterNavigationContext = useImageStore((state) => state.clusterNavigationContext);
  const setClusterNavigationContext = useImageStore((state) => state.setClusterNavigationContext);
  const cleanupInvalidImages = useImageStore((state) => state.cleanupInvalidImages);
  const activeView = useImageStore((state) => state.activeView);
  const setActiveView = useImageStore((state) => state.setActiveView);
  const isAutoTagging = useImageStore((state) => state.isAutoTagging);
  const startAutoTagging = useImageStore((state) => state.startAutoTagging);
  const cancelAutoTagging = useImageStore((state) => state.cancelAutoTagging);
  const autoTaggingProgress = useImageStore((state) => state.autoTaggingProgress);
  const cancelClustering = useImageStore((state) => state.cancelClustering);
  const cancelSemanticIndexing = useImageStore((state) => state.cancelSemanticIndexing);
  const clusteringProgress = useImageStore((state) => state.clusteringProgress);
  const similarityGroupProgress = useImageStore((state) => state.similarityGroupProgress);
  const toggleFavorite = useImageStore((state) => state.toggleFavorite);
  const addTagToImage = useImageStore((state) => state.addTagToImage);
  const removeTagFromImage = useImageStore((state) => state.removeTagFromImage);
  const isElectron = typeof window !== 'undefined' && !!window.electronAPI;


  const initializeFolderSelection = useImageStore((state) => state.initializeFolderSelection);
  const loadAnnotations = useImageStore((state) => state.loadAnnotations);
  const imageStoreSetSortOrder = useImageStore((state) => state.setSortOrder);
  const sortOrder = useImageStore((state) => state.sortOrder);
  const reshuffle = useImageStore((state) => state.reshuffle);
  const semanticMode = useImageStore((state) => state.semanticMode);
  const semanticHits = useImageStore((state) => state.semanticHits);
  // The "Relevance" sort option is only meaningful while semantic hits are
  // on screen (hits are score-ordered by default); hide it otherwise.
  const semanticActive = semanticMode === 'semantic' && (semanticHits?.length ?? 0) > 0;
  const updateDirectoryStatus = useImageStore((state) => state.updateDirectoryStatus);
  const restoreSmartLibraryCache = useImageStore((state) => state.restoreSmartLibraryCache);
  const processPostIndexingPipeline = useImageStore((state) => state.processPostIndexingPipeline);
  const handleStackImageDeletion = useImageStore((state) => state.handleStackImageDeletion);
  const mergeSelectedToStack = useImageStore((state) => state.mergeSelectedToStack);
  const unmergeSelectedFromStack = useImageStore((state) => state.unmergeSelectedFromStack);

  const safeFilteredImages = Array.isArray(filteredImages) ? filteredImages : [];
  const navigationImages = clusterNavigationContext && clusterNavigationContext.length > 0
    ? clusterNavigationContext
    : safeFilteredImages;
  const safeDirectories = Array.isArray(directories) ? directories : [];
  const safeSelectedImages = selectedImages instanceof Set ? selectedImages : new Set<string>();

  // --- Settings Store State ---
  const {
    viewMode,
    toggleViewMode,
    globalAutoWatch,
    isSidebarCollapsed,
    setSidebarCollapsed,
  } = useSettingsStore();

  // --- Local UI State ---
  const previousSearchQueryRef = useRef(searchQuery);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'folders' | 'hotkeys' | 'about'>('general');
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isHotkeyHelpOpen, setIsHotkeyHelpOpen] = useState(false);
  const [newImagesToast, setNewImagesToast] = useState<{ count: number; directoryName: string } | null>(null);

  // --- Hotkeys Hook ---
  const { commands } = useHotkeys({
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    isHotkeyHelpOpen,
    setIsHotkeyHelpOpen,
    isSettingsModalOpen,
    setIsSettingsModalOpen,
  });



  const handleOpenSettings = (tab: 'general' | 'folders' | 'hotkeys' | 'about' = 'general') => {
    setSettingsTab(tab);
    setIsSettingsModalOpen(true);
  };

  const handleManageFolders = () => {
    handleOpenSettings('folders');
  };

  const handleOpenHotkeySettings = () => {
    setIsHotkeyHelpOpen(false);
    handleOpenSettings('hotkeys');
  };

  useEffect(() => {
    if (!isFolderSelectionLoaded) {
      initializeFolderSelection();
    }
  }, [initializeFolderSelection, isFolderSelectionLoaded]);

  // Load annotations on app start
  useEffect(() => {
    if (!isAnnotationsLoaded) {
      loadAnnotations();
    }
  }, [loadAnnotations, isAnnotationsLoaded]);

  // Register console debug helpers
  useEffect(() => {
    if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) return;

    (window as any).resetStacking = async () => {
      const openReq = indexedDB.open('image-metahub-preferences', 7);
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        openReq.onsuccess = () => resolve(openReq.result);
        openReq.onerror = () => reject(openReq.error);
      });
      const tx = db.transaction('imageAnnotations', 'readwrite');
      const store = tx.objectStore('imageAnnotations');
      const all: any[] = await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      let count = 0;
      for (const ann of all) {
        if (ann.stackGroupId || ann.similarityGroupId || ann.isStackAnalyzed) {
          ann.stackGroupId = undefined;
          ann.similarityGroupId = undefined;
          ann.isStackAnalyzed = false;
          store.put(ann);
          count++;
        }
      }
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      localStorage.removeItem('similarityGroupVersion');
      console.log(`%cCleared stacking tags from ${count} images.%c Re-processing...`,
        'color: #4ade80; font-weight: bold', 'color: inherit');
      // Reload annotations from IndexedDB (now cleared)
      await useImageStore.getState().loadAnnotations();
      // Trigger full re-processing via unified pipeline:
      // stacking → similarity, running sequentially.
      await useImageStore.getState().processPostIndexingPipeline();
    };
  }, []);

  const primaryPath = safeDirectories.length > 0 ? safeDirectories[0].path : null;
  const hasImages = safeFilteredImages.length > 0;
  const images = useImageStore((state) => state.images);
  const totalImagesCount = images.length;

  useEffect(() => {
    // If total images exist but filtered is 0, and no filters are apparent, it's a folder selection issue
    if (totalImagesCount > 0 && safeFilteredImages.length === 0 && indexingState === 'idle') {
      console.warn('[App] Potential filtering issue detected: total images exist but none are filtered.');
    }
  }, [safeFilteredImages.length, totalImagesCount, safeDirectories.length, hasImages, indexingState]);

  // Restore auto-tags from cache after images are loaded.
  // Stack data is stored per-image in IndexedDB (via ImageAnnotations) and restored
  // automatically by loadAnnotations — no separate cache file needed.
  useEffect(() => {
    if (primaryPath && hasImages && indexingState !== 'indexing') {
      restoreSmartLibraryCache(primaryPath, scanSubfolders);
    }
  }, [primaryPath, hasImages, indexingState, scanSubfolders, restoreSmartLibraryCache]);

  // Unified post-indexing pipeline: when BOTH annotations are loaded AND
  // indexing is idle (either completed or never started), run the sequential
  // processing pipeline (stacking → similarity) for any images that need it.
  // Unlike the old one-shot indexingState transition, this check is
  // persistent — if annotations load after indexing, the pipeline fires
  // when both conditions are met.
  const pipelineStartedRef = useRef(false);
  useEffect(() => {
    if (isAnnotationsLoaded && indexingState === 'idle' && !pipelineStartedRef.current) {
      pipelineStartedRef.current = true;
      processPostIndexingPipeline();
    }
  }, [isAnnotationsLoaded, indexingState, processPostIndexingPipeline]);

  // --- Effects ---
  useEffect(() => {
    const applyTheme = (systemShouldUseDark: boolean) => {
      if (systemShouldUseDark) {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme', 'light');
      }
    };

    if (window.electronAPI) {
      window.electronAPI.getTheme().then(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });

      const unsubscribe = window.electronAPI.onThemeUpdated(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });

      return () => {
        if (unsubscribe) unsubscribe();
      };
    } else {
      // Fallback for browser
      applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
  }, []);

  // Report the ACTIVE GPU at startup (main-process source — no model load
  // needed). The worker's adapter.info report refreshes it after a load.
  useEffect(() => {
    if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) return;
    fetchMainProcessGpuInfo();
  }, []);

  // Dev tools: Ctrl+Y opens the dev-tools window (all testers switchable
  // via tabs; semantic search is the default tool)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key === 'y') {
        e.preventDefault();
        if (window.electronAPI) {
          window.electronAPI.openDevTools('semantic-search');
        } else {
          window.open(`${window.location.origin}/?devtools=semantic-search`, '_blank');
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // If premium is deactivated while inside a stack view (e.g. license
  // revoked or expired mid-session), exit the stack context and leave the
  // Stacks view so the user isn't stranded on a locked feature.
  useEffect(() => {
    if (aiFeaturesEnabled) return;
    const { libraryStackContext, activeView, setLibraryStackContext, setActiveView } =
      useImageStore.getState();
    if (libraryStackContext) setLibraryStackContext(null);
    if (activeView === 'smart') setActiveView('library');
  }, [aiFeaturesEnabled]);

  // Escape from stack view back to library
  useEffect(() => {
    if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't intercept if a modal, input, or textarea is focused
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.contentEditable === 'true') return;

      const { libraryStackContext, setStackingEnabled, setLibraryStackContext } = useImageStore.getState();
      if (libraryStackContext) {
        e.preventDefault();
        setStackingEnabled(true);
        setLibraryStackContext(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Ctrl+Z: Undo last merge
  useEffect(() => {
    if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) return;

    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.shiftKey || e.key !== 'z') return;

      // Don't intercept when the user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.contentEditable === 'true') return;

      // Don't intercept when a modal is open
      if (document.querySelector('[role="dialog"]')) return;

      e.preventDefault();
      useImageStore.getState().tryUndo();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Initialize the cache manager on startup
  useEffect(() => {
    const initializeCache = async () => {
      // Zustand persistence can be async, wait for it to rehydrate
      await useSettingsStore.persist.rehydrate();
      
      // Sync sort order from settings to store after rehydration
      const savedSortOrder = useSettingsStore.getState().sortOrder;
      if (savedSortOrder) {
        useImageStore.getState().setSortOrder(savedSortOrder);
      }

      await cacheManager.init();

      // Validate cached images have valid file handles (for hot reload scenarios in browser)
      // Note: In Electron, mock handles are created with proper getFile() implementation
      const isElectron = typeof window !== 'undefined' && window.electronAPI;
      const currentImages = useImageStore.getState().images;

      if (!isElectron && currentImages.length > 0) {
        const firstImage = currentImages[0];
        const fileHandle = firstImage.thumbnailHandle || firstImage.handle;
        if (!fileHandle || typeof fileHandle.getFile !== 'function') {
          console.warn('⚠️ Detected invalid file handles (likely after hot reload). Clearing state...');
          resetState();
        }
      } else if (currentImages.length > 0) {
        // Clean up any invalid images that might have been loaded
        cleanupInvalidImages();
      }
    };
    initializeCache().catch(console.error);
  }, []); // ✅ Run only once on mount

  // Handler for loading directory from a path
  const handleLoadFromPath = useCallback(async (path: string) => {
    try {

      // Check if directory already exists in the store
      const existingDir = safeDirectories.find(d => d.path === path);
      if (existingDir) {
        return;
      }

      // Create directory object for Electron environment
      const dirName = path.split(/[\\/]/).pop() || path;
      const mockHandle = {
        name: dirName,
        kind: 'directory' as const
      };

      const newDirectory: Directory = {
        id: path,
        name: dirName,
        path: path,
        handle: mockHandle as unknown as FileSystemDirectoryHandle,
        autoWatch: globalAutoWatch
      };

      // Add to store so it appears in sidebar and is persisted
      addDirectory(newDirectory);

      // Persist the state
      const updatedDirectories = useImageStore.getState().directories;
      if (window.electronAPI) {
        localStorage.setItem(
          "image-metahub-directories",
          JSON.stringify(updatedDirectories.map((d) => d.path)),
        );
      }

      // Load the directory using the hook's loadDirectory function
      await loadDirectory(newDirectory, false);

      // Start watcher if autoWatch is enabled
      if (window.electronAPI && globalAutoWatch) {
        try {
          const result = await window.electronAPI.startWatchingDirectory({
            directoryId: path,
            dirPath: path
          });
          if (!result.success) {
            console.error(`Failed to start auto-watch: ${result.error}`);
          }
        } catch (err) {
          console.error('Error starting auto-watch:', err);
        }
      }

    } catch (error) {
      console.error('Error loading directory from path:', error);
    }
  }, [loadDirectory, safeDirectories, globalAutoWatch, addDirectory]);

  // ── Reprocess Images (Settings → Cache Management) ─────────────────────
  // Wipes all derived image data (caches, thumbnails, semantic vectors,
  // auto-tags, stack/similarity groups) keeping user data + folders + license,
  // re-scans every folder from scratch, and lets the post-indexing pipeline
  // rebuild stacks/similarity/semantic index — then runs auto-tag BEFORE the
  // final semantic index so search embeds the fresh tags and synonyms.
  const [reprocessing, setReprocessing] = useState(false);

  // Sustained-idle poll: the pipeline runs fire-and-forget (phaseB.then) with
  // a 500ms queued re-run gap, and finalizeDirectoryLoad lingers ~100ms — so
  // require 3 consecutive idle polls (~1s) before reporting quiescence.
  const waitForReprocessIdle = useCallback(async (timeoutMs = 30 * 60 * 1000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let idleStreak = 0;
    while (Date.now() < deadline) {
      const s = useImageStore.getState();
      const busy = s.indexingState === 'indexing'
        || s.enrichmentProgress !== null
        || s.pipelinePhase !== null
        || s.semanticIndexProgress !== null
        || s.isAutoTagging
        || s.refreshingDirectories.size > 0;
      if (!busy) {
        idleStreak += 1;
        if (idleStreak >= 3) return true;
      } else {
        idleStreak = 0;
      }
      await new Promise(r => setTimeout(r, 350));
    }
    return false;
  }, []);

  const handleReprocessImages = useCallback(async () => {
    const dirs = useImageStore.getState().directories;
    if (dirs.length === 0) {
      alert('No library folders loaded — add a folder first.');
      return;
    }

    // 1. Silence watchers BEFORE the wipe — an onNewImagesDetected event
    //    mid-reload would appendToCache (resurrecting cache chunks) and fire
    //    the pipeline against half-cleared state.
    if (window.electronAPI) {
      for (const dir of dirs) {
        if (dir.autoWatch) {
          await window.electronAPI.stopWatchingDirectory({ directoryId: dir.id }).catch(() => {});
        }
      }
    }

    setReprocessing(true);
    try {
      // 2. Wipe all derived data (throws if a scan/pipeline/semantic run is
      //    in flight; the Settings button is also disabled while busy).
      await useImageStore.getState().clearDerivedImageData();

      // 3. Suppress the startup pipeline effect (above) — it must not
      //    double-fire if this happens before its first run.
      pipelineStartedRef.current = true;

      // 4. Full reload of every folder, sequentially. Caches are gone, so
      //    validateCacheAndGetDiff reports everything as new → full
      //    re-catalog + re-enrichment. loadDirectory resolves after Phase A;
      //    Phase B enrichment and the pipeline auto-fire in the background
      //    (useImageLoader's phaseB.then). NEVER call the pipeline here:
      //    stacking un-enriched stubs would permanently poison stack
      //    membership (isStackAnalyzed with no stackGroupId = "intentional
      //    unmerge", skipped forever by computeSimilarityGroups).
      for (const dir of dirs) {
        await loadDirectory(dir, true, undefined, true);
      }

      // 5. Wait for enrichment + the automatic pipeline (stacking →
      //    similarity → semantic Δ; the wiped vector store makes the Δ a
      //    full re-embed).
      const pipelineSettled = await waitForReprocessIdle();

      // 6. Auto-tag BEFORE the final semantic index — the index text embeds
      //    auto-tags + English synonyms, so search becomes more accurate.
      //    Every image is eligible again (searchTagVersion was cleared); the
      //    worker's 'complete' handler persists tags and fires the Δ
      //    re-index. A missing ai-intelligence module makes this a no-op.
      if (primaryPath) {
        await startAutoTagging(primaryPath, scanSubfolders);
        await waitForReprocessIdle(); // auto-tag run + its trailing re-index
      }

      setSuccess(
        pipelineSettled
          ? 'Library reprocessed: caches rebuilt, stacking/similarity/semantic index refreshed.'
          : 'Library reprocessed — post-indexing steps are still finishing in the background.'
      );
    } catch (error) {
      console.error('Reprocess failed:', error);
      alert(`❌ Reprocess failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // 7. Restore watchers regardless of outcome.
      if (window.electronAPI) {
        for (const dir of useImageStore.getState().directories) {
          if (dir.autoWatch) {
            await window.electronAPI.startWatchingDirectory({ directoryId: dir.id, dirPath: dir.path }).catch(() => {});
          }
        }
      }
      setReprocessing(false);
    }
  }, [loadDirectory, waitForReprocessIdle, primaryPath, scanSubfolders, startAutoTagging, setSuccess]);

  // On mount, load directories stored in localStorage
  useEffect(() => {
    // Only run once on mount
    handleLoadFromStorage();
  }, []);

  // Listen for directory load events from the main process (e.g., from CLI argument)
  useEffect(() => {
    if (window.electronAPI && typeof window.electronAPI.onLoadDirectoryFromCLI === 'function') {
      const unsubscribe = window.electronAPI.onLoadDirectoryFromCLI((path: string) => {
        if (path) {
          handleLoadFromPath(path);
        }
      });

      // Cleanup the listener when the component unmounts
      return unsubscribe;
    }
  }, [handleLoadFromPath]);

  // Listen for new images from file watcher
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onNewImagesDetected(async (data) => {
      const { directoryId, files } = data;
      const normalizedId = normalizePath(directoryId);
      const directory = directories.find(d => normalizePath(d.id) === normalizedId);

      if (!directory || !files || files.length === 0) return;

      // Show toast notification
      setNewImagesToast({ count: files.length, directoryName: directory.name });

      // Processar novos arquivos usando a função do useImageLoader
      await processNewWatchedFiles(directory, files);

      // Run unified post-indexing pipeline (stacking → similarity)
      useImageStore.getState().processPostIndexingPipeline();
    });

    return () => unsubscribe();
  }, [directories, processNewWatchedFiles, sortOrder]);

  // Listen for deleted images from file watcher
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onImagesDeleted(async (data) => {
      const { directoryId, paths } = data;
      const normalizedId = normalizePath(directoryId);
      const directory = directories.find(d => normalizePath(d.id) === normalizedId);

      if (!directory || !paths || !directory) return;

      // Process deleted files using the function from useImageLoader
      await processDeletedWatchedFiles(directory, paths);

      // Clean up deleted images from persistent library stacks
      const deletedImageIds = paths.map(filePath => {
        const normalizedFilePath = normalizePath(filePath);
        const normalizedRootPath = normalizePath(directory.path);
        let relativePath = normalizedFilePath;
        if (normalizedRootPath && normalizedFilePath !== normalizedRootPath) {
          const prefix = `${normalizedRootPath}/`;
          if (normalizedFilePath.startsWith(prefix)) {
            relativePath = normalizedFilePath.slice(prefix.length);
          }
        }
        const fileName = filePath.split(/[\\/]/).pop() || filePath;
        return `${directory.id}::${relativePath || fileName}`;
      });
      useImageStore.getState().handleStackImageDeletion(deletedImageIds);
    });

    return () => unsubscribe();
  }, [directories, processDeletedWatchedFiles]);

  // Watcher debug listener — disabled by default.
  // Uncomment for troubleshooting file-watch issues.
  // useEffect(() => {
  //   if (!window.electronAPI?.onWatcherDebug) return;
  //   const unsubscribe = window.electronAPI.onWatcherDebug(({ message }) => {
  //     console.log('[WATCHER-DEBUG]', message);
  //   });
  //   return () => { unsubscribe(); };
  // }, []);

  // Restore auto-watchers on app start
  useEffect(() => {
    if (!window.electronAPI || directories.length === 0) return;

    const restoreWatchers = async () => {
      console.log('[App] Restoring watchers for directories:', directories.map(d => ({ id: d.id, name: d.name, autoWatch: d.autoWatch })));
      for (const dir of directories) {
        if (dir.autoWatch) {
          try {
            console.log(`[App] Starting watcher for ${dir.name} (${dir.path})`);
            const result = await window.electronAPI.startWatchingDirectory({
              directoryId: dir.id,
              dirPath: dir.path
            });
            console.log(`[App] Watcher start result for ${dir.name}:`, result);
          } catch (err) {
            console.error(`Failed to restore watcher for ${dir.path}:`, err);
          }
        } else {
          console.log(`[App] Skipping watcher for ${dir.name} (autoWatch: ${dir.autoWatch})`);
        }
      }
    };

    // Delay para garantir que todas as pastas foram carregadas
    const timeoutId = setTimeout(restoreWatchers, 1000);

    return () => clearTimeout(timeoutId);
  }, [directories]);

  // Sync all directories with globalAutoWatch setting when it changes
  useEffect(() => {
    if (!window.electronAPI || directories.length === 0) return;

    const syncAutoWatch = async () => {
      console.log(`[App] Syncing all directories to globalAutoWatch: ${globalAutoWatch}`);
      for (const dir of directories) {
        // Update directory autoWatch state if it differs from global
        if (dir.autoWatch !== globalAutoWatch) {
          console.log(`[App] Updating ${dir.name} autoWatch from ${dir.autoWatch} to ${globalAutoWatch}`);
          toggleAutoWatch(dir.id);

          // Start or stop watcher based on new state
          try {
            if (globalAutoWatch) {
              const result = await window.electronAPI.startWatchingDirectory({
                directoryId: dir.id,
                dirPath: dir.path
              });
              console.log(`[App] Started watcher for ${dir.name}:`, result);
            } else {
              await window.electronAPI.stopWatchingDirectory({
                directoryId: dir.id
              });
              console.log(`[App] Stopped watcher for ${dir.name}`);
            }
          } catch (err) {
            console.error(`Failed to sync watcher for ${dir.path}:`, err);
          }
        }
      }
    };

    syncAutoWatch();
  }, [globalAutoWatch]);

  // Auto-dismiss new images toast after 5 seconds
  useEffect(() => {
    if (newImagesToast) {
      const timer = setTimeout(() => {
        setNewImagesToast(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [newImagesToast]);

  // Listen for menu events
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribeAddFolder = window.electronAPI.onMenuAddFolder(() => {
      handleSelectFolder();
    });

    const unsubscribeOpenSettings = window.electronAPI.onMenuOpenSettings(() => {
      handleOpenSettings('general');
    });

    const unsubscribeOpenAbout = window.electronAPI.onMenuOpenAbout(() => {
      handleOpenSettings('about');
    });

    const unsubscribeToggleView = window.electronAPI.onMenuToggleView(() => {
      toggleViewMode();
    });

    return () => {
      unsubscribeAddFolder();
      unsubscribeOpenSettings();
      unsubscribeOpenAbout();
      unsubscribeToggleView();
    };
  }, [handleSelectFolder, toggleViewMode]);

  useEffect(() => {
    if (previousSearchQueryRef.current !== searchQuery) {
      previousSearchQueryRef.current = searchQuery;
    }
  }, [searchQuery]);


  // Clean up selectedImage if its directory no longer exists
  useEffect(() => {
    if (selectedImage && !safeDirectories.find(d => d.id === selectedImage.directoryId)) {
      console.warn('Selected image directory no longer exists, clearing selection');
      setSelectedImage(null);
    }
  }, [selectedImage, safeDirectories, setSelectedImage]);

  // Poll for directory connection status (for removable storage)
  useEffect(() => {
    if (!window.electronAPI) return;

    const checkConnections = async () => {
        const { directories, updateDirectoryStatus } = useImageStore.getState();
        
        for (const dir of directories) {
            try {
                const result = await window.electronAPI.checkDirectoryConnection(dir.path);
                
                // Only update if status changed (handled by store action to avoid redundant re-renders)
                if (dir.isConnected !== result.isConnected) {
                    updateDirectoryStatus(dir.id, result.isConnected);
                }
            } catch (e) {
                console.warn(`Failed to poll connection for ${dir.path}`, e);
            }
        }
    };

    // Check every 5 seconds
    const intervalId = setInterval(checkConnections, 5000);
    
    // Also run immediately on mount/change
    checkConnections();

    return () => clearInterval(intervalId);
  }, [directories.length]); // Re-setup when directory count changes (added/removed)


  // --- Memoized Callbacks for UI ---
  const handleImageDeleted = useCallback((imageId: string) => {
    removeImage(imageId);
    // Only close modal if the deleted image is still the one currently selected
    // (This allows ImageModal to navigate to next image BEFORE deletion without App closing it)
    if (useImageStore.getState().selectedImage?.id === imageId) {
      setSelectedImage(null);
    }
  }, [removeImage, setSelectedImage]);

  const handleImageRenamed = useCallback((imageId: string, newName: string) => {
    updateImage(imageId, newName);
    setSelectedImage(null);
  }, [updateImage, setSelectedImage]);

  const getCurrentImageIndex = useCallback(() => {
    if (!selectedImage) return 0;
    return navigationImages.findIndex(img => img.id === selectedImage.id);
  }, [selectedImage, navigationImages]);

  // Memoize ImageModal callbacks to prevent unnecessary re-renders during Phase B
  const handleCloseImageModal = useCallback(() => {
    setClusterNavigationContext(null);
    setSelectedImage(null);
  }, [setSelectedImage, setClusterNavigationContext]);

  const handleImageModalNavigateNext = useCallback(() => {
    handleNavigateNext();
  }, [handleNavigateNext]);

  const handleImageModalNavigatePrevious = useCallback(() => {
    handleNavigatePrevious();
  }, [handleNavigatePrevious]);

  // --- Image Viewer Window IPC ---
  // Helper to serialize an IndexedImage for IPC (strip non-serializable fields)
  const serializeImage = useCallback((img: any) => {
    if (!img) return null;
    const { handle, thumbnailHandle, ...serializable } = img;
    return serializable;
  }, []);

  // Track how many viewer windows are currently open
  const openViewerWindowIds = React.useRef<Set<number>>(new Set());

  // Send image data to a specific viewer window (used for fallback / action-triggered updates)
  const sendImageToViewer = useCallback((direction: 'current' | 'next' | 'previous', windowId?: number) => {
    const state = useImageStore.getState();
    const currentSelected = state.selectedImage;
    if (!currentSelected) return;

    const imagesToNavigate = state.clusterNavigationContext || state.filteredImages;
    let currentIdx = imagesToNavigate.findIndex(img => img.id === currentSelected.id);

    if (direction === 'next' && currentIdx < imagesToNavigate.length - 1) {
      handleNavigateNext();
      currentIdx += 1;
    } else if (direction === 'previous' && currentIdx > 0) {
      handleNavigatePrevious();
      currentIdx -= 1;
    }

    // Re-read after navigation
    const updatedState = useImageStore.getState();
    const updatedImageList = updatedState.clusterNavigationContext || updatedState.filteredImages;
    const updatedSelected = updatedState.selectedImage;
    if (!updatedSelected) return;

    const updatedIdx = updatedImageList.findIndex(img => img.id === updatedSelected.id);
    const dirPath = safeDirectories.find(d => d.id === updatedSelected.directoryId)?.path || '';

    const nextImg = updatedIdx < updatedImageList.length - 1 ? updatedImageList[updatedIdx + 1] : null;
    const prevImg = updatedIdx > 0 ? updatedImageList[updatedIdx - 1] : null;

    window.electronAPI?.sendImageViewerUpdate({
      windowId,
      image: serializeImage(updatedSelected),
      currentIndex: updatedIdx,
      totalImages: updatedImageList.length,
      directoryPath: dirPath,
      nextImage: serializeImage(nextImg),
      previousImage: serializeImage(prevImg),
    });
  }, [safeDirectories, handleNavigateNext, handleNavigatePrevious, serializeImage]);

  // Listen for navigation requests from viewer window
  // (Viewers navigate locally, so this is mainly for keeping the grid selection in sync)
  useEffect(() => {
    if (!window.electronAPI?.onImageViewerNavigate) return;

    const unsubscribe = window.electronAPI.onImageViewerNavigate((payload) => {
      const direction = typeof payload === 'string' ? payload : payload.direction;
      sendImageToViewer(direction as 'current' | 'next' | 'previous', typeof payload === 'object' ? payload.windowId : undefined);
    });

    return () => unsubscribe();
  }, [sendImageToViewer]);

  // Listen for actions from viewer window
  useEffect(() => {
    if (!window.electronAPI?.onImageViewerAction) return;

    const unsubscribe = window.electronAPI.onImageViewerAction(async (action: any) => {
      let updatedImageId = action.imageId;

      switch (action.type) {
        case 'delete':
          handleImageDeleted(action.imageId);
          updatedImageId = null;
          break;
        case 'rename':
          if (action.newName) {
            updateImage(action.imageId, action.newName);
          }
          break;
        case 'toggleFavorite':
          await toggleFavorite(action.imageId);
          break;
        case 'addTag':
          if (action.tag) {
            await addTagToImage(action.imageId, action.tag);
          }
          break;
        case 'removeTag':
          if (action.tag) {
            await removeTagFromImage(action.imageId, action.tag);
          }
          break;
      }

      // If the image was updated (not deleted), broadcast the new state back to viewers
      if (updatedImageId && window.electronAPI?.sendImageViewerUpdate) {
        const updatedImage = useImageStore.getState().images.find(img => img.id === updatedImageId);
        if (updatedImage) {
          window.electronAPI.sendImageViewerUpdate({
            windowId: action.windowId,
            image: serializeImage(updatedImage)
          });
        }
      }
    });

    return () => unsubscribe();
  }, [handleImageDeleted, handleImageRenamed, toggleFavorite, addTagToImage, removeTagFromImage, updateImage, sendImageToViewer]);

  // Listen for viewer window closed — only reset selectedImage when all viewer windows are gone
  useEffect(() => {
    if (!window.electronAPI?.onImageViewerClosed) return;

    const unsubscribe = window.electronAPI.onImageViewerClosed((payload) => {
      const windowId = payload?.windowId;
      if (windowId !== undefined) {
        openViewerWindowIds.current.delete(windowId);
      }
      // Clear selection only when no viewer windows remain
      if (openViewerWindowIds.current.size === 0) {
        setClusterNavigationContext(null);
        setSelectedImage(null);
      }
    });

    return () => unsubscribe();
  }, [setSelectedImage, setClusterNavigationContext]);

  // Track newly opened viewer windows via a custom DOM event dispatched by useImageSelection
  useEffect(() => {
    const handler = (e: Event) => {
      const windowId = (e as CustomEvent<{ windowId: number }>).detail?.windowId;
      if (windowId !== undefined) {
        openViewerWindowIds.current.add(windowId);
      }
    };
    window.addEventListener('viewer-window-opened', handler);
    return () => window.removeEventListener('viewer-window-opened', handler);
  }, []);

  // --- Render Logic ---
  const hasDirectories = safeDirectories.length > 0;
  const directoryPath = selectedImage ? safeDirectories.find(d => d.id === selectedImage.directoryId)?.path : undefined;

  const handleAutoTag = useCallback(() => {
    if (!primaryPath) return;
    startAutoTagging(primaryPath, scanSubfolders);
  }, [primaryPath, scanSubfolders, startAutoTagging]);

  const layoutOffset = hasDirectories 
    ? (isSidebarCollapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)') 
    : '0px';

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-900 text-gray-100 font-sans selection:bg-blue-500/30">
      <BrowserCompatibilityWarning />
      
      {/* Spacer for fixed TopMenuBar */}
      <div className="shrink-0 w-full" style={{ height: 'var(--header-height, 44px)' }} />

      <div className="flex flex-1 overflow-hidden relative">
        {hasDirectories && (
          <Sidebar
            isCollapsed={isSidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!isSidebarCollapsed)}
            availableModels={availableModels}
            availableLoras={availableLoras}
            availableSchedulers={availableSchedulers}
            selectedModels={selectedModels}
            selectedLoras={selectedLoras}
            selectedSchedulers={selectedSchedulers}
            onModelChange={(models) => setSelectedFilters({ models })}
            onLoraChange={(loras) => setSelectedFilters({ loras })}
            onSchedulerChange={(schedulers) => setSelectedFilters({ schedulers })}
            onClearAllFilters={() => {
              setSelectedFilters({ models: [], loras: [], schedulers: [] });
              setAdvancedFilters({});
            }}
            advancedFilters={advancedFilters}
            onAdvancedFiltersChange={setAdvancedFilters}
            onClearAdvancedFilters={() => setAdvancedFilters({})}
            availableDimensions={availableDimensions}
            availableAspectRatios={availableAspectRatios}
            isIndexing={indexingState === 'indexing' || indexingState === 'completed'}
            scanSubfolders={scanSubfolders}
            excludedFolders={excludedFolders}
            onManageFolders={handleManageFolders}
            sortOrder={sortOrder}
            onSortOrderChange={imageStoreSetSortOrder}
            onReshuffle={reshuffle}
            semanticActive={semanticActive}
          >
            <DirectoryList
              directories={safeDirectories}
              onRemoveDirectory={handleRemoveDirectory}
              onUpdateDirectory={handleUpdateFolder}
              refreshingDirectories={refreshingDirectories}
              onToggleFolderSelection={toggleFolderSelection}
              onClearFolderSelection={clearFolderSelection}
              isFolderSelected={isFolderSelected}
              selectedFolders={selectedFolders}
              includeSubfolders={includeSubfolders}
              onToggleIncludeSubfolders={toggleIncludeSubfolders}
              isIndexing={indexingState === 'indexing' || indexingState === 'paused' || indexingState === 'completed'}
              scanSubfolders={scanSubfolders}
            />
          </Sidebar>
        )}
        
        <ImagePreviewSidebar />

        <div className={`flex-1 flex flex-col transition-[margin,width] duration-300 ease-in-out overflow-hidden ${previewImage ? 'mr-96' : 'mr-0'}`}
             style={{ marginLeft: layoutOffset }}>
          <main className="flex-1 overflow-hidden relative flex flex-col">
            {/* Back from Stack Button — now handled inside SimilarityStackExpandedView */}
            {/* (libraryStackContext drill-down renders its own back bar) */}

            <div className="flex-1 overflow-y-auto min-h-0 bg-gray-900/40 scrollbar-adaptive">
              {error && (
                <div className="mx-6 bg-red-900/50 text-red-300 p-3 rounded-lg my-4 flex items-center justify-between font-medium">
                  <span>{error}</span>
                  <button
                    onClick={() => setError(null)}
                    className="ml-4 p-1 hover:bg-red-800/50 rounded transition-colors"
                    title="Dismiss message"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              
              {success && (
                <Toast
                  message={success}
                  onDismiss={() => setSuccess(null)}
                />
              )}

              {newImagesToast && (
                <div className="fixed bottom-4 right-4 z-50 animate-slide-in-right">
                  <div className="bg-blue-900/90 backdrop-blur-sm text-blue-100 px-4 py-3 rounded-lg shadow-lg flex items-center gap-3 min-w-[300px] max-w-[500px] border border-blue-700/50">
                    <div className="flex items-center gap-2 flex-1">
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse"></div>
                      <span className="text-sm">
                        <span className="font-semibold">{newImagesToast.count}</span> new image{newImagesToast.count !== 1 ? 's' : ''} detected in <span className="font-semibold">{newImagesToast.directoryName}</span>
                      </span>
                    </div>
                    <button
                      onClick={() => setNewImagesToast(null)}
                      className="p-1 hover:bg-blue-800/50 rounded transition-colors flex-shrink-0"
                      title="Dismiss"
                      aria-label="Dismiss notification"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              )}

              {!hasDirectories ? (
                <div className="h-full px-6 flex items-center justify-center">
                  <FolderSelector onSelectFolder={handleSelectFolder} />
                </div>
              ) : (
                <div className="h-full">
                  {activeView === 'smart' ? (
                    aiFeaturesEnabled ? <Stacks /> : null
                  ) : activeView === 'model' ? (
                    <ModelView 
                      onModelSelect={(modelName) => {
                        setSelectedFilters({ models: [modelName] });
                        setActiveView('library');
                      }}
                    />
                  ) : (
                    <div className="h-full">
                      {aiFeaturesEnabled && libraryStackContext ? (
                        <SimilarityStackExpandedView
                          images={safeFilteredImages}
                          subGroups={libraryStackContext.subGroups || []}
                          onImageClick={handleImageSelection}
                          selectedImages={safeSelectedImages}
                          onBack={() => {
                            setStackingEnabled(true);
                            setLibraryStackContext(null);
                          }}
                          onContextMenu={handleContextMenu}
                        />
                      ) : viewMode === 'grid' ? (
                        <ImageGrid
                          images={safeFilteredImages}
                          onImageClick={handleImageSelection}
                          selectedImages={safeSelectedImages}
                        />
                      ) : (
                        <ImageTable
                          images={safeFilteredImages}
                          onImageClick={handleImageSelection}
                          selectedImages={safeSelectedImages}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </main>
          
          {activeView === 'library' && (
            <Footer
              viewMode={viewMode}
              onViewModeChange={toggleViewMode}
              filteredCount={safeFilteredImages.length}
              totalCount={selectionTotalImages}
              enrichmentProgress={enrichmentProgress}
              autoTaggingProgress={autoTaggingProgress}
              clusteringProgress={clusteringProgress}
              similarityGroupProgress={similarityGroupProgress}
              onCancelAutoTag={cancelAutoTagging}
              onCancelClustering={cancelClustering}
              onCancelSemanticIndex={cancelSemanticIndexing}
              showStackingToggle={true}
              showAutoTag={true}
              onAutoTag={handleAutoTag}
              isAutoTagging={isAutoTagging}
              hasDirectories={hasDirectories}
              isPreviewOpen={!!previewImage}
              onTogglePreview={() => {
                if (previewImage) {
                  setPreviewImage(null);
                } else if (safeFilteredImages.length > 0) {
                  let target = null;
                  
                  // IF an image or multiple images are selected, the first image in the selection should be previewed
                  if (safeSelectedImages.size > 0) {
                    target = safeFilteredImages.find(img => safeSelectedImages.has(img.id));
                  }
                  
                  // IF no image is selected, the preview should open the first image in the grid (or focused one)
                  if (!target) {
                    const index = focusedImageIndex && focusedImageIndex >= 0 ? focusedImageIndex : 0;
                    target = safeFilteredImages[index] || safeFilteredImages[0];
                  }

                  if (target) {
                    setPreviewImage(target);
                  }
                }
              }}
            >
              {hasDirectories && (
                <GridToolbar
                  selectedImages={safeSelectedImages}
                  images={safeFilteredImages}
                  directories={safeDirectories}
                  onDeleteSelected={handleDeleteSelectedImages}
                  onClearSelection={clearSelection}
                  onMergeSelected={mergeSelectedToStack}
                  isInStackView={!!libraryStackContext}
                  onUnmergeSelected={unmergeSelectedFromStack}
                />
              )}
            </Footer>
          )}
        </div>
      </div>

      {/* In Electron mode, ImageModal opens in a separate window via IPC.
          In browser mode, fall back to the in-app overlay modal. */}
      {!isElectron && selectedImage && (
        <ImageModal
          image={selectedImage}
          onClose={handleCloseImageModal}
          onImageDeleted={handleImageDeleted}
          onImageRenamed={handleImageRenamed}
          currentIndex={getCurrentImageIndex()}
          totalImages={navigationImages.length}
          onNavigateNext={handleImageModalNavigateNext}
          onNavigatePrevious={handleImageModalNavigatePrevious}
          directoryPath={directoryPath || ''}
          isIndexing={indexingState === 'indexing'}
          nextImage={navigationImages[(getCurrentImageIndex() + 1) % navigationImages.length]}
          previousImage={navigationImages[(getCurrentImageIndex() - 1 + navigationImages.length) % navigationImages.length]}
        />
      )}

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => {
          setIsSettingsModalOpen(false);
        }}
        initialTab={settingsTab}
        directories={safeDirectories}
        onAddFolder={handleSelectFolder}
        onRemoveFolder={handleRemoveDirectory}
        onReprocessImages={handleReprocessImages}
        reprocessing={reprocessing}
      />


      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        commands={commands}
      />

      <HotkeyHelp
        isOpen={isHotkeyHelpOpen}
        onClose={() => setIsHotkeyHelpOpen(false)}
        onOpenSettings={handleOpenHotkeySettings}
      />

      <TopMenuBar
        onOpenSettings={(tab) => handleOpenSettings(tab || 'general')}
        onAddFolder={handleSelectFolder}
        onToggleView={toggleViewMode}
        onUndo={() => useImageStore.getState().tryUndo()}
        hasUndo={undoAvailable}
        isSidebarCollapsed={isSidebarCollapsed}
        hasDirectories={hasDirectories}
        activeView={activeView}
        onLibraryViewChange={setActiveView}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />

      {/* Right-click context menu (same as the library grid/table/stacks view) */}
      {contextMenu.visible && (
        <div
          className="fixed z-[60] bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px] context-menu-class"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={copyImage}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <Copy className="w-4 h-4" />
            Copy to Clipboard
          </button>

          <div className="border-t border-gray-600 my-1"></div>

          <button
            onClick={copyPrompt}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.prompt && !(contextMenu.image?.metadata as any)?.prompt}
          >
            <Copy className="w-4 h-4" />
            Copy Prompt
          </button>
          <button
            onClick={copyNegativePrompt}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.negativePrompt && !(contextMenu.image?.metadata as any)?.negativePrompt}
          >
            <Copy className="w-4 h-4" />
            Copy Negative Prompt
          </button>
          <button
            onClick={copySeed}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.seed && !(contextMenu.image?.metadata as any)?.seed}
          >
            <Copy className="w-4 h-4" />
            Copy Seed
          </button>
          <button
            onClick={copyModel}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.models?.[0] && !(contextMenu.image?.metadata as any)?.model}
          >
            <Copy className="w-4 h-4" />
            Copy Model
          </button>

          <div className="border-t border-gray-600 my-1"></div>

          <button
            onClick={copyRawMetadata}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
            disabled={!contextMenu.image?.metadata}
          >
            <Copy className="w-4 h-4" />
            Copy Raw Metadata
          </button>

          <div className="border-t border-gray-600 my-1"></div>

          <button
            onClick={openWithNativeViewer}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Open in Native Viewer
          </button>

          <button
            onClick={showInFolder}
            className="w-full text-left px-4 py-2 text-sm text-gray-200 hover:bg-gray-700 hover:text-white transition-colors flex items-center gap-2"
          >
            <Folder className="w-4 h-4" />
            Show in Folder
          </button>
        </div>
      )}
    </div>
  );
}
