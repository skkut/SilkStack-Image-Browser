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
 */
export function useBaseModelResolution(): void {
  const indexingState = useImageStore((state) => state.indexingState);
  const imageCount = useImageStore((state) => state.images.length);
  const onlineModelLookupEnabled = useSettingsStore((state) => state.onlineModelLookupEnabled);

  useEffect(() => {
    void loadBaseModelTable();
  }, []);

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
