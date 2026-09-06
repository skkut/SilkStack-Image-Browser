import { useState, useRef, useCallback, useEffect } from 'react';
import {
  createLLMTagGenerator,
  TAG_GENERATION_MODEL_ID,
  TAGS_PROMPT,
  MAX_TAGS_PER_IMAGE,
  MAX_SYNONYMS_PER_IMAGE,
  MAX_CATEGORIES_PER_IMAGE,
  isAiAvailable,
  getAiLoadError,
  type ILLMTagGenerator,
} from '../services/aiBridge';
import { getTagModelOptions } from '../services/semanticSearchEngine';
import { useSettingsStore } from '../store/useSettingsStore';

/** idle = mounted but the model has NOT been loaded (explicit button). */
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

type TagModelOption = Awaited<ReturnType<typeof getTagModelOptions>>[number];

const TAG_TIER_LABELS = {
  low: 'Low VRAM',
  mid: 'Mid VRAM',
  high: 'High VRAM',
} as const;

const PRESETS = [
  { label: 'SD prompt', value: 'masterpiece, best quality, 1girl, solo, (cyberpunk city:1.2), neon lights, <lora:detailer:0.8>, 8k, high resolution' },
  { label: 'Dragon fantasy', value: 'a beautiful dragon flying over a medieval castle at sunset, fantasy art style, trending on ArtStation' },
  { label: 'Portrait', value: 'close-up portrait of an old fisherman with weathered skin, dramatic lighting, black and white, 85mm lens' },
  { label: 'Cozy cottage', value: 'a cozy cottage in a magical forest, soft ambient lighting, fairycore aesthetic' },
  { label: 'Lion', value: 'a majestic lion with a flowing mane, african savanna, golden hour, national geographic style' },
];

export default function DevAutoTaggingTester() {
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadText, setLoadText] = useState('Initializing...');
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(PRESETS[0].value);
  const [tags, setTags] = useState<string[]>([]);
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [lastTime, setLastTime] = useState<number | null>(null);
  const [rawResponse, setRawResponse] = useState('');
  // Default prompt: the structured auto-tag system prompt the worker uses —
  // ONE completion returning {"concepts":[…≤15], "synonyms":[…≤6]}.
  const [systemPrompt, setSystemPrompt] = useState(TAGS_PROMPT);
  const systemPromptModified = systemPrompt !== TAGS_PROMPT;

  const llmRef = useRef<ILLMTagGenerator | null>(null);

  const [modelOptions, setModelOptions] = useState<TagModelOption[]>([]);
  // Session-scoped model picker: defaults to the Settings choice (the same
  // resolution production auto-tag uses: aiTagModel || stock default) but is
  // NEVER written back — the tester stays a pure harness. A stale persisted
  // id (not in the loaded catalog) falls back to the first option below.
  const [selectedModelId, setSelectedModelId] = useState<string>(
    () => useSettingsStore.getState().aiTagModel || TAG_GENERATION_MODEL_ID,
  );

  // Apply theme on mount (same pattern as ImageModalWindow)
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

      const unsubscribe = window.electronAPI.onThemeUpdated(
        ({ shouldUseDarkColors }) => {
          applyTheme(shouldUseDarkColors);
        }
      );

      return () => {
        if (unsubscribe) unsubscribe();
      };
    } else {
      applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
  }, []);

  // Module availability check on mount only — the LLM (chat) model itself
  // is loaded exclusively via the "Load models" button (handleLoadModels):
  // opening the tester must not trigger the model download/initialization.
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
            'The ai-intelligence package must be installed for LLM-based auto-tagging. ' +
            (errMsg ? `(${errMsg})` : ''),
          );
          setLoadText('AI module unavailable');
        }
      }
    }

    init();

    return () => {
      cancelled = true;
      llmRef.current?.dispose();
    };
  }, []);

  // Catalog fetch for the model picker — options only; the chat model itself
  // is still loaded exclusively via the "Load models" button. An empty result
  // (module absent) leaves the picker disabled and the fallback id in place.
  useEffect(() => {
    let cancelled = false;
    getTagModelOptions().then((options) => {
      if (cancelled || options.length === 0) return;
      setModelOptions(options);
      setSelectedModelId((prev) =>
        options.some((o) => o.modelId === prev) ? prev : options[0].modelId,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The catalog-validated model that will load (and the id the badge shows).
  // Before options arrive the constant fallback keeps today's behavior.
  const effectiveModelId =
    modelOptions.some((o) => o.modelId === selectedModelId)
      ? selectedModelId
      : (modelOptions[0]?.modelId ?? TAG_GENERATION_MODEL_ID);

  /**
   * Model picker change. While a model is loaded ('ready'), switching models
   * means the loaded engine belongs to the old model: dispose it, clear its
   * outputs, and drop back to 'idle' so loading the new model is an explicit
   * button click (downloads must stay user-initiated). In any other state the
   * change just updates the pending choice.
   */
  const handleModelChange = useCallback(
    (modelId: string) => {
      if (modelId === effectiveModelId) return;
      setSelectedModelId(modelId);
      llmRef.current?.dispose();
      llmRef.current = null;
      setTags([]);
      setSynonyms([]);
      setRawResponse('');
      setLastTime(null);
      setLoadState('idle');
      setLoadProgress(0);
      setError(null);
    },
    [effectiveModelId],
  );

  /**
   * Explicit model load — the LLM generator is created and initialized
   * (WebGPU engine + chat model download) only when this button is clicked,
   * never on mount. A failed load disposes the broken generator so a retry
   * starts clean.
   */
  const handleLoadModels = useCallback(async () => {
    if (loadState === 'loading' || loadState === 'ready') return;
    llmRef.current?.dispose();
    llmRef.current = null;
    setLoadState('loading');
    setLoadText('Initializing...');
    setError(null);
    try {
      const llm = await createLLMTagGenerator(effectiveModelId, (report) => {
        setLoadProgress(Math.round(report.progress * 100));
        setLoadText(report.text);
      }, {
        // skipMasterCheck: this harness is premium-gated at its entry
        // (Ctrl+Y is license-only) and loads only on explicit click — the
        // master AI toggle governs the MAIN APP, not the dev tester.
        skipMasterCheck: true,
      });
      if (!llm) {
        setLoadState('error');
        setError('Failed to create LLM tag generator. Check that WebGPU is supported and the model is available.');
        setLoadText('Generator creation failed');
        return;
      }
      llmRef.current = llm;
      await llm.initialize();
      setLoadState('ready');
      setLoadText('Model ready');
    } catch (err: any) {
      setLoadState('error');
      setError(`Model initialization failed: ${err.message || err}`);
      setLoadText('Model failed to load');
    }
  }, [loadState, effectiveModelId]);

  const handleGenerate = useCallback(async () => {
    const llm = llmRef.current;
    if (!llm || loadState !== 'ready' || !prompt.trim()) return;

    setGenerating(true);
    setError(null);

    const start = performance.now();
    try {
      // The worker's per-image call: ONE structured completion returning the
      // concept chips (see TAGS_PROMPT / MAX_TAGS_PER_IMAGE) and caching the
      // hidden search vocabulary — synonyms followed by the main-subject
      // categories (zebra → "animal") — on lastSynonyms (see
      // MAX_SYNONYMS_PER_IMAGE / MAX_CATEGORIES_PER_IMAGE). The harness
      // renders the FULL concept list exactly as the app would persist it —
      // no display-side cap (2026-09-03: the old "Max tags" slice hid tags
      // the app shows; a tester that truncates cannot judge a model).
      const result = await llm.generateFlatTags(prompt, systemPrompt);
      setTags(result);
      setSynonyms(llm.lastSynonyms ?? []);
      setRawResponse(llm.lastRawResponse || '(empty response)');
      setLastTime(Math.round(performance.now() - start));
    } catch (err: any) {
      setError(`Tag generation failed: ${err.message || err}`);
      setTags([]);
      setSynonyms([]);
      setRawResponse('');
      setLastTime(null);
    } finally {
      setGenerating(false);
    }
  }, [loadState, prompt, systemPrompt]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'Enter') {
      handleGenerate();
    }
  }, [handleGenerate]);

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

  const handleClose = () => {
    window.close();
  };

  // Shared class sets to keep things DRY
  const cardClass = 'bg-gray-900 rounded-xl border border-gray-800 p-5';
  const btnChipClass = 'px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-gray-100 disabled:opacity-30 disabled:cursor-not-allowed transition-colors';
  const btnPresetClass = 'px-3 py-1 text-xs bg-gray-800 border border-gray-700 rounded-full text-gray-300 hover:bg-gray-700 hover:text-gray-100 transition-colors';
  const textareaClass = 'w-full bg-gray-950 border border-gray-800 rounded-lg px-4 py-3 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 resize-y scrollbar-adaptive';
  const labelClass = 'block text-sm font-medium text-gray-200 mb-2';
  const helperClass = 'text-xs text-gray-400';

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
            Auto-Tagging Test
            <span className="px-2 py-0.5 text-xs font-mono bg-gray-800 text-gray-400 rounded-md border border-gray-700 font-normal">
              {effectiveModelId}
            </span>
          </h1>
          <p className="text-sm text-gray-500">Local inference via WebLLM</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {loadState === 'idle' || loadState === 'error' ? (
            <button
              onClick={handleLoadModels}
              className="px-4 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              {loadState === 'error' ? 'Retry: load models' : 'Load models'}
            </button>
          ) : (
            <div className={`w-2 h-2 rounded-full ${
              loadState === 'loading' ? 'bg-yellow-500' :
              loadState === 'ready' ? 'bg-green-500' : 'bg-red-500'
            }`} />
          )}
          <span className="text-sm text-gray-400">
            {loadState === 'idle'
              ? 'model not loaded'
              : loadState === 'loading'
                ? loadProgress > 0
                  ? `Loading: ${loadProgress}% — ${loadText}`
                  : 'Loading model...'
                : loadText}
          </span>
          {loadState === 'loading' && (
            <div className="w-32 h-1 bg-gray-800 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-300" style={{ width: `${loadProgress}%` }} />
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left Column (Inputs) */}
        <div className="w-full lg:w-3/5 flex flex-col overflow-y-auto scrollbar-adaptive p-6 space-y-6 border-b lg:border-b-0 lg:border-r border-gray-800">

          {/* Error */}
          {error && (
            <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40 rounded-lg text-sm text-red-600 dark:text-red-400 shrink-0">
              {error}
            </div>
          )}

          {/* Tagging model card — session-scoped picker (never writes the
              aiTagModel pref); mirrors the Settings tier grouping. */}
          <div className={`${cardClass} shrink-0`}>
            <label className={labelClass} htmlFor="tester-tag-model">
              Tagging model
            </label>
            <select
              id="tester-tag-model"
              aria-label="Auto-tag model"
              value={effectiveModelId}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={modelOptions.length === 0 || loadState === 'loading'}
              className="w-full bg-gray-950 border border-gray-800 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {modelOptions.length === 0 ? (
                <option value={effectiveModelId}>{effectiveModelId}</option>
              ) : (
                (['low', 'mid', 'high'] as const).map((tier) => {
                  const tierOptions = modelOptions.filter((o) => o.tier === tier);
                  if (tierOptions.length === 0) return null;
                  return (
                    <optgroup key={tier} label={TAG_TIER_LABELS[tier]}>
                      {tierOptions.map((option) => (
                        <option key={option.modelId} value={option.modelId}>
                          {option.label} · {option.vram}
                        </option>
                      ))}
                    </optgroup>
                  );
                })
              )}
            </select>
            <p className={`${helperClass} mt-2`}>
              {loadState === 'ready'
                ? 'Switching models unloads the current one — click "Load models" to use the new model.'
                : 'Applied on the next "Load models". Per tester session only — Settings is never changed.'}
            </p>
          </div>

          {/* System prompt card */}
          <div className={`${cardClass} flex-1 flex flex-col min-h-[250px]`}>
            <div className="flex items-center justify-between mb-3 shrink-0">
              <label className="text-sm font-medium text-gray-200 m-0">System Prompt</label>
              {systemPromptModified && (
                <span className="px-2 py-0.5 text-xs bg-yellow-50 dark:bg-yellow-900/40 border border-yellow-200 dark:border-yellow-700/40 rounded-full text-yellow-600 dark:text-yellow-500">
                  modified
                </span>
              )}
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className={textareaClass + ' font-mono flex-1 mb-3'}
              placeholder="Enter system prompt..."
            />
            <div className="flex items-center gap-3 shrink-0">
              <button
                onClick={() => setSystemPrompt(TAGS_PROMPT)}
                disabled={!systemPromptModified}
                className={btnChipClass}
              >
                Reset to default
              </button>
              <span className={helperClass}>
                {systemPromptModified
                  ? 'Custom prompt will be used for generation.'
                  : 'Edit the text above to override the default system prompt.'}
              </span>
            </div>
          </div>

          {/* Input card */}
          <div className={`${cardClass} shrink-0`}>
            <label className={labelClass}>Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
              className={textareaClass}
              placeholder="Enter an image generation prompt..."
            />

            {/* Presets */}
            <div className="flex flex-wrap gap-2 mt-3">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => setPrompt(p.value)}
                  className={btnPresetClass}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Controls */}
            <div className="flex items-center gap-4 mt-4">
              <button
                onClick={handleGenerate}
                disabled={loadState !== 'ready' || generating || !prompt.trim()}
                className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {generating ? 'Generating...' : 'Generate Tags'}
              </button>
              <span className="text-xs text-gray-400 ml-auto">Ctrl+Enter to generate</span>
            </div>
          </div>
        </div>

        {/* Right Column (Outputs) */}
        <div className="w-full lg:w-2/5 flex flex-col overflow-y-auto scrollbar-adaptive p-6 space-y-6">
          {/* Results card */}
          <div className={`${cardClass} shrink-0`}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-gray-200">Generated Concepts</h3>
              {lastTime !== null && (
                <span className="text-xs text-gray-400">{tags.length} concept(s) in {lastTime}ms</span>
              )}
            </div>
            <p className="text-[11px] text-gray-500 mb-3">
              The concept chips (max {MAX_TAGS_PER_IMAGE}) the app persists as autoTags — the same
              structured call the auto-tag worker makes per image.
            </p>
            <div className="flex flex-wrap gap-2 min-h-[40px] items-center">
              {tags.length === 0 ? (
                <span className="text-sm text-gray-500">
                  {generating ? 'Generating...' : 'Click "Generate Tags" or press Ctrl+Enter'}
                </span>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-full text-sm text-gray-200"
                  >
                    {tag}
                  </span>
                ))
              )}
            </div>
            <div className="mt-4 border-t border-gray-800 pt-3">
              <h4 className="text-xs font-medium text-gray-400 mb-1">
                Search synonyms + categories <span className="text-gray-600 font-normal">— hidden, feeds search only</span>
              </h4>
              <div className="flex flex-wrap gap-2 min-h-[24px] items-center">
                {synonyms.length === 0 ? (
                  <span className="text-[11px] text-gray-600">
                    {generating
                      ? 'Generating...'
                      : tags.length === 0
                        ? 'Run generation to see the hidden search vocabulary.'
                        : 'None returned (or response was not the structured JSON form).'}
                  </span>
                ) : (
                  synonyms.map((syn) => (
                    <span
                      key={syn}
                      className="px-2.5 py-1 bg-gray-900 border border-dashed border-gray-700 rounded-full text-xs text-gray-400 font-mono"
                    >
                      {syn}
                    </span>
                  ))
                )}
              </div>
              <p className="text-[10px] text-gray-600 mt-1">
                Max {MAX_SYNONYMS_PER_IMAGE} synonyms + {MAX_CATEGORIES_PER_IMAGE} categories — merged, persisted to
                the annotation's hidden synonymTags (searchable-text vocabulary), never shown as chips in the app.
              </p>
            </div>
          </div>

          {/* Raw LLM response (debug) */}
          <div className={`${cardClass} flex-1 flex flex-col min-h-[200px]`}>
            <h3 className="text-sm font-medium text-gray-400 mb-2 shrink-0">Raw model response</h3>
            <pre className="flex-1 text-xs text-gray-400 bg-gray-950 rounded-lg p-3 overflow-auto scrollbar-adaptive whitespace-pre-wrap break-all font-mono">
              {rawResponse || (generating ? 'Generating...' : 'No response yet.')}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
