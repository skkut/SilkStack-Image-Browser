import React from 'react';
import CustomMenuBar from './CustomMenuBar';
import SearchBar from './SearchBar';
import { Settings } from 'lucide-react';

interface TopMenuBarProps {
    onOpenSettings: (tab?: 'general' | 'hotkeys' | 'privacy' | 'about') => void;
    onAddFolder: () => void;
    onToggleView: () => void;
    onShowChangelog: () => void;
    libraryView?: 'library' | 'smart' | 'model';
    onLibraryViewChange?: (view: 'library' | 'smart' | 'model') => void;
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    isSidebarCollapsed?: boolean;
    hasDirectories?: boolean;
}

const TopMenuBar: React.FC<TopMenuBarProps> = ({
    onOpenSettings,
    onAddFolder,
    onToggleView,
    onShowChangelog,
    libraryView,
    onLibraryViewChange,
    searchQuery,
    setSearchQuery,
    isSidebarCollapsed = false,
    hasDirectories = false
}) => {
    // Only show in Electron (desktop app)
    const isDesktop = !!window.electronAPI;
    
    if (!isDesktop) return null;

    const offset = hasDirectories 
        ? (isSidebarCollapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)') 
        : '0px';

    return (
        <div 
            className="bg-gray-900/40 backdrop-blur-md border-b border-gray-800/60 fixed top-0 right-0 z-[100] select-none shadow-sm flex items-center pt-0.5 pb-0.5 transition-all duration-300"
            style={{ 
                height: 'var(--header-height, 44px)',
                left: offset,
                width: `calc(100% - ${offset})`,
                WebkitAppRegion: 'drag'
            } as any}
        >
            {/* Menu Items */}
            <div className="flex items-center h-full shrink-0 px-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <CustomMenuBar 
                    onOpenSettings={onOpenSettings}
                    onAddFolder={onAddFolder}
                    onToggleView={onToggleView}
                    onShowChangelog={onShowChangelog}
                />
            </div>

            {/* Center Side - View Controls */}
            {libraryView && onLibraryViewChange && (
                <div className="flex-1 flex justify-center pointer-events-none">
                    <div className="flex items-center bg-gray-800/50 rounded-full p-0.5 border border-gray-700/50 overflow-hidden pointer-events-auto" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        <button
                            onClick={() => onLibraryViewChange('library')}
                            className={`px-3.5 py-1 text-[13.5px] font-semibold rounded-full transition-all duration-200 ${
                                libraryView === 'library' 
                                ? 'bg-blue-600 text-white shadow-md shadow-blue-900/20' 
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            Library
                        </button>
                        <button
                            onClick={() => onLibraryViewChange('smart')}
                            className={`px-3.5 py-1 text-[13.5px] font-semibold rounded-full transition-all duration-200 ${
                                libraryView === 'smart' 
                                ? 'bg-purple-600 text-white shadow-md shadow-purple-900/20' 
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            Smart Library
                        </button>
                        <button
                            onClick={() => onLibraryViewChange('model')}
                            className={`px-3.5 py-1 text-[13.5px] font-semibold rounded-full transition-all duration-200 ${
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

            {/* Right Side - Actions (Search & Settings) */}
            <div className="flex items-center gap-2 shrink-0 pr-1 ml-auto">
                {/* Search Bar */}
                {libraryView && (
                    <div className="flex items-center h-full mr-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        <SearchBar
                            value={searchQuery}
                            onChange={setSearchQuery}
                        />
                    </div>
                )}
                
                {/* Settings Button */}
                <button
                    onClick={() => onOpenSettings()}
                    className="p-1.5 rounded-full hover:bg-gray-700/80 text-gray-400 hover:text-gray-100 transition-all hover:rotate-45"
                    title="Open Settings"
                    style={{ WebkitAppRegion: 'no-drag' } as any}
                >
                    <Settings size={20} />
                </button>
            </div>

            {/* Right Side - Reserved for Windows Native Controls (approx 140px) */}
            <div className="w-[140px] flex-shrink-0 h-full" />
        </div>
    );
};

export default TopMenuBar;
