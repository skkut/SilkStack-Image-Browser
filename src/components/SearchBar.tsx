
import React from 'react';
import { Loader2, Sparkles } from 'lucide-react';

interface SearchBarProps {
  value: string;
  onChange: (query: string) => void;
  // Semantic search (§9) — presentational: TopMenuBar wires these.
  semanticAvailable?: boolean; // useSemanticSearchEnabled() — hides the button
  semanticMode?: 'auto' | 'semantic' | 'off';
  semanticStatus?: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
  onToggleSemantic?: () => void;
}

const SearchBar: React.FC<SearchBarProps> = ({
  value,
  onChange,
  semanticAvailable = false,
  semanticMode = 'auto',
  semanticStatus = 'idle',
  onToggleSemantic,
}) => {
  // Clear handler
  const handleClear = () => onChange('');

  // Handle Escape key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClear();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onChange]);

  const semanticActive = semanticMode === 'semantic';

  return (
    <div className="relative w-full max-w-[16rem] min-w-[100px] group">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={semanticActive ? 'Search (semantic)' : 'Search'}
        className={`w-full h-8 bg-gray-800/50 backdrop-blur-sm text-sm text-gray-200 placeholder-gray-400 py-1 pl-8 ${
          semanticAvailable ? 'pr-14' : 'pr-8'
        } rounded-full border border-gray-700/50 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/30 transition-all duration-300 shadow-sm hover:bg-gray-800/70`}
        data-testid="search-input"
      />
      <div className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 transition-colors duration-300 group-focus-within:text-blue-500">
        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>

      {semanticAvailable && (
        <button
          onClick={onToggleSemantic}
          title="Semantic search (AI)"
          aria-label="Toggle semantic search"
          data-testid="semantic-toggle-button"
          className={`absolute right-8 top-1/2 -translate-y-1/2 p-1 rounded-full transition-all duration-200 ${
            semanticActive
              ? 'text-purple-400 bg-purple-500/10 shadow-[0_0_10px_rgba(168,85,247,0.4)]'
              : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
          }`}
        >
          {semanticStatus === 'loading' ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Sparkles size={13} />
          )}
        </button>
      )}

      {value && (
        <button
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white transition-colors p-1 rounded-full hover:bg-gray-700/50"
          aria-label="Clear search"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
};

export default SearchBar;
