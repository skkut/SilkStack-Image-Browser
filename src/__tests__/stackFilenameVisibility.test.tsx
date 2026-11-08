/**
 * Wiring test for the file-name strip setting in the stack view.
 *
 * The package component is mocked (the ai-intelligence module has no jsdom
 * harness in this repo), so this covers the wrapper layer only: the persisted
 * setting reaches the view as the `alwaysShowFilenames` prop, and a change
 * made in Settings reaches a stack view that is already open — the same
 * store-subscription behaviour the grid card has.
 */
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

/** Records what the wrapper hands to the package component. */
const captured = vi.hoisted(() => ({
  alwaysShowFilenames: undefined as boolean | undefined,
}));

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  SimilarityStackExpandedView: ({ alwaysShowFilenames }: any) => {
    captured.alwaysShowFilenames = alwaysShowFilenames;
    return <div data-testid="mock-expanded-view" />;
  },
}));

import React from 'react';
import { render, screen, act } from '@testing-library/react';
import Wrapper from '../components/SimilarityStackExpandedViewWrapper';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';

const mkImage = (id: string) =>
  ({
    id,
    name: `${id}.png`,
    prompt: 'a cat',
    directoryId: 'dir1',
    lastModified: 1000,
    metadata: {},
    models: [],
    loras: [],
  }) as any;

const renderWrapper = () =>
  render(
    <Wrapper
      images={[mkImage('1'), mkImage('2')] as any}
      onImageClick={vi.fn()}
      selectedImages={new Set<string>()}
      onBack={vi.fn()}
      imageSize={150}
    />,
  );

// The wrapper renders nothing when the module is absent from the build.
describe.skipIf(!import.meta.env.VITE_AI_FEATURES_AVAILABLE)(
  'SimilarityStackExpandedViewWrapper — file names',
  () => {
    beforeEach(() => {
      captured.alwaysShowFilenames = undefined;
      // One timestamp for both fields — see the note in SmartLibrary.test.tsx:
      // a stamp whose Date.now() straddles a millisecond boundary never
      // verifies, and the wrapper then renders nothing.
      const now = Date.now();
      useSettingsStore.setState({
        licenseStatus: 'valid',
        licenseKey: 'TEST-KEY',
        licenseLastValidated: now,
        licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', now),
        displayStarredFirst: false,
        disableThumbnails: true,
        stackGroupByDimensions: ['prompt'],
        stackHighlightPromptVariations: false,
        alwaysShowFilenames: false,
      });
    });

    it('asks for hover-only names by default', async () => {
      renderWrapper();
      await screen.findByTestId('mock-expanded-view');

      expect(captured.alwaysShowFilenames).toBe(false);
    });

    it('asks for always-visible names when the setting is on', async () => {
      useSettingsStore.getState().setAlwaysShowFilenames(true);

      renderWrapper();
      await screen.findByTestId('mock-expanded-view');

      expect(captured.alwaysShowFilenames).toBe(true);
    });

    it('applies a change to a stack view that is already open', async () => {
      renderWrapper();
      await screen.findByTestId('mock-expanded-view');
      expect(captured.alwaysShowFilenames).toBe(false);

      act(() => useSettingsStore.getState().setAlwaysShowFilenames(true));

      expect(captured.alwaysShowFilenames).toBe(true);
    });
  },
);
