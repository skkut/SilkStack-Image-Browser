import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AiModelCacheSection } from '../components/AiModelCacheSection';
import type { CachedModelGroup, CachedModelSummary } from '../services/modelCache';

// The section reads the real Cache API through the service — mocked here so
// the component can be driven to every state (jsdom has no `caches`).
const service = vi.hoisted(() => ({
  listCachedModels: vi.fn(),
  deleteCachedModel: vi.fn(),
}));

vi.mock('../services/modelCache', () => ({
  listCachedModels: service.listCachedModels,
  deleteCachedModel: service.deleteCachedModel,
  RUNTIME_LABEL: 'Shared runtime files',
}));

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** Mirror of the component's slugify — testids drop dots/slashes. */
const slug = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '-');
const rowId = (label: string) => `ai-model-cache-row-${slug(label)}`;
const sizeId = (label: string) => `ai-model-cache-size-${slug(label)}`;

const makeGroup = (overrides: Partial<CachedModelGroup> & { label: string }): CachedModelGroup => ({
  id: overrides.label,
  kind: 'model',
  bytes: 0,
  fileCount: 0,
  hasUnknownSize: false,
  ...overrides,
});

const okSummary = (groups: CachedModelGroup[], overrides?: Partial<CachedModelSummary>): CachedModelSummary => ({
  supported: true,
  reason: 'ok',
  groups,
  totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0),
  hasUnknownSize: groups.some((group) => group.hasUnknownSize),
  ...overrides,
});

const EMBED_8B = makeGroup({
  label: 'qwen3-embedding-8b-q4f16_1-MLC',
  bytes: 4_100_000_000,
  fileCount: 111,
});
const HERMES = makeGroup({
  label: 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC',
  bytes: 1_900_000_000,
  fileCount: 11,
});
const RUNTIME = makeGroup({ label: 'Shared runtime files', kind: 'other', bytes: 30_000_000, fileCount: 2 });

const WARNING_TEXT = /Models deleted from disk will be re-downloaded from the internet when used again\./;

beforeEach(() => {
  vi.clearAllMocks();
  service.listCachedModels.mockResolvedValue(okSummary([]));
  service.deleteCachedModel.mockResolvedValue({ removed: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AiModelCacheSection', () => {
  it('shows the loading state while the summary is pending', () => {
    service.listCachedModels.mockReturnValue(new Promise(() => {}));
    render(<AiModelCacheSection />);
    expect(screen.getByTestId('ai-model-cache-loading')).toBeDefined();
    expect(screen.queryByTestId('ai-model-cache-warning')).toBeNull();
  });

  it('lists cached models with sizes, counts and the re-download warning', async () => {
    service.listCachedModels.mockResolvedValue(okSummary([EMBED_8B, HERMES]));
    render(<AiModelCacheSection />);

    expect(await screen.findByRole('heading', { name: 'Cached model files' })).toBeDefined();
    expect(screen.getByTestId('ai-model-cache-warning').textContent).toMatch(WARNING_TEXT);

    const embedRow = screen.getByTestId('ai-model-cache-row-qwen3-embedding-8b-q4f16_1-MLC');
    expect(embedRow.textContent).toContain('111 files');
    expect(screen.getByTestId('ai-model-cache-size-qwen3-embedding-8b-q4f16_1-MLC').textContent).toBe('3.8 GB');
    expect(screen.getByTestId(sizeId('Hermes-3-Llama-3.2-3B-q4f16_1-MLC')).textContent).toBe('1.8 GB');

    // 111 + 11 files · 6.0e9 bytes = 5.6 GB
    expect(screen.getByTestId('ai-model-cache-total').textContent).toBe('122 files · 5.6 GB');
    expect(screen.queryByTestId('ai-model-cache-empty')).toBeNull();
  });

  it('renders partial and fully-unknown sizes with their flags', async () => {
    const partial = makeGroup({ label: 'qwen3-embedding-4b-q4f16_1-MLC-b2', bytes: 100, hasUnknownSize: true });
    const unknown = makeGroup({ label: 'stale-test-model', bytes: 0, fileCount: 4, hasUnknownSize: true });
    service.listCachedModels.mockResolvedValue(okSummary([partial, unknown], { hasUnknownSize: true }));
    render(<AiModelCacheSection />);

    await screen.findByTestId('ai-model-cache-row-stale-test-model');
    expect(screen.getByTestId('ai-model-cache-size-qwen3-embedding-4b-q4f16_1-MLC-b2').textContent).toBe('≥ 100 B');
    expect(screen.getByTestId('ai-model-cache-size-stale-test-model').textContent).toBe('size unknown');
    // Both rows carry the "some sizes unknown" subtitle; totals note the gap.
    expect(screen.getByTestId('ai-model-cache-total').textContent).toContain('(+ files of unknown size)');
  });

  it('shows shared runtime files read-only, without a delete button', async () => {
    service.listCachedModels.mockResolvedValue(okSummary([EMBED_8B, RUNTIME]));
    render(<AiModelCacheSection />);

    await screen.findByTestId('ai-model-cache-row-Shared-runtime-files');
    const row = screen.getByTestId('ai-model-cache-row-Shared-runtime-files');
    expect(row.textContent).toContain('shared');
    expect(row.querySelector('[data-testid="ai-model-cache-delete-Shared-runtime-files"]')).toBeNull();
    expect(screen.getByTestId('ai-model-cache-delete-qwen3-embedding-8b-q4f16_1-MLC')).toBeDefined();
  });

  it('shows the empty state when nothing is cached', async () => {
    service.listCachedModels.mockResolvedValue(okSummary([]));
    render(<AiModelCacheSection />);

    expect(await screen.findByTestId('ai-model-cache-empty')).toBeDefined();
    expect(screen.getByTestId('ai-model-cache-empty').textContent).toContain('No cached models');
    expect(screen.getByTestId('ai-model-cache-warning')).toBeDefined();
    expect(screen.getByTestId('ai-model-cache-total').textContent).toBe('0 files · 0 B');
  });

  it('shows the unavailable notice when the Cache API is not exposed', async () => {
    service.listCachedModels.mockResolvedValue({
      supported: false, reason: 'unavailable', groups: [], totalBytes: 0, hasUnknownSize: false,
    });
    render(<AiModelCacheSection />);

    expect(await screen.findByTestId('ai-model-cache-unavailable')).toBeDefined();
    expect(screen.queryByTestId('ai-model-cache-warning')).toBeNull();
  });

  it('surfaces enumeration errors verbatim', async () => {
    service.listCachedModels.mockResolvedValue({
      supported: false, reason: 'error', message: 'boom', groups: [], totalBytes: 0, hasUnknownSize: false,
    });
    render(<AiModelCacheSection />);

    expect(await screen.findByTestId('ai-model-cache-error')).toBeDefined();
    expect(screen.getByTestId('ai-model-cache-error').textContent).toContain('boom');
  });

  it('deletes a model after confirmation and refreshes the list', async () => {
    service.listCachedModels
      .mockResolvedValueOnce(okSummary([EMBED_8B, HERMES]))
      .mockResolvedValueOnce(okSummary([HERMES]));
    let resolveDelete!: (value: { removed: number }) => void;
    service.deleteCachedModel.mockReturnValue(new Promise((resolve) => { resolveDelete = resolve; }));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<AiModelCacheSection />);
    await screen.findByTestId('ai-model-cache-row-qwen3-embedding-8b-q4f16_1-MLC');

    fireEvent.click(screen.getByTestId('ai-model-cache-delete-qwen3-embedding-8b-q4f16_1-MLC'));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('qwen3-embedding-8b-q4f16_1-MLC'));
    expect(service.deleteCachedModel).toHaveBeenCalledWith('qwen3-embedding-8b-q4f16_1-MLC');
    // Busy: the row's button is disabled while the deletion is pending.
    const deleteButton = screen.getByTestId('ai-model-cache-delete-qwen3-embedding-8b-q4f16_1-MLC') as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    await act(async () => {
      resolveDelete({ removed: 111 });
      await flush();
    });

    expect(service.listCachedModels).toHaveBeenCalledTimes(2); // mount + refresh
    expect(screen.queryByTestId('ai-model-cache-row-qwen3-embedding-8b-q4f16_1-MLC')).toBeNull();
    expect(screen.getByTestId(rowId('Hermes-3-Llama-3.2-3B-q4f16_1-MLC'))).toBeDefined();
    expect(screen.queryByTestId('ai-model-cache-delete-qwen3-embedding-8b-q4f16_1-MLC')).toBeNull();
  });

  it('does nothing when the confirmation is declined', async () => {
    service.listCachedModels.mockResolvedValue(okSummary([EMBED_8B]));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AiModelCacheSection />);
    await screen.findByTestId('ai-model-cache-row-qwen3-embedding-8b-q4f16_1-MLC');

    fireEvent.click(screen.getByTestId('ai-model-cache-delete-qwen3-embedding-8b-q4f16_1-MLC'));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(service.deleteCachedModel).not.toHaveBeenCalled();
    expect(screen.getByTestId('ai-model-cache-row-qwen3-embedding-8b-q4f16_1-MLC')).toBeDefined();
  });

  it('shows an inline error and re-lists when the deletion fails', async () => {
    service.listCachedModels
      .mockResolvedValueOnce(okSummary([EMBED_8B]))
      .mockResolvedValueOnce(okSummary([EMBED_8B]));
    service.deleteCachedModel.mockRejectedValue(new Error('cache gone'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<AiModelCacheSection />);
    await screen.findByTestId('ai-model-cache-row-qwen3-embedding-8b-q4f16_1-MLC');

    await act(async () => {
      fireEvent.click(screen.getByTestId('ai-model-cache-delete-qwen3-embedding-8b-q4f16_1-MLC'));
      await flush();
    });

    expect(consoleError).toHaveBeenCalled();
    expect(screen.getByText(/Failed to delete the cached files/)).toBeDefined();
    expect(service.listCachedModels).toHaveBeenCalledTimes(2); // mount + refresh after failure
    expect(screen.getByTestId('ai-model-cache-row-qwen3-embedding-8b-q4f16_1-MLC')).toBeDefined();
  });
});
