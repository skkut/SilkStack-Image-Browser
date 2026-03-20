import React, { useState, useEffect } from 'react';
import ImageSizeSlider from './ImageSizeSlider';
import { Grid3X3, List, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

interface FooterProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  itemsPerPage: number;
  onItemsPerPageChange: (items: number) => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  customText?: string;
  filteredCount?: number;
  totalCount?: number;
  directoryCount?: number;
  enrichmentProgress?: { processed: number; total: number } | null;
}

const Token: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <span
    title={title}
    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-800/60 text-gray-300 border border-gray-700/50"
  >
    {children}
  </span>
);

const Footer: React.FC<FooterProps> = ({
  currentPage,
  totalPages,
  onPageChange,
  itemsPerPage,
  onItemsPerPageChange,
  viewMode,
  onViewModeChange,
  customText,
  filteredCount,
  totalCount,
  directoryCount,
  enrichmentProgress,
}) => {
  const [isEditingPage, setIsEditingPage] = useState(false);
  const [pageInput, setPageInput] = useState(currentPage.toString());

  useEffect(() => {
    setPageInput(currentPage.toString());
  }, [currentPage]);

  const handleItemsPerPageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    onItemsPerPageChange(parseInt(value, 10));
  };

  const folderText = directoryCount === 1 ? 'folder' : 'folders';
  const showPageControls = totalPages > 1;
  const hasEnrichmentJob = enrichmentProgress && enrichmentProgress.total > 0;

  return (
    <footer className={`sticky bottom-0 px-6 flex items-center gap-4 bg-gray-900/90 backdrop-blur-md border-t border-gray-800/60 transition-all duration-300 shadow-footer-up ${hasEnrichmentJob ? 'h-14 md:h-16' : 'h-12 md:h-14'}`}>
      <div className="min-w-0 flex-1 flex items-center gap-3 text-xs">
        {customText ? (
           <Token>
             <span className="font-semibold text-gray-200">{customText}</span>
           </Token>
        ) : (
          <>
            {filteredCount !== undefined && totalCount !== undefined && (
              <Token title="Images in current view / Total images">
                <span className="font-semibold text-gray-200">{filteredCount.toLocaleString()}</span>
                <span className="text-gray-600 mx-1">/</span>
                <span className="text-gray-400">{totalCount.toLocaleString()}</span>
              </Token>
            )}
            {directoryCount !== undefined && directoryCount > 0 && (
              <Token title="Number of folders">
                <span className="font-medium text-gray-200">{directoryCount}</span> <span className="text-gray-400 ml-1">{folderText}</span>
              </Token>
            )}
          </>
        )}
        {hasEnrichmentJob && (
          <div className="flex items-center gap-3 px-3 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs shadow-sm animate-in fade-in slide-in-from-bottom-2">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              <span className="font-medium">{enrichmentProgress!.processed}/{enrichmentProgress!.total}</span>
            </div>
            <div className="w-20 h-1.5 bg-gray-700/50 rounded-full overflow-hidden">
              <div className="h-full bg-blue-500 transition-all duration-500 ease-out" style={{ width: `${(enrichmentProgress!.processed / enrichmentProgress!.total) * 100}%` }} />
            </div>
          </div>
        )}
      </div>
      <nav className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-2">
          <label htmlFor="items-per-page" className="text-gray-500 hidden md:inline font-medium">Show:</label>
          <select id="items-per-page" value={itemsPerPage} onChange={handleItemsPerPageChange} className="bg-gray-800/80 border border-gray-700/60 rounded-lg px-2.5 py-1.5 text-gray-200 hover:bg-gray-700 hover:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all cursor-pointer">
            <option value={10}>10</option>
            <option value={20}>20</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={-1}>All</option>
          </select>
        </div>

        {showPageControls && (
          <div className="flex items-center gap-1 border-l border-gray-700/50 pl-4 h-6">
            <div className="flex items-center gap-1 mr-2">
              <button
                onClick={() => onPageChange(1)}
                disabled={currentPage === 1}
                className="p-1.5 rounded-md hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent text-gray-400 hover:text-white transition-all"
                title="First Page"
              >
                <ChevronsLeft className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => onPageChange(currentPage - 1)}
                disabled={currentPage === 1}
                className="p-1.5 rounded-md hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent text-gray-400 hover:text-white transition-all"
                title="Previous Page"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-2 px-1">
              {isEditingPage ? (
                <input
                  type="number"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={() => {
                    setIsEditingPage(false);
                    const val = parseInt(pageInput, 10);
                    if (!isNaN(val) && val >= 1 && val <= totalPages) {
                      onPageChange(val);
                    } else {
                      setPageInput(currentPage.toString());
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setIsEditingPage(false);
                      const val = parseInt(pageInput, 10);
                      if (!isNaN(val) && val >= 1 && val <= totalPages) {
                        onPageChange(val);
                      } else {
                        setPageInput(currentPage.toString());
                      }
                    } else if (e.key === 'Escape') {
                      setIsEditingPage(false);
                      setPageInput(currentPage.toString());
                    }
                  }}
                  className="w-12 bg-gray-800 border border-blue-500/50 rounded px-1 py-0.5 text-center text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  autoFocus
                />
              ) : (
                <button
                  onClick={() => setIsEditingPage(true)}
                  className="px-2 py-0.5 rounded hover:bg-gray-800 transition-colors font-medium text-gray-200"
                  title="Click to jump to page"
                >
                  Page <span className="text-blue-400">{currentPage}</span> of {totalPages}
                </button>
              )}
            </div>

            <div className="flex items-center gap-1 ml-2">
              <button
                onClick={() => onPageChange(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="p-1.5 rounded-md hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent text-gray-400 hover:text-white transition-all"
                title="Next Page"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => onPageChange(totalPages)}
                disabled={currentPage === totalPages}
                className="p-1.5 rounded-md hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent text-gray-400 hover:text-white transition-all"
                title="Last Page"
              >
                <ChevronsRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </nav>
      <div className="flex items-center gap-3 border-l border-gray-700/50 pl-3">
        <ImageSizeSlider />
        <button onClick={() => onViewModeChange(viewMode === 'grid' ? 'list' : 'grid')} className="p-2 hover:bg-gray-800 text-gray-400 hover:text-white rounded-lg transition-all hover:shadow-md" title={`Switch to ${viewMode === 'grid' ? 'list' : 'grid'} view`}>
          {viewMode === 'grid' ? <List className="h-4 w-4" /> : <Grid3X3 className="h-4 w-4" />}
        </button>
      </div>
    </footer>
  );
};

export default Footer;
