
import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface MenuItem {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  type?: 'separator';
}

interface MenuSection {
  label: string;
  items: MenuItem[];
}

interface CustomMenuBarProps {
  onOpenSettings: (tab?: string) => void;
  onAddFolder: () => void;
  onToggleView: () => void;
  onShowChangelog: () => void;
}

const CustomMenuBar: React.FC<CustomMenuBarProps> = ({
  onOpenSettings,
  onAddFolder,
  onToggleView,
  onShowChangelog,
}) => {
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;

  const handleAction = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    e.preventDefault();
    action();
    setActiveMenu(null);
  };

  const handleTopLevelMouseDown = (e: React.MouseEvent, label: string) => {
    e.stopPropagation();
    e.preventDefault();
    setActiveMenu(activeMenu === label ? null : label);
  };

  const handleTopLevelMouseEnter = (label: string) => {
    if (activeMenu) {
      setActiveMenu(label);
    }
  };

  const menuData: MenuSection[] = [
    {
      label: 'File',
      items: [
        { label: 'Add Folder...', shortcut: 'Ctrl+O', onClick: () => onAddFolder() },
        { label: 'Reload', shortcut: 'Ctrl+R', onClick: () => window.location.reload() },
        { type: 'separator' } as MenuItem,
        { label: 'Settings', shortcut: 'Ctrl+,', onClick: () => onOpenSettings('general') },
        { type: 'separator' } as MenuItem,
        { label: 'Exit', shortcut: 'Alt+F4', onClick: () => (window as any).electronAPI?.exitApp() },
      ],
    },

    {
      label: 'View',
      items: [
        { label: 'Toggle Grid/List', shortcut: 'Ctrl+L', onClick: () => onToggleView() },
        { type: 'separator' } as MenuItem,
        { label: 'Toggle DevTools', shortcut: 'F12', onClick: () => (window as any).electronAPI?.executeEditAction('toggleDevTools') },
        { type: 'separator' } as MenuItem,
        { label: 'Reset Zoom', shortcut: 'Ctrl+0', onClick: () => (window as any).electronAPI?.executeEditAction('resetZoom') }, 
        { label: 'Zoom In', shortcut: 'Ctrl+=', onClick: () => (window as any).electronAPI?.executeEditAction('zoomIn') },
        { label: 'Zoom Out', shortcut: 'Ctrl+-', onClick: () => (window as any).electronAPI?.executeEditAction('zoomOut') },
        { type: 'separator' } as MenuItem,
        { label: 'Toggle Fullscreen', shortcut: 'F11', onClick: () => (window as any).electronAPI?.toggleFullscreen() },
      ],
    },

    {
      label: 'Help',
      items: [
        { label: "What's New", shortcut: 'F1', onClick: () => onShowChangelog() },
        { type: 'separator' } as MenuItem,
        { label: 'Documentation', onClick: () => (window as any).electronAPI?.openExternal('https://github.com/skkut/AI-Images-Browser#readme') },
        { label: 'Report Bug', onClick: () => (window as any).electronAPI?.openExternal('https://github.com/skkut/AI-Images-Browser/issues/new') },
        { label: 'View on GitHub', onClick: () => (window as any).electronAPI?.openExternal('https://github.com/skkut/AI-Images-Browser') },
        { type: 'separator' } as MenuItem,
        { label: 'About', onClick: () => onOpenSettings('about') },
      ],
    },
  ];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setActiveMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (!isElectron) return null;

  return (
    <div className="flex items-center h-full select-none" ref={menuRef} style={{ WebkitAppRegion: 'no-drag' } as any}>
      {menuData.map((section) => (
        <div key={section.label} className="relative h-full flex items-center">
          <button
            className={`px-3 h-full flex items-center text-[14px] font-medium transition-all duration-150 ${
              activeMenu === section.label ? 'bg-blue-500 text-white' : 'text-gray-400 hover:bg-blue-500 hover:text-white'
            }`}
            style={{ WebkitAppRegion: 'no-drag' } as any}
            onMouseDown={(e) => handleTopLevelMouseDown(e, section.label)}
            onMouseEnter={() => handleTopLevelMouseEnter(section.label)}
          >
            {section.label}
          </button>

          <AnimatePresence>
            {activeMenu === section.label && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: -5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: -5 }}
                transition={{ duration: 0.1 }}
                className="absolute top-full left-0 mt-0.5 min-w-[10rem] w-max bg-gray-900 border border-gray-800 rounded-lg shadow-2xl overflow-hidden py-1 z-50"
                style={{ WebkitAppRegion: 'no-drag', '--header-height': 'env(titlebar-area-height, 44px)' } as any}
              >
                {section.items.map((item, idx) => (
                  item.type === 'separator' ? (
                    <div key={`sep-${idx}`} className="h-px bg-gray-800 my-1 mx-2" />
                  ) : (
                    <button
                      key={item.label}
                      className="w-full flex items-center justify-between px-3.5 py-2 text-sm text-gray-300 hover:bg-blue-500 hover:text-white transition-all duration-150 text-left"
                      style={{ WebkitAppRegion: 'no-drag' } as any}
                      onMouseDown={(e) => handleAction(e, item.onClick!)}
                    >
                      <span className="whitespace-nowrap">{item.label}</span>
                      {item.shortcut && <span className="text-[11px] opacity-60 ml-6 font-mono whitespace-nowrap">{item.shortcut}</span>}
                    </button>
                  )
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
};

export default CustomMenuBar;
