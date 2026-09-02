import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import {
  deleteCachedModel,
  listCachedModels,
  type CachedModelGroup,
  type CachedModelSummary,
} from '../services/modelCache';

/** Settings → AI Intelligence: every web-llm model cached on disk (with the
 *  space it occupies) and a per-model X to delete its files. Cache API
 *  entries are never auto-evicted, so this is the only way to reclaim the
 *  disk space of superseded models. The modal mounts this section only while
 *  the AI tab is open, so the listing is freshly enumerated on every open. */
export const AiModelCacheSection: React.FC = () => {
  const [summary, setSummary] = useState<CachedModelSummary | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void listCachedModels().then((result) => {
      if (!cancelled) setSummary(result);
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);

  /** Silent re-list after a delete — truthful (picks up size drift) and
   *  avoids flashing the loading state mid-action. */
  const refresh = async () => {
    const result = await listCachedModels();
    if (mountedRef.current) setSummary(result);
  };

  const handleDelete = async (group: CachedModelGroup) => {
    const confirmed = window.confirm(
      `Delete the cached files for '${group.label}'`
      + (group.bytes > 0 ? ` (${formatCachedBytes(group.bytes)})` : '')
      + '?\n\nThey will be re-downloaded from the internet the next time this model is used.',
    );
    if (!confirmed) return;
    setDeletingId(group.id);
    setDeleteError('');
    try {
      await deleteCachedModel(group.id);
    } catch (error) {
      console.error('Failed to delete cached model files:', error);
      if (mountedRef.current) {
        setDeleteError('Failed to delete the cached files. Check the console for details.');
      }
    }
    try {
      await refresh();
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  };

  const viewState: 'loading' | 'ready' | 'unsupported' | 'error' = summary === null
    ? 'loading'
    : !summary.supported
      ? (summary.reason === 'error' ? 'error' : 'unsupported')
      : 'ready';
  const groups = summary?.groups ?? [];
  const totalFiles = groups.reduce((sum, group) => sum + group.fileCount, 0);
  const groupCountLabel = groups.filter((group) => group.kind === 'model').length;

  return (
    <section data-testid="ai-model-cache-section">
      <h3 className="text-lg font-semibold mb-4 text-gray-200 border-b border-gray-700/50 pb-2">
        Cached model files
      </h3>
      <div className="space-y-4">
        {viewState === 'loading' && (
          <div className="bg-gray-900/80 p-5 rounded-xl border border-gray-700/50">
            <p className="text-sm text-gray-400" data-testid="ai-model-cache-loading">
              Loading cached models…
            </p>
          </div>
        )}

        {viewState === 'unsupported' && (
          <div className="bg-gray-900/80 p-5 rounded-xl border border-gray-700/50">
            <p className="text-sm text-gray-500" data-testid="ai-model-cache-unavailable">
              Model file caches are not available in this environment.
            </p>
          </div>
        )}

        {viewState === 'error' && summary?.message && (
          <div className="bg-red-900/50 text-red-300 p-4 rounded-lg text-sm" data-testid="ai-model-cache-error" role="alert">
            Failed to read the model file cache: {summary.message}
          </div>
        )}

        {viewState === 'ready' && (
          <>
            <div
              data-testid="ai-model-cache-warning"
              className="bg-amber-500/10 text-amber-400 border border-amber-500/20 p-4 rounded-lg text-sm leading-relaxed"
            >
              Models deleted from disk will be re-downloaded from the internet when used again.
            </div>

            {deleteError && (
              <div className="bg-red-900/50 text-red-300 p-4 rounded-lg text-sm" role="alert">
                {deleteError}
              </div>
            )}

            <div className="bg-gray-900/80 rounded-xl border border-gray-700/50 shadow-sm overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 gap-4">
                <p className="text-sm font-medium text-gray-200">
                  {groupCountLabel} model{groupCountLabel === 1 ? '' : 's'} on disk
                </p>
                <p className="text-xs text-gray-500 text-right shrink-0" data-testid="ai-model-cache-total">
                  {totalFiles} file{totalFiles === 1 ? '' : 's'} · {formatCachedBytes(summary?.totalBytes ?? 0)}
                  {summary?.hasUnknownSize ? ' (+ files of unknown size)' : ''}
                </p>
              </div>

              {groups.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-gray-500" data-testid="ai-model-cache-empty">
                  No cached models — model files are downloaded on first use.
                </div>
              ) : (
                <ul className="divide-y divide-gray-800">
                  {groups.map((group) => (
                    <li
                      key={group.id}
                      className="flex items-center justify-between px-5 py-3 gap-4"
                      data-testid={`ai-model-cache-row-${slugify(group.id)}`}
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-200 truncate" title={group.label}>
                          {group.label}
                        </p>
                        <p className="text-xs text-gray-500">
                          {group.fileCount} file{group.fileCount === 1 ? '' : 's'}
                          {group.hasUnknownSize ? ' · some sizes unknown' : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <span
                          className="text-sm text-gray-300 tabular-nums"
                          data-testid={`ai-model-cache-size-${slugify(group.id)}`}
                        >
                          {group.hasUnknownSize && group.bytes === 0
                            ? 'size unknown'
                            : group.hasUnknownSize
                              ? `≥ ${formatCachedBytes(group.bytes)}`
                              : formatCachedBytes(group.bytes)}
                        </span>
                        {group.kind === 'model' ? (
                          <button
                            type="button"
                            onClick={() => void handleDelete(group)}
                            disabled={deletingId !== null}
                            title="Delete these cached files — re-downloaded from the internet on next use"
                            aria-label={`Delete cached model ${group.label}`}
                            data-testid={`ai-model-cache-delete-${slugify(group.id)}`}
                            className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          >
                            {deletingId === group.id
                              ? <RefreshCw size={16} className="animate-spin" />
                              : <X size={16} />}
                          </button>
                        ) : (
                          <span className="text-xs text-gray-600" title="Shared runtime files used by every model">
                            shared
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
};

/** Local KB/MB/GB formatter — duplicated in ImageModal/ImageTable already;
 *  extracting a shared util is out of scope for this section. */
const formatCachedBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
};

/** Model ids contain `/` and `.` — legal in an attribute but unusable in CSS
 *  selectors, so testids get a slugged id. */
const slugify = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '-');
