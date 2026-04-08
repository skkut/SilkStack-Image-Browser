## Basic Instructions

SilkStack Image Browser is a desktop application (Electron + React + TypeScript) for browsing, searching, and organizing AI-generated images locally.

The development is done in Windows, so use Windows-specific tools and commands when needed for development. Always ensure that the code is compatible with both Windows, MacOS and Linux. Check if final code builds without errors. Use only tmp folder for temporary files.

When working on this codebase:

- Always read existing code before modifying
- Maintain backward compatibility with cached data
- Test with multiple AI generator formats
- Consider performance impact on large collections
- Keep privacy-first approach (no external connections)
- Follow TypeScript best practices
- Write tests for new functionality

### Code Style

- Use TypeScript strict mode
- Follow existing naming conventions
- Use functional React components with hooks
- Prefer explicit typing over `any`
- Keep components focused and single-responsibility

**Key Dependencies & Technologies:**

- **Runtime & Build:** `electron` (^38.1.2), `vite` (^7.2.4), `typescript` (^5.2.2), `eslint` (^9.37.0) (Note: package scope is `"type": "module"`)
- **Frontend Framework:** `react` & `react-dom` (^18.2.0)
- **State Management:** `zustand` (^5.0.8)
- **Styling & UI:** `tailwindcss` (^3.4.18), `postcss` (^8.5.6), `autoprefixer` (^10.4.21)
- **Icons & Animations:** `lucide-react` (^0.544.0), `framer-motion` (^12.23.24)
- **UI Components & Virtualization:** `react-window` (^1.8.10), `react-virtualized-auto-sizer` (^1.0.26), `recharts` (^3.4.1), `react-zoom-pan-pinch` (^3.6.1)
- **Testing:** `vitest` (^3.2.4), `@testing-library/react` (^16.3.0), `playwright` (^1.59.1)
- **Metadata & Files:** `exifr` (^7.1.3), `pngjs` (^7.0.0), `cbor-js` (^0.1.0), `chokidar` (^5.0.0)
- **Storage:** IndexedDB for caching

**Key NPM Scripts (from package.json):**

- `npm run dev:app` - Run the full Electron + React dev environment
- `npm run dev` - Run the browser-only dev server
- `npm run build` - Compile TypeScript and build the React output
- `npm test` - Run tests via vitest
- `npm run lint` - Run ESLint
- `npm run electron-dist` - Build distributable without publishing
- `npm run auto-release <version>` - Execute the complete automated CI/CD pipeline
- `npm run cli:parse` / `npm run cli:index` - Execute CLI interface commands

## Project Structure

```
/
├── electron/              # Electron application code
│   ├── main.mjs           # Electron main process
│   ├── preload.js         # Electron preload script
│   └── fileWatcher.mjs    # File system watcher
├── scripts/               # Maintenance, release, and CLI scripts (cli.ts)
├── src/                   # Main React application source
│   ├── components/        # React components
│   ├── services/          # Business logic services
│   ├── store/             # Zustand state management
│   ├── utils/             # Utility functions
│   ├── hooks/             # Custom React hooks
│   ├── App.tsx            # Main React application component
│   ├── types.ts           # TypeScript type definitions
│   └── __tests__/         # Test files
├── docs/                  # Documentation and guides
└── public/                # Static assets
```

- **README.md**: [README.md](README.md) (User-facing documentation and features)
- **ARCHITECTURE.md**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Technical architecture and design decisions)
- **CHANGELOG.md**: [docs/CHANGELOG.md](docs/CHANGELOG.md) (Version history and changes)
- **RELEASE-GUIDE.md**: [docs/RELEASE-GUIDE.md](docs/RELEASE-GUIDE.md) (Release workflow for maintainers)
- **CLI-README.md**: [docs/CLI-README.md](docs/CLI-README.md) (CLI tool documentation)

## Key Features to Maintain

1. **Privacy**: All processing is local, no external connections
2. **Performance**: Optimized for 18,000+ images with smart caching
3. **Metadata Search**: Full-text search across all metadata fields
4. **Multi-Format Support**: Handle various AI generator formats
5. **File Operations**: Rename, delete (desktop only)
6. **Video & GIF Support**: Indexing, playback, and thumbnail support for MP4, WEBM, and GIF files
7. **Shadow Metadata**: View original metadata and revert changes (non-destructive editing)
8. **Subfolder Management**: Ability to exclude specific subfolders from indexing

## Smart Library & Auto-Tags

- **Clustering & Stacks**: `services/clusteringEngine.ts`, `services/workers/clusteringWorker.ts`, `components/SmartLibrary.tsx`, `components/StackCard.tsx`, `components/StackExpandedView.tsx`
- **Auto-Tags (TF-IDF)**: `services/autoTaggingEngine.ts`, `services/workers/autoTaggingWorker.ts`, `components/TagsAndFavorites.tsx`, `components/ImageModal.tsx`, `components/ImagePreviewSidebar.tsx`
- **Cluster Cache**: `services/clusterCacheManager.ts` (atomic writes, userData path resolution)

## Common Tasks

### Adding Smart Library Features

1. Update clustering or auto-tagging logic in `src/services/` or `src/utils/`
2. Update UI in `src/components/SmartLibrary.tsx` or stack components
3. Extend store state in `src/store/useImageStore.ts` if needed
4. Add/adjust worker logic in `src/services/workers/` for background tasks
5. Add tests in `src/__tests__/` when parser or tokenizer changes

### Adding New Metadata Format Support

1. Add parser in `src/services/parsers/`
2. Update type definitions in `src/types.ts`
3. Add tests in `src/__tests__/`
4. Update CLI parser if applicable
5. Document in `docs/CHANGELOG.md`

### Adding New UI Features

1. Create component in `src/components/`
2. Add state management in `src/store/` if needed
3. Update `src/App.tsx` to integrate
4. Consider Electron/browser compatibility
5. Test with large collections

### Fixing Performance Issues

1. Check IndexedDB caching logic
2. Review virtual scrolling implementation
3. Profile with large image collections
4. Consider lazy loading and background processing

## Testing Strategy

- Unit tests for parsers and utilities
- Component tests for React components
- Integration tests for metadata extraction
- Manual testing with various AI generator outputs
- Performance testing with 10,000+ images

## Browser vs Desktop Considerations

Some features are desktop-only (Electron):

- File system operations (rename, delete, show in folder)
- Command-line arguments
- Auto-updater
- Native file dialogs

Browser version uses File System Access API with limited capabilities.

## Performance Tips

- Always test with large image collections (10,000+ images)
- Use React.memo() for expensive components
- Implement proper virtualization for lists
- Cache metadata aggressively in IndexedDB
- Process files in background threads when possible
- Use synchronous I/O (`fs.openSync`) for header reads during indexing to prevent disk contention (Phase B optimization)
