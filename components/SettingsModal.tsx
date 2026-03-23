
import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLicenseStore } from '../store/useLicenseStore';
import { X, Save, RefreshCw, CheckCircle, AlertCircle, Trash2, FolderOpen, Wrench, Palette, Keyboard, Eye, Check } from 'lucide-react';
import { resetAllCaches } from '../utils/cacheReset';
import { HotkeySettings } from './HotkeySettings';
import { useImageStore } from '../store/useImageStore';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'general' | 'hotkeys' | 'privacy';
  focusSection?: 'license' | null;
}

type Tab = 'general' | 'hotkeys' | 'privacy';


const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, initialTab = 'general' }) => {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const cachePath = useSettingsStore((state) => state.cachePath);

  const setCachePath = useSettingsStore((state) => state.setCachePath);

  const indexingConcurrency = useSettingsStore((state) => state.indexingConcurrency);
  const setIndexingConcurrency = useSettingsStore((state) => state.setIndexingConcurrency);
  const showFilenames = useSettingsStore((state) => state.showFilenames);
  const setShowFilenames = useSettingsStore((state) => state.setShowFilenames);
  const showFullFilePath = useSettingsStore((state) => state.showFullFilePath);
  const setShowFullFilePath = useSettingsStore((state) => state.setShowFullFilePath);
  const doubleClickToOpen = useSettingsStore((state) => state.doubleClickToOpen);
  const setDoubleClickToOpen = useSettingsStore((state) => state.setDoubleClickToOpen);
  const displayStarredFirst = useSettingsStore((state) => state.displayStarredFirst);
  const setDisplayStarredFirst = useSettingsStore((state) => state.setDisplayStarredFirst);
  const globalAutoWatch = useSettingsStore((state) => state.globalAutoWatch);
  const toggleGlobalAutoWatch = useSettingsStore((state) => state.toggleGlobalAutoWatch);
  const sensitiveTags = useSettingsStore((state) => state.sensitiveTags);
  const setSensitiveTags = useSettingsStore((state) => state.setSensitiveTags);
  const blurSensitiveImages = useSettingsStore((state) => state.blurSensitiveImages);
  const setBlurSensitiveImages = useSettingsStore((state) => state.setBlurSensitiveImages);



  const [currentCachePath, setCurrentCachePath] = useState('');
  const [defaultCachePath, setDefaultCachePath] = useState('');

  const hardwareConcurrency = typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : null;
  const maxConcurrency = hardwareConcurrency ? Math.max(1, Math.min(16, Math.floor(hardwareConcurrency))) : 16;

  const [sensitiveTagsInput, setSensitiveTagsInput] = useState('');

  useEffect(() => {
    if (isOpen) {
      // Fetch the default path when the modal opens
      window.electronAPI?.getDefaultCachePath().then(result => {
        if (result.success && result.path) {
          setDefaultCachePath(result.path);
          setCurrentCachePath(cachePath || result.path);
        }
      }).catch(error => {
        console.error('Failed to get default cache path:', error);
      });
    }
  }, [isOpen, cachePath]);

  useEffect(() => {
    setSensitiveTagsInput((sensitiveTags ?? []).join(', '));
  }, [sensitiveTags]);



  const handleSelectCacheDirectory = async () => {
    const result = await window.electronAPI?.showDirectoryDialog();
    if (result && result.success && result.path) {
      setCachePath(result.path);
      setCurrentCachePath(result.path);
    }
  };

  const handleResetCacheDirectory = () => {
    setCachePath(defaultCachePath);
    setCurrentCachePath(defaultCachePath);
  };

  const handleOpenCacheLocation = async () => {
    if (currentCachePath) {
      await window.electronAPI?.openCacheLocation(currentCachePath);
    }
  };



  const handleClearCache = async () => {
    const confirmed = window.confirm(
      '⚠️ CLEAR ALL CACHE & RESET APP ⚠️\n\n' +
      'This will completely reset the application:\n\n' +
      '🗑️ DATA:\n' +
      '  • Delete all indexed image metadata (IndexedDB)\n' +
      '  • Remove all loaded directories\n' +
      '  • Clear all search filters and selections\n' +
      '  • Delete existing thumbnails (will be regenerated at higher quality)\n\n' +
      '⚙️ SETTINGS:\n' +
      '  • Reset cache location to default\n' +
      '  • Reset auto-update preference\n' +
      '  • Clear all localStorage preferences\n\n' +
      '📁 YOUR FILES ARE SAFE:\n' +
      '  • Image files will NOT be deleted\n' +
      '  • You will need to re-add directories to start fresh indexing\n\n' +
      '🔄 The app will reload automatically after clearing.\n\n' +
      'This action CANNOT be undone. Continue?'
    );

    if (confirmed) {
      try {
        console.log('Starting cache reset...');
        await resetAllCaches();
        // resetAllCaches() will handle the reload automatically
        // The alert will show briefly before the reload
        alert('✅ Cache cleared successfully!\n\nThe app will now reload to complete the reset.');
        onClose();
      } catch (error) {
        console.error('Failed to clear cache:', error);
        alert('❌ Failed to clear cache. Check console for details.');
      }
    }
  };



  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex justify-center items-center p-4" onClick={onClose}>
      <div className="bg-gray-800 text-gray-100 rounded-lg shadow-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold">Settings</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-gray-700">
            <X size={24} />
          </button>
        </div>

        <div className="flex border-b border-gray-700 mb-6">
            <button
              onClick={() => setActiveTab('general')}
              className={`flex items-center space-x-2 px-4 py-2 text-sm font-medium ${activeTab === 'general' ? 'border-b-2 border-blue-500 text-gray-100' : 'text-gray-400 hover:text-gray-50'}`}
            >
              <Wrench size={16} />
              <span>General</span>
            </button>

            <button
              onClick={() => setActiveTab('hotkeys')}
              className={`flex items-center space-x-2 px-4 py-2 text-sm font-medium ${activeTab === 'hotkeys' ? 'border-b-2 border-blue-500 text-gray-100' : 'text-gray-400 hover:text-gray-50'}`}
            >
              <Keyboard size={16} />
              <span>Keyboard Shortcuts</span>
            </button>
            <button
              onClick={() => setActiveTab('privacy')}
              className={`flex items-center space-x-2 px-4 py-2 text-sm font-medium ${activeTab === 'privacy' ? 'border-b-2 border-blue-500 text-gray-100' : 'text-gray-400 hover:text-gray-50'}`}
            >
              <Eye size={16} />
              <span>Privacy</span>
            </button>
        </div>


        {activeTab === 'general' && (
          <div className="space-y-6">
            {/* Cache Location Setting */}
            <div>
              <h3 className="text-lg font-semibold mb-2">Cache Location</h3>
            <p className="text-sm text-gray-400 mb-2">
              The directory where the image index cache is stored.
            </p>
            <div className="bg-gray-900 p-2 rounded-md text-sm truncate">
              {currentCachePath || 'Loading...'}
            </div>
            <div className="flex items-center space-x-2 mt-2">
              <button
                onClick={handleSelectCacheDirectory}
                className="bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-md text-sm font-medium"
              >
                Change Location
              </button>
              <button
                onClick={handleOpenCacheLocation}
                className="bg-green-600 hover:bg-green-700 px-4 py-2 rounded-md text-sm font-medium"
              >
                Open Location
              </button>
              <button
                onClick={handleResetCacheDirectory}
                disabled={currentCachePath === defaultCachePath}
                className="bg-gray-600 hover:bg-gray-700 px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
              >
                Reset to Default
              </button>
            </div>
             <p className="text-xs text-gray-500 mt-2">
              Default: {defaultCachePath}
            </p>
          </div>



          {/* Auto-watch Setting */}
          <div>
            <h3 className="text-lg font-semibold mb-2">File Monitoring</h3>
            <div className="flex items-center justify-between bg-gray-900 p-3 rounded-md">
              <div>
                <p className="text-sm">Monitor changes in real-time</p>
                <p className="text-xs text-gray-400">
                  Automatically watch directories for new or modified images. Disable this if you have very large folders or a slower PC.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={globalAutoWatch}
                  onChange={toggleGlobalAutoWatch}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-gray-50 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-50 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>

          {/* Display */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Display</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between bg-gray-900 p-3 rounded-md">
                <div>
                  <p className="text-sm">Show filenames under thumbnails</p>
                  <p className="text-xs text-gray-400">
                    Always display file names below each thumbnail in the grid.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showFilenames}
                    onChange={(event) => setShowFilenames(event.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-gray-50 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-50 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              <div className="flex items-center justify-between bg-gray-900 p-3 rounded-md">
                <div>
                  <p className="text-sm">Display Starred images first</p>
                  <p className="text-xs text-gray-400">
                    Always arrange starred (favorite) images at the beginning of the grid, sorting them according to the active sort order separately.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={displayStarredFirst}
                    onChange={(event) => {
                      setDisplayStarredFirst(event.target.checked);
                      useImageStore.getState().filterAndSortImages();
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-gray-50 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-50 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              <div className="flex items-center justify-between bg-gray-900 p-3 rounded-md">
                <div>
                  <p className="text-sm">Show full file path</p>
                  <p className="text-xs text-gray-400">
                    Display complete relative path instead of just filename (e.g., "subfolder/image.png" vs "image.png").
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showFullFilePath}
                    onChange={(event) => setShowFullFilePath(event.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-gray-50 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-50 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
              <div className="flex items-center justify-between bg-gray-900 p-3 rounded-md">
                <div>
                  <p className="text-sm">Double-click to open image</p>
                  <p className="text-xs text-gray-400">
                    Single click selects, double-click opens details. When off, single click opens details.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={doubleClickToOpen}
                    onChange={(event) => setDoubleClickToOpen(event.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-gray-50 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-50 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            </div>
          </div>



          {/* Indexing Concurrency */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Metadata Indexing</h3>
            <div className="bg-gray-900 p-3 rounded-md space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm">Parallel workers</p>
                  <p className="text-xs text-gray-400">
                    Increase to speed up metadata enrichment on faster machines. Reduce if the UI becomes unresponsive.
                  </p>
                </div>
                <input
                  type="number"
                  min={1}
                  max={maxConcurrency}
                  value={indexingConcurrency}
                  onChange={(event) => setIndexingConcurrency(Number(event.target.value) || 1)}
                  className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm text-right"
                />
              </div>
              {hardwareConcurrency && (
                <p className="text-xs text-gray-500">
                  Detected {hardwareConcurrency} logical cores. The default is capped at 8 to stay responsive.
                </p>
              )}
            </div>
          </div>

          {/* Cache Management Setting */}
          <div>
            <h3 className="text-lg font-semibold mb-2">Cache Management</h3>
            <p className="text-sm text-gray-400 mb-3">
              Clear all cached image metadata and app settings. Use this if you encounter issues or want to start fresh.
            </p>
            <button
              onClick={handleClearCache}
              className="bg-red-600 hover:bg-red-700 px-4 py-2 rounded-md text-sm font-medium"
            >
              Clear All Cache
            </button>
            <p className="text-xs text-gray-500 mt-2">
              This will delete indexed metadata but keep your image files intact.
            </p>
          </div>

          </div>
        )}

        {activeTab === 'hotkeys' && (
          <HotkeySettings />
        )}

        {activeTab === 'privacy' && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold mb-2">Content Filtering</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-gray-300">Sensitive tags</label>
                  <p className="text-xs text-gray-400 mb-2">
                    Comma-separated tags that should be hidden or blurred (for example: nsfw, private, hidden).
                  </p>
                  <input
                    type="text"
                    value={sensitiveTagsInput}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setSensitiveTagsInput(nextValue);
                      const parsedTags = nextValue
                        .split(',')
                        .map(tag => tag.trim().toLowerCase())
                        .filter(Boolean);
                      setSensitiveTags(parsedTags);
                    }}
                    placeholder="nsfw, private, hidden"
                    className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                  />
                </div>

                <div className="flex items-center justify-between bg-gray-900 p-3 rounded-md">
                  <div>
                    <p className="text-sm">Blur sensitive images instead of hiding</p>
                    <p className="text-xs text-gray-400">
                      If enabled, sensitive images will be shown with a strong blur effect. If disabled, they will be completely removed from the grid.
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={blurSensitiveImages}
                      onChange={(event) => setBlurSensitiveImages(event.target.checked)}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-gray-50 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-50 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                  </label>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 text-center">
            <p className="text-xs text-gray-500">Changes are saved automatically. You may need to restart the application for some changes to take full effect.</p>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
