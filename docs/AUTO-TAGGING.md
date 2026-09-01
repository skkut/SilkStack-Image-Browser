# Auto-Tagging in SilkStack Image Browser

SilkStack Image Browser features an intelligent, fully local **Auto-Tagging** system designed to help you quickly organize and discover your AI-generated images.

## Overview
The Auto-Tagging engine analyzes the prompts used to generate your images and automatically extracts relevant, descriptive tags (such as subjects, styles, lighting, and concepts). These tags are then added to your images alongside any manual tags and metadata tags you already have.

## How It Works

### Local AI Model (WebGPU)
By default, the auto-tagging system utilizes a small, efficient local Large Language Model (LLM) — typically a Llama-based model (like Llama 3.2 3B). 
- **Privacy First:** The model runs entirely offline directly on your machine via WebGPU. No image or text data is ever sent to the cloud.
- **Hardware Acceleration:** Since it runs on WebGPU, it offloads the work to your local graphics card, making tag generation fast.
- **Rule-Based Fallback:** If your hardware does not support WebGPU, or if the AI model fails to load, the system will automatically fall back to a rule-based extraction engine (unless fallback is disabled in Settings).

### Smart Processing & Status Tracking
To save time and compute resources, the auto-tagging process is highly optimized:
1. **New Images Only:** When you initiate an auto-tagging run, the system checks the database and only processes *new images* that haven't been processed before.
2. **"Processed" Flag:** Once an image passes through the engine, it receives a hidden `isAutoTagged` flag. This applies **even if the model yields 0 tags** for a specific prompt. Because of this, the engine won't needlessly retry parsing an empty or un-taggable prompt on every run.
3. **Per-Image Incremental Persistence:** Each image's tags and `isAutoTagged` flag are committed to the local database (IndexedDB) **the moment that image finishes** — the engine doesn't wait for the whole run. The UI updates live, and an interrupted run (cancel, crash, app close) resumes from the first un-tagged image on the next run instead of restarting from the beginning. Persisted data survives app restarts perfectly.

## Managing Auto-Tags

### Running Auto-Tagging
You can start generating tags by selecting the "Generate Tags" option. The progress will be shown as the model works through your untagged library. You can cancel the process at any time; progress on already completed images will be saved.

### Clearing Auto-Tags
If you want to start fresh or re-evaluate your library with a different tagging threshold:
- You can use the **Clear Auto-Tags** function.
- This will remove all automatically generated tags from your images.
- It will also **reset the processed flag**. This means the next time you run "Generate Tags", the system will re-process those images as if they were new.

### Integration with Manual Tags
Auto-tags coexist seamlessly with your manual tags. When you view an image, you will see a unified list of tags. You can manually remove an auto-generated tag if it's incorrect, and that removal will be saved to the database.

### Flat merged tag list (search-friendly)
Auto-tagging returns ONE bounded flat list per image (max 15 tags): the core visual concepts plus search-friendly synonyms and alternate phrasings a searcher might type (e.g. "red fox" → also "vulpes", "foxy", "crimson fox"). The whole list is generated in a single model call — there is no separate hidden synonym pass. The synonyms are ordinary auto-tags: visible in the UI, embedded into the semantic index text (the autoTags segment), and matched by the keyword search box — so cross-language queries (e.g. a Japanese search for a concept described in English in the prompt) can match. Each image is tagged exactly once; re-running auto-tag or clearing auto-tags re-opens that gate (see `SEARCH_ENRICHMENT_VERSION`). Images enriched with the older v1 design keep their legacy `synonymTags` records until they are re-tagged.

> **Note:** Auto-tagging relies primarily on the `prompt` metadata embedded in the generated images. Images without any embedded prompt metadata cannot be effectively auto-tagged.
