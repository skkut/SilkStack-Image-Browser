/**
 * Cross-window settings sync.
 *
 * Each renderer (main window, popped-out stack window, viewer) instantiates
 * `useSettingsStore` independently and keeps its own in-memory copy. The main
 * process announces every `save-settings` write with a payload-free
 * `settings-changed`; the store re-reads the settings file so a preference
 * changed in one window — the stack view's Group by selection is the case
 * users hit — applies to all of them.
 *
 * The Electron bridge is stubbed in `vi.hoisted` because the persist storage
 * choice AND the subscription are both decided at module load. The store is
 * imported dynamically after `vi.resetModules()` so each test gets a fresh
 * persist instance and a fresh listener.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bridge = vi.hoisted(() => {
  const state = {
    /** What the settings file currently holds. */
    stored: {} as Record<string, unknown>,
    /** `settings-changed` listeners registered by the store under test. */
    listeners: [] as Array<() => void>,
    getSettings: vi.fn(),
    saveSettings: vi.fn(),
  };

  state.getSettings = vi.fn(async () => state.stored);
  state.saveSettings = vi.fn(async (next: Record<string, unknown>) => {
    state.stored = { ...state.stored, ...next };
  });

  (window as any).electronAPI = {
    getSettings: state.getSettings,
    saveSettings: state.saveSettings,
    onSettingsChanged: (callback: () => void) => {
      state.listeners.push(callback);
      return () => {
        const index = state.listeners.indexOf(callback);
        if (index >= 0) state.listeners.splice(index, 1);
      };
    },
  };

  return state;
});

/** Drain microtasks so persist hydration/rehydration settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Import the store fresh and wait for its initial async hydration. */
async function loadStore() {
  vi.resetModules();
  const { useSettingsStore } = await import('../store/useSettingsStore');
  await flush();
  return useSettingsStore;
}

describe('useSettingsStore cross-window sync', () => {
  beforeEach(() => {
    bridge.listeners.length = 0;
    bridge.getSettings.mockClear();
    bridge.saveSettings.mockClear();
  });

  it('applies a settings change written by another window', async () => {
    bridge.stored = { stackGroupByDimensions: ['prompt'] };
    const store = await loadStore();
    expect(store.getState().stackGroupByDimensions).toEqual(['prompt']);

    // Another window writes a different selection to the file, then main
    // broadcasts the payload-free event.
    bridge.stored = { stackGroupByDimensions: ['prompt', 'model'] };
    expect(bridge.listeners).toHaveLength(1);
    bridge.listeners[0]!();

    await flush();
    expect(store.getState().stackGroupByDimensions).toEqual(['prompt', 'model']);
  });

  it('does not echo the remote value back to disk', async () => {
    bridge.stored = { stackGroupByDimensions: ['prompt'] };
    const store = await loadStore();

    bridge.stored = { stackGroupByDimensions: ['loras'] };
    bridge.listeners[0]!();
    await flush();

    expect(store.getState().stackGroupByDimensions).toEqual(['loras']);
    // Rehydrate applies through persist's raw setter, which does not write.
    // A write here would broadcast again and could ping-pong between windows.
    expect(bridge.saveSettings).not.toHaveBeenCalled();
  });

  it('still persists locally initiated changes (sanity check on the bridge)', async () => {
    bridge.stored = { stackGroupByDimensions: ['prompt'] };
    const store = await loadStore();

    store.getState().setStackGroupByDimensions(['prompt', 'model']);
    await flush();

    expect(bridge.saveSettings).toHaveBeenCalledTimes(1);
    expect(bridge.stored.stackGroupByDimensions).toEqual(['prompt', 'model']);
  });
});
