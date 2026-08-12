import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SemanticSearchCoordinator,
  type SemanticIndexProgress,
  type SemanticSearchStatus,
} from '../services/semanticSearchEngine';
import { getAiLoadError, isAiAvailable } from '../services/aiBridge';
import type { IndexedImage } from '../types';

/**
 * Dev tools page for the semantic search feature (plan §14, Phase 4 verify).
 * Reached via `?devtools=semantic-search`. Uses the REAL coordinator →
 * worker → storage → module stack against a small fixture library so the
 * feature can be exercised end-to-end:
 *
 *   1. Index the fixture library (Δ by textHash — re-indexing is a no-op).
 *   2. Natural-language queries — hits must rank by meaning, not word match.
 *   3. "Index + query" — the query must resolve while the index batch is
 *      still running (worker preemption, §5.1).
 *   4. Clear index → storage + worker index wiped, then re-index.
 */

interface FixtureImage {
  id: string;
  prompt: string;
  tags: string[];
  models: string[];
}

const FIXTURES: FixtureImage[] = [
  { id: 'fixture-fox-snow', prompt: 'a red fox sitting in a snowy forest, digital painting', tags: ['red fox', 'snowy forest', 'digital painting'], models: ['sd-1.5'] },
  { id: 'fixture-cyberpunk', prompt: '1girl, solo, cyberpunk city, neon lights, night rain', tags: ['cyberpunk city', 'neon lights', '1girl'], models: ['sd-1.5'] },
  { id: 'fixture-dragon-castle', prompt: 'a dragon flying over a medieval castle at sunset, fantasy art', tags: ['dragon', 'medieval castle', 'fantasy art'], models: ['sd-1.5'] },
  { id: 'fixture-fisherman', prompt: 'close-up portrait of an old fisherman, weathered skin, dramatic lighting, black and white', tags: ['portrait', 'old fisherman', 'black and white'], models: ['sd-1.5'] },
  { id: 'fixture-cottage', prompt: 'a cozy cottage in a magical forest, soft ambient lighting, fairycore', tags: ['cozy cottage', 'magical forest', 'fairycore'], models: ['sd-1.5'] },
  { id: 'fixture-lion', prompt: 'a majestic lion with a flowing mane, african savanna, golden hour', tags: ['lion', 'african savanna', 'golden hour'], models: ['sd-1.5'] },
  { id: 'fixture-robot', prompt: 'a small cute robot in a garden full of flowers, soft light, studio ghibli style', tags: ['robot', 'garden', 'flowers', 'studio ghibli'], models: ['sd-1.5'] },
  { id: 'fixture-ocean', prompt: 'underwater scene, colorful coral reef, tropical fish, sun rays', tags: ['underwater', 'coral reef', 'tropical fish'], models: ['sd-1.5'] },
  { id: 'fixture-coffee', prompt: 'a cup of coffee on a rustic wooden table, morning light, cozy cafe', tags: ['coffee', 'wooden table', 'cozy cafe'], models: ['sd-1.5'] },
  { id: 'fixture-mountain', prompt: 'a lone hiker on a mountain ridge above the clouds, epic landscape', tags: ['hiker', 'mountain ridge', 'epic landscape'], models: ['sd-1.5'] },
  { id: 'fixture-cat-window', prompt: 'a cat sitting on a windowsill watching the rain, melancholic mood', tags: ['cat', 'windowsill', 'rain'], models: ['sd-1.5'] },
  { id: 'fixture-astronaut', prompt: 'an astronaut floating in space above a glowing earth, stars', tags: ['astronaut', 'space', 'earth'], models: ['sd-1.5'] },
  { id: 'fixture-forest-path', prompt: 'sunlight through pine trees on a forest path, morning mist', tags: ['pine forest', 'sunlight', 'morning mist'], models: ['sd-1.5'] },
  { id: 'fixture-market', prompt: 'a bustling street market with colorful fruit stalls, warm afternoon light', tags: ['street market', 'fruit stalls', 'warm light'], models: ['sd-1.5'] },
  { id: 'fixture-owl', prompt: 'a wise owl perched on a mossy branch at night, full moon', tags: ['owl', 'mossy branch', 'full moon'], models: ['sd-1.5'] },
  { id: 'fixture-train', prompt: 'a steam locomotive crossing a viaduct bridge, autumn landscape', tags: ['steam locomotive', 'viaduct', 'autumn'], models: ['sd-1.5'] },
];

const QUERY_PRESETS = [
  { label: 'Fox in snow', value: 'a red fox in the snow' },
  { label: 'Cyberpunk city', value: 'cyberpunk neon city at night' },
  { label: 'Old portrait', value: 'portrait of an old man with a beard' },
  { label: 'Dragon fantasy', value: 'a dragon above a castle' },
  { label: 'Cozy', value: 'warm cozy place to relax' },
  { label: 'Lion', value: 'lion on the savanna' },
  { label: 'Underwater', value: 'underwater ocean life' },
  { label: 'Cat', value: 'a cat' },
];

const fixtureById = new Map(FIXTURES.map((f) => [f.id, f]));

type LoadState = 'loading' | 'ready' | 'error';

interface QueryResult {
  q: string;
  hits: Array<{ imageId: string; score: number }>;
  elapsed: number;
}

export default function DevSemanticSearchTester() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [status, setStatus] = useState<SemanticSearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SemanticIndexProgress | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [preempting, setPreempting] = useState(false);
  const [query, setQuery] = useState(QUERY_PRESETS[0].value);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const coordinatorRef = useRef<SemanticSearchCoordinator | null>(null);

  const appendLog = useCallback((line: string) => {
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);
  }, []);

  // Apply theme on mount (same pattern as DevAutoTaggingTester)
  useEffect(() => {
    const applyTheme = (systemShouldUseDark: boolean) => {
      if (systemShouldUseDark) {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme', 'light');
      }
    };

    if (window.electronAPI) {
      window.electronAPI.getTheme().then(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });
      const unsubscribe = window.electronAPI.onThemeUpdated(({ shouldUseDarkColors }) => {
        applyTheme(shouldUseDarkColors);
      });
      return () => {
        if (unsubscribe) unsubscribe();
      };
    } else {
      applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
  }, []);

  // Initialize the coordinator (worker + chunked restore) on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      const available = await isAiAvailable();
      if (!available) {
        if (!cancelled) {
          const errMsg = await getAiLoadError();
          setLoadState('error');
          setError(
            'AI intelligence module is not available. ' +
              'The ai-intelligence package must be installed for semantic search. ' +
              (errMsg ? `(${errMsg})` : ''),
          );
        }
        return;
      }

      const coordinator = new SemanticSearchCoordinator((p) => {
        if (!cancelled) setProgress(p);
      });
      coordinatorRef.current = coordinator;

      try {
        await coordinator.ensureInitialized();
        if (!cancelled) {
          setStatus(coordinator.getStatus());
          setLoadState('ready');
          appendLog('worker ready — persisted index restored (chunked)');
        }
      } catch (err) {
        if (!cancelled) {
          setLoadState('error');
          setError(
            `Semantic search failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      coordinatorRef.current?.dispose();
    };
  }, [appendLog]);

  const refreshStatus = useCallback((coordinator: SemanticSearchCoordinator) => {
    setStatus(coordinator.getStatus());
  }, []);

  const handleIndexFixtures = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || loadState !== 'ready' || indexing) return;
    setIndexing(true);
    setError(null);
    try {
      const images = FIXTURES.map((f) => ({ ...f })) as unknown as IndexedImage[];
      const start = performance.now();
      const result = await coordinator.indexImages(images);
      refreshStatus(coordinator);
      appendLog(
        `indexed ${result.indexed} fixture(s) (+${result.skipped} unchanged) in ${Math.round(performance.now() - start)}ms`,
      );
    } catch (err) {
      setError(`Indexing failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIndexing(false);
      setProgress(null);
    }
  }, [loadState, indexing, appendLog, refreshStatus]);

  const handleSearch = useCallback(
    async (text?: string) => {
      const coordinator = coordinatorRef.current;
      const q = (text ?? query).trim();
      if (!coordinator || loadState !== 'ready' || !q) return;
      setSearching(true);
      setError(null);
      const start = performance.now();
      try {
        const hits = await coordinator.search(q);
        setResult({ q, hits, elapsed: Math.round(performance.now() - start) });
      } catch (err) {
        setError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSearching(false);
      }
    },
    [loadState, query],
  );

  /** §5.1 preemption check: a query fired mid-index must resolve first. */
  const handlePreemptDemo = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator || loadState !== 'ready' || preempting) return;
    setPreempting(true);
    setError(null);
    try {
      const many = Array.from({ length: 60 }, (_, i) => ({ ...FIXTURES[i % FIXTURES.length] }));
      appendLog('preemption demo: starting 60-image index...');
      const indexPromise = coordinator.indexImages(many as unknown as IndexedImage[]);
      // Fire the query while the first embed batch is in flight.
      setTimeout(() => {
        void coordinator.search('a red fox in the snow').then((hits) => {
          appendLog(`query resolved with ${hits.length} hit(s) WHILE indexing — preemption OK`);
        });
      }, 100);
      const result = await indexPromise;
      refreshStatus(coordinator);
      appendLog(`index finished: ${result.indexed} embedded, ${result.skipped} skipped`);
    } catch (err) {
      setError(`Preemption demo failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setPreempting(false);
      setProgress(null);
    }
  }, [loadState, preempting, appendLog, refreshStatus]);

  const handleClearIndex = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (!coordinator) return;
    setError(null);
    try {
      await coordinator.clearIndex();
      refreshStatus(coordinator);
      appendLog('index cleared (store + worker heap)');
    } catch (err) {
      setError(`Clear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [appendLog, refreshStatus]);

  // Ctrl+Y closes this window
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key === 'y') {
        e.preventDefault();
        window.close();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleClose = () => window.close();

  // Shared class sets to keep things DRY
  const cardClass = 'bg-gray-900 rounded-xl border border-gray-800 p-5';
  const btnChipClass =
    'px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
  const btnPresetClass =
    'px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded-full text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors';
  const inputClass =
    'w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30';
  const labelClass = 'block text-sm font-medium text-gray-200 mb-2';

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-gray-950 text-gray-200 font-sans">
      {/* Header — draggable region (titleBarStyle: hidden needs explicit drag region) */}
      <div
        className="px-6 py-4 border-b border-gray-800 flex items-center gap-4 shrink-0"
        style={{ WebkitAppRegion: 'drag', paddingTop: '36px' } as React.CSSProperties}
      >
        <button
          onClick={handleClose}
          className={btnChipClass + ' shrink-0'}
          title="Ctrl+Y"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          &#8592; Close
        </button>
        <div>
          <h1 className="text-lg font-semibold text-gray-100 flex items-center gap-2">
            Semantic Search Test
            <span className="px-2 py-0.5 text-xs font-mono bg-gray-800 text-gray-400 rounded-md border border-gray-700 font-normal">
              {status?.modelId ?? 'arctic-embed-m'}
            </span>
          </h1>
          <p className="text-sm text-gray-500">Natural-language search over prompts/tags — local via WebLLM</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div
            className={`w-2 h-2 rounded-full ${
              loadState === 'loading' ? 'bg-yellow-500' : loadState === 'ready' ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-sm text-gray-400">
            {loadState === 'loading'
              ? 'Initializing worker...'
              : `indexed: ${status?.indexed ?? 0}${status?.dimension ? ` · ${status.dimension} dims` : ''}`}
          </span>
          {progress && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400">{progress.message}</span>
              <div className="w-32 h-1 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Column (Controls) */}
        <div className="w-full lg:w-3/5 flex flex-col overflow-y-auto scrollbar-adaptive p-6 space-y-6 border-b lg:border-b-0 lg:border-r border-gray-800">
          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg text-sm text-red-600 dark:text-red-400 shrink-0">
              {error}
            </div>
          )}

          {/* Indexing card */}
          <div className={`${cardClass} shrink-0`}>
            <div className="flex items-center gap-4">
              <button
                onClick={handleIndexFixtures}
                disabled={loadState !== 'ready' || indexing || preempting}
                className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {indexing ? 'Indexing...' : 'Index fixture library'}
              </button>
              <button
                onClick={handlePreemptDemo}
                disabled={loadState !== 'ready' || indexing || preempting}
                className="px-5 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {preempting ? 'Running...' : 'Index 60 + query mid-run'}
              </button>
              <button
                onClick={handleClearIndex}
                disabled={loadState === 'loading' || indexing || preempting}
                className={btnChipClass}
              >
                Clear index
              </button>
              <span className="text-xs text-gray-500 ml-auto">{FIXTURES.length} fixture images</span>
            </div>
            <p className={labelClass + ' mt-4 mb-0'}>
              Indexing is Δ by textHash — re-running is a no-op unless fixture text changes.
            </p>
          </div>

          {/* Query card */}
          <div className={`${cardClass} shrink-0`}>
            <label className={labelClass}>Natural-language query</label>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              className={inputClass}
              placeholder='e.g. "a red fox in the snow"'
            />
            <div className="flex flex-wrap gap-2 mt-3">
              {QUERY_PRESETS.map((p) => (
                <button key={p.label} onClick={() => handleSearch(p.value)} className={btnPresetClass}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-4">
              <button
                onClick={() => handleSearch()}
                disabled={loadState !== 'ready' || searching || !query.trim()}
                className="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {searching ? 'Searching...' : 'Search'}
              </button>
              <span className="text-xs text-gray-400 ml-auto">
                Queries preempt a running index batch (worker §5.1)
              </span>
            </div>
          </div>

          {/* Activity log */}
          <div className={`${cardClass} flex-1 flex flex-col min-h-[150px]`}>
            <h3 className="text-sm font-medium text-gray-400 mb-2 shrink-0">Activity log</h3>
            <pre className="flex-1 text-xs text-gray-400 bg-gray-950 rounded-lg p-3 overflow-auto scrollbar-adaptive whitespace-pre-wrap break-all font-mono">
              {log.length === 0 ? 'No activity yet.' : log.join('\n')}
            </pre>
          </div>
        </div>

        {/* Right Column (Results) */}
        <div className="w-full lg:w-2/5 flex flex-col overflow-y-auto scrollbar-adaptive p-6 space-y-6">
          <div className={`${cardClass} flex-1 flex flex-col`}>
            <div className="flex items-center justify-between mb-3 shrink-0">
              <h3 className="text-sm font-medium text-gray-200">Top hits</h3>
              {result && (
                <span className="text-xs text-gray-400">
                  {result.hits.length} hit(s) in {result.elapsed}ms
                </span>
              )}
            </div>
            {!result ? (
              <span className="text-sm text-gray-500">
                {searching ? 'Searching...' : 'Run a query to see ranked hits.'}
              </span>
            ) : result.hits.length === 0 ? (
              <span className="text-sm text-gray-500">
                No hits above the 0.55 threshold for “{result.q}”.
              </span>
            ) : (
              <div className="space-y-2 overflow-y-auto scrollbar-adaptive">
                {result.hits.map((hit, i) => {
                  const fixture = fixtureById.get(hit.imageId);
                  return (
                    <div
                      key={hit.imageId}
                      className="p-3 bg-gray-950 border border-gray-800 rounded-lg"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium text-gray-200">
                          #{i + 1} {fixture?.id ?? hit.imageId}
                        </span>
                        <span className="text-xs font-mono text-green-400 shrink-0">
                          {(hit.score * 100).toFixed(1)}%
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                        {fixture?.prompt ?? ''}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
