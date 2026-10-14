import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
import StackCardWrapper from '../components/StackCardWrapper';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';
import type { LicenseStatus } from '../services/licenseService';
import type { ImageStack } from '../types';

/**
 * Ctrl/Cmd+click on a stack card pops the stack out into its own window
 * instead of drilling into it here.
 *
 * The interception is a capture-phase handler on a wrapper element, because the
 * card itself is MPL-covered source and must keep firing its own `onClick`
 * unmodified for a plain click. That makes the interesting behaviour invisible
 * in the card's code — and easy to break by "tidying up": the two assertions
 * that matter are that the modifier DIVERTS the click, and that it does not
 * fire both paths at once.
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

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  StackCard: ({ onOpen }: any) => (
    <button onClick={onOpen} type="button">
      stack card
    </button>
  ),
}));

if (typeof global.window !== 'undefined') {
  (global.window as any).electronAPI = {};
}

const STACK = {
  id: 'stack-group-9',
  groupKey: 'group-9',
  coverImage: { id: 'dir-1::a.png', name: 'a.png', metadata: {} },
  images: [{ id: 'dir-1::a.png', name: 'a.png', metadata: {} }],
  count: 1,
  basePrompt: 'a blue cat',
} as unknown as ImageStack;

// Typed with their signature: an untyped `vi.fn()` in vitest 4 carries no call
// signature, so passing one as `onOpen={() => void}` is a type error.
let onOpen: ReturnType<typeof vi.fn<() => void>>;
let onOpenInNewWindow: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  onOpen = vi.fn();
  onOpenInNewWindow = vi.fn();
  useSettingsStore.setState(validLicense());
});

afterEach(() => {
  delete (global.window as any).electronAPI;
});

/** The card is lazy-loaded, so the button only exists after suspension. */
const renderCard = async (withNewWindow: boolean) => {
  render(
    <StackCardWrapper
      stack={STACK}
      onOpen={onOpen}
      onOpenInNewWindow={withNewWindow ? onOpenInNewWindow : undefined}
    />,
  );
  return waitFor(() => screen.getByText('stack card'));
};

describe('ctrl+click on a stack card', () => {
  it('drills down as usual on a plain click', async () => {
    const card = await renderCard(true);

    fireEvent.click(card);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpenInNewWindow).not.toHaveBeenCalled();
  });

  it('opens its own window instead, and does not also drill down', async () => {
    // Both firing is the failure mode the capture phase exists to prevent: the
    // main window would open the stack AND a window would open beside it.
    const card = await renderCard(true);

    fireEvent.click(card, { ctrlKey: true });

    expect(onOpenInNewWindow).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('treats Cmd+click the same way, for macOS', async () => {
    const card = await renderCard(true);

    fireEvent.click(card, { metaKey: true });

    expect(onOpenInNewWindow).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('falls through to the drill-down where there is no window to open', async () => {
    // The wrapper is also mounted by callers that pass no handler — and by the
    // browser build, which has no child windows at all. Swallowing the click
    // there would make the modifier do nothing at all.
    const card = await renderCard(false);

    fireEvent.click(card, { ctrlKey: true });

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpenInNewWindow).not.toHaveBeenCalled();
  });
});
