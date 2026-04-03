import React from 'react';
import CustomMenuBar from './CustomMenuBar';

interface TopMenuBarProps {
    onOpenSettings: () => void;
    onAddFolder: () => void;
    onToggleView: () => void;
    onShowChangelog: () => void;
    isSidebarCollapsed?: boolean;
    hasDirectories?: boolean;
}

const TopMenuBar: React.FC<TopMenuBarProps> = ({
    onOpenSettings,
    onAddFolder,
    onToggleView,
    onShowChangelog,
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
            className="h-8 bg-gray-900 border-b border-gray-800/60 fixed top-0 right-0 z-[100] select-none shadow-sm flex items-center transition-all duration-300"
            style={{ 
                left: offset,
                width: `calc(100% - ${offset})`
            } as any}
        >
            {/* Layer 1: Dedicated Background Drag Handle (No children to prevent hit-test masking) */}
            <div 
                className="absolute inset-0 z-0" 
                style={{ WebkitAppRegion: 'drag' } as any} 
            />

            {/* Layer 2: Interactive Content Layer (Pinned above the drag handle) */}
            <div 
                className="relative z-10 flex items-center h-full w-full pl-1" 
            >
                {/* Menu Items */}
                <div className="flex items-center h-full" style={{ WebkitAppRegion: 'no-drag' } as any}>
                    <CustomMenuBar 
                        onOpenSettings={onOpenSettings}
                        onAddFolder={onAddFolder}
                        onToggleView={onToggleView}
                        onShowChangelog={onShowChangelog}
                    />
                </div>

                {/* Flexible Space (Click through to drag handle) */}
                <div className="flex-grow h-full" />

                {/* Right Side - Reserved for Windows Native Controls (approx 140px) */}
                <div className="w-[140px] flex-shrink-0 h-full" />
            </div>
        </div>
    );
};

export default TopMenuBar;
