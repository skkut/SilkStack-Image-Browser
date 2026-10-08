# SilkStack Image Browser v2.4.0

**v2.4.0 is the release where SilkStack Image Browser matures into a production-grade application.** The app is simplified and works consistently across every surface — the grid, the list, the viewer and the compact window all behave the way the others do, and the shape of the window is yours to set and is remembered.

As always, everything AI runs **fully locally on your own GPU** — your images, prompts and tags stay on your machine. The only network calls the app makes are the documented ones: license activation and re-verification, model downloads on first use, update checks, and the anonymous daily usage ping described below.

---

### Major Changes

**Shift + click now selects a range of images.** Click one image, `Shift`+click another, and everything between them is selected. The run connects the clicked card to the **nearest edge** of your current selection — click *before* the selection and it fills up to its first image, click *after* it and it extends from its last — and it is always added to what you already have, never replacing it. The run is measured in the order the cards are actually drawn on screen, so it stays correct in a sorted list or in the Stacks view, where that order is not the library's. Two gestures that used to miss the range now work as well: `Shift`+clicking a card's **checkbox**, and `Shift`+clicking to extend a selection you built by simply opening images.

**The metadata sidebar is now available in Compact mode.** The sidebar button in a compact window used to be a way *out* of the mode. It now docks the metadata panel into the compact window instead: the picture keeps its size to the pixel, and the window grows by exactly the panel's width to hold it, so nothing on screen moves when the panel arrives. When your display has no room left to grow into, it is the picture that gives way — it is **cropped rather than shrunk**, and you can drag it to reach the rest, with the minimap showing which part you are on.

**The compact window remembers its panel.** Close a compact window with the panel open and the next image opens with the panel already docked, at the width you last dragged it to. It is remembered as compact mode's own setting, so a panel docked by `Ctrl+F` is not carried forward — a search you closed does not become a standing choice about every window after it.

**The viewer's sidebar is resizable, and the width is yours.** Drag the panel's left edge and it stays where you put it, in the viewer and in a compact window alike. The default is a slightly narrower **80/20** split than the fixed 70/30 it replaces, and a double-click on the edge puts it straight back. The width is written to storage once the drag ends and is remembered for every image you open after it — personal to you, not per image. The panel can be dragged between **15% and 25%** of the room. In a compact window that share is read against your **display** rather than the frame, so it is a genuine share of the screen: roughly 384px on a 1920-wide display and roughly 768px on a 4K one, where before it was a fixed 384px on both.

**A 7-day free trial, and a subscription to go with it.** The premium AI features could previously only be bought one way — a one-time license, purchased before you could see what they did. There are now two doors. **Start 7-day free trial** takes a card and begins a monthly membership that converts by itself when the week ends: you get an email about **48 hours before the first charge**, and cancelling before then costs nothing. **Buy lifetime license** is the same one-time purchase as before, and subscribers are offered the same buyout from an **Own It Forever** panel on the license screen. Both email a key that goes into the same box in **Settings → License**, and the panel labels what it is looking at — **Trial — N days left**, **Subscription — active**, or **Subscription cancelled — active until the period ends** — so a subscriber who cancels keeps working to the end of the period they paid for. A subscription is re-checked once a day when the app starts and keeps working **offline for up to 14 days** between successful checks; a lifetime license is still trusted offline indefinitely, and no existing customer has to re-enter a key.

**List view sorting, and the viewer follows it.** Opening an image from the list now inherits the list's sort order: the viewer walks the same sequence the rows are drawn in, so `←`/`→` steps through your images exactly as you arranged them. The list also sorts by far more than a filename — click a column header to sort by **model, steps, CFG, resolution, megapixels, aspect ratio, file size, seed, created date** or name, ascending or descending.

### Fixes

**Vulnerabilities and CodeQL alerts are cleared.** `npm audit` reported 24 findings at the workspace root (1 critical, 19 high), 3 in the AI module and 5 in the metadata engine; it now reports **zero in all three**. Every fix lands inside its current major version, so nothing here is an API change. The unused `axios` dependency — declared in `dependencies` but imported by nothing, carrying itself and `form-data` into `app.asar` for 22 advisories between them — is gone from the packaged app. CodeQL's default setup also flagged 18 high-severity alerts, 13 of them polynomial ReDoS in the metadata parser regexes, where an unbounded quantifier could walk a 40KB field and backtrack for **462ms**. Every affected quantifier is now bounded, which makes the scan linear; the bounds sit far above anything real metadata contains, so results on actual images are unchanged.

**Auto-tagging now runs before semantic indexing when AI is switched on.** Switching the AI features on — with the master toggle, or by activating a license — resumed the semantic index directly, skipping the auto-tagging pass that runs ahead of it everywhere else. A freshly added image was therefore embedded from its prompt and existing tags alone, with no auto-tags and none of the hidden synonym vocabulary, and the moment tagging did run it cleared that image's index stamp and forced a full second embed of text that had just been indexed in its weaker form. Switching on now enters the same pipeline startup the file watcher uses, so **auto-tagging completes before the semantic phase** and the enrichment is in the very first embed. Every phase is idempotent, so flipping the switch on an already-processed library costs one cheap pass, and with semantic search switched off the round stops after tagging. A license activated mid-session takes the same path.

**Moving images between folders no longer re-processes them from scratch.** An image's identity is derived from its path, so a move used to look like a deletion followed by a brand-new file: its tags, annotations, thumbnail and embeddings were destroyed, and the file was re-parsed, re-tagged and re-embedded at its new location. Everything derived from it is now carried across the move and re-keyed to the new path, so a moved or renamed image keeps what was already computed for it and costs no re-indexing. Genuinely deleted files are unaffected and keep their existing protection.

### Minor Improvements

- **Text in the expanded stack view is readable in the light theme.** The yellow highlight marking the words that differ between prompts used a gray token for its text, and SilkStack's gray scale is inverted per theme — `gray-900` is near-white in light mode — so highlighted words were drawn white-on-yellow. The highlight's text is now literal black, in the stack view and in the viewer's own search matches alike.
- **`Ctrl+F` from the grid now puts the cursor in the search bar**, so you can start typing a query without reaching for the mouse.
- **Loading an AI model shows a progress bar.** Clicking **Auto-Tag** now reads *"Loading AI model: N%"* with a filling bar while the model is fetched and loaded into GPU memory, instead of a pill that vanished for the whole load and reappeared only once the first image was tagged. Semantic indexing shows the same readout during its model load.
- **Qwen3 1.7B is the default auto-tagging model.** Hermes 3 3B had been the fixed default since LLM tagging shipped; the catalog's default is now **Qwen3 1.7B** — smaller (about 1.2 GB against 2.0 GB), multilingual, and the best quality-per-GB in the low-VRAM tier, so the first tagging run downloads less and leaves more room beside the embedding model. Hermes 3 3B is still one pick away, and a model you chose yourself stays chosen.
- **Images can now be dragged and dropped from the list view.** Rows drag exactly like grid cards — drop them onto your file manager or another app, and when the dragged row is part of a selection, the whole selection goes with it.
- **The list view gained a created date**, shown per row and sortable from its column header.
- **ComfyUI's SeedNode is supported.** The comfy-core `SeedNode` (v0.31+) is a widget-only node whose seed is wired into samplers by converting their seed widget into a link — and the sampler keeps its *last* widget value, which is stale. The parser now follows the **link** in preference to that leftover value, so the seed actually used for a generation is the one that gets read, including through subgraphs.
- **Basic anonymous usage analysis.** The packaged app sends one ping per day with a random install ID, the app version, the operating system and the plan — free, trial or pro. **Nothing from your library is included**, the country comes from the connection and the IP is discarded, and it runs only in packaged builds. It tells us which platforms and plans to keep building for; nothing more.

More features are coming soon. Follow, subscribe and keep looking for updates.

---

## License & Build Provenance

This release contains Mozilla Public License 2.0 code. The corresponding source ships in the attached **`silkstack-mpl-covered-sources-v2.4.0.zip`** and in the repository's [`mpl-covered-sources/`](https://github.com/skkut/SilkStack-Image-Browser/tree/main/mpl-covered-sources) directory. Built from the private `ai-intelligence` revision `b7c608b` (source drop at the link above). Covered-sources ZIP SHA-256: `24E9B6FF85A296F4AC3986B184A33B2ACED96771E48B89054A5C541EF2512267`.

---

## Feedback

Found a bug or have a feature request? [Open an issue](https://github.com/skkut/SilkStack-Image-Browser/issues)!

---
