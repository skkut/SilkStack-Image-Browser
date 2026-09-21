import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useSettingsStore is persisted — it needs a localStorage stub before import.
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

import hotkeyManager from '../services/hotkeyManager';
import { getDefaultKeymap } from '../services/hotkeyConfig';
import { useSettingsStore } from '../store/useSettingsStore';

/**
 * Regression guard for the hotkey scope mismatch.
 *
 * hotkeys-js only dispatches a handler whose BOUND scope matches the ACTIVE
 * scope (or when bound to 'all'). Every action in hotkeyConfig declares
 * `scope: 'global'`, but the library's default active scope is 'all' — so
 * unless something activates 'global', every registered hotkey is silently
 * inert: the DOM listener runs, the callback never does.
 *
 * That is exactly what happened to Ctrl+F (focusSearch) — and to every other
 * action routed through hotkeyManager.
 */
describe('global hotkey scope', () => {
  const pressCtrlF = () => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f',
        code: 'KeyF',
        keyCode: 70,
        which: 70,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    useSettingsStore.setState({ keymap: getDefaultKeymap() });
  });

  afterEach(() => {
    hotkeyManager.clearActions();
  });

  it('fires focusSearch on Ctrl+F and moves the cursor into the search input', () => {
    const searchInput = document.createElement('input');
    searchInput.setAttribute('data-testid', 'search-input');
    document.body.appendChild(searchInput);

    // Mirrors the focusSearch action registered by useHotkeys.
    const focusSearch = vi.fn(() => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="search-input"]');
      el?.focus();
      el?.select();
    });

    hotkeyManager.registerAction('focusSearch', focusSearch);
    hotkeyManager.bindAllActions();

    pressCtrlF();

    expect(focusSearch).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(searchInput);
  });

  it('keeps hotkeys working after a re-bind (keymap change)', () => {
    const focusSearch = vi.fn();
    hotkeyManager.registerAction('focusSearch', focusSearch);

    hotkeyManager.bindAllActions();
    // Re-binding happens on every keymap change via the settings subscription.
    hotkeyManager.bindAllActions();

    pressCtrlF();

    expect(focusSearch).toHaveBeenCalledTimes(1);
  });
});
