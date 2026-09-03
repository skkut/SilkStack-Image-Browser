import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// The tester is a pure harness: aiBridge + the catalog accessor are mocked,
// and the settings store is stubbed to a hoisted value so the picker's
// "default to the Settings model" seed is controllable per test without
// touching the real persisted store.
const state = vi.hoisted(() => {
  const HERMES_ID = 'Hermes-3-Llama-3.2-3B-q4f16_1-MLC';
  const hermes = {
    modelId: HERMES_ID,
    label: 'Hermes 3 3B (default)',
    description: 'd',
    vram: '~2.3 GB',
    tier: 'low' as const,
  };
  const mid = {
    modelId: 'mid-trial-model',
    label: 'Mid Trial',
    description: 'd',
    vram: '~4 GB',
    tier: 'mid' as const,
  };
  const gemma = {
    modelId: 'gemma-4-e2b-test',
    label: 'Gemma 4 E2B (community test)',
    description: 'd',
    vram: '~5.4 GB',
    tier: 'high' as const,
  };
  return {
    HERMES_ID,
    hermes,
    mid,
    gemma,
    aiTagModelValue: '',
    isAiAvailable: vi.fn(),
    getAiLoadError: vi.fn(),
    createLLMTagGenerator: vi.fn(),
    getTagModelOptions: vi.fn(),
    fakeGen: {
      dispose: vi.fn(),
      generateFlatTags: vi.fn(),
      lastRawResponse: '',
      lastSynonyms: null,
    },
  };
});

vi.mock('../services/aiBridge', () => ({
  TAG_GENERATION_MODEL_ID: state.HERMES_ID,
  TAGS_PROMPT: 'FAKE SYSTEM PROMPT',
  MAX_TAGS_PER_IMAGE: 15,
  MAX_SYNONYMS_PER_IMAGE: 6,
  MAX_CATEGORIES_PER_IMAGE: 4,
  isAiAvailable: state.isAiAvailable,
  getAiLoadError: state.getAiLoadError,
  createLLMTagGenerator: state.createLLMTagGenerator,
}));

vi.mock('../services/semanticSearchEngine', () => ({
  getTagModelOptions: state.getTagModelOptions,
}));

vi.mock('../store/useSettingsStore', () => ({
  useSettingsStore: { getState: () => ({ aiTagModel: state.aiTagModelValue }) },
}));

import DevAutoTaggingTester from '../components/DevAutoTaggingTester';

function modelSelect(): HTMLSelectElement {
  return screen.getByLabelText('Auto-tag model') as HTMLSelectElement;
}

describe('DevAutoTaggingTester model picker', () => {
  beforeEach(() => {
    state.aiTagModelValue = '';
    state.isAiAvailable.mockReset().mockResolvedValue(true);
    state.getAiLoadError.mockReset().mockResolvedValue(null);
    state.createLLMTagGenerator.mockReset().mockResolvedValue(state.fakeGen);
    state.fakeGen.dispose.mockReset();
    state.fakeGen.generateFlatTags.mockReset();
    state.getTagModelOptions
      .mockReset()
      .mockResolvedValue([state.hermes, state.mid, state.gemma]);
    // jsdom lacks matchMedia; the tester's theme effect needs it.
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
  });

  it('defaults to the Settings auto-tag model when one is set', async () => {
    state.aiTagModelValue = state.mid.modelId;
    render(<DevAutoTaggingTester />);

    await waitFor(() => expect(state.getTagModelOptions).toHaveBeenCalled());
    expect(modelSelect().value).toBe(state.mid.modelId);
  });

  it('falls back to the stock default when Settings has no auto-tag model', async () => {
    render(<DevAutoTaggingTester />);

    await waitFor(() => expect(state.getTagModelOptions).toHaveBeenCalled());
    expect(modelSelect().value).toBe(state.HERMES_ID);
  });

  it('offers the whole catalog tier-grouped, community trial entry included', async () => {
    render(<DevAutoTaggingTester />);

    await waitFor(() => expect(state.getTagModelOptions).toHaveBeenCalled());
    const select = modelSelect();
    expect(select.options.length).toBe(3);
    // Tier optgroups mirror Settings → AI Intelligence.
    const optgroupLabels = [...select.querySelectorAll('optgroup')].map(
      (g) => (g as HTMLOptGroupElement).label,
    );
    expect(optgroupLabels).toEqual(['Low VRAM', 'Mid VRAM', 'High VRAM']);
    expect(
      screen.getByRole('option', {
        name: `${state.gemma.label} · ${state.gemma.vram}`,
      }),
    ).toBeTruthy();
  });

  it('loads the selected model; switching while loaded disposes and returns to idle', async () => {
    render(<DevAutoTaggingTester />);
    await waitFor(() => expect(state.getTagModelOptions).toHaveBeenCalled());

    // Load the (default) Hermes model.
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await waitFor(() =>
      expect(state.createLLMTagGenerator).toHaveBeenCalledWith(
        state.HERMES_ID,
        expect.any(Function),
      ),
    );
    // Ready: the Load button is replaced by the status dot.
    expect(screen.queryByRole('button', { name: 'Load models' })).toBeNull();

    // Switch to the community Gemma trial — engine dies, back to idle.
    fireEvent.change(modelSelect(), { target: { value: state.gemma.modelId } });
    expect(state.fakeGen.dispose).toHaveBeenCalledTimes(1);
    expect(modelSelect().value).toBe(state.gemma.modelId);
    expect(
      screen.getByRole('button', { name: 'Load models' }),
    ).toBeTruthy();

    // The new Load uses the freshly selected model id.
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await waitFor(() =>
      expect(state.createLLMTagGenerator).toHaveBeenLastCalledWith(
        state.gemma.modelId,
        expect.any(Function),
      ),
    );
  });
});
