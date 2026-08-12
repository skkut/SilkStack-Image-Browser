import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue('true'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

// The store lazy-loads the coordinator via dynamic import — every `new
// SemanticSearchCoordinator(...)` returns the same mock instance (mirrors the
// module-level singleton in useImageStore). Constructable via `function`.
const coordinatorMock = vi.hoisted(() => ({
  ensureInitialized: vi.fn().mockResolvedValue(undefined),
  indexImages: vi.fn().mockResolvedValue({ indexed: 0, skipped: 0 }),
  search: vi.fn().mockResolvedValue([]),
  clearIndex: vi.fn().mockResolvedValue(undefined),
  getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
  dispose: vi.fn(),
}));

vi.mock('../services/semanticSearchEngine', () => ({
  SemanticSearchCoordinator: vi.fn(function SemanticSearchCoordinator() {
    return coordinatorMock;
  }),
}));

// The settings subscription fires `semanticIndexImages()` when the pref flips
// on — the annotations store must be inert for that run to complete quietly.
vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

// ai-intelligence package — not rendered on the general tab, but the real
// aiBridge module statically imports the engine factories from it.
vi.mock('@ai-images-browser/ai-intelligence', () => ({
  createStackingEngine: vi.fn(),
  createAutoTaggingEngine: vi.fn(),
  createSemanticSearchEngine: vi.fn(),
  createRerankEngine: vi.fn(),
  createEmbeddingEngine: vi.fn(),
  StackCard: () => null,
  SimilarityStackExpandedView: () => null,
}));

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SearchBar from '../components/SearchBar';
import TopMenuBar from '../components/TopMenuBar';
import ActiveFilters from '../components/ActiveFilters';
import Footer from '../components/Footer';
import SettingsModal from '../components/SettingsModal';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';

/** Drain the microtask queue so fire-and-forget chains (the settings
 *  subscription → semanticIndexImages → coordinator) complete. */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Real premium gate: valid license + matching HMAC stamp (SmartLibrary
 *  pattern). `useSemanticSearchEnabled()` also needs the user pref. */
const stampPremium = () => {
  const now = Date.now();
  useSettingsStore.setState({
    licenseStatus: 'valid',
    licenseKey: 'TEST-KEY',
    licenseLastValidated: now,
    licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', now),
  });
};

const setElectronAPI = () => {
  if (typeof global.window !== 'undefined') {
    (global.window as any).electronAPI = {
      openImageViewer: vi.fn(),
      isDev: vi.fn().mockResolvedValue(false),
      getDefaultCachePath: vi.fn().mockResolvedValue({ success: true, path: 'C:/cache' }),
      getAppVersion: vi.fn().mockResolvedValue('9.9.9'),
    };
  }
};

beforeEach(() => {
  vi.clearAllMocks(); // clears records, keeps implementations
  useImageStore.setState({
    images: [],
    filteredImages: [],
    annotations: new Map(),
    isAnnotationsLoaded: true, // the Δ-index defers until annotations load
    directories: [],
    selectedFolders: new Set(),
    excludedFolders: new Set(),
    searchQuery: '',
    semanticHits: null,
    semanticMode: 'auto',
    semanticSearchStatus: 'idle',
    semanticIndexProgress: null,
    semanticIndexedCount: 0,
    semanticLastError: null,
    detectedGpuInfo: null,
  });
  useSettingsStore.setState({
    licenseStatus: 'unchecked',
    licenseKey: '',
    licenseLastValidated: 0,
    licenseStamp: '',
    isSemanticSearchEnabled: false,
  });
});

// ── SearchBar (presentational) ────────────────────────────────────────

describe('SearchBar semantic toggle (Phase 6)', () => {
  it('hides the toggle when semantic search is not available', () => {
    render(<SearchBar value="cat" onChange={vi.fn()} />);
    expect(screen.queryByTestId('semantic-toggle-button')).toBeNull();
    expect((screen.getByTestId('search-input') as HTMLInputElement).placeholder).toBe('Search');
  });

  it('shows the toggle with the active glow and semantic placeholder when active', () => {
    render(
      <SearchBar value="cat" onChange={vi.fn()} semanticAvailable semanticMode="semantic" onToggleSemantic={vi.fn()} />,
    );
    const toggle = screen.getByTestId('semantic-toggle-button');
    expect(toggle.className).toContain('text-purple-400');
    expect(toggle.className).toContain('shadow-[0_0_10px_rgba(168,85,247,0.4)]');
    expect((screen.getByTestId('search-input') as HTMLInputElement).placeholder).toBe('Search (semantic)');
  });

  it('shows the loading spinner and the tooltip while a search is running', () => {
    const { container } = render(
      <SearchBar value="cat" onChange={vi.fn()} semanticAvailable semanticStatus="loading" onToggleSemantic={vi.fn()} />,
    );
    const toggle = screen.getByTestId('semantic-toggle-button');
    expect(toggle.title).toBe('Semantic search (AI)');
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('fires onToggleSemantic when clicked', () => {
    const onToggleSemantic = vi.fn();
    render(<SearchBar value="cat" onChange={vi.fn()} semanticAvailable onToggleSemantic={onToggleSemantic} />);
    fireEvent.click(screen.getByTestId('semantic-toggle-button'));
    expect(onToggleSemantic).toHaveBeenCalledTimes(1);
  });
});

// ── TopMenuBar (wiring) ───────────────────────────────────────────────

describe('TopMenuBar semantic wiring (Phase 6)', () => {
  it('passes store state to SearchBar and flips the mode on click', async () => {
    setElectronAPI();
    stampPremium();
    useSettingsStore.setState({ isSemanticSearchEnabled: true });

    render(
      <TopMenuBar
        onOpenSettings={vi.fn()}
        onAddFolder={vi.fn()}
        onToggleView={vi.fn()}
        searchQuery=""
        setSearchQuery={vi.fn()}
        activeView="library"
        onLibraryViewChange={vi.fn()}
      />,
    );

    // Toggle visible only via the full gate (module + stamp + pref)
    const toggle = screen.getByTestId('semantic-toggle-button');
    expect((screen.getByTestId('search-input') as HTMLInputElement).placeholder).toBe('Search');

    fireEvent.click(toggle);
    expect(useImageStore.getState().semanticMode).toBe('semantic');
    expect((screen.getByTestId('search-input') as HTMLInputElement).placeholder).toBe('Search (semantic)');

    fireEvent.click(toggle);
    expect(useImageStore.getState().semanticMode).toBe('auto');

    // Let the subscription-triggered Δ-index run (fired when the pref was
    // set true above) settle so nothing leaks into the next test.
    await flush();
  });
});

// ── ActiveFilters (chip) ──────────────────────────────────────────────

describe('ActiveFilters semantic chip (Phase 6)', () => {
  it('shows the chip while hits exist and the X clears only the hits', () => {
    useImageStore.setState({ searchQuery: 'cat', semanticHits: [{ imageId: '1', score: 0.9 }] });
    render(<ActiveFilters />);

    expect(screen.getByText('Semantic')).toBeDefined();

    fireEvent.click(screen.getByLabelText('Clear semantic search'));

    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(useImageStore.getState().searchQuery).toBe('cat'); // query survives
    expect(screen.queryByText('Semantic')).toBeNull();
    expect(screen.getByText('"cat"')).toBeDefined(); // search chip persists
  });

  it('renders nothing when there are no hits or other filters', () => {
    const { container } = render(<ActiveFilters />);
    expect(container.innerHTML).toBe('');
  });
});

// ── Footer (progress pill) ────────────────────────────────────────────

describe('Footer semantic indexing pill (Phase 6)', () => {
  const renderFooter = () => render(<Footer viewMode="grid" onViewModeChange={vi.fn()} />);

  it('shows the pill with the indigo bar while a run is active', () => {
    useImageStore.setState({ semanticIndexProgress: { current: 1, total: 4, message: 'embedding' } });
    const { container } = renderFooter();

    expect(screen.getByText(/Semantic indexing 1\/4/)).toBeDefined();
    expect(screen.getByText(/embedding/)).toBeDefined();
    expect(container.querySelector('.bg-indigo-500')).not.toBeNull();
  });

  it('hides the pill once the run clears', () => {
    useImageStore.setState({ semanticIndexProgress: { current: 1, total: 4, message: 'embedding' } });
    const { rerender } = renderFooter();
    expect(screen.getByText(/Semantic indexing 1\/4/)).toBeDefined();

    useImageStore.setState({ semanticIndexProgress: null });
    rerender(<Footer viewMode="grid" onViewModeChange={vi.fn()} />);

    expect(screen.queryByText(/Semantic indexing/)).toBeNull();
  });
});

// ── SettingsModal (premium section) ───────────────────────────────────

describe('SettingsModal semantic section (Phase 6)', () => {
  it('hides the section without a premium license', () => {
    setElectronAPI();
    render(<SettingsModal isOpen onClose={vi.fn()} />);
    expect(screen.queryByText('Semantic search')).toBeNull();
  });

  it('toggles the pref, fires the Δ-index and shows the indexed count', async () => {
    setElectronAPI();
    stampPremium();
    coordinatorMock.getStatus.mockReturnValue({
      ready: true,
      indexed: 42,
      modelId: 'm',
      dimension: 768,
      error: null,
    });

    render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));

    const toggle = screen.getByTestId('semantic-toggle-checkbox') as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);

    expect(useSettingsStore.getState().isSemanticSearchEnabled).toBe(true);
    await flush(); // settings subscription → semanticIndexImages() → coordinator
    expect(useImageStore.getState().semanticIndexedCount).toBe(42);
    expect(screen.getByText('42 images indexed')).toBeDefined();
  });

  it('Re-index calls semanticIndexImages({ force: true }) and is disabled while a run is active', async () => {
    setElectronAPI();
    stampPremium();
    // Spy BEFORE render: zustand replaces the state object on every set(),
    // which would detach a post-render spy.
    const spy = vi.spyOn(useImageStore.getState(), 'semanticIndexImages').mockResolvedValue(undefined);

    render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));

    const button = screen.getByText('Re-index library');
    fireEvent.click(button);

    expect(spy).toHaveBeenCalledWith({ force: true });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    // A running index job disables the button (and spins the icon) — the
    // setState must be act()-wrapped: a bare call schedules the re-render
    // asynchronously (concurrent batching) and the assert would read stale DOM.
    act(() => {
      useImageStore.setState({ semanticIndexProgress: { current: 1, total: 3, message: 'embedding' } });
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── SettingsModal AI Intelligence section (GPU preference) ────────────

describe('SettingsModal AI Intelligence section (GPU preference)', () => {
  it('shows the section with the GPU select when premium', () => {
    setElectronAPI();
    stampPremium();

    render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));

    // The sidebar tab and the pane heading share the label.
    expect(screen.getAllByText('AI Intelligence').length).toBe(2);
    const select = screen.getByTestId('ai-device-preference-select') as HTMLSelectElement;
    expect(select.options.length).toBe(4);
    expect(select.value).toBe('auto');
  });

  it('hides the whole AI Intelligence section without premium', () => {
    setElectronAPI();
    render(<SettingsModal isOpen onClose={vi.fn()} />);

    expect(screen.queryByText('AI Intelligence')).toBeNull();
    expect(screen.queryByRole('button', { name: 'AI Intelligence' })).toBeNull();
    expect(screen.queryByTestId('ai-device-preference-select')).toBeNull();
  });

  it('persists the chosen preference', () => {
    setElectronAPI();
    stampPremium();

    render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));

    fireEvent.change(screen.getByTestId('ai-device-preference-select'), {
      target: { value: 'low-power' },
    });
    expect(useSettingsStore.getState().aiDevicePreference).toBe('low-power');
  });

  it('shows the detected GPU readout when reported, hidden when null', () => {
    setElectronAPI();
    stampPremium();

    const { rerender } = render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));
    expect(screen.queryByText(/NVIDIA/)).toBeNull();

    act(() => {
      useImageStore.setState({
        detectedGpuInfo: { vendor: 'NVIDIA', device: 'RTX 4090', preference: 'auto' },
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText(/NVIDIA — RTX 4090/)).toBeDefined();

    act(() => {
      useImageStore.setState({ detectedGpuInfo: null });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);
    expect(screen.queryByText(/NVIDIA/)).toBeNull();
  });
});
