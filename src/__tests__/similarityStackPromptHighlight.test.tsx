/**
 * Wiring test for the "Highlight variations" switch in the similarity stack
 * drill-down.
 *
 * The package component is mocked, so these tests cover the wrapper layer only:
 * that the switch reaches the toolbar, reflects and writes the persisted
 * setting, and that sub-groups handed to the package carry prompt segments only
 * when they should. (The package's own rendering of those segments is verified
 * in the running app — the module has no jsdom harness.)
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

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Wrapper from '../components/SimilarityStackExpandedViewWrapper';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';
import type { StackSubGroup } from '../types';

/** Records what the wrapper hands to the package component. */
const captured = vi.hoisted(() => ({ subGroups: [] as any[] }));

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  // Mirrors the real component's structure: the group-by toolbar (which is
  // where the switch lives) is rendered from the injected ReactNode.
  SimilarityStackExpandedView: ({ subGroups, groupByToolbar }: any) => {
    captured.subGroups = subGroups;
    return <div data-testid="mock-expanded-view">{groupByToolbar}</div>;
  },
}));

const mkImage = (id: string, prompt: string, lastModified: number, model?: string) =>
  ({
    id,
    name: `${id}.png`,
    prompt,
    directoryId: 'dir1',
    lastModified,
    metadata: {},
    ...(model ? { models: [model] } : {}),
  }) as any;

/** The Prompt dimension's segments, per sub-group, as handed to the package. */
const promptSegments = () =>
  (captured.subGroups as StackSubGroup[]).map(
    (sg) => sg.dimensions?.find((dim) => dim.label === 'Prompt')?.segments,
  );

const renderWrapper = () =>
  render(
    <Wrapper
      images={
        [
          mkImage('1', 'a cat in a garden', 3000, 'sdxl'),
          mkImage('2', 'a dog in a garden', 2000, 'sdxl'),
        ] as any
      }
      subGroups={[]}
      onImageClick={vi.fn()}
      selectedImages={new Set<string>()}
      onBack={vi.fn()}
      imageSize={150}
    />,
  );

// The wrapper renders nothing when the module is absent from the build.
describe.skipIf(!import.meta.env.VITE_AI_FEATURES_AVAILABLE)(
  'SimilarityStackExpandedViewWrapper — highlight variations switch',
  () => {
    beforeEach(() => {
      captured.subGroups = [];
      useSettingsStore.setState({
        licenseStatus: 'valid',
        licenseKey: 'TEST-KEY',
        licenseLastValidated: Date.now(),
        licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', Date.now()),
        displayStarredFirst: false,
        disableThumbnails: true,
        stackGroupByDimensions: ['prompt'],
        stackHighlightPromptVariations: true,
      });
    });

    it('renders the switch checked, and marks prompt variations', async () => {
      renderWrapper();

      const toggle = await screen.findByLabelText<HTMLInputElement>(
        'Highlight prompt variations',
      );
      expect(toggle.checked).toBe(true);
      expect(toggle.disabled).toBe(false);

      await waitFor(() => expect(captured.subGroups).toHaveLength(2));
      const segments = promptSegments();

      // Every prompt keeps the words they share and flags the ones they don't.
      expect(segments[0]!.filter((s) => s.isVariation).map((s) => s.text.trim())).toEqual([
        'cat',
      ]);
      expect(segments[1]!.filter((s) => s.isVariation).map((s) => s.text.trim())).toEqual([
        'dog',
      ]);
    });

    it('drops the segments when the switch is turned off, and persists it', async () => {
      renderWrapper();

      const toggle = await screen.findByLabelText<HTMLInputElement>(
        'Highlight prompt variations',
      );
      await waitFor(() => expect(captured.subGroups).toHaveLength(2));

      fireEvent.click(toggle);

      expect(useSettingsStore.getState().stackHighlightPromptVariations).toBe(false);
      await waitFor(() => expect(promptSegments().every((s) => s === undefined)).toBe(true));
    });

    it('disables the switch when Prompt is not an active grouping dimension', async () => {
      useSettingsStore.setState({ stackGroupByDimensions: ['model'] });
      renderWrapper();

      const toggle = await screen.findByLabelText<HTMLInputElement>(
        'Highlight prompt variations',
      );
      expect(toggle.disabled).toBe(true);
      expect(toggle.checked).toBe(true);

      await waitFor(() => expect(captured.subGroups).toHaveLength(1));
      expect(promptSegments().every((s) => s === undefined)).toBe(true);
    });
  },
);
