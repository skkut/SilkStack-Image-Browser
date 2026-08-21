# SilkStack Image Browser v2.2.0

The v2.2.0 release introduces **AI Intelligence** — fully local semantic search and LLM-powered auto-tagging. Every AI feature runs entirely on your machine via WebGPU: your images, prompts, and tags never leave your computer. Both features are premium-gated, and the AI engine (`ai-intelligence`) powers them with a shared, on-device WebLLM runtime.

### Semantic Search

Search your library by meaning, not just keywords. A local Qwen3-Embedding model (0.6B / 4B / 8B — you pick in Settings) turns every image and its tags into a semantic index, so a query like "red fox in snow" finds conceptually related images even when the words never match.

- **Semantic mode in the search bar** — a one-click toggle switches the search box between keyword and semantic matching, with live status (loading / ready / error).
- **Union with keyword search** — semantic results appear first, keyword-only matches are appended, and duplicates are removed, so you never lose access to your old search behavior.
- **Sparkle badge** — semantic hits are marked with a ✨ badge in both the image grid and the table view, so you can see why a result matched.
- **Relevance sort** — a new sort order ranks results by semantic relevance while a semantic search is active.
- **Search-quality tuning** — model-aware match thresholds plus a lexical blend with exact-word overlap and synonym/hypernym expansion ("animal" → dog, cat, fox…) make results useful on real corpora.
- **One-time indexing** — each image is embedded exactly once, results persist in the local database (IndexedDB), and indexing resumes where it left off across app restarts. Vectors load from disk, not re-computed.
- **Model choice** — Qwen3-Embedding 0.6B / 4B / 8B, with snowflake-arctic-embed fallbacks; the 4B model is the default.

### Auto-Tagging with Local LLMs

Auto-tagging now uses a real language model running on your GPU — not just keyword heuristics:

- **Qwen3-powered tag extraction** — the LLM reads the embedded prompt of each image and extracts descriptive tags: subjects, styles, lighting, concepts. Models from Qwen3 0.6B up to 8B (Llama 3.2 1B/3B and Hermes 3 3B/8B remain available).
- **One call, one bounded list** — each image is tagged in a single model call producing one flat list (max 15 tags) that includes search-friendly synonyms and alternate phrasings, so the tags match what a searcher would actually type.
- **Processed-once guarantee** — images carry an `isAutoTagged` flag; re-runs only process new images, and empty results are not retried endlessly. **Clear Auto-Tags** resets the flag so you can re-evaluate the whole library.
- **Rule-based fallback** — if your hardware doesn't support WebGPU or a model fails to load, the system falls back to the rule-based extractor (unless disabled in Settings).
- Auto-tagging and semantic search share a single WebLLM engine — one model loaded at a time per purpose, with a single worker per source.

### AI Model Management

- **Footer AI-model pill** — the footer shows each loaded AI model with its declared VRAM footprint, with load/eject controls. One eject unloads a model; the next use reloads and restores it automatically.
- **Settings → AI Intelligence** — pick your embedding model and auto-tagging model, toggle semantic search, and watch indexing progress and errors live.

### GPU Selection in Settings

- **Detected GPU names** — the GPU dropdown lists the actual adapters on your machine, so you can pick the discrete GPU on dual-GPU laptops (the WebGPU API can't select an adapter by name — this maps your choice to the right `powerPreference`).
- **Preference options** — auto / high-performance / low-power / software.
- **Higher buffer limits** — a `requestDevice` shim raises WebGPU buffer limits to the adapter's caps, so larger models (e.g. Qwen3-Embedding 8B) fit where the default 1 GiB cap would reject them.
- Fixes `DXGI_ERROR_DEVICE_HUNG`-style failures caused by WebLLM silently running on the integrated GPU — set **Settings → GPU → High performance** if you hit GPU crashes.

### Reprocess Images

- **Settings → Reprocess Images** — wipe all derived data (thumbnails, auto-tags, semantic vectors) and rebuild the library from scratch through the full pipeline: re-scan, re-tag, re-index. Disabled while any processing is in flight.

### Premium Gating

- The whole AI Intelligence section (semantic search + auto-tagging) is gated behind a **premium license**. License validation is stamped and tamper-checked; without a valid license the section is hidden and the features are disabled.

### Developer Tools

- **DevTools shell** — a new developer window with a **Semantic Search Tester** and an **Auto-Tagging Tester**: load models manually, run search queries, inspect similarity scores, and exercise the tagging pipeline against an isolated test store (your library database is never touched in tester mode).

### Under the Hood

- **IndexedDB v8 migration** — a new `semanticVectors` store; the app migrates automatically on first launch after upgrade, and the empty store costs nothing until semantic search is enabled.
- **Processing queue & sequencer** — derived-data pipelines run through a bounded queue with a sequencer; tagging and semantic indexing are guaranteed to run once per image even across retries.
- **Worker-based AI runtime** — the `ai-intelligence` engine is consumed from its built bundle and runs in a dedicated worker; model loads skip when the app starts offline.
- **Large test-suite expansion** — semantic store/UI/engine tests, premium-gating and license tests, GPU classification tests, reprocess and processing-queue tests, and more (≈9.5k new lines across both repos).

### Bug Fixes & Polish

- **Semantic search no longer activates by itself** — the search mode now respects the settings toggle and stays off until you enable it.
- **Clear semantic search** now fully resets the index state consistently (search box, badges, and persisted state agree afterwards).
- **Relevance sort fixes** — the sort option appears only while semantic hits are on screen and restores the durable sort when cleared.
- **Offline launches** no longer attempt AI model loads or error out at startup without a connection.
- **Semantic search tester fixes** — thumbnail previews reuse the app's thumbnail cache, and persisted semantic IDs are matched against both historical and current id shapes.

## Feedback

Found a bug or have a feature request? [Open an issue](https://github.com/skkut/SilkStack-Image-Browser/issues)!

---
