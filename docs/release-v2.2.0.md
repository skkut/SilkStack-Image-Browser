# Image MetaHub v2.2.0

## [2.2.0] - 2026-08-21

### AI Intelligence (Premium)

- Fully local **semantic search** and **LLM auto-tagging** powered by WebGPU — images, prompts, and tags never leave your machine
- Whole AI section gated behind a premium license (stamped, tamper-checked validation)

### Semantic Search

- Search by meaning with local Qwen3-Embedding models (0.6B / 4B / 8B; arctic-embed fallbacks) — model selectable in Settings
- Semantic mode toggle in the search bar with live loading/ready/error status
- Union with keyword search — semantic hits first, keyword-only appended, deduplicated
- Sparkle badge on semantic hits in the grid and table views
- Relevance sort order while semantic search is active
- Model-aware thresholds + lexical blend with synonym/hypernym expansion for search quality
- One-time indexing per image, persisted in IndexedDB (`semanticVectors` store, DB v8) and resumed across restarts

### Auto-Tagging with LLMs

- Qwen3-powered tag extraction from embedded prompts (Qwen3 0.6B–8B; Llama 3.2 1B/3B and Hermes 3 3B/8B remain available)
- One model call per image → one bounded flat list (max 15 tags) including search-friendly synonyms
- Processed-once flag; **Clear Auto-Tags** resets it for re-evaluation
- Rule-based fallback when WebGPU is unavailable; auto-tagging shares one WebLLM engine with semantic search

### AI Model Management

- Footer AI-model pill with declared VRAM per model and load/eject controls
- Settings → AI Intelligence: model selection, semantic search toggle, indexing progress and errors

### GPU Selection in Settings

- GPU dropdown lists detected adapter names (auto / high-performance / low-power / software)
- `requestDevice` shim raises WebGPU buffer limits to adapter caps (larger models fit)
- Fixes WebLLM running on the iGPU of dual-GPU laptops (DXGI_ERROR_DEVICE_HUNG) — pick High performance

### Reprocess Images

- Settings → Reprocess Images wipes derived data (thumbnails, auto-tags, semantic vectors) and rebuilds the library through the full pipeline; disabled while processing is in flight

### Developer Tools

- DevTools shell with Semantic Search Tester and Auto-Tagging Tester against an isolated test store (library DB untouched)

### Bug Fixes & Polish

- Semantic search no longer activates by itself — respects the settings toggle
- Clear semantic search resets index state consistently
- Relevance sort appears only while semantic hits are on screen; restores durable sort when cleared
- Offline launches skip AI model loads without erroring
- Semantic tester previews reuse the app thumbnail cache; persisted IDs matched against historical and current shapes

## Downloads

Choose the appropriate installer for your operating system:

###  Windows
- **Installer**: `ImageMetaHub-Setup-2.2.0.exe`
- **Format**: NSIS installer with desktop and start menu shortcuts
- **Size**: ~85MB

###  macOS
- **Intel Macs**: `ImageMetaHub-2.2.0.dmg`
- **Apple Silicon**: `ImageMetaHub-2.2.0-arm64.dmg`
- **Format**: DMG packages with proper entitlements
- **Requirements**: macOS 10.15+

###  Linux
- **Universal**: `ImageMetaHub-2.2.0.AppImage`
- **Format**: Portable AppImage (no installation required)
- **Dependencies**: None (fully self-contained)

## System Requirements

- **OS**: Windows 10+, macOS 10.15+, Ubuntu 18.04+ (or equivalent)
- **RAM**: 4GB minimum, 8GB recommended
- **Storage**: 100MB for application + space for your image collections

## Documentation

- [README](https://github.com/skkut/SilkStack-Image-Browser/blob/main/README.md)
- [Architecture](https://github.com/skkut/SilkStack-Image-Browser/blob/main/docs/ARCHITECTURE.md)
- [Changelog](https://github.com/skkut/SilkStack-Image-Browser/blob/main/docs/CHANGELOG.md)

## Known Issues

- Safari, Firefox, and Brave browsers don't support the File System Access API on macOS
- Use Chrome, Vivaldi, Edge, or the Desktop App for full functionality

## Feedback

Found a bug or have a feature request? [Open an issue](https://github.com/skkut/SilkStack-Image-Browser/issues)!

---

*Released on 2026-08-21*