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
  cancelIndexing: vi.fn(),
  getStatus: vi.fn(() => ({ ready: true, indexed: 0, modelId: 'm', dimension: 768, error: null })),
  unloadModels: vi.fn().mockResolvedValue(undefined),
  getModelsStatus: vi.fn(() => ({
    chatLoaded: false,
    embedLoaded: false,
    chatModelId: null,
    embedModelId: null,
    chatVramMb: null,
    embedVramMb: null,
  })),
  dispose: vi.fn(),
}));

vi.mock('../services/semanticSearchEngine', () => ({
  SemanticSearchCoordinator: vi.fn(function SemanticSearchCoordinator() {
    return coordinatorMock;
  }),
  // Model catalogs (Settings → AI Intelligence) — the SettingsModal loads
  // them async via useEffect. Two options each so "defaults to options[0]",
  // "reflects the persisted choice", and "stale id falls back" are distinct.
  getEmbeddingModelOptions: vi.fn().mockResolvedValue([
    { modelId: 'embed-768', dimension: 768, label: 'Arctic Embed M (768d)', vram: '~0.5 GB', description: 'default' },
    { modelId: 'embed-384', dimension: 384, label: 'Arctic Embed S (384d)', vram: '~0.3 GB', description: 'light' },
  ]),
  getTagModelOptions: vi.fn().mockResolvedValue([
    { modelId: 'tag-hermes', label: 'Hermes 3 3B', vram: '~2.0 GB', tier: 'mid', description: 'default' },
    { modelId: 'tag-qwen', label: 'Qwen3 4B', vram: '~2.6 GB', tier: 'mid', description: 'big' },
  ]),
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
    semanticMode: 'off',
    semanticSearchStatus: 'idle',
    semanticIndexProgress: null,
    semanticIndexedCount: 0,
    semanticLastError: null,
    detectedGpuInfo: null,
    detectedGpuDevices: [],
  });
  useSettingsStore.setState({
    licenseStatus: 'unchecked',
    licenseKey: '',
    licenseLastValidated: 0,
    licenseStamp: '',
    isSemanticSearchEnabled: false,
    aiEmbeddingModel: '',
    aiTagModel: '',
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
    expect(useImageStore.getState().semanticMode).toBe('off');

    // Let the subscription-triggered Δ-index run (fired when the pref was
    // set true above) settle so nothing leaks into the next test.
    await flush();
  });

  it('toggling the sparkle off drops the hits so the Semantic chip disappears', async () => {
    setElectronAPI();
    stampPremium();
    useSettingsStore.setState({ isSemanticSearchEnabled: true });
    useImageStore.setState({
      searchQuery: 'fox',
      semanticMode: 'semantic',
      semanticSearchStatus: 'ready',
      semanticHits: [{ imageId: '1', score: 0.9 }],
    });

    render(
      <TopMenuBar
        onOpenSettings={vi.fn()}
        onAddFolder={vi.fn()}
        onToggleView={vi.fn()}
        searchQuery="fox"
        setSearchQuery={vi.fn()}
        activeView="library"
        onLibraryViewChange={vi.fn()}
      />,
    );
    render(<ActiveFilters />);
    expect(screen.getByText('Semantic')).toBeDefined();

    fireEvent.click(screen.getByTestId('semantic-toggle-button'));

    // The chip lives only while hits are on screen; the toggle-off must
    // clear them (reversal regression), not just flip the mode.
    expect(useImageStore.getState().semanticMode).toBe('off');
    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(screen.queryByText('Semantic')).toBeNull();

    await flush();
  });
});

// ── ActiveFilters (chip) ──────────────────────────────────────────────

describe('ActiveFilters semantic chip (Phase 6)', () => {
  it('shows the chip while hits exist and the X clears the hits AND turns the sparkle off', () => {
    useImageStore.setState({
      searchQuery: 'cat',
      semanticHits: [{ imageId: '1', score: 0.9 }],
      semanticMode: 'semantic',
    });
    render(<ActiveFilters />);

    expect(screen.getByText('Semantic')).toBeDefined();

    fireEvent.click(screen.getByLabelText('Clear semantic search'));

    expect(useImageStore.getState().semanticHits).toBeNull();
    expect(useImageStore.getState().semanticMode).toBe('off'); // sparkle clears
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

  it('renders a cancel button that fires onCancelSemanticIndex', () => {
    useImageStore.setState({ semanticIndexProgress: { current: 2, total: 4, message: 'embedding' } });
    const onCancelSemanticIndex = vi.fn();
    render(
      <Footer
        viewMode="grid"
        onViewModeChange={vi.fn()}
        onCancelSemanticIndex={onCancelSemanticIndex}
      />,
    );

    fireEvent.click(screen.getByLabelText('Cancel semantic indexing'));
    expect(onCancelSemanticIndex).toHaveBeenCalledTimes(1);
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

  it('lists every detected GPU with the active one marked, plus a divergent inference report', () => {
    setElectronAPI();
    stampPremium();

    const { container, rerender } = render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));

    act(() => {
      useImageStore.setState({
        detectedGpuDevices: [
          { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
          { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
        ],
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);

    // Assert against the readout's normalized text: row text spans several
    // text nodes (vendor, dash, device, marker span), which RTL's element
    // matcher splits on.
    const readout = container.querySelector('[data-testid="detected-gpu-readout"]');
    expect(readout).not.toBeNull();
    const text = (readout!.textContent ?? '').replace(/\s+/g, ' ').trim();
    expect(text).toContain('Detected GPUs');
    expect(text).toContain('AMD — Radeon(TM) Graphics (active)'); // active card marked
    expect(text).toContain('NVIDIA — GeForce RTX 4090');
    expect(text).not.toContain('NVIDIA — GeForce RTX 4090 (active)'); // other card not

    // A worker report matching a listed card adds no inference line…
    act(() => {
      useImageStore.setState({
        detectedGpuInfo: { vendor: 'NVIDIA', device: 'GeForce RTX 4090', preference: 'high-performance' },
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);
    expect(screen.queryByText(/Inference GPU/)).toBeNull();

    // …but a card outside the main-process list is surfaced separately.
    act(() => {
      useImageStore.setState({
        detectedGpuInfo: { vendor: 'Intel', device: 'Arc A770', preference: 'high-performance' },
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);
    expect(screen.getByText(/Inference GPU \(last model load\): Intel — Arc A770/)).toBeDefined();
  });

  it('replaces the generic class options with the detected GPU names', () => {
    setElectronAPI();
    stampPremium();

    const { rerender } = render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));

    act(() => {
      useImageStore.setState({
        detectedGpuDevices: [
          { vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true },
          { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: false },
          // Vendor that classifies to 'auto' — keeps its own entry, replaces nothing.
          { vendor: 'Microsoft', device: 'Basic Render Driver', active: false },
        ],
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);

    const select = screen.getByTestId('ai-device-preference-select') as HTMLSelectElement;
    // auto + one option per detected card + software — the generic
    // high/low entries are REPLACED, not duplicated. Cards render grouped
    // by class (discrete group, then integrated, then unrecognized).
    expect(select.options.length).toBe(5);
    expect(select.options[1].textContent).toBe('GeForce RTX 4090 (discrete)');
    expect(select.options[1].value).toBe('NVIDIA|GeForce RTX 4090');
    expect(select.options[2].textContent).toBe('Radeon(TM) Graphics (integrated)');
    expect(select.options[2].value).toBe('AMD|Radeon(TM) Graphics');
    expect(select.options[3].textContent).toBe('Basic Render Driver (auto)');
    expect(select.options[3].value).toBe('Microsoft|Basic Render Driver');
    expect(select.options[4].textContent).toBe('Software rendering (SwiftShader, for debugging)');

    const texts = Array.from(select.options).map((o) => o.textContent);
    expect(texts.some((t) => t?.includes('prefer discrete'))).toBe(false);
    expect(texts.some((t) => t?.includes('prefer integrated'))).toBe(false);
  });

  it('keeps the generic class option when no detected GPU maps to that class', () => {
    setElectronAPI();
    stampPremium();

    const { rerender } = render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));

    // Discrete-only machine: the low-power class has no card, so the generic
    // entry stays selectable.
    act(() => {
      useImageStore.setState({
        detectedGpuDevices: [{ vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: true }],
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);

    const select = screen.getByTestId('ai-device-preference-select') as HTMLSelectElement;
    expect(select.options.length).toBe(4);
    expect(select.options[1].textContent).toBe('GeForce RTX 4090 (discrete)');
    expect(select.options[2].textContent).toBe('Low power — prefer integrated GPU');
    expect(select.options[2].value).toBe('low-power');
  });

  it('picking a detected GPU targets that card and derives the class hint', () => {
    setElectronAPI();
    stampPremium();

    const { rerender } = render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));
    act(() => {
      useImageStore.setState({
        detectedGpuDevices: [
          { vendor: 'NVIDIA', device: 'GeForce RTX 4090', active: true },
        ],
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('ai-device-preference-select'), {
      target: { value: 'NVIDIA|GeForce RTX 4090' },
    });
    expect(useSettingsStore.getState().aiDeviceTarget).toBe('NVIDIA|GeForce RTX 4090');
    expect(useSettingsStore.getState().aiDevicePreference).toBe('high-performance');
  });

  it('re-shows a persisted GPU selection when the card is still detected', () => {
    setElectronAPI();
    stampPremium();

    const { rerender } = render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));
    act(() => {
      useSettingsStore.setState({ aiDeviceTarget: 'AMD|Radeon(TM) Graphics' });
      useImageStore.setState({
        detectedGpuDevices: [{ vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true }],
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);

    const select = screen.getByTestId('ai-device-preference-select') as HTMLSelectElement;
    expect(select.value).toBe('AMD|Radeon(TM) Graphics');
  });

  it('falls back to the class option when the target card is no longer detected', () => {
    setElectronAPI();
    stampPremium();

    const { rerender } = render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));
    act(() => {
      // Card was removed (unplugged / driver change) — the target is stale.
      useSettingsStore.setState({ aiDeviceTarget: 'NVIDIA|GeForce RTX 4090' });
      useImageStore.setState({
        detectedGpuDevices: [{ vendor: 'AMD', device: 'Radeon(TM) Graphics', active: true }],
      });
    });
    rerender(<SettingsModal isOpen onClose={vi.fn()} />);

    const select = screen.getByTestId('ai-device-preference-select') as HTMLSelectElement;
    expect(select.value).toBe('high-performance'); // class survives, card option gone
  });
});

// ── SettingsModal AI Intelligence section (model selection) ────────────

describe('SettingsModal AI Intelligence section (model selection)', () => {
  /** Premium + AI tab + async catalog load (the fetchers resolve in microtasks). */
  const openAiSection = async () => {
    setElectronAPI();
    stampPremium();
    render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));
    await flush();
  };

  it('renders both selects with the catalog options (default = options[0])', async () => {
    await openAiSection();

    const embedding = screen.getByTestId('ai-embedding-model-select') as HTMLSelectElement;
    const tag = screen.getByTestId('ai-tag-model-select') as HTMLSelectElement;
    expect(embedding.options.length).toBe(2);
    expect(embedding.value).toBe('embed-768');
    expect(tag.options.length).toBe(2);
    expect(tag.value).toBe('tag-hermes');
  });

  it('embedding change persists the selection (via applySemanticEmbeddingModel)', async () => {
    await openAiSection();

    fireEvent.change(screen.getByTestId('ai-embedding-model-select'), {
      target: { value: 'embed-384' },
    });
    await flush(); // the store action persists then force re-indexes

    expect(useSettingsStore.getState().aiEmbeddingModel).toBe('embed-384');
  });

  it('embedding change routes through applySemanticEmbeddingModel', async () => {
    setElectronAPI();
    stampPremium();
    // Spy BEFORE render: zustand replaces the state object on every set(),
    // which would detach a post-render spy.
    const spy = vi
      .spyOn(useImageStore.getState(), 'applySemanticEmbeddingModel')
      .mockResolvedValue(undefined);

    render(<SettingsModal isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'AI Intelligence' }));
    await flush();

    fireEvent.change(screen.getByTestId('ai-embedding-model-select'), {
      target: { value: 'embed-384' },
    });

    expect(spy).toHaveBeenCalledWith('embed-384');
    spy.mockRestore(); // leave the real implementation for later tests
  });

  it('tag change persists via setAiTagModel (next run picks it up)', async () => {
    await openAiSection();

    fireEvent.change(screen.getByTestId('ai-tag-model-select'), {
      target: { value: 'tag-qwen' },
    });

    expect(useSettingsStore.getState().aiTagModel).toBe('tag-qwen');
  });

  it('selects reflect persisted choices on open', async () => {
    useSettingsStore.setState({ aiEmbeddingModel: 'embed-384', aiTagModel: 'tag-qwen' });
    await openAiSection();

    expect((screen.getByTestId('ai-embedding-model-select') as HTMLSelectElement).value)
      .toBe('embed-384');
    expect((screen.getByTestId('ai-tag-model-select') as HTMLSelectElement).value)
      .toBe('tag-qwen');
  });

  it('a stale persisted id falls back to the first catalog option (never a blank select)', async () => {
    useSettingsStore.setState({ aiEmbeddingModel: 'embed-unknown-old-version' });
    await openAiSection();

    expect((screen.getByTestId('ai-embedding-model-select') as HTMLSelectElement).value)
      .toBe('embed-768');
  });
});

// ── SettingsModal Reprocess Images button (Cache Management) ────────────

describe('SettingsModal Reprocess Images button', () => {
  it('sits between Clear Auto-Tags and Clear All Cache in Cache Management', () => {
    render(<SettingsModal isOpen onClose={vi.fn()} onReprocessImages={vi.fn()} />);

    const section = screen.getByText('Cache Management').closest('section') as HTMLElement;
    const labels = Array.from(section.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels.indexOf('Clear Auto-Tags')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Reprocess Images')).toBe(labels.indexOf('Clear Auto-Tags') + 1);
    expect(labels.indexOf('Clear All Cache')).toBe(labels.indexOf('Reprocess Images') + 1);
  });

  it('confirms the destructive action before calling onReprocessImages', async () => {
    const onReprocessImages = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettingsModal isOpen onClose={vi.fn()} onReprocessImages={onReprocessImages} />);
    fireEvent.click(screen.getByRole('button', { name: /Reprocess Images/ }));

    await flush();
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/favorites/i));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('CLEARED'));
    expect(onReprocessImages).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('does nothing when the user cancels the confirm', () => {
    const onReprocessImages = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<SettingsModal isOpen onClose={vi.fn()} onReprocessImages={onReprocessImages} />);
    fireEvent.click(screen.getByRole('button', { name: /Reprocess Images/ }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(onReprocessImages).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('is disabled while any processing is in flight', () => {
    act(() => {
      useImageStore.setState({ isAutoTagging: true });
    });
    render(<SettingsModal isOpen onClose={vi.fn()} onReprocessImages={vi.fn()} />);
    const button = screen.getByRole('button', { name: /Reprocess Images/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    act(() => {
      useImageStore.setState({ isAutoTagging: false });
    });
  });
});
