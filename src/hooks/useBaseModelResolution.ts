import { useEffect } from 'react';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { loadBaseModelTable } from '../services/baseModelTable';

/**
 * Waits for the library to settle before touching the network. Indexing walks
 * the same disks the app is already reading from, and a newly added folder
 * arrives in bursts — this coalesces them into one run.
 */
const SETTLE_MS = 1500;

/**
 * Adopts the offline table and follows it for the life of the window.
 *
 * Every **window** that shows a base model needs this, not just the main one.
 * The table is module state in `baseModelTable.ts`, so each renderer process
 * holds its own copy — a window that never calls this renders blank base models
 * with no error to show for it. That is precisely what the popped-out image
 * viewer did: in Electron the image modal lives in a child window (see
 * `App.tsx`, where the in-app modal is browser-only), and nothing in that window
 * ever read the table, so "Base Model" was missing from Generation details for
 * every image, in every case.
 *
 * The subscription is what keeps two open windows from disagreeing: whichever
 * window resolves or maps a checkpoint writes it to disk, and main tells the
 * others, which re-read. Deliberately payload-free — the file on disk is the
 * single shape of the table, and re-reading it cannot hand a window a second,
 * staler copy of it to keep in sync.
 */
export function useBaseModelTable(): void {
  useEffect(() => {
    void loadBaseModelTable();

    const unsubscribe = window.electronAPI?.onBaseModelTableChanged?.(() => {
      void loadBaseModelTable();
    });

    return unsubscribe;
  }, []);
}

/**
 * Keeps the offline checkpoint → base model table current.
 *
 * Two steps, deliberately separated:
 *
 * 1. **Load the table from disk** — once per session, unconditionally and with
 *    no network. The table is the cache; reading it is what makes the column
 *    light up instantly on every later launch, and it keeps working after the
 *    user switches the lookup off.
 * 2. **Resolve what is missing** — only when the preference is on. This is the
 *    only part that talks to Civitai / HuggingFace, and only for checkpoints
 *    the table has never seen. Re-running it is cheap and idempotent: a warm
 *    table means zero requests, which is why it can safely re-run whenever the
 *    library changes.
 *
 * Step 2 is the main window's alone — it is the only window holding the library
 * the checkpoints are collected from. Step 1 is every window's, which is why it
 * lives in `useBaseModelTable` above.
 */
export function useBaseModelResolution(): void {
  const indexingState = useImageStore((state) => state.indexingState);
  const imageCount = useImageStore((state) => state.images.length);
  const onlineModelLookupEnabled = useSettingsStore((state) => state.onlineModelLookupEnabled);

  useBaseModelTable();

  useEffect(() => {
    if (!onlineModelLookupEnabled) return;
    if (imageCount === 0) return;
    // Mid-index there is nothing stable to resolve against, and the run would
    // be thrown away by the next batch anyway.
    if (indexingState === 'indexing') return;

    const timer = setTimeout(() => {
      void useImageStore.getState().resolveBaseModelsNow();
    }, SETTLE_MS);

    return () => clearTimeout(timer);
  }, [onlineModelLookupEnabled, imageCount, indexingState]);
}
