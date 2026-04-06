# SilkStack Image Browser

> _A powerful Image Browser for AI-generated images with ComfyUI metadata support, and more._

![SilkStack Image Browser main UI](assets/screenshot-hero-grid.webp)

## What is SilkStack Image Browser?

**SilkStack Image Browser** is a **local image browser and manager** focused on AI-generated images.
It scans your folders, parses metadata from popular tools (ComfyUI, Automatic1111, Fooocus, SD.Next, Forge, SwarmUI, DrawThings) and online services like Midjourney / Nijijourney, whenever their metadata is present in the files, and lets you search, filter and organize your images by prompt, model, sampler, seed and more - all offline, on your machine.

It is open-source (MPL 2.0) and free to use.

> It is a fork of **"Image MetaHub v0.13.0"**.

---

## Key features (overview)

- **Fast local browser** for AI images (no accounts, no cloud, no telemetry)
- **Rich metadata parsing** for Stable Diffusion / A1111 / ComfyUI and other tools, including WebP format.
- **Beautuful Image Grid** with adaptive layout and smooth scrolling.
- **Auto-Watch functionality** for real-time monitoring of output folders during generation.
- **Powerful search & filters** by prompt text, model, steps, CFG, sampler, seed, etc.
- **Smart Library** with clustering stacks and collections
- **Auto-tags and manual tags** for faster organization and discovery

The goal is to create a beautiful, fast, and useful image browser for AI-generated images.

2. **Install and run**
   - Launch SilkStack Image Browser.

3. **Add your image folders**
   - Point the app to the directories where you keep your AI-generated images.
   - SilkStack Image Browser will scan and index them, reading metadata where available.

4. **Start browsing & filtering**
   - Use the search bar and filters (model, sampler, steps, seed, etc.) to narrow down results.

![Browsing and filters](assets/screenshot-gallery.webp)

---

## Auto-Watch: Real-time folder monitoring

SilkStack Image Browser can automatically monitor your output folders and detect new images in real-time as they're generated:

- **Individual folder toggles** - Enable/disable watching per directory with eye icon
- **Real-time detection** - Instant image detection using intelligent file monitoring
- **Background processing** - Silent updates without notifications or interruptions
- **State persistence** - Watchers automatically restored on app restart
- **Multiple formats** - Supports PNG, JPG, JPEG, and WEBP
- **Smart filtering** - Automatically filters cache folders and system directories

Perfect for monitoring ComfyUI or Automatic1111 output folders during active generation sessions.

---

## Smart Library: Clustering, auto-tags

The Smart Library groups similar images into stacks using prompt similarity, so you can browse variations together and manage large libraries faster.

- **Clustering stacks** - Background worker builds stacks from prompt similarity with progress updates and cached results
- **Collections sidebar** - Filter stacks by model and auto-tag collections
- **Auto-tags** - TF-IDF suggestions from prompts and metadata, with promote-to-tag and removal workflows

---

## Metadata support

SilkStack Image Browser parses metadata from:

- Stable Diffusion / Automatic1111 images (PNG, JPEG, WebP)
- ComfyUI (**full coverage** with [MetaHub Save Node](https://github.com/skkut/ImageMetaHub-ComfyUI-Save) - [ComfyUI Registry](https://registry.comfy.org/publishers/image-metahub/nodes/imagemetahub-comfyui-save); partial coverage for legacy workflows)
- Fooocus
- SD.Next
- Forge
- SwarmUI
- DrawThings
- Online services like Midjourney / Nijijourney (when prompts/settings are saved into the downloaded files)
- Other tools that store generation parameters in PNG/JPG/WebP metadata

## Development

This repo contains the full source code for the core app.

- **Tech stack:** Electron, React, TypeScript, Vite
- **License:** MPL 2.0

Basic dev commands:

```bash
# install dependencies
npm install

# run in dev mode
npm run dev:app

# build production bundle
npm run build

# build desktop app (no publish)
npm run electron-dist
```

If you're interested in contributing (bugfixes, parser support, UX tweaks, etc.), feel free to open an issue or PR.

---

## Privacy

SilkStack Image Browser is designed to be **local-first**:

- Your libraries and metadata stay on your machine.
- No mandatory account, no remote server dependency.

---

## Credits

SilkStack Image Browser is built by **Saravana (skkut)** using AI and Vibe Coding, feedback from the community is welcome.
