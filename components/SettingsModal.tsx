
import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLicenseStore } from '../store/useLicenseStore';
import { X, Save, RefreshCw, CheckCircle, AlertCircle, Trash2, FolderOpen, Wrench, Palette, Keyboard, Eye, Check } from 'lucide-react';
import { resetAllCaches } from '../utils/cacheReset';
import { HotkeySettings } from './HotkeySettings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'general' | 'hotkeys' | 'themes' | 'privacy';
  focusSection?: 'license' | null;
}

type Tab = 'general' | 'hotkeys' | 'themes' | 'privacy';

const themeOptions = [
  { id: 'system', name: 'System Default', colors: ['#525252', '#a3a3a3'] },
  { id: 'light', name: 'Light Mode', colors: ['#ffffff', '#3b82f6', '#1f2937'] },
  { id: 'dark', name: 'Dark Mode', colors: ['#0a0a0a', '#3b82f6', '#e5e5e5'] },
  { id: 'dracula', name: 'Dracula', colors: ['#282a36', '#bd93f9', '#f8f8f2'] },
  { id: 'nord', name: 'Nord', colors: ['#2e3440', '#88c0d0', '#d8dee9'] },
  { id: 'ocean', name: 'Ocean', colors: ['#0f172a', '#38bdf8', '#e2e8f0'] },
];

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose, initialTab = 'general' }) => {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const theme = useSettingsStore((state) => state.theme);
  const setTheme = useSettingsStore((state) => state.setTheme);
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
  const globalAutoWatch = useSettingsStore((state) => state.globalAutoWatch);
  const toggleGlobalAutoWatch = useSettingsStore((state) => state.toggleGlobalAutoWatch);
  const sensitiveTags = useSettingsStore((state) => state.sensitiveTags);
  const setSensitiveTags = useSettingsStore((state) => state.setSensitiveTags);
  const blurSensitiveImages = useSettingsStore((state) => state.blurSensitiveImages);
  const setBlurSensitiveImages = useSettingsStore((state) => state.setBlurSensitiveImages);

  // A1111 Integration settings
  const a1111ServerUrl = useSettingsStore((state) => state.a1111ServerUrl);
  const a1111AutoStart = useSettingsStore((state) => state.a1111AutoStart);
  const a1111LastConnectionStatus = useSettingsStore((state) => state.a1111LastConnectionStatus);
  const setA1111ServerUrl = useSettingsStore((state) => state.setA1111ServerUrl);
  const toggleA1111AutoStart = useSettingsStore((state) => state.toggleA1111AutoStart);
  const setA1111ConnectionStatus = useSettingsStore((state) => state.setA1111ConnectionStatus);

  // ComfyUI Integration settings
  const comfyUIServerUrl = useSettingsStore((state) => state.comfyUIServerUrl);
  const comfyUILastConnectionStatus = useSettingsStore((state) => state.comfyUILastConnectionStatus);
  const comfyUIDesktopPath = useSettingsStore((state) => state.comfyUIDesktopPath);
  const setComfyUIServerUrl = useSettingsStore((state) => state.setComfyUIServerUrl);
  const setComfyUIDesktopPath = useSettingsStore((state) => state.setComfyUIDesktopPath);
  const setComfyUIConnectionStatus = useSettingsStore((state) => state.setComfyUIConnectionStatus);

  const [currentCachePath, setCurrentCachePath] = useState('');
  const [defaultCachePath, setDefaultCachePath] = useState('');
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [isTestingComfyUIConnection, setIsTestingComfyUIConnection] = useState(false);
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

  const handleTestConnection = async () => {
    if (!a1111ServerUrl) {
      alert('Please enter a server URL');
      return;
    }

    setIsTestingConnection(true);
    setA1111ConnectionStatus('unknown');

    try {
      const { A1111ApiClient } = await import('../services/a1111ApiClient');
      const client = new A1111ApiClient({ serverUrl: a1111ServerUrl });
      const result = await client.testConnection();

      if (result.success) {
        setA1111ConnectionStatus('connected');
      } else {
        setA1111ConnectionStatus('error');
        alert(`Connection failed: ${result.error}`);
      }
    } catch (error: any) {
      setA1111ConnectionStatus('error');
      alert(`Error testing connection: ${error.message}`);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const handleTestComfyUIConnection = async () => {
    if (!comfyUIServerUrl) {
      alert('Please enter a server URL');
      return;
    }

    setIsTestingComfyUIConnection(true);
    setComfyUIConnectionStatus('unknown');

    try {
      const { ComfyUIApiClient } = await import('../services/comfyUIApiClient');
      const client = new ComfyUIApiClient({ serverUrl: comfyUIServerUrl });
      const result = await client.testConnection();

      if (result.success) {
        setComfyUIConnectionStatus('connected');
      } else {
        setComfyUIConnectionStatus('error');
        alert(`Connection failed: ${result.error}`);
      }
    } catch (error: any) {
      setComfyUIConnectionStatus('error');
      alert(`Error testing connection: ${error.message}`);
    } finally {
      setIsTestingComfyUIConnection(false);
    }
  };

  const handleClearCache = async () => {
    const confirmed = window.confirm(
      '⚠️ CLEAR ALL CACHE & RESET APP ⚠️\n\n' +
      'This will completely reset the application:\n\n' +
      '🗑️ DATA:\n' +
      '  • Delete all indexed image metadata (IndexedDB)\n' +
      '  • Remove all loaded directories\n' +
      '  • Clear all search filters and selections\n\n' +
      '⚙️ SETTINGS:\n' +
      '  • Reset cache location to default\n' +
      '  • Reset auto-update preference\n' +
      '  • Clear all localStorage preferences\n\n' +
      '📁 YOUR FILES ARE SAFE:\n' +
      '  • Image files will NOT be deleted\n' +
      '  • You will need to re-add directories\n\n' +
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
              onClick={() => setActiveTab('themes')}
              className={`flex items-center space-x-2 px-4 py-2 text-sm font-medium ${activeTab === 'themes' ? 'border-b-2 border-blue-500 text-gray-100' : 'text-gray-400 hover:text-gray-50'}`}
            >
              <Palette size={16} />
              <span>Themes</span>
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

        {activeTab === 'themes' && (
          <div className="grid grid-cols-2 gap-4">
            {themeOptions.map((option) => (
              <button
                key={option.id}
                onClick={() => setTheme(option.id as any)}
                className={`relative p-4 rounded-lg border-2 text-left transition-all ${
                  theme === option.id
                    ? 'border-blue-500 bg-gray-700'
                    : 'border-gray-700 bg-gray-900 hover:bg-gray-800'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-gray-100">{option.name}</span>
                  {theme === option.id && <Check size={16} className="text-blue-500" />}
                </div>
                <div className="flex space-x-2">
                  {option.colors.map((color, index) => (
                    <div
                      key={index}
                      className="w-6 h-6 rounded-full border border-gray-600"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}

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

            {/* A1111 Integration */}
            <div>
              <h3 className="text-lg font-semibold mb-2">Automatic1111 Integration</h3>
              <p className="text-sm text-gray-400 mb-3">
                Configure connection to your local Automatic1111 instance. Make sure A1111 is running with the --api flag.
              </p>

              {/* Server URL Input */}
              <div className="space-y-2 mb-3">
                <label className="text-sm text-gray-300">Server URL</label>
                <input
                  type="text"
                  value={a1111ServerUrl}
                  onChange={(e) => setA1111ServerUrl(e.target.value)}
                  placeholder="http://127.0.0.1:7860"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
                />
              </div>

              {/* Test Connection Button */}
              <div className="flex items-center space-x-2 mb-3">
                <button
                  onClick={handleTestConnection}
                  disabled={isTestingConnection}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-4 py-2 rounded-md text-sm font-medium"
                >
                  {isTestingConnection ? 'Testing...' : 'Test Connection'}
                </button>
                {a1111LastConnectionStatus === 'connected' && (
                  <span className="text-green-400 text-sm">✓ Connected</span>
                )}
                {a1111LastConnectionStatus === 'error' && (
                  <span className="text-red-400 text-sm">✗ Connection failed</span>
                )}
              </div>

              {/* Auto-start Toggle */}
              <div className="flex items-center justify-between bg-gray-900 p-3 rounded-md">
                <div>
                  <p className="text-sm">Auto-start generation</p>
                  <p className="text-xs text-gray-400">
                    Automatically start generating when sending parameters to A1111
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={a1111AutoStart}
                    onChange={toggleA1111AutoStart}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-800 peer-checked:after:translate-x-full peer-checked:after:border-gray-50 after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-gray-50 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            </div>

            {/* ComfyUI Integration */}
            <div>
              <h3 className="text-lg font-semibold mb-2">ComfyUI Integration</h3>
              <p className="text-sm text-gray-400 mb-3">
                Configure connection to your local ComfyUI instance.
                <br />
                <span className="text-xs text-yellow-400">
                  Requires MetaHub Save Node installed in ComfyUI.
                </span>
              </p>

              <div className="space-y-4 mb-3">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    ComfyUI Server URL
                  </label>
                  <input
                    type="text"
                    value={comfyUIServerUrl}
                    onChange={(e) => setComfyUIServerUrl(e.target.value)}
                    className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                    placeholder="http://127.0.0.1:8188"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-1">
                    ComfyUI Desktop Path (Optional)
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={comfyUIDesktopPath || ''}
                      onChange={(e) => setComfyUIDesktopPath(e.target.value)}
                      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
                      placeholder="C:\Path\To\ComfyUI\ComfyUI.exe"
                    />
                      <button
                        onClick={async () => {
                          const result = await window.electronAPI.selectPath(false);
                          if (result.success && result.path) {
                            setComfyUIDesktopPath(result.path);
                          }
                        }}
                        className="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded-lg text-gray-200 transition-colors"
                      >
                        <FolderOpen size={18} />
                      </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    If set, "Send to ComfyUI" will try to launch this executable.
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2 mb-3">
                <button
                  onClick={handleTestComfyUIConnection}
                  disabled={isTestingComfyUIConnection}
                  className="bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:cursor-not-allowed px-4 py-2 rounded-md text-sm font-medium"
                >
                  {isTestingComfyUIConnection ? 'Testing...' : 'Test Connection'}
                </button>
                {comfyUILastConnectionStatus === 'connected' && (
                  <span className="text-green-400 text-sm">✓ Connected</span>
                )}
                {comfyUILastConnectionStatus === 'error' && (
                  <span className="text-red-400 text-sm">✗ Connection failed</span>
                )}
              </div>

              {/* Info Box */}
              <div className="bg-blue-900/20 border border-blue-700 rounded p-3 text-xs text-blue-200">
                <strong>Installation:</strong> Install the MetaHub Save Node in ComfyUI from:
                <br />
                <a
                  href="https://github.com/LuqP2/ImageMetaHub-ComfyUI-Save"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:underline"
                >
                  github.com/LuqP2/ImageMetaHub-ComfyUI-Save
                </a>
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
