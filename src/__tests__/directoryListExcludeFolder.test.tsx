// @vitest-environment jsdom
//
// Right-click → Exclude Folder in the sidebar's subfolder tree.
//
// The exclusion itself is an old store capability (`addExcludedFolder`); what
// these tests pin is the new route to it, and the two rules that make the
// route safe:
//   - the clicked subfolder is the one filed — not its parent, and not a
//     name search that could match a different folder;
//   - library roots do not offer the action, because excluding a root hides
//     its whole library while its row stays on screen with nothing to say so.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// The store reads localStorage at module load — stub it before any import.
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
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import DirectoryList from '../components/DirectoryList';
import { useImageStore } from '../store/useImageStore';
import { normalizePath } from '../utils/pathUtils';
import type { Directory, IndexedImage } from '../types';

const ROOT = 'C:\\Library';
const CATS = 'C:\\Library\\cats';
const DOGS = 'C:\\Library\\dogs';

const rootDirectory: Directory = {
  id: 'root1',
  path: ROOT,
  name: 'Library',
} as Directory;

const image = (id: string): IndexedImage =>
  ({
    id,
    name: id.split('/').pop(),
    handle: {} as FileSystemFileHandle,
    metadata: {},
    metadataString: '',
    lastModified: 0,
    models: [],
    loras: [],
    scheduler: '',
    directoryId: 'root1',
  }) as unknown as IndexedImage;

/** The bridge DirectoryList calls when a node is expanded. */
const stubElectronBridge = () => {
  const bridge = {
    listSubfolders: vi.fn().mockResolvedValue({
      success: true,
      subfolders: [
        { name: 'cats', path: CATS },
        { name: 'dogs', path: DOGS },
      ],
    }),
  };
  (window as any).electronAPI = bridge;
  return bridge;
};

const seedStore = () => {
  useImageStore.setState({
    images: [image('root1::cats/a.png'), image('root1::dogs/b.png')],
    filteredImages: [],
    directories: [rootDirectory],
    folderPreferences: new Map(),
    excludedFolders: new Set(),
    selectedFolders: new Set(),
    selectedModels: [],
    selectedBaseModels: [],
    selectedLoras: [],
    selectedSchedulers: [],
    selectedTags: [],
    searchQuery: '',
    showFavoritesOnly: false,
    sortOrder: 'date-desc',
    annotations: new Map(),
    success: null,
  });
  useImageStore.getState().filterAndSortImages();
};

/**
 * Mirrors the real wiring: `Sidebar` passes the store's `excludedFolders`
 * down to `DirectoryList`, so the tree re-renders without the row when an
 * exclusion lands. Rendering DirectoryList directly with a static prop would
 * see the store change and never update the visible list.
 */
const Harness = () => {
  const excludedFolders = useImageStore((state) => state.excludedFolders);
  return (
    <DirectoryList
      directories={[rootDirectory]}
      onRemoveDirectory={() => {}}
      onUpdateDirectory={() => {}}
      isFolderSelected={() => false}
      scanSubfolders={true}
      excludedFolders={excludedFolders}
    />
  );
};

const renderTree = () => render(<Harness />);

const openMenuFor = async (label: string) => {
  const node = await screen.findByText(label);
  fireEvent.contextMenu(node, { clientX: 40, clientY: 60 });
  return node;
};

describe('DirectoryList → Exclude Folder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubElectronBridge();
    seedStore();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).electronAPI;
  });

  it('lists Exclude Folder on a subfolder and files that exact path', async () => {
    renderTree();
    await openMenuFor('cats');

    fireEvent.click(screen.getByText('Exclude Folder'));

    const excluded = useImageStore.getState().excludedFolders;
    expect(Array.from(excluded)).toEqual([normalizePath(CATS)]);
    // The clicked subfolder leaves the tree; its sibling stays.
    expect(screen.queryByText('cats')).toBeNull();
    expect(screen.getByText('dogs')).toBeTruthy();
  });

  it('explains where an excluded folder can be restored', async () => {
    renderTree();
    await openMenuFor('cats');

    fireEvent.click(screen.getByText('Exclude Folder'));

    expect(useImageStore.getState().success).toContain('"cats" excluded');
    expect(useImageStore.getState().success).toContain('Settings → Folders');
  });

  it('removes the excluded folder\'s images while keeping its siblings', async () => {
    renderTree();
    await openMenuFor('cats');

    fireEvent.click(screen.getByText('Exclude Folder'));

    await waitFor(() => {
      const ids = useImageStore.getState().filteredImages.map((img) => img.id);
      expect(ids).toEqual(['root1::dogs/b.png']);
    });
  });

  it('does not offer the action on a library root', async () => {
    renderTree();

    // The root row's name button carries the context-menu handler.
    fireEvent.contextMenu(screen.getByText('Library'), { clientX: 40, clientY: 60 });

    expect(screen.getByText('Refresh Folder')).toBeTruthy();
    expect(screen.queryByText('Exclude Folder')).toBeNull();
  });
});
