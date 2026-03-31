import React, { useState } from 'react';
import { Settings, Sparkles, ChevronDown, Layers, Layers2, Eye, EyeOff, ArrowLeft } from 'lucide-react';
import { useFeatureAccess } from '../hooks/useFeatureAccess';
import { useSettingsStore } from '../store/useSettingsStore';
import { useImageStore } from '../store/useImageStore';

interface HeaderProps {
    onOpenSettings: () => void;
    onOpenLicense: () => void;
    onOpenA1111Generate?: () => void;
    onOpenComfyUIGenerate?: () => void;
    libraryView?: 'library' | 'smart' | 'model';
    onLibraryViewChange?: (view: 'library' | 'smart' | 'model') => void;
    children?: React.ReactNode;
}

const Header: React.FC<HeaderProps> = ({ 
    onOpenSettings, 
    onOpenLicense, 
    onOpenA1111Generate, 
    onOpenComfyUIGenerate,
    libraryView,
    onLibraryViewChange,
    children
}) => {
  const {
    canUseA1111,
    canUseComfyUI,
    showProModal,
    isTrialActive,
    trialDaysRemaining,
    isPro,
    initialized,
    isExpired,
    isFree,
  } = useFeatureAccess();

  // Store hooks for View Controls
  const enableSafeMode = useSettingsStore((state) => state.enableSafeMode);
  const setEnableSafeMode = useSettingsStore((state) => state.setEnableSafeMode);
  const isStackingEnabled = useImageStore((state) => state.isStackingEnabled);
  const setStackingEnabled = useImageStore((state) => state.setStackingEnabled);
  const viewingStackPrompt = useImageStore((state) => state.viewingStackPrompt);
  const setViewingStackPrompt = useImageStore((state) => state.setViewingStackPrompt);
  const setSearchQuery = useImageStore((state) => state.setSearchQuery);

  // Store hooks for Smart Library Actions
  const directories = useImageStore((state) => state.directories);
  const scanSubfolders = useImageStore((state) => state.scanSubfolders);
  const isClustering = useImageStore((state) => state.isClustering);
  const isAutoTagging = useImageStore((state) => state.isAutoTagging);
  const startClustering = useImageStore((state) => state.startClustering);
  const startAutoTagging = useImageStore((state) => state.startAutoTagging);



  const primaryPath = directories[0]?.path ?? '';
  const hasDirectories = directories.length > 0;
  const DEFAULT_SIMILARITY_THRESHOLD = 0.88;

  const handleGenerateClusters = () => {
    if (!primaryPath) return;
    startClustering(primaryPath, scanSubfolders, DEFAULT_SIMILARITY_THRESHOLD);
  };

  const handleGenerateAutoTags = () => {
    if (!primaryPath) return;
    startAutoTagging(primaryPath, scanSubfolders);
  };

  const statusConfig = (() => {
    if (!initialized) {
      return {
        label: 'Status: Checking license…',
        classes: 'text-gray-300 bg-gray-800/70 border-gray-700',
      };
    }
    if (isPro) {
      return {
        label: 'Status: Pro License',
        classes: 'text-green-300 bg-green-900/30 border-green-600/50',
      };
    }
    if (isTrialActive) {
      const daysLabel = `${trialDaysRemaining} ${trialDaysRemaining === 1 ? 'day' : 'days'} left`;
      return {
        label: `Status: Pro Trial (${daysLabel})`,
        classes: 'text-amber-400 bg-amber-900/30 border-amber-500/50',
      };
    }
    if (isExpired) {
      return {
        label: 'Status: Trial expired',
        classes: 'text-red-300 bg-red-900/30 border-red-600/50',
      };
    }
    return {
      label: 'Status: Free Version',
      classes: 'text-gray-300 bg-gray-800/60 border-gray-700',
    };
  })();

  return (
    <header className="bg-gray-900/80 backdrop-blur-md sticky top-0 z-30 pl-2 pr-4 py-2 border-b border-gray-800/60 shadow-lg transition-all duration-300">
      <div className="flex items-center justify-between gap-4 w-full">
        
        {/* Left Side - Status Indicator - REMOVED */}
        <div className="flex items-center gap-4 flex-1 justify-start overflow-hidden">
            {children}
        </div>

        {/* Center Side - View Controls (Only visible if libraryView is provided) */}
        {libraryView && onLibraryViewChange && (
            <div className="flex items-center gap-3">
                <div className="flex items-center bg-gray-800/50 rounded-full p-1 border border-gray-700/50">
                    <button
                        onClick={() => onLibraryViewChange('library')}
                        className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-200 ${
                            libraryView === 'library' 
                            ? 'bg-blue-600 text-white shadow-md shadow-blue-900/20' 
                            : 'text-gray-400 hover:text-white hover:bg-white/5'
                        }`}
                    >
                        Library
                    </button>
                    <button
                        onClick={() => onLibraryViewChange('smart')}
                        className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-200 flex items-center gap-1.5 ${
                            libraryView === 'smart' 
                            ? 'bg-purple-600 text-white shadow-md shadow-purple-900/20' 
                            : 'text-gray-400 hover:text-white hover:bg-white/5'
                        }`}
                    >
                        Smart Library
                    </button>
                    <button
                        onClick={() => onLibraryViewChange('model')}
                        className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-200 flex items-center gap-1.5 ${
                            libraryView === 'model' 
                            ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/20' 
                            : 'text-gray-400 hover:text-white hover:bg-white/5'
                        }`}
                    >
                        Model View
                    </button>
                </div>

            </div>
        )}


        {/* Right Side - Actions */}
        <div className="flex items-center gap-3 flex-1 justify-end">
            
                   {/* Stacking Toggle - Only relevant for Library view */}
                   {libraryView === 'library' && (
                     <>
                        <button
                          onClick={() => setStackingEnabled(!isStackingEnabled)}
                          className={`p-1.5 rounded-lg transition-all duration-200 ${
                              isStackingEnabled 
                              ? 'text-blue-400 bg-blue-500/10' 
                              : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                          }`}
                          title={isStackingEnabled ? "Disable stacking" : "Stack items by identical prompt"}
                        >
                          {isStackingEnabled ? <Layers2 size={16} /> : <Layers size={16} />}
                        </button>
                        
                         {/* Back from Stack Button */}
                        {viewingStackPrompt && (
                            <button
                                onClick={() => {
                                setSearchQuery('');
                                setStackingEnabled(true);
                                setViewingStackPrompt(null);
                                }}
                                className="flex items-center gap-1 px-2 py-1 bg-blue-500/10 text-blue-400 rounded-md hover:bg-blue-500/20 transition-colors text-xs font-medium"
                            >
                                <ArrowLeft size={12} />
                                Back
                            </button>
                        )}
                        <div className="w-px h-4 bg-gray-700/50 mx-1"></div>
                     </>
                   )}

                   {/* Safe Mode Toggle */}
                   <button
                     onClick={() => setEnableSafeMode(!enableSafeMode)}
                     className={`p-1.5 rounded-lg transition-all duration-200 ${
                         enableSafeMode
                         ? 'text-gray-400 hover:text-gray-100'
                         : 'text-gray-600 hover:text-gray-400'
                     }`}
                     title={enableSafeMode ? 'Safe Mode on' : 'Safe Mode off'}
                   >
                     {enableSafeMode ? <Eye size={16} /> : <EyeOff size={16} />}
                   </button>
           
          {/* Smart Library Actions (Contextual) */}
          {libraryView === 'smart' && (
             <div className="flex items-center gap-2 mr-2 animate-in fade-in duration-300">
                <button
                    onClick={handleGenerateClusters}
                    disabled={!hasDirectories || isClustering}
                    className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                        isClustering ? 'text-blue-400/50 cursor-wait' : 'text-blue-400 hover:bg-blue-500/10 hover:text-blue-300'
                    }`}
                    title="Generate Clusters"
                >
                    <Layers size={14} className={isClustering ? 'animate-pulse' : ''}/>
                    <span className="hidden xl:inline">Cluster</span>
                </button>
                <button
                    onClick={handleGenerateAutoTags}
                    disabled={!hasDirectories || isAutoTagging}
                    className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                        isAutoTagging ? 'text-purple-400/50 cursor-wait' : 'text-purple-400 hover:bg-purple-500/10 hover:text-purple-300'
                    }`}
                    title="Generate Auto-Tags"
                >
                    <Sparkles size={14} className={isAutoTagging ? 'animate-pulse' : ''}/>
                    <span className="hidden xl:inline">Auto-Tag</span>
                </button>
                 <div className="w-px h-5 bg-gray-700/50 mx-1"></div>
             </div>
          )}



{/* Generate Dropdown REMOVED */}
          
          {/* Get Pro link REMOVED */}
          
          <div className="flex items-center bg-gray-800/50 rounded-full p-0.5 border border-gray-700/50">
            <button
              onClick={onOpenSettings}
              className="p-1.5 rounded-full hover:bg-gray-700/80 text-gray-400 hover:text-gray-100 transition-all hover:rotate-45"
              title="Open Settings"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
