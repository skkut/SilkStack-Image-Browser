import { describe, expect, it, vi } from 'vitest';

// SettingsModal reads persisted stores on render — the usual stand-in.
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

// The License tab is lazily loaded from the closed module; About never
// renders it, but the loader is created at import time.
vi.mock('@ai-images-browser/ai-intelligence', () => ({
  LicenseTab: () => <div />,
}));

// SettingsModal statically imports these; a render of another tab must not
// touch the real engines.
vi.mock('../services/semanticSearchEngine', () => ({
  getEmbeddingModelOptions: vi.fn().mockResolvedValue([]),
  getTagModelOptions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SettingsModal from '../components/SettingsModal';

// The About screen is the one surface that must render in EVERY build
// (including the open-source one), so its website link is pinned here.
describe('Settings → About', () => {
  it('opens the product site from the Visit Website button', () => {
    // ipcRenderer.invoke always resolves — the button's `?? window.open`
    // fallback is only for the browser build, so the stub must return a
    // promise or the test would pass through the wrong branch.
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    // The modal calls these two on open — optional chaining guards a missing
    // electronAPI, not a missing method, so the stub needs both.
    (global.window as any).electronAPI = {
      openExternal,
      getDefaultCachePath: vi.fn().mockResolvedValue({ success: false }),
      getAppVersion: vi.fn().mockResolvedValue('0.0.0-test'),
    };

    render(<SettingsModal isOpen onClose={vi.fn()} initialTab="about" />);

    const openSpy = vi.fn();
    (global.window as any).open = openSpy;

    fireEvent.click(screen.getByRole('button', { name: /Visit Website/i }));

    expect(openExternal).toHaveBeenCalledWith('https://skkut.github.io/silkstack/');
    // Electron path taken, browser fallback untouched.
    expect(openSpy).not.toHaveBeenCalled();
  });
});
