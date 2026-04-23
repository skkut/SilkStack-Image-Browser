import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { X, Save, RefreshCw, CheckCircle, AlertCircle, Trash2, FolderOpen, Wrench, Palette, Keyboard, Eye, Check, Info, Github, Smile } from 'lucide-react';
import { resetAllCaches } from '../utils/cacheReset';
import { HotkeySettings } from './HotkeySettings';
import { useImageStore } from '../store/useImageStore';
import { Directory } from '../types';
import { EMOJI_CATEGORIES } from '../utils/emojiData';
import { normalizePath } from '../utils/pathUtils';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'general' | 'folders' | 'hotkeys' | 'privacy' | 'about';
  directories?: Directory[];
  onAddFolder?: () => void;
  onRemoveFolder?: (directoryId: string) => void;
}

type Tab = 'general' | 'folders' | 'hotkeys' | 'privacy' | 'about';


const SettingsModal: React.FC<SettingsModalProps> = ({ 
  isOpen, 
  onClose, 
  initialTab = 'general',
  directories = [],
  onAddFolder,
  onRemoveFolder
}) => {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  const doubleClickToOpen = useSettingsStore((state) => state.doubleClickToOpen);
  const setDoubleClickToOpen = useSettingsStore((state) => state.setDoubleClickToOpen);
  const displayStarredFirst = useSettingsStore((state) => state.displayStarredFirst);
  const setDisplayStarredFirst = useSettingsStore((state) => state.setDisplayStarredFirst);
  const globalAutoWatch = useSettingsStore((state) => state.globalAutoWatch);
  const toggleGlobalAutoWatch = useSettingsStore((state) => state.toggleGlobalAutoWatch);
  const scanSubfolders = useSettingsStore((state) => state.scanSubfolders);
  const sensitiveTags = useSettingsStore((state) => state.sensitiveTags);
  const setSensitiveTags = useSettingsStore((state) => state.setSensitiveTags);
  const blurSensitiveImages = useSettingsStore((state) => state.blurSensitiveImages);
  const setBlurSensitiveImages = useSettingsStore((state) => state.setBlurSensitiveImages);
  const confirmOnDelete = useSettingsStore((state) => state.confirmOnDelete);
  const setConfirmOnDelete = useSettingsStore((state) => state.setConfirmOnDelete);

  const [sensitiveTagsInput, setSensitiveTagsInput] = useState('');
  const [cacheFolderPath, setCacheFolderPath] = useState('');
  const [appVersion, setAppVersion] = useState('');

  const [activeEmojiPicker, setActiveEmojiPicker] = useState<string | null>(null);
  const [emojiCategory, setEmojiCategory] = useState(EMOJI_CATEGORIES[0].name);
  const folderPreferences = useImageStore((state) => state.folderPreferences);
  const setFolderEmoji = useImageStore((state) => state.setFolderEmoji);
  const setFolderScanSubfolders = useImageStore((state) => state.setFolderScanSubfolders);

  useEffect(() => {
    const handleClickOutside = () => setActiveEmojiPicker(null);
    if (activeEmojiPicker) {
      window.addEventListener("click", handleClickOutside);
      return () => window.removeEventListener("click", handleClickOutside);
    }
  }, [activeEmojiPicker]);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (isOpen) {
      window.electronAPI?.getDefaultCachePath().then(result => {
        if (result?.success && result.path) {
          // getDefaultCachePath returns the ImageMetaHubCache subfolder;
          // strip one level to show the actual userData directory
          const parts = result.path.replace(/[\\/]+$/, '').split(/[\\/]/);
          parts.pop();
          setCacheFolderPath(parts.join('\\'));
        }
      }).catch(() => {/* silently ignore */});
      
      window.electronAPI?.getAppVersion().then(setAppVersion).catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    setSensitiveTagsInput((sensitiveTags ?? []).join(', '));
  }, [sensitiveTags]);


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
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[110] flex justify-center items-center p-4 sm:p-6" onClick={onClose}>
      <div 
        className="bg-gray-900 border border-gray-700 text-gray-100 rounded-xl shadow-2xl w-full max-w-4xl h-[80vh] min-h-[500px] max-h-[800px] flex flex-col overflow-hidden" 
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-800 bg-gray-900 shrink-0">
          <h2 className="text-xl font-bold tracking-tight">Settings</h2>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-gray-800 text-gray-400 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar Navigation */}
          <div className="w-64 border-r border-gray-800 bg-gray-900/50 p-4 space-y-2 overflow-y-auto shrink-0 flex flex-col">
            <button
              onClick={() => setActiveTab('general')}
              className={`flex items-center space-x-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'general' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}
            >
              <Wrench size={18} />
              <span>General</span>
            </button>
            <button
              onClick={() => setActiveTab('folders')}
              className={`flex items-center space-x-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'folders' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}
            >
              <FolderOpen size={18} />
              <span>Folders</span>
            </button>
            <button
              onClick={() => setActiveTab('hotkeys')}
              className={`flex items-center space-x-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'hotkeys' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}
            >
              <Keyboard size={18} />
              <span>Keyboard Shortcuts</span>
            </button>
            <button
              onClick={() => setActiveTab('privacy')}
              className={`flex items-center space-x-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'privacy' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}
            >
              <Eye size={18} />
              <span>Privacy</span>
            </button>
            <button
              onClick={() => setActiveTab('about')}
              className={`flex items-center space-x-3 px-4 py-3 rounded-lg text-sm font-medium transition-all duration-200 ${activeTab === 'about' ? 'bg-blue-600/20 text-blue-400' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'}`}
            >
              <Info size={18} />
              <span>About</span>
            </button>
          </div>

          {/* Main Content Area */}
          <div className="flex-1 overflow-y-auto bg-gray-800/50 p-6 md:p-8">
            <div className="max-w-2xl mx-auto h-full">
              {activeTab === 'general' && (
                <div className="space-y-8 animate-in fade-in duration-300 pb-8">
                  {/* File Monitoring */}
                  <section>
                    <h3 className="text-lg font-semibold mb-4 text-gray-200 border-b border-gray-700/50 pb-2">File Monitoring</h3>
                    <div className="flex items-start justify-between bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm transition-all hover:border-gray-600">
                      <div className="pr-6">
                        <p className="text-sm font-medium text-gray-200">Monitor changes in real-time</p>
                        <p className="text-sm text-gray-400 mt-1 leading-relaxed">
                          Automatically watch directories for new or modified images. Disable this if you have very large folders or a slower PC.
                        </p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                        <input
                          type="checkbox"
                          checked={globalAutoWatch}
                          onChange={toggleGlobalAutoWatch}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                      </label>
                    </div>
                  </section>

                  {/* Display */}
                  <section>
                    <h3 className="text-lg font-semibold mb-4 text-gray-200 border-b border-gray-700/50 pb-2">Display</h3>
                    <div className="space-y-3">
                      <div className="flex items-start justify-between bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm transition-all hover:border-gray-600">
                        <div className="pr-6">
                          <p className="text-sm font-medium text-gray-200">Display Starred images first</p>
                          <p className="text-sm text-gray-400 mt-1 leading-relaxed">
                            Always arrange starred (favorite) images at the beginning of the grid, sorting them according to the active sort order separately.
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                          <input
                            type="checkbox"
                            checked={displayStarredFirst}
                            onChange={(event) => {
                              setDisplayStarredFirst(event.target.checked);
                              useImageStore.getState().filterAndSortImages();
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                        </label>
                      </div>

                      <div className="flex items-start justify-between bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm transition-all hover:border-gray-600">
                        <div className="pr-6">
                          <p className="text-sm font-medium text-gray-200">Double-click to open image</p>
                          <p className="text-sm text-gray-400 mt-1 leading-relaxed">
                            Single click selects, double-click opens details. When off, single click opens details.
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                          <input
                            type="checkbox"
                            checked={doubleClickToOpen}
                            onChange={(event) => setDoubleClickToOpen(event.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                        </label>
                      </div>

                      <div className="flex items-start justify-between bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm transition-all hover:border-gray-600">
                        <div className="pr-6">
                          <p className="text-sm font-medium text-gray-200">Confirm before deleting</p>
                          <p className="text-sm text-gray-400 mt-1 leading-relaxed">
                            Show a confirmation prompt before deleting an image.
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                          <input
                            type="checkbox"
                            checked={confirmOnDelete}
                            onChange={(event) => setConfirmOnDelete(event.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                        </label>
                      </div>
                    </div>
                  </section>

                  {/* Cache Management */}
                  <section>
                    <h3 className="text-lg font-semibold mb-4 text-gray-200 border-b border-gray-700/50 pb-2">Cache Management</h3>
                    <div className="bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm">
                      <p className="text-sm text-gray-300 mb-4 leading-relaxed">
                        Clear all cached image metadata and app settings. Use this if you encounter issues or want to start fresh.
                        This will delete indexed metadata but keep your image files intact.
                      </p>
                      <button
                        onClick={handleClearCache}
                        className="bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/20 hover:border-red-500 px-5 py-2.5 rounded-lg text-sm font-medium transition-colors mb-4 flex items-center gap-2"
                      >
                        <Trash2 size={16} />
                        Clear All Cache
                      </button>
                      
                      {cacheFolderPath && (
                        <div className="bg-gray-950 p-3 rounded-lg border border-gray-800">
                          <p className="text-xs text-gray-500 mb-1.5 uppercase tracking-wider font-semibold">Cache Location</p>
                          <div
                            className="text-xs text-gray-400 font-mono break-all select-all flex items-center gap-2"
                            title="Click to select all, then copy"
                          >
                            <FolderOpen size={14} className="shrink-0 text-gray-500" />
                            {cacheFolderPath}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                </div>
              )}

              {activeTab === 'folders' && (() => {
                const renderEmojiPicker = (path: string) => {
                  const categories = EMOJI_CATEGORIES;
                  const currentCategory =
                    categories.find((c) => c.name === emojiCategory) || categories[0];

                  return (
                    <div
                      className="absolute right-12 top-2 mt-8 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl z-[100] w-64 overflow-hidden flex flex-col"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* Categories Tab */}
                      <div className="flex border-b border-gray-800 overflow-x-auto scrollbar-hide bg-gray-800/50">
                        {categories.map((cat) => (
                          <button
                            key={cat.name}
                            onClick={() => setEmojiCategory(cat.name)}
                            className={`px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
                              emojiCategory === cat.name
                                ? "text-blue-400 border-b-2 border-blue-400 bg-gray-800"
                                : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
                            }`}
                          >
                            {cat.name}
                          </button>
                        ))}
                      </div>

                      {/* Emoji Grid */}
                      <div className="p-2 grid grid-cols-6 gap-1 h-48 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-700">
                        <button
                          onClick={() => {
                            setFolderEmoji(path, undefined);
                            setActiveEmojiPicker(null);
                          }}
                          className="col-span-6 py-1.5 mb-1 text-[10px] text-gray-400 hover:text-white hover:bg-red-500/20 rounded transition-colors border border-dashed border-gray-700"
                        >
                          Clear Emoji
                        </button>
                        {currentCategory.emojis.map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => {
                              setFolderEmoji(path, emoji);
                              setActiveEmojiPicker(null);
                            }}
                            className="w-8 h-8 flex items-center justify-center rounded hover:bg-gray-800 hover:scale-110 transition-all text-lg"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                };

                return (
                <div className="space-y-8 animate-in fade-in duration-300 pb-8 h-full flex flex-col">
                  <section className="flex flex-col flex-1 min-h-0">
                    <div className="flex justify-between items-center mb-4 border-b border-gray-700/50 pb-2">
                      <h3 className="text-lg font-semibold text-gray-200">Manage Folders</h3>
                      <button
                        onClick={onAddFolder}
                        className="bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 border border-blue-500/20 hover:border-blue-500"
                      >
                        <FolderOpen size={16} />
                        Add Folder
                      </button>
                    </div>

                    <div className="bg-gray-900/80 rounded-xl border border-gray-700/50 shadow-sm flex-1 overflow-y-auto mb-6 p-2">
                       {directories.length === 0 ? (
                         <div className="h-full flex items-center justify-center text-gray-500 text-sm py-10">
                           No folders added yet
                         </div>
                       ) : (
                         <div className="space-y-2">
                             {directories.map(dir => (
                              <div key={dir.id} className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-800/50 group border border-transparent hover:border-gray-700/50 transition-colors bg-gray-800/30 relative">
                                <div className="flex items-center gap-3 min-w-0 pr-4">
                                  <div className="p-2 bg-gray-900 rounded-lg shrink-0 border border-gray-700/50">
                                    {folderPreferences.get(normalizePath(dir.path))?.emoji ? (
                                      <span className="w-4 h-4 flex items-center justify-center text-sm">
                                        {folderPreferences.get(normalizePath(dir.path))?.emoji}
                                      </span>
                                    ) : (
                                      <FolderOpen size={16} className={dir.isConnected === false ? "text-gray-600" : (dir.visible === false ? "text-gray-500" : "text-blue-400")} />
                                    )}
                                  </div>
                                  <div className="min-w-0 flex flex-col">
                                     <span className={`text-sm font-medium truncate ${dir.isConnected === false ? "text-gray-500" : "text-gray-200"}`}>{dir.name}</span>
                                     <span className="text-xs text-gray-500 truncate">{dir.path}</span>
                                  </div>
                                  {dir.isConnected === false && (
                                    <span className="ml-2 px-2 py-0.5 rounded text-[10px] font-medium bg-red-900/20 text-red-400 border border-red-900/40 shrink-0">Offline</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-4 shrink-0">
                                  <label className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded-md hover:bg-gray-800/80 transition-colors" title="Scan subfolders">
                                    <span className="text-xs text-gray-400 font-medium select-none">Subfolders</span>
                                    <div className="relative inline-flex items-center">
                                      <input
                                        type="checkbox"
                                        checked={folderPreferences.get(normalizePath(dir.path))?.scanSubfolders ?? scanSubfolders}
                                        onChange={(e) => setFolderScanSubfolders(dir.path, e.target.checked)}
                                        className="sr-only peer"
                                      />
                                      <div className="w-8 h-4 bg-gray-700/80 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500/50 peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-gray-300 peer-checked:after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-blue-500 shadow-inner group-hover:bg-gray-600"></div>
                                    </div>
                                  </label>

                                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setActiveEmojiPicker(
                                          activeEmojiPicker === dir.path ? null : dir.path,
                                        );
                                      }}
                                      className={`p-1.5 rounded-md transition-colors ${
                                        activeEmojiPicker === dir.path
                                          ? "text-blue-400 bg-gray-700"
                                          : "text-gray-500 hover:text-white hover:bg-gray-700/50"
                                      }`}
                                      title="Set folder emoji"
                                    >
                                      <Smile size={16} />
                                    </button>
                                    {activeEmojiPicker === dir.path &&
                                      renderEmojiPicker(dir.path)}

                                    {onRemoveFolder && (
                                      <button 
                                        onClick={() => {
                                          if (window.confirm(`Are you sure you want to remove '${dir.name}' from the library? Files will not be deleted.`)) {
                                            onRemoveFolder(dir.id);
                                          }
                                        }}
                                        className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded-md transition-colors"
                                        title="Remove from library"
                                      >
                                        <Trash2 size={16} />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </div>
                           ))}
                         </div>
                       )}
                    </div>

                  </section>
                </div>
                );
              })()}

              {activeTab === 'hotkeys' && (
                <div className="animate-in fade-in duration-300 h-full pb-8">
                  <h3 className="text-lg font-semibold mb-6 text-gray-200 border-b border-gray-700/50 pb-2">Keyboard Shortcuts</h3>
                  <HotkeySettings />
                </div>
              )}

              {activeTab === 'privacy' && (
                <div className="space-y-8 animate-in fade-in duration-300 pb-8">
                  <section>
                    <h3 className="text-lg font-semibold mb-4 text-gray-200 border-b border-gray-700/50 pb-2">Content Filtering</h3>
                    <div className="space-y-4">
                      <div className="bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm transition-all hover:border-gray-600">
                        <label className="text-sm font-medium text-gray-200 block mb-1">Sensitive tags</label>
                        <p className="text-sm text-gray-400 mb-4 leading-relaxed">
                          Comma-separated tags that should be hidden or blurred (e.g., nsfw, private, hidden).
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
                          className="w-full bg-gray-950 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                        />
                      </div>

                      <div className="flex items-start justify-between bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm transition-all hover:border-gray-600">
                        <div className="pr-6">
                          <p className="text-sm font-medium text-gray-200">Blur sensitive images instead of hiding</p>
                          <p className="text-sm text-gray-400 mt-1 leading-relaxed">
                            If enabled, sensitive images will be shown with a strong blur effect. If disabled, they will be completely removed from the grid.
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
                          <input
                            type="checkbox"
                            checked={blurSensitiveImages}
                            onChange={(event) => setBlurSensitiveImages(event.target.checked)}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
                        </label>
                      </div>
                    </div>
                  </section>
                </div>
              )}

              {activeTab === 'about' && (
                <div className="flex flex-col items-center justify-center min-h-full py-8 animate-in fade-in duration-300 pb-8">
                  <div className="bg-gray-900/60 border border-gray-700/50 rounded-2xl p-10 max-w-sm w-full text-center space-y-5 shadow-2xl backdrop-blur-sm">
                    <div className="mx-auto bg-gradient-to-br from-blue-500/20 to-purple-500/20 p-5 rounded-full w-28 h-28 flex items-center justify-center mb-8 shadow-inner border border-white/5">
                      <img src="./logo1.png" alt="App Logo" className="w-16 h-16 object-contain drop-shadow-md" />
                    </div>
                    
                    <div>
                      <h3 className="text-2xl font-bold text-gray-50 tracking-tight">SilkStack<br/>Image Browser</h3>
                      <div className="inline-block bg-blue-500/10 border border-blue-500/20 text-blue-400 font-medium px-3 py-1 rounded-full text-xs mt-3">
                        Version {appVersion}
                      </div>
                    </div>
                    
                    <div className="pt-5 border-t border-gray-800/80">
                      <p className="text-sm text-gray-400 leading-relaxed max-w-[250px] mx-auto">
                        A powerful, privacy-first image browser built specially for AI-generated images.
                      </p>
                    </div>

                    <div className="pt-4">
                      <button
                        onClick={() => window.electronAPI?.openExternal('https://github.com/skkut/SilkStack-Image-Browser')}
                        className="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-600 hover:border-gray-500 rounded-xl text-sm font-medium text-gray-200 transition-all shadow-sm hover:shadow-md"
                      >
                        <Github size={18} />
                        <span>View on GitHub</span>
                      </button>
                    </div>
                    
                    <div className="pt-6 font-medium text-xs text-gray-600 uppercase tracking-widest">
                      © 2025 skkut
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-800 bg-gray-900 shrink-0 text-center flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <CheckCircle size={14} className="text-green-500/70" />
            <span>Settings saved automatically</span>
          </div>
          <p className="text-xs text-gray-600">Some changes may require a restart</p>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;