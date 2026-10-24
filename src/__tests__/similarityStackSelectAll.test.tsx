/**
 * Wiring test for the stack header's "Select all" control.
 *
 * The package component is mocked (the ai-intelligence module has no jsdom
 * harness in this repo), so these tests cover the wrapper layer only: which
 * handler the button calls, the store fallback it uses when a surface supplies
 * none, and the label it shows once every member is selected.
 *
 * The control is injected through the package's existing `groupByToolbar`
 * slot — the reason this feature needs no edit to MPL-covered source.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  // Both stores read localStorage at module load.
  global.localStorage = {
    getItem: vi.fn().mockReturnValue('true'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Wrapper from '../components/SimilarityStackExpandedViewWrapper';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';
import type { LicenseStatus } from '../services/licenseService';

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  // Mirrors the real header: the toolbar node is rendered in it.
  SimilarityStackExpandedView: ({ groupByToolbar }: any) => (
    <div data-testid="mock-expanded-view">{groupByToolbar}</div>
  ),
}));

/**
 * See SmartLibrary.test.tsx — the stamp is a hash over (key, status, time),
 * so both fields must come from ONE Date.now(). A pair that straddles a
 * millisecond boundary never verifies and the wrapper renders nothing.
 */
const validLicense = (): {
  licenseStatus: LicenseStatus;
  licenseKey: string;
  licenseLastValidated: number;
  licenseStamp: string;
} => {
  const now = Date.now();
  return {
    licenseStatus: 'valid',
    licenseKey: 'TEST-KEY',
    licenseLastValidated: now,
    licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', now),
  };
};

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

interface RenderOptions {
  images?: any[];
  selectedImages?: Set<string>;
  onSelectAll?: () => void;
}

const renderWrapper = ({ images, selectedImages, onSelectAll }: RenderOptions = {}) =>
  render(
    <Wrapper
      images={(images ?? [mkImage('1'), mkImage('2')]) as any}
      onImageClick={vi.fn()}
      selectedImages={selectedImages ?? new Set<string>()}
      onBack={vi.fn()}
      imageSize={150}
      onSelectAll={onSelectAll}
    />,
  );

describe.skipIf(!import.meta.env.VITE_AI_FEATURES_AVAILABLE)(
  'SimilarityStackExpandedViewWrapper — select all',
  () => {
    beforeEach(() => {
      useSettingsStore.setState({
        ...validLicense(),
        displayStarredFirst: false,
        disableThumbnails: true,
        stackGroupByDimensions: ['prompt'],
        stackHighlightPromptVariations: false,
      });
      useImageStore.setState({
        selectedImages: new Set(),
        selectionAnchorId: null,
      });
    });

    it('selects every image in the stack through the store by default', async () => {
      renderWrapper();

      fireEvent.click(await screen.findByRole('button', { name: /select all/i }));

      expect([...useImageStore.getState().selectedImages].sort()).toEqual(['1', '2']);
    });

    it('prefers the surface handler when one is supplied', async () => {
      // The popped-out stack window owns its selection locally; the default
      // store action would be a no-op there.
      const onSelectAll = vi.fn();
      renderWrapper({ onSelectAll });

      fireEvent.click(await screen.findByRole('button', { name: /select all/i }));

      expect(onSelectAll).toHaveBeenCalledTimes(1);
      expect(useImageStore.getState().selectedImages.size).toBe(0);
    });

    it('reports when every image is already selected', async () => {
      renderWrapper({ selectedImages: new Set(['1', '2']) });

      const button = await screen.findByRole('button', { name: /all selected/i });
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('hides the control for a one-image group', async () => {
      renderWrapper({ images: [mkImage('1')] });

      // Wait for the lazy module so this asserts about the control, not about
      // the Suspense fallback.
      await screen.findByTestId('mock-expanded-view');
      expect(screen.queryByRole('button', { name: /select all/i })).toBeNull();
    });
  },
);
