import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { clearPromptCache, getPromptCacheStats, type PromptCacheStats } from '../services/promptCache';

/**
 * Settings → AI Intelligence: prompt-processing cache readout and the
 * explicit "Clear prompt cache" action. The cache is per prompt (auto-tags,
 * prompt vectors, searchable-text vectors) and survives Reprocess — this is
 * the only place it is discarded, so a stale result is always escapable.
 *
 * The modal mounts this section only while the AI tab is open, so the counts
 * are freshly read on every open.
 */
export const PromptCacheSection: React.FC = () => {
  const [stats, setStats] = useState<PromptCacheStats | null>(null);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState('');
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    const next = await getPromptCacheStats();
    if (mountedRef.current) setStats(next);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const handleClear = async () => {
    const confirmed = window.confirm(
      'Clear the prompt cache?\n\n'
      + 'Processed prompts, their embedding vectors, and cached auto-tags will be forgotten. '
      + 'Images keep their current tags; the next auto-tag / indexing pass will call the models '
      + 'again for prompts it can no longer reuse.\n\n'
      + 'This never touches favorites, manual tags, stacks, or folder settings.',
    );
    if (!confirmed) return;

    setClearing(true);
    setMessage('');
    try {
      await clearPromptCache();
      await refresh();
      if (mountedRef.current) {
        setMessage('Prompt cache cleared — the models will run again on the next pass.');
      }
    } catch (error) {
      console.error('Failed to clear prompt cache:', error);
      if (mountedRef.current) setMessage('Failed to clear the prompt cache. Check the console for details.');
    } finally {
      if (mountedRef.current) setClearing(false);
    }
  };

  const total = stats === null
    ? null
    : stats.enrichments + stats.promptEmbeddings + stats.textEmbeddings;

  return (
    <section data-testid="prompt-cache-section">
      <h3 className="text-lg font-semibold mb-4 text-gray-200 border-b border-gray-700/50 pb-2">
        Processed prompts
      </h3>
      <div className="space-y-4">
        <div className="bg-gray-900/80 rounded-xl border border-gray-700/50 shadow-sm">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 gap-4">
            <p className="text-sm font-medium text-gray-200">Prompt results kept for reuse</p>
            <p className="text-xs text-gray-500 text-right shrink-0" data-testid="prompt-cache-total">
              {total === null ? 'Loading…' : `${total} entr${total === 1 ? 'y' : 'ies'}`}
            </p>
          </div>

          <div className="px-5 py-4 space-y-2 text-sm text-gray-400">
            <p>
              Auto-tags and embeddings are computed once per prompt and reused by every image
              that shares it — across runs and after Reprocess. Everything stays on this device.
            </p>
            {stats && (
              <ul className="text-xs text-gray-500 space-y-1" data-testid="prompt-cache-breakdown">
                <li>{stats.enrichments} prompt{stats.enrichments === 1 ? '' : 's'} with cached auto-tags</li>
                <li>{stats.promptEmbeddings} prompt vector{stats.promptEmbeddings === 1 ? '' : 's'}</li>
                <li>{stats.textEmbeddings} searchable-text vector{stats.textEmbeddings === 1 ? '' : 's'}</li>
              </ul>
            )}
          </div>

          {message && (
            <div className="px-5 pb-3 text-xs text-gray-400" role="status">
              {message}
            </div>
          )}

          <div className="px-5 pb-4">
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={clearing || stats === null || total === 0}
              className="inline-flex items-center gap-2 bg-gray-700/50 text-gray-300 hover:bg-gray-700 hover:text-gray-100 border border-gray-700 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="prompt-cache-clear"
            >
              <Trash2 size={16} />
              {clearing ? 'Clearing…' : 'Clear prompt cache'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
