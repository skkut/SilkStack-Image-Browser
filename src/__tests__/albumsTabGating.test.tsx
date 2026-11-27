import { describe, expect, it, vi, beforeEach } from 'vitest';

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

// The store's lazy premium imports must resolve, but nothing here renders the
// module's components.
vi.mock('@ai-images-browser/ai-intelligence', () => ({
  createAiWorker: vi.fn(),
  StackCard: () => null,
  SimilarityStackExpandedView: () => null,
  AlbumsView: () => null,
  AddToAlbumDialog: () => null,
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import TopMenuBar from '../components/TopMenuBar';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';

const grantLicense = () => {
  const now = Date.now();
  useSettingsStore.setState({
    licenseStatus: 'valid',
    licenseKey: 'TEST-KEY',
    licenseLastValidated: now,
    licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', now),
    licenseProduct: 'lifetime',
  });
};

const revokeLicense = () => {
  useSettingsStore.setState({
    licenseStatus: 'unchecked',
    licenseKey: '',
    licenseLastValidated: 0,
    licenseStamp: '',
    licenseProduct: null,
  });
};

const baseProps = {
  onOpenSettings: vi.fn(),
  onAddFolder: vi.fn(),
  onToggleView: vi.fn(),
  searchQuery: '',
  setSearchQuery: vi.fn(),
  sortOrder: 'date-desc' as const,
  onSortOrderChange: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  (global.window as any).electronAPI = {
    isDev: vi.fn().mockResolvedValue(false),
  };
  revokeLicense();
});

describe('Albums tab gating', () => {
  it('is absent without a premium license', () => {
    render(<TopMenuBar {...baseProps} activeView="library" onLibraryViewChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Library' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stacks' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Albums' })).toBeNull();
  });

  it('appears with a valid license and opens the Albums view', () => {
    grantLicense();
    const onChange = vi.fn();

    render(<TopMenuBar {...baseProps} activeView="library" onLibraryViewChange={onChange} />);

    const albumsTab = screen.getByRole('button', { name: 'Albums' });
    fireEvent.click(albumsTab);

    expect(onChange).toHaveBeenCalledWith('albums');
  });

  it('hides the library search and sort controls in Albums', () => {
    grantLicense();

    render(<TopMenuBar {...baseProps} activeView="albums" onLibraryViewChange={vi.fn()} />);

    expect(screen.queryByPlaceholderText(/search/i)).toBeNull();
    expect(screen.queryByLabelText('Sort:')).toBeNull();
  });
});
