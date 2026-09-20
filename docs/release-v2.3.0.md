# SilkStack Image Browser v2.3.0

**v2.3.0 is the release where SilkStack starts understanding what your prompts *mean*.** Images generated from reworded, rephrased or translated prompts now find each other — both in search and in your stacks. Alongside that, the viewer gains a minimap, in-prompt search and a compact window mode, the AI features get a proper off switch, and the app moves to Electron 43.

As always, everything AI runs **fully locally on your own GPU** — no accounts, no cloud, and your images, prompts and tags never leave your machine.

![Semantic search and AI features in SilkStack](docs/Semantic-Search-and-AI%20Features.jpg)

---

### Vector Similarity Stacks: Grouped by Meaning, Not Just Wording

Variations of the same idea are rarely worded the same way. *"a girl in a pink gown"* and *"a princess wearing a pink dress"* describe the same picture, but share almost no words. Until now, stacking compared prompt text; now it also compares what the prompts **mean**.

- **Vector embeddings** — each prompt is embedded with the same local model that powers search, and prompts whose embeddings are close are grouped together. Reworded, translated and synonym-only variations now land in the same stack.
- **Two signals, one result** — a stack now forms when *either* the text-similarity score *or* the embedding similarity clears its bar. The combination is a union, so the new signal can only ever **add** images to a stack — it can never break up a group that text matching already found.
- **Works without AI** — grouping is built on top of plain text matching or AI, so stacks still work exactly as before (premium feature).
- **Group how you like** — group by **Prompt**, **Model** or **Loras**, or turn grouping off entirely.
- **Sort stacks by size** — the Stacks view's sort menu gains **Most Images** and **Fewest Images**, so the stacks that matter most to you surface first.

![Prompt variation highlighting in a similarity stack](docs/Highlights-in-Similarity-Stack-view.jpg)

### Highlight What Actually Changed

Opening a similarity stack shows you every prompt side by side. With **Highlight** enabled and prompting grouping on, SilkStack marks the exact words that **differ** between the prompts in that stack — so comparing two generations becomes a glance instead of a read. Spotting that one generation added an age, changed a colour, or swapped a single adjective is now instant.

### An Off Switch for AI — and Your VRAM Back

The AI features are powerful, but you should not have to pay for them in GPU memory when you are not using them.

- **Top-bar AI toggle (new)** — one button turns every AI feature on or off: model loading, semantic search and auto-tagging. Useful when you want SilkStack to stay completely out of your GPU while you are generating, or while another app needs the VRAM. 
- **Settings → AI Intelligence (new)** — manages your cached models end to end. Every model on disk is listed with its size (and the total), and each can be deleted individually to reclaim disk space. Deleted models are simply re-downloaded the next time they are needed. On a multi-GPU setup, this is also where you pick the GPU the models run on.
- **The footer model pill** rounds this out: it shows which models are currently resident in GPU memory and how much VRAM each needs, with an **Eject** button to hand the memory straight back. The next AI action loads them again automatically.

![Managing cached AI models in Settings](docs/Manage-AI-Models-Settings.jpg)

### The Image Viewer, Upgraded

Finding a word inside a long prompt used to mean scrolling a wall of text. Not any more:

- **`Ctrl+F` in the viewer** — search inside the prompt of the image you are looking at. Matches are highlighted with a match counter; `Enter` and `Shift+Enter` step through them, `Esc` closes the search. It works in the metadata panel, so opening the search steps out of compact mode automatically.
- **Minimap** — zoom into a large image and a minimap appears in the corner, showing which part of the picture you are looking at. Drag it to move around, and the footer keeps your zoom percentage with a one-click reset.

![In-prompt search and the minimap in the image viewer](docs/Image-View-Ctrl-F-Minimap.jpg)

### Compact Window Mode

A new way to keep an eye on your generations without giving up your screen. **Fit window to image** collapses the viewer into a slim window sized to the image itself — no sidebar, no metadata panel, just the picture. It can sit beside ComfyUI (or any other app) while you work, and it remembers your scale as you step through images. Maximising, resizing and leaving fullscreen all behave properly in this mode.

![Compact window mode](docs/Compact-window-mode-viewer.jpg)

### One-Click Folder Watching

Real-time folder monitoring can now be switched on and off from the top bar, next to the search box — a single button toggles watching for every folder at once. The icon makes the current state obvious (watching / not watching), and the same toggle remains in Settings → General for when you are already in there. Handy when you want to pause indexing during a heavy generation session without removing folders from your library.

### Sort Order, Where You Can Actually Reach It

The sort dropdown moved out of the sidebar and into the top bar, so it stays visible and clickable even when the sidebar is collapsed. It now also carries the Stacks view's **Most Images** / **Fewest Images** orders described above, and the reshuffle button appears right next to it when you are sorting randomly. The sort you pick is still remembered between sessions; view-specific orders like **Relevance** still last only as long as the view that needs them.

### Copy Image Path

Every right-click menu — in the grid, the list view and inside stacks — now offers **Copy Image Path**, copying the full path of the image to your clipboard ready to paste into a terminal, a script or chat. Quoting is handled for you, so paths containing spaces paste correctly into shell commands.

### Smoother, More Consistent Pipelines

The auto-watch pipeline was reworked so that every way a file can change on disk is picked up correctly:

- **In-place overwrites** — editors and download managers that write over an existing file (rather than replacing it) now trigger a re-index, instead of the change going unnoticed.
- **Rename-saves and re-downloads** — a file that is deleted and recreated within the same batch window is treated as a *replacement*: the stale entry is dropped before the new one is added, so the new content is actually indexed rather than silently skipped as a duplicate.
- **Sidecar JSON changes** — editing a companion JSON file re-indexes the image, so changed metadata shows up in search and filters.
- **Removable drives** — folders that go offline and come back (a USB drive or SD card reconnected) resume monitoring automatically.

### Under the Hood

- **Electron 43** — the app runs on a newer Electron, bringing upstream security and performance fixes along with it.
- **New CLI: `npm run prompt <file>`** — extract a plain prompt from a ComfyUI workflow JSON or straight out of an image or video file, with `--negative`, `--json` and `--require-prompt` options for scripting. Detection is content-based, so a mislabelled file still resolves correctly.
- **Krea2 style selector support** — ComfyUI workflows using the OREX/Krea2 style-selector node now parse correctly.
- **More reliable metadata parsing** across formats, plus CLI fixes for smooth non-interactive use.
- **MPL compliance housekeeping** — licensing metadata brought up to date.

### Tested but Not Shipped: Gemma-4-E2B

I evaluated **Gemma-4-E2B** as an alternative tag-generation model for the auto-tagging pipeline. It turned out to be **not compatible** with how SilkStack extracts tags: as a multimodal instruct model it insists on a conversational, image-grounded exchange and refuses the plain text-only tag extraction the pipeline is built around. The trial was rolled back, the model is not included in this release, and your existing tag models are unchanged. We would rather ship nothing than a model that quietly degrades your tags.

### Fixes & Polish

- **Similarity grouping accuracy** — several fixes to the vector-similarity pass, including cases where unrelated prompts could be grouped together.
- **Fullscreen in compact mode** — entering and leaving fullscreen from a compact window no longer leaves the window mis-sized.
- **Viewer fixes** — a round of corrections to zoom, navigation and sidebar behaviour in the image viewer.
- **Notifications are visible again** — toasts were rendering underneath the top bar; they now drop in below it where you can actually read them.
- **Stable model loading** — AI models load more efficiently, avoiding redundant work at startup.
- **Cleaner semantic indexing progress** — the indexing indicator no longer reports stale or leftover progress.
- **Tags sorted by frequency** — the tags panel now lists the most-used tags first.
- **The separate image preview pane was removed** — the viewer, grid and list view cover the same ground with less clutter.

---

## Feedback

Found a bug or have a feature request? [Open an issue](https://github.com/skkut/SilkStack-Image-Browser/issues)!

---
