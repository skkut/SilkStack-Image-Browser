import React from 'react';
import { Settings } from 'lucide-react';

import { useImageStore } from '../store/useImageStore';
import SearchBar from './SearchBar';

interface HeaderProps {
    onOpenSettings: () => void;
    onAddFolder?: () => void;
    onToggleView?: () => void;
    onShowChangelog?: () => void;
    libraryView?: 'library' | 'smart' | 'model';
    onLibraryViewChange?: (view: 'library' | 'smart' | 'model') => void;
}

const Header: React.FC<HeaderProps> = ({ 
    onOpenSettings, 
    onAddFolder,
    onToggleView,
    onShowChangelog,
    libraryView,
    onLibraryViewChange,
}) => {
  const searchQuery = useImageStore((state) => state.searchQuery);
  const setSearchQuery = useImageStore((state) => state.setSearchQuery);



  return (
    <header 
      className="h-14 bg-gray-900/40 backdrop-blur-md border-b border-gray-800/60 px-6 flex items-center shrink-0 z-20 justify-between transition-all duration-300 shadow-sm"
      style={{ WebkitAppRegion: 'drag' } as any}
    >
      <div className="flex items-center justify-between gap-4 w-full">
        
        {/* Left Side - Spacer */}
        <div className="flex-1" />

        {/* Center Side - View Controls (Only visible if libraryView is provided) */}
        {libraryView && onLibraryViewChange && (
            <div className="flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
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
        <div className="flex items-center gap-3 flex-1 justify-end" style={{ WebkitAppRegion: 'no-drag' } as any}>
            
                   {/* Search Bar - Visible in Library views */}
                   {libraryView && (
                     <div className="flex items-center mr-2">
                       <SearchBar
                         value={searchQuery}
                         onChange={setSearchQuery}
                       />
                     </div>
                   )}



            

          
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
