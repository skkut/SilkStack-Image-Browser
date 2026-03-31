
import React, { useState, useEffect } from 'react';
import SearchBar from './SearchBar';
import AdvancedFilters from './AdvancedFilters';
import TagsAndFavorites from './TagsAndFavorites';
import { ChevronLeft, X, ChevronDown, Plus, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface SidebarProps {
  availableModels: string[];
  availableLoras: string[];
  availableSchedulers: string[];
  availableDimensions: string[];
  availableAspectRatios: string[];
  selectedModels: string[];
  selectedLoras: string[];
  selectedSchedulers: string[];
  onModelChange: (models: string[]) => void;
  onLoraChange: (loras: string[]) => void;
  onSchedulerChange: (schedulers: string[]) => void;
  onClearAllFilters: () => void;
  advancedFilters: any;
  onAdvancedFiltersChange: (filters: any) => void;
  onClearAdvancedFilters: () => void;
  children?: React.ReactNode;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onAddFolder?: () => void;
  isIndexing: boolean;
  scanSubfolders: boolean;
  excludedFolders: Set<string>;
  onExcludeFolder: (path: string) => void;
  sortOrder: string;
  onSortOrderChange: (value: string) => void;
  onReshuffle?: () => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  availableModels,
  availableLoras,
  availableSchedulers,
  availableDimensions,
  availableAspectRatios,
  selectedModels,
  selectedLoras,
  selectedSchedulers,
  onModelChange,
  onLoraChange,
  onSchedulerChange,
  onClearAllFilters,
  advancedFilters,
  onAdvancedFiltersChange,
  onClearAdvancedFilters,
  children,
  isCollapsed,
  onToggleCollapse,
  onAddFolder,
  isIndexing = false,
  scanSubfolders,
  excludedFolders,
  onExcludeFolder,
  sortOrder,
  onSortOrderChange,
  onReshuffle
}) => {

  const [expandedSections, setExpandedSections] = useState({
    models: false,
    loras: false,
    schedulers: false,
  });

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const handleModelToggle = (model: string, checked: boolean) => {
    if (checked) {
      onModelChange([...selectedModels, model]);
    } else {
      onModelChange(selectedModels.filter(m => m !== model));
    }
  };

  const handleLoraToggle = (lora: string, checked: boolean) => {
    if (checked) {
      onLoraChange([...selectedLoras, lora]);
    } else {
      onLoraChange(selectedLoras.filter(l => l !== lora));
    }
  };

  const handleSchedulerToggle = (scheduler: string, checked: boolean) => {
    if (checked) {
      onSchedulerChange([...selectedSchedulers, scheduler]);
    } else {
      onSchedulerChange(selectedSchedulers.filter(s => s !== scheduler));
    }
  };

  const clearSection = (section: 'models' | 'loras' | 'schedulers') => {
    switch (section) {
      case 'models':
        onModelChange([]);
        break;
      case 'loras':
        onLoraChange([]);
        break;
      case 'schedulers':
        onSchedulerChange([]);
        break;
    }
  };

  const [appVersion, setAppVersion] = useState<string>('v0.0.0');

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        if (typeof window !== 'undefined' && window.electronAPI?.getAppVersion) {
          const version = await window.electronAPI.getAppVersion();
          setAppVersion(`v${version}`);
        }
      } catch (error) {
        console.error('Failed to fetch app version:', error);
      }
    };
    fetchVersion();
  }, []);

  if (isCollapsed) {
    return (
      <div
        data-area="sidebar"
        tabIndex={-1}
        className="fixed left-0 top-0 h-full w-16 bg-gray-900/90 backdrop-blur-md border-r border-gray-800/60 z-40 flex flex-col transition-all duration-300 ease-in-out shadow-lg shadow-black/20">
        
        {/* Header section for the logo/toggle button - structure exactly matches expanded sidebar height and vertical padding */}
        <div className="flex flex-col border-b border-gray-800/60 bg-gray-900/40">
          <div className="flex flex-col items-center pt-4 pb-2 px-2">
            <button
              onClick={onToggleCollapse}
              className="relative group"
              title="Expand sidebar"
            >
               <div className="absolute inset-0 bg-blue-500/20 blur-md rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
               <img src="logo1.png" alt="Expand" className="h-11 w-11 rounded-xl shadow-lg relative z-10 transition-transform duration-200 group-hover:scale-105" />
            </button>
          </div>
          {/* Row matching the 'Filters' label row height in expanded sidebar using relative classes */}
          <div className="flex items-center justify-center pt-1 pb-3 px-2">
             <div className="h-4 flex items-center justify-center">
                 <div className="w-4 h-0.5 bg-gray-700/50 rounded-full" />
             </div>
          </div>
        </div>

        <div className="flex flex-col items-center pt-4 space-y-3 mb-4">
          {(selectedModels.length > 0 || selectedLoras.length > 0 || selectedSchedulers.length > 0) && (
            <div className="w-2 h-2 bg-blue-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.6)] animate-pulse" title="Active filters"></div>
          )}
        </div>
        <div className="flex-1 w-full overflow-y-auto no-scrollbar pb-10">
          {children && React.isValidElement(children) ? (
            React.cloneElement(children as React.ReactElement<any>, {
              isIndexing,
              scanSubfolders,
              excludedFolders,
              onExcludeFolder,
              isCollapsed: true,
            })
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-area="sidebar"
      tabIndex={-1}
      className="fixed left-0 top-0 h-full w-80 bg-gray-900/90 backdrop-blur-md border-r border-gray-800/60 z-40 flex flex-col transition-all duration-300 ease-in-out shadow-2xl shadow-black/40">
      {/* Header with collapse button */}
      <div className="flex flex-col border-b border-gray-800/60 bg-gray-900/40">
        <div className="flex items-center gap-3 p-4 pb-2">
            <div className="relative flex-shrink-0">
                <div className="absolute inset-0 bg-blue-500/20 blur-xl rounded-full opacity-50" />
                <img src="logo1.png" alt="AI Images Browser" className="h-10 w-10 rounded-xl shadow-2xl relative z-10" />
            </div>
            <div className="flex flex-col overflow-hidden">
                <h1 className="text-lg font-bold tracking-tight text-gray-100 truncate">AI Images Browser</h1>
                <span className="text-[10px] font-mono font-normal text-gray-500">{appVersion}</span>
            </div>
        </div>

        <div className="flex items-center justify-between px-4 pb-3 pt-1">
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider">Filters</h2>
            <button
            onClick={onToggleCollapse}
            className="text-gray-400 hover:text-gray-100 transition-all duration-200 hover:shadow-lg hover:shadow-purple-500/20 bg-gray-800/40 hover:bg-gray-700/60 rounded-lg p-1.5"
            title="Collapse sidebar"
            >
            <ChevronLeft className="w-4 h-4" />
            </button>
        </div>
      </div>

      {/* Scrollable Content - includes DirectoryList AND Filters */}
      <div className="flex-1 overflow-y-auto scrollbar-sidebar">
        {/* Sort Order - Moved from footer for semantic consistency with filters */}
        <div className="px-4 py-3 border-b border-gray-700">
          <label htmlFor="sidebar-sort" className="block text-gray-400 text-xs font-medium mb-2">Sort Order</label>
          <div className="flex items-center">
          <select
            id="sidebar-sort"
            value={sortOrder}
            onChange={(e) => onSortOrderChange(e.target.value)}
            className="w-full bg-gray-700 text-gray-200 border border-gray-600 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="date-desc">Newest First</option>
            <option value="date-asc">Oldest First</option>
            <option value="asc">A-Z</option>
            <option value="desc">Z-A</option>
            <option value="random">Random</option>
          </select>
          {sortOrder === 'random' && onReshuffle && (
            <button
                onClick={onReshuffle}
                className="ml-2 p-2 text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-md border border-gray-600 transition-colors"
                title="Reshuffle Random Order"
            >
                <RefreshCw className="h-5 w-5" />
            </button>
          )}
          </div>
        </div>

        {/* Add Folder Button - Subtle and discrete */}
        {onAddFolder && (
          <div className="px-3 py-2 border-b border-gray-700">
            <button
              onClick={onAddFolder}
              disabled={isIndexing}
              className={`w-full flex items-center justify-center gap-1 py-1.5 px-2 rounded text-sm transition-all duration-200 ${
                isIndexing
                  ? 'bg-gray-700/50 text-gray-500 cursor-not-allowed' 
                  : 'bg-gray-700/40 text-gray-300 hover:bg-gray-700/60 hover:text-gray-50 hover:shadow-md hover:shadow-accent/20'
              }`}
              title={isIndexing ? "Cannot add folder during indexing" : "Add a new folder"}
            >
              <Plus size={14} />
              <span>Add Folder</span>
            </button>
          </div>
        )}

        {/* Render children, which will be the DirectoryList */}
        {children && React.isValidElement(children) ? (
          React.cloneElement(children as React.ReactElement<any>, {
            isIndexing,
            scanSubfolders,
            excludedFolders,
            onExcludeFolder
          })
        ) : (
          children
        )}

        {/* Tags and Favorites Section */}
        <TagsAndFavorites />

        {/* Models Section */}
        {availableModels.length > 0 && (
          <div className="border-b border-gray-700">
            <button
              onClick={() => toggleSection('models')}
              className="w-full flex items-center justify-between p-4 hover:bg-gray-700/50 transition-colors"
            >
              <div className="flex items-center space-x-2">
                <span className="text-gray-300 font-medium">Models</span>
                <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded border border-gray-600">
                  {availableModels.length}
                </span>
                {selectedModels.length > 0 && (
                  <span className="text-xs bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded border border-blue-700/50">
                    {selectedModels.length} selected
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                {selectedModels.length > 0 && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      clearSection('models');
                    }}
                    className="text-xs text-gray-400 hover:text-red-400 cursor-pointer"
                    title="Clear model filters"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        clearSection('models');
                      }
                    }}
                  >
                    <X size={16} />
                  </span>
                )}
                <ChevronDown
                  className={`w-4 h-4 transform transition-transform ${expandedSections.models ? 'rotate-180' : ''}`}
                />
              </div>
            </button>
            <AnimatePresence>
              {expandedSections.models && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-4 max-h-64 overflow-y-auto scrollbar-thin">
                    {availableModels
                      .filter(model => typeof model === 'string' && model.trim() !== '')
                      .map((model, index) => (
                      <label key={`model-${index}-${model}`} className="flex items-center space-x-2 py-2 hover:bg-gray-700/30 px-2 rounded-lg cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedModels.includes(model)}
                          onChange={(e) => handleModelToggle(model, e.target.checked)}
                          className="w-4 h-4 text-accent bg-gray-700 border-gray-600 rounded-md focus:ring-accent focus:ring-2"
                        />
                        <span className="text-gray-200 text-sm flex-1 truncate" title={model}>{model}</span>
                      </label>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* LoRAs Section */}
        {availableLoras.length > 0 && (
          <div className="border-b border-gray-700">
            <button
              onClick={() => toggleSection('loras')}
              className="w-full flex items-center justify-between p-4 hover:bg-gray-700/50 transition-colors"
            >
              <div className="flex items-center space-x-2">
                <span className="text-gray-300 font-medium">LoRAs</span>
                <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded border border-gray-600">
                  {availableLoras.length}
                </span>
                {selectedLoras.length > 0 && (
                  <span className="text-xs bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded border border-blue-700/50">
                    {selectedLoras.length} selected
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                {selectedLoras.length > 0 && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      clearSection('loras');
                    }}
                    className="text-xs text-gray-400 hover:text-red-400 cursor-pointer"
                    title="Clear LoRA filters"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        clearSection('loras');
                      }
                    }}
                  >
                    <X size={16} />
                  </span>
                )}
                <ChevronDown
                  className={`w-4 h-4 transform transition-transform ${expandedSections.loras ? 'rotate-180' : ''}`}
                />
              </div>
            </button>
            <AnimatePresence>
              {expandedSections.loras && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-4 max-h-64 overflow-y-auto scrollbar-thin">
                    {availableLoras
                      .filter(lora => typeof lora === 'string' && lora.trim() !== '')
                      .map((lora, index) => (
                      <label key={`lora-${index}-${lora}`} className="flex items-center space-x-2 py-2 hover:bg-gray-700/30 px-2 rounded-lg cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedLoras.includes(lora)}
                          onChange={(e) => handleLoraToggle(lora, e.target.checked)}
                          className="w-4 h-4 text-blue-500 bg-gray-700 border-gray-600 rounded-md focus:ring-blue-500 focus:ring-2"
                        />
                        <span className="text-gray-200 text-sm flex-1 truncate" title={lora}>{lora}</span>
                      </label>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Schedulers Section */}
        {availableSchedulers.length > 0 && (
          <div className="border-b border-gray-700">
            <button
              onClick={() => toggleSection('schedulers')}
              className="w-full flex items-center justify-between p-4 hover:bg-gray-700/50 transition-colors"
            >
              <div className="flex items-center space-x-2">
                <span className="text-gray-300 font-medium">Schedulers</span>
                <span className="text-xs bg-gray-700 text-gray-400 px-2 py-0.5 rounded border border-gray-600">
                  {availableSchedulers.length}
                </span>
                {selectedSchedulers.length > 0 && (
                  <span className="text-xs bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded border border-blue-700/50">
                    {selectedSchedulers.length} selected
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                {selectedSchedulers.length > 0 && (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      clearSection('schedulers');
                    }}
                    className="text-xs text-gray-400 hover:text-red-400 cursor-pointer"
                    title="Clear scheduler filters"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        clearSection('schedulers');
                      }
                    }}
                  >
                    <X size={16} />
                  </span>
                )}
                <ChevronDown
                  className={`w-4 h-4 transform transition-transform ${expandedSections.schedulers ? 'rotate-180' : ''}`}
                />
              </div>
            </button>
            <AnimatePresence>
              {expandedSections.schedulers && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="px-4 pb-4 max-h-64 overflow-y-auto scrollbar-thin">
                    {availableSchedulers
                      .filter(scheduler => typeof scheduler === 'string' && scheduler.trim() !== '')
                      .map((scheduler, index) => (
                      <label key={`scheduler-${index}-${scheduler}`} className="flex items-center space-x-2 py-2 hover:bg-gray-700/30 px-2 rounded-lg cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedSchedulers.includes(scheduler)}
                          onChange={(e) => handleSchedulerToggle(scheduler, e.target.checked)}
                          className="w-4 h-4 text-blue-500 bg-gray-700 border-gray-600 rounded-md focus:ring-blue-500 focus:ring-2"
                        />
                        <span className="text-gray-200 text-sm flex-1 truncate" title={scheduler}>{scheduler}</span>
                      </label>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* Advanced Filters */}
        <AdvancedFilters
          advancedFilters={advancedFilters}
          onAdvancedFiltersChange={onAdvancedFiltersChange}
          onClearAdvancedFilters={onClearAdvancedFilters}
          availableDimensions={availableDimensions}
          availableAspectRatios={availableAspectRatios}
        />
      </div>

      {/* Clear All Filters */}
      {(selectedModels.length > 0 || selectedLoras.length > 0 || selectedSchedulers.length > 0 || Object.keys(advancedFilters || {}).length > 0) && (
        <div className="p-4 border-t border-gray-700">
          <button
            onClick={onClearAllFilters}
            className="w-full text-red-400 hover:text-gray-100 hover:bg-red-900/30 border border-red-900/30 hover:border-red-500/50 px-4 py-2 rounded-lg text-sm transition-all duration-200"
          >
            Clear All Filters
          </button>
        </div>
      )}
    </div>
  );
};

// Memoize to prevent unnecessary re-renders
export default React.memo(Sidebar);
