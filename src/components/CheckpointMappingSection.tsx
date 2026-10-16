import React, { useMemo, useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import {
  collectCheckpointSummaries,
  getBaseModelEntries,
  isBaseModelLookupAvailable,
} from '../services/baseModelTable';

/**
 * Civitai's own `baseModel` strings, grouped and ordered exactly as Civitai's
 * filter dropdown presents them.
 *
 * **This is a copy, not a fetch, and that is the point.** Civitai publishes no
 * endpoint that lists base models; the values below were taken from its own
 * **Base model** filter, publishers and all. Keeping the source's grouping and
 * order (rather than inventing families) means refreshing this is a mechanical
 * copy-paste that diffs cleanly, and it means the user sees the same list here
 * as on the site they upload to.
 *
 * Exactness matters more than tidiness, because the sidebar facet is a plain set
 * of strings: a hand-picked value that differs from the resolved one by a single
 * character becomes a *second* architecture in the filter list, with half the
 * images behind each. These strings are not the tidy names one would guess — the
 * Wan family is `Wan Video 2.2 TI2V-5B` rather than "Wan 2.2", the Krea Flux line
 * is `Flux.1 Krea` not "Flux.1 K", and there is no `SD 3.5` anywhere.
 *
 * Three things keep it honest between refreshes:
 *   1. **The `baseModels` filter verifies a value.** `GET /api/v1/models?baseModels=`
 *      returning any items at all means Civitai recognises the string; the
 *      endpoint is cursor-paginated and reports no total, so existence is the
 *      signal, not a count. (`Other` is the one value that fails this check while
 *      still being real — it is Civitai's unset fallback, present on real model
 *      versions but not accepted as a filter.)
 *   2. **`libraryExtras` below merges in anything the table already holds**, so
 *      one checkpoint resolving to a value absent from this list adds it to every
 *      other row's dropdown as its own "From your library" group.
 *   3. **`Custom…`** takes a free-text value for everything else.
 *
 * **The list below is deliberately shorter than that dropdown.** What was taken
 * out, and the rule for keeping it out, is in `EXCLUDED_BASE_MODELS`.
 *
 * Last verified against Civitai's filter dropdown: 2026-10-16.
 */
export const STANDARD_BASE_MODEL_GROUPS: Array<{ label: string; options: string[] }> = [
  { label: 'Anima', options: ['Anima'] },
  
  { label: 'Chroma', options: ['Chroma'] },
  { label: 'Baidu', options: ['Ernie'] },
  {
    label: 'Black Forest Labs',
    options: [
      'Flux.1 S',
      'Flux.1 D',
      'Flux.1 Krea',
      'Flux.1 Kontext',
      'Flux.2 D',
      'Flux.2 Klein 9B',
      'Flux.2 Klein 9B-base',
      'Flux.2 Klein 4B',
      'Flux.2 Klein 4B-base',
      'Flux.3',
      'Flux.3 Klein',
      'Flux.3 Klein-base',
      'Flux 3 Video',
    ],
  },  
  { label: 'HiDream', options: ['HiDream', 'HiDream-O1'] },
  { label: 'Tencent', options: ['Hunyuan 1', 'Hunyuan Video'] },
  { label: 'Ideogram', options: ['Ideogram 4.0'] },
  { label: 'Boogu', options: ['Boogu'] },
  { label: 'SDXL Community', options: ['Illustrious', 'NoobAI'] },
  { label: 'Krea AI', options: ['Krea 2', 'Krea 2 Turbo'] },
  { label: 'Lightricks', options: ['LTXV', 'LTXV2', 'LTXV 2.3', 'LTXV 2.5'] },
  { label: 'Lens', options: ['Lens'] },
  { label: 'Lumina', options: ['Lumina'] },
  { label: 'Microsoft', options: ['MageFlow', 'MAI'] },
  { label: 'Mochi', options: ['Mochi'] },
  { label: 'Upscaler', options: ['Upscaler'] },
  { label: 'Other', options: ['Other'] },
  { label: 'PixArt', options: ['PixArt a', 'PixArt E'] },
  { label: 'Pony Diffusion', options: ['Pony', 'Pony V7'] },
  {
    label: 'Alibaba',
    options: [
      'Qwen',
      'Qwen 2',
      'Qwen 2.1',
      'Qwen 3',
      'Wan Video 1.3B t2v',
      'Wan Video 14B t2v',
      'Wan Video 14B i2v 480p',
      'Wan Video 14B i2v 720p',
      'Wan Video 2.2 TI2V-5B',
      'Wan Video 2.2 I2V-A14B',
      'Wan Video 2.2 T2V-A14B',
      'Wan Video 2.5 T2V',
      'Wan Video 2.5 I2V',
      'Wan Image 2.7',
      'Wan Video 2.7',
      'Wan Video 3.0',
    ],
  },
  {
    label: 'Stability AI',
    options: [
      'SD 1.4',
      'SD 1.5',
      'SD 1.5 LCM',
      'SD 1.5 Hyper',
      'SD 2.0',
      'SD 2.1',
      'SDXL 1.0',
      'SDXL Lightning',
      'SDXL Hyper',
    ],
  },
  { label: 'Reve AI', options: ['Reve'] },
  { label: 'Meta', options: ['Muse Image'] },
  { label: 'Alibaba - Tongyi Lab', options: ['ZImageTurbo', 'ZImageBase'] },
  {
    label: 'inclusionAI',
    options: ['Ming Image Design 0.1', 'Ming Image Design Layer 0.1'],
  },
  { label: 'MiniMax', options: ['MiniMax H3', 'MiniMax Music 3'] },
];

const STANDARD_SET = new Set(STANDARD_BASE_MODEL_GROUPS.flatMap((group) => group.options));

/**
 * Values taken out of the list above **by hand**, and left out on purpose.
 *
 * ⚠️ **Re-copying Civitai's filter dropdown re-introduces every one of these**,
 * because the list above is a copy of that dropdown. Remove them again as part
 * of any refresh — the guard test in `checkpointMappingSection.test.tsx` turns a
 * forgotten one into a failure rather than a silent re-appearance in the picker.
 *
 * Two separate removals, both 2026-10-16:
 *
 *   - **Eight entries the picker has no use for** — `AuraFlow`, `CogVideoX`,
 *     `Grok`, `HappyHorse` (not architectures this app is expected to meet) and
 *     `Kolors`, `ACE Audio`, `Sonilo` (audio / speciality models that will never
 *     sit behind an image). Their whole groups went with them.
 *   - **The `Legacy` group** — seven values Civitai's API still filters on but
 *     its UI has retired: `SD 2.1 768`, `SDXL 0.9`, `SDXL 1.0 LCM`,
 *     `SDXL Distilled`, `Wan Video`, `Playground v2`, `Stable Cascade`.
 *
 * Note that `Custom…` still reaches anything here by hand (as does
 * `libraryExtras`, for anything the lookup actually returns), so an exclusion is
 * a statement about what belongs in a dropdown — not a value going unreachable.
 */
export const EXCLUDED_BASE_MODELS: string[] = [
  'AuraFlow',
  'CogVideoX',
  'Grok',
  'HappyHorse',
  'Kolors',
  'ACE Audio',
  'Sonilo',
  'SD 2.1 768',
  'SDXL 0.9',
  'SDXL 1.0 LCM',
  'SDXL Distilled',
  'Wan Video',
  'Playground v2',
  'Stable Cascade',
];

/** Sentinel for the "type your own" branch of the picker. No real base model
 *  can collide with it: Civitai's values are display strings, not identifiers. */
const CUSTOM_VALUE = '__custom__';

/** Checkpoint names contain dots, slashes and spaces — legal in an attribute,
 *  unusable in a CSS selector, so testids get a slugged key. */
const slugify = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '-');

/**
 * Settings → Base Models: the online lookup's switch and maintenance actions,
 * then every distinct checkpoint in the library with a picker to assign it a
 * base model by hand.
 *
 * The switch belongs here rather than in the top bar it started in: it is a
 * network preference, and the one screen that lists what the network is *for* —
 * the checkpoints it can and cannot answer — is this one. Everything the
 * feature needs to be understood is on this screen, so nothing about it has to
 * be discovered from a toolbar glyph.
 *
 * The manual half exists for the checkpoints the online lookup cannot answer —
 * most often because the model file was deleted from disk long ago, which is
 * exactly the case where its base model is still worth knowing. A mapping
 * written here is stored as a `source: 'manual'` row in the main process's
 * offline table, so it is applied to **every image using that checkpoint at
 * once**, survives a restart, is never overwritten by a later lookup, and
 * survives "Clear cached table". It is not per image and nothing is re-indexed.
 *
 * Mounted only while its tab is open (like `AiModelCacheSection`), so the
 * library-wide scan below runs on demand rather than on every store change.
 */
export const CheckpointMappingSection: React.FC = () => {
  const images = useImageStore((state) => state.images);
  const setBaseModelMapping = useImageStore((state) => state.setBaseModelMapping);
  // Subscribe-only read: the version is not used as a value, it is what makes
  // this list re-render when a resolve lands or a mapping is saved. The table
  // itself lives outside React (see services/baseModelTable.ts).
  useImageStore((state) => state.baseModelTableVersion);

  // The online lookup's own controls. Off means "no new lookups" — the offline
  // table already on disk keeps answering, so the column never goes blank just
  // because the network was switched off.
  const onlineModelLookupEnabled = useSettingsStore((state) => state.onlineModelLookupEnabled);
  const setOnlineModelLookupEnabled = useSettingsStore((state) => state.setOnlineModelLookupEnabled);
  const baseModelResolveStatus = useImageStore((state) => state.baseModelResolveStatus);
  const resolveBaseModelsNow = useImageStore((state) => state.resolveBaseModelsNow);
  const clearBaseModelTable = useImageStore((state) => state.clearBaseModelTable);
  const onlineModelLookupAvailable = isBaseModelLookupAvailable();

  const [filter, setFilter] = useState('');
  const [onlyUnmapped, setOnlyUnmapped] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const summaries = useMemo(() => collectCheckpointSummaries(images), [images]);
  const entries = getBaseModelEntries();

  const rows = useMemo(() => {
    const enriched = summaries.map((summary) => {
      const entry = entries[summary.key];
      return {
        ...summary,
        baseModel: entry?.baseModel ?? null,
        isManual: entry?.source === 'manual',
      };
    });

    return enriched.sort((a, b) => {
      // Unmapped first: the whole reason to open this tab is to fill them in,
      // and a library that has settled leaves the mapped ones at the bottom.
      if (!a.baseModel !== !b.baseModel) return a.baseModel ? 1 : -1;
      if (b.imageCount !== a.imageCount) return b.imageCount - a.imageCount;
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
    });
  }, [summaries, entries]);

  /** Base models the table already knows that are not in the standard list —
   *  Civitai grows, so the picker has to offer what it actually returned rather
   *  than only what was known when this list was written. */
  const libraryExtras = useMemo(() => {
    const extra = new Set<string>();
    for (const entry of Object.values(entries)) {
      if (entry?.baseModel && !STANDARD_SET.has(entry.baseModel)) extra.add(entry.baseModel);
    }
    return Array.from(extra).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [entries]);

  const needle = filter.trim().toLowerCase();
  const visibleRows = rows.filter((row) => {
    if (onlyUnmapped && row.baseModel) return false;
    return !needle || row.label.toLowerCase().includes(needle);
  });

  const mappedCount = rows.filter((row) => row.baseModel).length;
  const manualCount = rows.filter((row) => row.isManual).length;

  const handleSelect = (key: string, name: string | null, value: string) => {
    if (value === CUSTOM_VALUE) {
      const current = rows.find((row) => row.key === key)?.baseModel ?? '';
      setDraft(current);
      setEditingKey(key);
      return;
    }
    // '' is the "not set" option — clearing a manual mapping hands the
    // checkpoint back to automatic resolution on the next run.
    void setBaseModelMapping(key, value || null, name);
  };

  const commitCustom = (key: string, name: string | null) => {
    const value = draft.trim();
    setEditingKey(null);
    void setBaseModelMapping(key, value || null, name);
  };

  return (
    <section>
      <h3 className="text-lg font-semibold mb-4 text-gray-200 border-b border-gray-700/50 pb-2">
        Base Models
      </h3>

      {/* The online lookup's switch, which used to be a toolbar button. It sits
          above the list because it is what answers most of the rows below, and
          because the status line ("N of M checkpoints known") reads as the
          heading for the table rather than as a footnote to it. */}
      {onlineModelLookupAvailable && (
      <div className="bg-gray-900/80 p-5 rounded-xl border border-gray-700/50 shadow-sm transition-all hover:border-gray-600 mb-6">
        <div className="flex items-start justify-between">
          <div className="pr-6">
            <p className="text-sm font-medium text-gray-200">Resolve checkpoint base models online</p>
            <p className="text-sm text-gray-400 mt-1 leading-relaxed">
              Looks up each distinct checkpoint's base model — SD 1.5, SDXL 1.0, Pony, Flux.1 D and so on —
              on Civitai and HuggingFace, and shows it as the list view's Base Model column, a sidebar
              filter, and a row in the viewer's Generation details.
            </p>
            <p className="text-sm text-gray-400 mt-2 leading-relaxed">
              The lookup runs by itself as your library changes, once per <span className="text-gray-300">checkpoint</span> rather
              than per image, and the answers are cached in an offline table — so a whole library settles
              after a few dozen requests, and later launches make none at all. Turning this off leaves the
              cached answers in place and only stops new lookups; the mapping table below works either way.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1">
            <input
              type="checkbox"
              checked={onlineModelLookupEnabled}
              onChange={(event) => setOnlineModelLookupEnabled(event.target.checked)}
              data-testid="base-model-lookup-toggle"
              className="sr-only peer"
            />
            <div className="w-11 h-6 bg-gray-700 rounded-full peer peer-focus:ring-2 peer-focus:ring-blue-500 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-500"></div>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-5 pt-4 border-t border-gray-700/50">
          <button
            onClick={() => void resolveBaseModelsNow()}
            disabled={baseModelResolveStatus.state === 'resolving'}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600/20 text-blue-300 border border-blue-700/50 hover:bg-blue-600/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {baseModelResolveStatus.state === 'resolving' ? 'Resolving…' : 'Resolve now'}
          </button>
          <button
            onClick={() => void clearBaseModelTable()}
            className="px-3 py-1.5 text-sm rounded-lg bg-gray-800/80 text-gray-300 border border-gray-700/50 hover:bg-gray-700/80 transition-colors"
          >
            Clear cached table
          </button>
          <span className="text-xs text-gray-500" data-testid="base-model-resolve-status">
            {baseModelResolveStatus.state === 'idle'
              ? 'Resolves using the cache first; only unknown checkpoints are requested.'
              : `${baseModelResolveStatus.resolved} of ${baseModelResolveStatus.total} checkpoints known${
                  baseModelResolveStatus.fetched > 0
                    ? ` — ${baseModelResolveStatus.fetched} requested`
                    : ''
                }`}
          </span>
        </div>
      </div>
      )}

      <p className="text-sm text-gray-400 mb-4 leading-relaxed">
        Checkpoints the lookup cannot answer — typically ones whose file you have
        since deleted — can be assigned a base model by hand below. A mapping
        applies to every image made with that checkpoint, and is kept separate
        from the looked-up answers, so <span className="text-gray-300">Clear cached table</span> will
        not remove it.
      </p>

      <div
        className="bg-gray-900/80 rounded-xl border border-gray-700/50 shadow-sm overflow-hidden"
        data-testid="checkpoint-mapping-section"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800 gap-4">
          <p className="text-sm font-medium text-gray-200">
            {rows.length} checkpoint{rows.length === 1 ? '' : 's'} in your library
          </p>
          <p className="text-xs text-gray-500 text-right shrink-0">
            {mappedCount} with a base model
            {manualCount > 0 ? ` · ${manualCount} mapped by hand` : ''}
          </p>
        </div>

        <div className="flex items-center gap-3 px-5 py-2 border-b border-gray-800 bg-gray-950/40">
          <Search size={14} className="text-gray-500 shrink-0" />
          <input
            type="text"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter checkpoints…"
            aria-label="Filter checkpoints"
            data-testid="checkpoint-mapping-filter"
            className="flex-1 min-w-0 bg-transparent text-sm text-gray-200 placeholder-gray-600 focus:outline-none"
          />
          <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer shrink-0">
            <input
              type="checkbox"
              checked={onlyUnmapped}
              onChange={(event) => setOnlyUnmapped(event.target.checked)}
              data-testid="checkpoint-mapping-only-unmapped"
              className="accent-blue-500"
            />
            Only unmapped
          </label>
        </div>

        {rows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500" data-testid="checkpoint-mapping-empty">
            No checkpoints found yet — this list fills in as your library is indexed.
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-gray-500" data-testid="checkpoint-mapping-no-matches">
            No checkpoints match this filter.
          </div>
        ) : (
          <ul className="divide-y divide-gray-800 max-h-96 overflow-y-auto">
            {visibleRows.map((row) => (
              <li
                key={row.key}
                className="flex items-center justify-between gap-4 px-5 py-3"
                data-testid={`checkpoint-mapping-row-${slugify(row.key)}`}
              >
                <div className="min-w-0">
                  <p className="text-sm text-gray-200 truncate" title={row.label}>
                    {row.label}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {row.imageCount} image{row.imageCount === 1 ? '' : 's'}
                    {row.hash ? ` · ${row.hash.slice(0, 10)}` : ''}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {row.isManual && (
                    <span className="px-2 py-0.5 text-xs rounded-md bg-blue-600/20 text-blue-300 border border-blue-700/50">
                      Manual
                    </span>
                  )}

                  {editingKey === row.key ? (
                    <>
                      <input
                        type="text"
                        value={draft}
                        autoFocus
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') commitCustom(row.key, row.name);
                          if (event.key === 'Escape') setEditingKey(null);
                        }}
                        placeholder="Base model name"
                        aria-label={`Base model for ${row.label}`}
                        data-testid={`checkpoint-mapping-custom-${slugify(row.key)}`}
                        className="w-44 bg-gray-950 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => commitCustom(row.key, row.name)}
                        className="px-3 py-1.5 text-sm rounded-lg bg-blue-600/20 text-blue-300 border border-blue-700/50 hover:bg-blue-600/30 transition-colors"
                      >
                        Save
                      </button>
                    </>
                  ) : (
                    <select
                      value={row.baseModel ?? ''}
                      onChange={(event) => handleSelect(row.key, row.name, event.target.value)}
                      aria-label={`Base model for ${row.label}`}
                      data-testid={`checkpoint-mapping-select-${slugify(row.key)}`}
                      className="w-44 bg-gray-700 text-gray-200 border border-gray-600 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 hover:bg-gray-600 transition-colors cursor-pointer"
                    >
                      <option value="">Not set</option>
                      {STANDARD_BASE_MODEL_GROUPS.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.options.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                      {libraryExtras.length > 0 && (
                        <optgroup label="From your library">
                          {libraryExtras.map((option) => (
                            <option key={option} value={option}>
                              {option}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <option value={CUSTOM_VALUE}>Custom…</option>
                    </select>
                  )}

                  {row.isManual && editingKey !== row.key && (
                    <button
                      type="button"
                      onClick={() => void setBaseModelMapping(row.key, null, row.name)}
                      title="Clear the manual mapping and let the lookup try again"
                      aria-label={`Clear manual mapping for ${row.label}`}
                      className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-blue-900/20 rounded-md transition-colors"
                    >
                      <RotateCcw size={16} />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-gray-500 mt-3 leading-relaxed">
        Mappings are stored with the offline table and never expire. Clearing a
        mapping hands that checkpoint back to the automatic lookup, which will
        query Civitai and HuggingFace for it again — switch the lookup off above
        to map everything by hand.
      </p>
    </section>
  );
};

export default CheckpointMappingSection;
