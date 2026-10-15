import React from 'react';
import CustomMenuBar from './CustomMenuBar';
import SearchBar from './SearchBar';
import { FolderSync, FolderX, Settings, Sparkles, Ban, ChevronDown, RefreshCw, Boxes, PackageX, Loader2 } from 'lucide-react';
import { useAiFeaturesEnabled, useAiMasterEnabled, useAiModelFeaturesEnabled } from '../services/aiFeatureAccess';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { isBaseModelLookupAvailable } from '../services/baseModelTable';
import { SortOrder, type SettingsTab } from '../types';

interface TopMenuBarProps {
    onOpenSettings: (tab?: SettingsTab) => void;
    onAddFolder: () => void;
    onToggleView: () => void;
    onUndo?: () => void;
    hasUndo?: boolean;
    activeView?: 'library' | 'smart' | 'model';
    onLibraryViewChange?: (view: 'library' | 'smart' | 'model') => void;
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    isSidebarCollapsed?: boolean;
    hasDirectories?: boolean;
    // Sort Order control — moved here from the sidebar; App.tsx wires the
    // same store values/actions the sidebar used, so behavior is unchanged.
    sortOrder?: SortOrder;
    onSortOrderChange?: (value: string) => void;
    onReshuffle?: () => void;
    /** True while semantic hits are on screen — shows the "Relevance" option. */
    semanticActive?: boolean;
}

const TopMenuBar: React.FC<TopMenuBarProps> = ({
    onOpenSettings,
    onAddFolder,
    onToggleView,
    onUndo,
    hasUndo = false,
    activeView,
    onLibraryViewChange,
    searchQuery,
    setSearchQuery,
    isSidebarCollapsed = false,
    hasDirectories = false,
    sortOrder = 'date-desc',
    onSortOrderChange,
    onReshuffle,
    semanticActive = false
}) => {
    // Runtime gate: the Stacks view tab requires premium license
    const aiFeaturesEnabled = useAiFeaturesEnabled();
    // Semantic search (§9): the sparkles button is the feature's ONLY
    // switch. Availability therefore needs just the premium gate (master ∧
    // license ∧ module) — NOT the pref, or a switched-off feature could
    // never be switched back on. 'semantic' (purple glow) ranks results by
    // embedding similarity; 'off' (gray) is pure keyword search. Store
    // state flows down — SearchBar stays presentational.
    const semanticAvailable = useAiModelFeaturesEnabled();
    const semanticMode = useImageStore((state) => state.semanticMode);
    const semanticSearchStatus = useImageStore((state) => state.semanticSearchStatus);
    const setSemanticMode = useImageStore((state) => state.setSemanticMode);
    const setSemanticSearchEnabled = useSettingsStore((state) => state.setSemanticSearchEnabled);

    // Real-time folder monitoring: global on/off, persisted in settings.
    // App.tsx watches this value and starts/stops the OS watchers on change.
    const globalAutoWatch = useSettingsStore((state) => state.globalAutoWatch);
    const toggleGlobalAutoWatch = useSettingsStore((state) => state.toggleGlobalAutoWatch);

    // Checkpoint → base model lookup. On by default, and the button is the
    // visible switch the feature ships with. Off means "no new lookups" — the
    // offline table already on disk keeps answering, so the column never goes
    // blank just because the network was switched off.
    const onlineModelLookupEnabled = useSettingsStore((state) => state.onlineModelLookupEnabled);
    const setOnlineModelLookupEnabled = useSettingsStore((state) => state.setOnlineModelLookupEnabled);
    const baseModelResolveStatus = useImageStore((state) => state.baseModelResolveStatus);
    const onlineModelLookupAvailable = isBaseModelLookupAvailable();
    const baseModelResolving = baseModelResolveStatus.state === 'resolving';

    // The library's list view sorts from its column headers (ImageTable owns
    // that order), so the header sort box is disabled while it is on screen.
    // Only the library view has a list mode — SmartLibrary/ModelView render
    // their own layouts whatever viewMode says, and keep the header control.
    const viewMode = useSettingsStore((state) => state.viewMode);
    const sortDisabled = activeView === 'library' && viewMode === 'list';

    // Master AI-features toggle: when off, no model may load into VRAM.
    // The button is premium-only chrome (license-gated below); the raw pref
    // stays independent and persisted so it keeps the user's last choice
    // across license lapses. The Stacks tab above is unaffected by this pref.
    const aiMasterEnabled = useAiMasterEnabled();
    const setAiFeaturesEnabled = useSettingsStore((state) => state.setAiFeaturesEnabled);

    const handleToggleSemantic = () => {
        if (semanticMode === 'semantic') {
            // OFF: switch the feature itself off — the persisted pref flip
            // clears the hits via useImageStore's settings subscription, and
            // nothing embeds in the background while it stays off.
            setSemanticSearchEnabled(false);
            setSemanticMode('off');
        } else {
            // ON: the pref flip is what starts the Δ-index build (same
            // subscription; idempotent, so a re-enable only embeds what
            // changed), then the mode flip re-runs the current query against
            // whatever is already embedded.
            setSemanticSearchEnabled(true);
            setSemanticMode('semantic');
        }
    };

    const [isDev, setIsDev] = React.useState<boolean>(false);

    React.useEffect(() => {
        const fetchInfo = async () => {
            try {
                if (typeof window !== 'undefined' && window.electronAPI?.isDev) {
                    const devStatus = await window.electronAPI.isDev();
                    setIsDev(devStatus);
                }
            } catch (error) {
                console.error('Failed to fetch dev status:', error);
            }
        };
        fetchInfo();
    }, []);

    // Only show in Electron (desktop app)
    const isDesktop = !!window.electronAPI;
    
    if (!isDesktop) return null;

    const offset = hasDirectories 
        ? (isSidebarCollapsed ? 'var(--sidebar-collapsed-width)' : 'var(--sidebar-width)') 
        : '0px';

    return (
        <div 
            className="bg-gray-900/40 backdrop-blur-md border-b border-gray-800/60 fixed top-0 right-0 z-[100] select-none shadow-sm flex items-center pt-0.5 pb-0.5 transition-all duration-300"
            style={{ 
                height: 'var(--header-height, 44px)',
                left: offset,
                width: `calc(100% - ${offset})`,
                WebkitAppRegion: 'drag'
            } as any}
        >
            {/* Menu Items */}
            <div className="flex items-center h-full shrink-0 px-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <CustomMenuBar
                    onOpenSettings={onOpenSettings}
                    onAddFolder={onAddFolder}
                    onToggleView={onToggleView}
                    onUndo={onUndo}
                    hasUndo={hasUndo}
                />
            </div>

            {/* Center Side - View Controls */}
            {activeView && onLibraryViewChange && (
                <div className="flex-1 flex justify-center pointer-events-none">
                    <div className="flex items-center bg-gray-800/50 rounded-full p-0.5 border border-gray-700/50 overflow-hidden pointer-events-auto" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        <button
                            onClick={() => onLibraryViewChange('library')}
                            className={`px-3.5 py-1 text-[13.5px] font-semibold rounded-full transition-all duration-200 ${
                                activeView === 'library'
                                ? 'bg-blue-600 text-white shadow-md shadow-blue-900/20'
                                : 'text-gray-400 hover:text-gray-200 dark:hover:text-white hover:bg-gray-300/20 dark:hover:bg-white/5'
                            }`}
                        >
                            Library
                        </button>
                        {aiFeaturesEnabled && (
                        <button
                            onClick={() => onLibraryViewChange('smart')}
                            className={`px-3.5 py-1 text-[13.5px] font-semibold rounded-full transition-all duration-200 ${
                                activeView === 'smart'
                                ? 'bg-purple-600 text-white shadow-md shadow-purple-900/20'
                                : 'text-gray-400 hover:text-gray-200 dark:hover:text-white hover:bg-gray-300/20 dark:hover:bg-white/5'
                            }`}
                        >
                            Stacks
                        </button>
                        )}
                        <button
                            onClick={() => onLibraryViewChange('model')}
                            className={`px-3.5 py-1 text-[13.5px] font-semibold rounded-full transition-all duration-200 ${
                                activeView === 'model'
                                ? 'bg-emerald-600 text-white shadow-md shadow-emerald-900/20'
                                : 'text-gray-400 hover:text-gray-200 dark:hover:text-white hover:bg-gray-300/20 dark:hover:bg-white/5'
                            }`}
                        >
                            Models
                        </button>
                    </div>
                </div>
            )}

            {/* Right Side - Actions (Search & Settings) */}
            <div className="flex items-center gap-2 min-w-0 pr-1 ml-auto">
                {/* Search Bar */}
                {activeView && (
                    <div className="flex items-center h-full mr-1 min-w-0 flex-1 justify-end" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        <SearchBar
                            value={searchQuery}
                            onChange={setSearchQuery}
                            semanticAvailable={semanticAvailable}
                            semanticMode={semanticMode}
                            semanticStatus={semanticSearchStatus}
                            onToggleSemantic={handleToggleSemantic}
                        />
                    </div>
                )}
                
                {/* Sort Order — was in the sidebar; lives here so it stays
                    visible even when the sidebar is collapsed. Rendered only
                    when App wires the handlers (kept optional for tests). */}
                {activeView && onSortOrderChange && (
                    <div className="flex items-center gap-1.5 h-full shrink-0" style={{ WebkitAppRegion: 'no-drag' } as any}>
                        <label
                            htmlFor="topbar-sort"
                            className={`text-xs text-gray-400 whitespace-nowrap ${sortDisabled ? 'opacity-50' : ''}`}
                        >Sort:</label>
                        {/* The tooltip sits on the wrapper: a disabled control
                            doesn't reliably receive the hover it needs. */}
                        <div
                            className="relative"
                            title={sortDisabled ? 'List view sorts from the column headers' : undefined}
                        >
                            <select
                                id="topbar-sort"
                                value={sortOrder}
                                onChange={(e) => onSortOrderChange(e.target.value)}
                                disabled={sortDisabled}
                                className={`h-8 appearance-none bg-gray-800/50 text-gray-200 text-sm border border-gray-700/50 rounded-full pl-3 pr-8 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 transition-all duration-300 ${
                                    sortDisabled
                                        ? 'opacity-50 cursor-not-allowed'
                                        : 'cursor-pointer hover:bg-gray-800/70'
                                }`}
                            >
                                {semanticActive && <option value="relevance">Relevance</option>}
                                <option value="date-desc">Newest First</option>
                                <option value="date-asc">Oldest First</option>
                                <option value="asc">A-Z</option>
                                <option value="desc">Z-A</option>
                                <option value="random">Random</option>
                                {/* Stack-size sorts: only meaningful in the Stacks view,
                                    where the list is made of stacks. Kept last so the
                                    option order of the other views is unchanged. */}
                                {activeView === 'smart' && (
                                    <>
                                        <option value="stack-desc">Most Images</option>
                                        <option value="stack-asc">Fewest Images</option>
                                    </>
                                )}
                            </select>
                            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
                        </div>
                        {sortOrder === 'random' && onReshuffle && (
                            <button
                                onClick={onReshuffle}
                                className="p-1.5 rounded-full text-gray-400 hover:text-gray-200 hover:bg-gray-700/80 transition-all duration-200"
                                title="Reshuffle Random Order"
                                aria-label="Reshuffle random order"
                            >
                                <RefreshCw className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                )}

                {/* Settings + Real-time Monitoring Toggle */}
                <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as any}>
                    {isDev && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-500/20 text-amber-500 border border-amber-500/30 rounded uppercase tracking-tighter shadow-[0_0_10px_rgba(245,158,11,0.1)]">
                            Dev
                        </span>
                    )}
                    {/* Master AI-features toggle: off = no model loads (auto-tag,
                        semantic search). Independent persisted pref — stacking is
                        rule-based and unaffected. Premium-only chrome, like the
                        Stacks tab above: renders only under an active license.
                        License-gated, NOT master-gated — while off, the button
                        must stay visible so the user can re-enable. */}
                    {aiFeaturesEnabled && (
                    <button
                        onClick={() => setAiFeaturesEnabled(!aiMasterEnabled)}
                        className={`p-1.5 rounded-full transition-all duration-200 ${
                            aiMasterEnabled
                                ? 'text-purple-400 bg-purple-500/10 shadow-[0_0_10px_rgba(168,85,247,0.4)]'
                                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/80'
                        }`}
                        title={aiMasterEnabled
                            ? 'AI features on — click to disable all model loading'
                            : 'AI features off — click to enable auto-tag & semantic search'}
                        aria-label="Toggle all AI features"
                        aria-pressed={aiMasterEnabled}
                        data-testid="ai-features-toggle-button"
                    >
                        {aiMasterEnabled ? <Sparkles size={20} /> : <Ban size={20} />}
                    </button>
                    )}
                    <button
                        onClick={toggleGlobalAutoWatch}
                        className={`p-1.5 rounded-full transition-all duration-200 ${
                            globalAutoWatch
                                ? 'text-blue-400 bg-blue-500/10 shadow-[0_0_10px_rgba(59,130,246,0.4)]'
                                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/80'
                        }`}
                        title={globalAutoWatch
                            ? 'Monitoring folders in real-time — click to pause'
                            : 'Real-time monitoring paused — click to resume'}
                        aria-label="Toggle real-time folder monitoring"
                        aria-pressed={globalAutoWatch}
                        data-testid="auto-watch-toggle-button"
                    >
                        {globalAutoWatch ? <FolderSync size={20} /> : <FolderX size={20} />}
                    </button>
                    {/* Base model lookup: resolves each distinct checkpoint to
                        its architecture family (SD 1.5, SDXL 1.0, Pony, …) via
                        Civitai / HuggingFace and caches the answers offline.
                        Desktop-only — in the browser build there is no cache
                        file to read or write, so the button is not rendered. */}
                    {onlineModelLookupAvailable && (
                    <button
                        onClick={() => setOnlineModelLookupEnabled(!onlineModelLookupEnabled)}
                        className={`p-1.5 rounded-full transition-all duration-200 ${
                            baseModelResolving
                                ? 'text-blue-400 bg-blue-500/10'
                                : onlineModelLookupEnabled
                                    ? 'text-blue-400 bg-blue-500/10 shadow-[0_0_10px_rgba(59,130,246,0.4)]'
                                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/80'
                        }`}
                        title={
                            baseModelResolving
                                ? `Resolving base models… ${baseModelResolveStatus.resolved} known of ${baseModelResolveStatus.total} checkpoints`
                                : onlineModelLookupEnabled
                                    ? 'Base model lookup on — click to stop querying Civitai / HuggingFace (already-resolved models are kept)'
                                    : 'Base model lookup off — click to resolve checkpoint base models online'
                        }
                        aria-label="Toggle online base model lookup"
                        aria-pressed={onlineModelLookupEnabled}
                        data-testid="base-model-lookup-toggle-button"
                    >
                        {baseModelResolving
                            ? <Loader2 size={20} className="animate-spin" />
                            : onlineModelLookupEnabled ? <Boxes size={20} /> : <PackageX size={20} />}
                    </button>
                    )}
                    <button
                        onClick={() => onOpenSettings()}
                        className="p-1.5 rounded-full hover:bg-gray-700/80 text-gray-400 hover:text-gray-100 transition-all hover:rotate-45"
                        title="Open Settings"
                    >
                        <Settings size={20} />
                    </button>
                </div>
            </div>

            {/* Right Side - Reserved for Windows Native Controls (approx 140px) */}
            <div className="w-[140px] flex-shrink-0 h-full" />
        </div>
    );
};

export default TopMenuBar;
