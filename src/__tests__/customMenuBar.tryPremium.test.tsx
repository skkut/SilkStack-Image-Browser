import { describe, expect, it, vi, beforeEach } from 'vitest';

// The menu bar reads the persisted settings store (license gate for the Undo
// item), so it needs the same localStorage stand-in every persisted-store
// suite carries.
vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CustomMenuBar from '../components/CustomMenuBar';

// Help → "Try Premium" must land on the Settings License tab. The item only
// exists when the license surface does (the AI module was in the build), so
// the suite is skipped in the no-module path — same convention as the other
// module-dependent suites.
describe.skipIf(!import.meta.env.VITE_AI_FEATURES_AVAILABLE)(
  'CustomMenuBar — Help menu',
  () => {
    beforeEach(() => {
      // The bar renders only when the Electron bridge is present.
      (global.window as any).electronAPI = {};
    });

    const openHelpMenu = () => {
      // Menus open on mousedown (not click) — the handler is onMouseDown.
      fireEvent.mouseDown(screen.getByText('Help'));
    };

    it('routes Try Premium to the License tab', () => {
      const onOpenSettings = vi.fn();
      render(
        <CustomMenuBar
          onOpenSettings={onOpenSettings}
          onAddFolder={vi.fn()}
          onToggleView={vi.fn()}
        />,
      );

      openHelpMenu();
      fireEvent.mouseDown(screen.getByText('Try Premium'));

      expect(onOpenSettings).toHaveBeenCalledWith('license');
    });

    it('routes About to the About tab', () => {
      const onOpenSettings = vi.fn();
      render(
        <CustomMenuBar
          onOpenSettings={onOpenSettings}
          onAddFolder={vi.fn()}
          onToggleView={vi.fn()}
        />,
      );

      openHelpMenu();
      fireEvent.mouseDown(screen.getByText('About'));

      expect(onOpenSettings).toHaveBeenCalledWith('about');
    });
  },
);
