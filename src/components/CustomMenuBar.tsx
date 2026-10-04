
import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useAiFeaturesEnabled, AI_MODULE_AVAILABLE } from '../services/aiFeatureAccess';
import type { SettingsTab } from '../types';

interface MenuItem {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  type?: 'separator';
  disabled?: boolean;
}

interface MenuSection {
  label: string;
  items: MenuItem[];
}

interface CustomMenuBarProps {
  onOpenSettings: (tab?: SettingsTab) => void;
  onAddFolder: () => void;
  onToggleView: () => void;
  onUndo?: () => void;
  hasUndo?: boolean;
}

const CustomMenuBar: React.FC<CustomMenuBarProps> = ({
  onOpenSettings,
  onAddFolder,
  onToggleView,
  onUndo,
  hasUndo = false,
}) => {
  // NOTE: this is the LICENSE gate — the hook is named after the gate, not the
  // master AI switch. The user's manual master toggle (`useAiMasterEnabled`) is
  // deliberately NOT part of it: switching AI features off does not un-buy a
  // license.
  const premiumActive = useAiFeaturesEnabled();
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;

  // Help → "Try Premium" is an upsell for users WITHOUT premium access, so it
  // needs the license surface to exist (no AI module → SettingsModal hides the
  // License tab, leaving nothing to open) AND premium to be locked. A running
  // trial fails the second check — its features are unlocked, so it is not a
  // "free" user either. Only the license decides: the master AI switch stays
  // out of this, so a paying user who turns the features off keeps the item
  // hidden rather than being upsold what they already own.
  const showTryPremium = AI_MODULE_AVAILABLE && !premiumActive;

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
        ...(premiumActive
          ? [
              { label: 'Undo', shortcut: 'Ctrl+Z', onClick: () => onUndo?.(), disabled: !hasUndo } as MenuItem,
              { type: 'separator' as const } as MenuItem,
            ]
          : []),
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
        // Same `showTryPremium` as the native menu below — free users only.
        ...(showTryPremium
          ? [
              { label: 'Try Premium', onClick: () => onOpenSettings('license') } as MenuItem,
              { type: 'separator' } as MenuItem,
            ]
          : []),
        { label: 'Documentation', onClick: () => (window as any).electronAPI?.openExternal('https://github.com/skkut/SilkStack-Image-Browser#readme') },
        { label: 'Report Bug', onClick: () => (window as any).electronAPI?.openExternal('https://github.com/skkut/SilkStack-Image-Browser/issues/new') },
        { label: 'View on GitHub', onClick: () => (window as any).electronAPI?.openExternal('https://github.com/skkut/SilkStack-Image-Browser') },
        { type: 'separator' } as MenuItem,
        { label: 'About', onClick: () => onOpenSettings('about') },
      ],
    },
  ];

  // Mirror the item into the NATIVE Electron menu. Main has no way to compute
  // it, so the renderer — where the decision already lives — pushes it. This
  // component is where that decision is made, which keeps the two Help menus
  // from ever disagreeing.
  useEffect(() => {
    window.electronAPI?.setTryPremiumMenuVisible?.(showTryPremium);
  }, [showTryPremium]);

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
                      disabled={item.disabled}
                      className={`w-full flex items-center justify-between px-3.5 py-2 text-sm transition-all duration-150 text-left ${
                        item.disabled
                          ? 'text-gray-600 cursor-default'
                          : 'text-gray-300 hover:bg-blue-500 hover:text-white'
                      }`}
                      style={{ WebkitAppRegion: 'no-drag' } as any}
                      onMouseDown={(e) => !item.disabled && handleAction(e, item.onClick!)}
                    >
                      <span className="whitespace-nowrap">{item.label}</span>
                      {item.shortcut && <span className={`text-[11px] ml-6 font-mono whitespace-nowrap ${item.disabled ? 'opacity-30' : 'opacity-60'}`}>{item.shortcut}</span>}
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
