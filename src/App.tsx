import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useImageStore } from './store/useImageStore';
import { useSettingsStore } from './store/useSettingsStore';
import { useImageLoader } from './hooks/useImageLoader';
import { useImageSelection } from './hooks/useImageSelection';
import { useHotkeys } from './hooks/useHotkeys';
import { Directory } from './types';
import { X, ArrowLeft } from 'lucide-react';

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
import SmartLibrary from './components/SmartLibrary';
import { ModelView } from './components/ModelView';
import GridToolbar from './components/GridToolbar';
import TopMenuBar from './components/TopMenuBar';

import ImageTable from './components/ImageTable';

export default function App() {
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

  // Loading & progress selectors
  const isLoading = useImageStore((state) => state.isLoading);
  const progress = useImageStore((state) => state.progress);
  const indexingState = useImageStore((state) => state.indexingState);
  const enrichmentProgress = useImageStore((state) => state.enrichmentProgress);

  // Status selectors
  const error = useImageStore((state) => state.error);
  const success = useImageStore((state) => state.success);

  // Filter state selectors
  const searchQuery = useImageStore((state) => state.searchQuery);
  const scanSubfolders = useImageStore((state) => state.scanSubfolders);
  const excludedFolders = useImageStore((state) => state.excludedFolders);
  const addExcludedFolder = useImageStore((state) => state.addExcludedFolder);
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

  const isStackingEnabled = useImageStore((state) => state.isStackingEnabled);
  const setStackingEnabled = useImageStore((state) => state.setStackingEnabled);
  const viewingStackPrompt = useImageStore((state) => state.viewingStackPrompt);
  const setViewingStackPrompt = useImageStore((state) => state.setViewingStackPrompt);
  const isAnnotationsLoaded = useImageStore((state) => state.isAnnotationsLoaded);
  const refreshingDirectories = useImageStore((state) => state.refreshingDirectories);

  // Action selectors
  const setSearchQuery = useImageStore((state) => state.setSearchQuery);
  const setSelectedFilters = useImageStore((state) => state.setSelectedFilters);
  const setAdvancedFilters = useImageStore((state) => state.setAdvancedFilters);
  const setSelectedImage = useImageStore((state) => state.setSelectedImage);
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
  const setClusterNavigationContext = useImageStore((state) => state.setClusterNavigationContext);
  const cleanupInvalidImages = useImageStore((state) => state.cleanupInvalidImages);
  const activeView = useImageStore((state) => state.activeView);
  const setActiveView = useImageStore((state) => state.setActiveView);



  const initializeFolderSelection = useImageStore((state) => state.initializeFolderSelection);
  const loadAnnotations = useImageStore((state) => state.loadAnnotations);
  const imageStoreSetSortOrder = useImageStore((state) => state.setSortOrder);
  const sortOrder = useImageStore((state) => state.sortOrder);
  const reshuffle = useImageStore((state) => state.reshuffle);
  const updateDirectoryStatus = useImageStore((state) => state.updateDirectoryStatus);
  const restoreSmartLibraryCache = useImageStore((state) => state.restoreSmartLibraryCache);

  const safeFilteredImages = Array.isArray(filteredImages) ? filteredImages : [];
  const safeDirectories = Array.isArray(directories) ? directories : [];
  const safeSelectedImages = selectedImages instanceof Set ? selectedImages : new Set<string>();

  // --- Settings Store State ---
  const {
    viewMode,
    toggleViewMode,
    globalAutoWatch,
  } = useSettingsStore();

  // --- Local UI State ---
  const previousSearchQueryRef = useRef(searchQuery);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'hotkeys' | 'privacy' | 'about'>('general');
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
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



  const handleOpenSettings = (tab: 'general' | 'hotkeys' | 'privacy' | 'about' = 'general') => {
    setSettingsTab(tab);
    setIsSettingsModalOpen(true);
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

  // Restore auto-tags from cache after images are loaded
  // This runs early so tags are visible without needing to open Smart Library first
  useEffect(() => {
    if (primaryPath && hasImages && indexingState !== 'indexing') {
      restoreSmartLibraryCache(primaryPath, scanSubfolders);
    }
  }, [primaryPath, hasImages, indexingState, scanSubfolders, restoreSmartLibraryCache]);



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
  }, [loadDirectory, safeDirectories, globalAutoWatch]);

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
      const directory = directories.find(d => d.id === directoryId);

      if (!directory || !files || files.length === 0) return;

      // Show toast notification
      setNewImagesToast({ count: files.length, directoryName: directory.name });

      // Processar novos arquivos usando a função do useImageLoader
      await processNewWatchedFiles(directory, files);
    });

    return () => unsubscribe();
  }, [directories, processNewWatchedFiles, sortOrder]);

  // Listen for deleted images from file watcher
  useEffect(() => {
    if (!window.electronAPI) return;

    const unsubscribe = window.electronAPI.onImagesDeleted(async (data) => {
      const { directoryId, paths } = data;
      const directory = directories.find(d => d.id === directoryId);

      if (!directory || !paths || paths.length === 0) return;

      // Process deleted files using the function from useImageLoader
      await processDeletedWatchedFiles(directory, paths);
    });

    return () => unsubscribe();
  }, [directories, processDeletedWatchedFiles]);

  // Watcher debug logs
  useEffect(() => {
    if (!window.electronAPI?.onWatcherDebug) return;

    console.log('[App] Setting up watcher-debug listener');
    const unsubscribe = window.electronAPI.onWatcherDebug(({ message }) => {
      console.log('[WATCHER-DEBUG]', message);
    });
    console.log('[App] watcher-debug listener registered successfully');

    return () => {
      console.log('[App] Cleaning up watcher-debug listener');
      unsubscribe();
    };
  }, []);

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
    return safeFilteredImages.findIndex(img => img.id === selectedImage.id);
  }, [selectedImage, safeFilteredImages]);

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

  // --- Render Logic ---
  const hasDirectories = safeDirectories.length > 0;
  const directoryPath = selectedImage ? safeDirectories.find(d => d.id === selectedImage.directoryId)?.path : undefined;

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
            onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
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
            onAddFolder={handleSelectFolder}
            isIndexing={indexingState === 'indexing' || indexingState === 'completed'}
            scanSubfolders={scanSubfolders}
            excludedFolders={excludedFolders}
            onExcludeFolder={addExcludedFolder}
            sortOrder={sortOrder}
            onSortOrderChange={imageStoreSetSortOrder}
            onReshuffle={reshuffle}
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
            {/* Back from Stack Button - Now outside header */}
            {activeView === 'library' && viewingStackPrompt && (
              <div className="px-6 py-2 bg-gray-900/40 border-b border-gray-800/40 flex items-center shrink-0">
                <button
                  onClick={() => {
                    setSearchQuery('');
                    setStackingEnabled(true);
                    setViewingStackPrompt(null);
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500/10 text-blue-400 rounded-md hover:bg-blue-500/20 transition-all text-xs font-medium border border-blue-500/20 shadow-sm"
                >
                  <ArrowLeft size={14} />
                  <span>Back to all stacks</span>
                </button>
                <div className="ml-3 text-xs text-gray-400 truncate">
                  Viewing stack: <span className="text-gray-200 font-mono">{viewingStackPrompt}</span>
                </div>
              </div>
            )}

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

              {indexingState === 'indexing' && (
                <div className="mx-6 p-4 mb-4 bg-gray-800/50 rounded-lg border border-gray-700">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm text-gray-300 font-medium flex items-center gap-2">
                      <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                      Indexing library...
                    </span>
                    <span className="text-sm text-gray-400 font-mono">
                      {progress?.current ?? 0} / {progress?.total ?? 0}
                    </span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden shadow-inner">
                    <div 
                      className="bg-blue-500 h-full transition-all duration-300 shadow-[0_0_10px_rgba(59,130,246,0.5)]" 
                      style={{ width: `${((progress?.current ?? 0) / (progress?.total || 1)) * 100}%` }}
                    />
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
                    <SmartLibrary />
                  ) : activeView === 'model' ? (
                    <ModelView 
                      onModelSelect={(modelName) => {
                        setSelectedFilters({ models: [modelName] });
                        setActiveView('library');
                      }}
                    />
                  ) : (
                    <div className="h-full">
                      {viewMode === 'grid' ? (
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
              showStackingToggle={true}
            >
              {hasDirectories && (
                <GridToolbar
                  selectedImages={safeSelectedImages}
                  images={safeFilteredImages}
                  directories={safeDirectories}
                  onDeleteSelected={handleDeleteSelectedImages}
                  onClearSelection={clearSelection}
                />
              )}
            </Footer>
          )}
        </div>
      </div>

      {selectedImage && (
        <ImageModal
          image={selectedImage}
          onClose={handleCloseImageModal}
          onImageDeleted={handleImageDeleted}
          onImageRenamed={handleImageRenamed}
          currentIndex={getCurrentImageIndex()}
          totalImages={safeFilteredImages.length}
          onNavigateNext={handleImageModalNavigateNext}
          onNavigatePrevious={handleImageModalNavigatePrevious}
          directoryPath={directoryPath || ''}
          isIndexing={indexingState === 'indexing'}
          nextImage={safeFilteredImages[(getCurrentImageIndex() + 1) % safeFilteredImages.length]}
          previousImage={safeFilteredImages[(getCurrentImageIndex() - 1 + safeFilteredImages.length) % safeFilteredImages.length]}
        />
      )}

      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => {
          setIsSettingsModalOpen(false);
        }}
        initialTab={settingsTab}
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
        isSidebarCollapsed={isSidebarCollapsed}
        hasDirectories={hasDirectories}
        activeView={activeView}
        onLibraryViewChange={setActiveView}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />
    </div>
  );
}
