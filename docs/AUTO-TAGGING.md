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
3. **Persisted Data:** All auto-generated tags and their processing status are saved to a local database (IndexedDB). Your tags and processing statuses persist perfectly across app restarts.

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

### Search Enrichment (hidden)
When **semantic search** is enabled, an auto-tag run also generates English synonyms for each image's core tags using the same local model (one extra call per image, stored hidden). These synonyms never appear in the tag list — they are embedded into the semantic index text so that cross-language queries (e.g. a Japanese search for a concept described in English in the prompt) can match. Each image is enriched exactly once; re-running auto-tag or clearing auto-tags re-opens that gate. See `ai-intelligence/docs/dual-model-enriched-semantic-search.md` for the design.

> **Note:** Auto-tagging relies primarily on the `prompt` metadata embedded in the generated images. Images without any embedded prompt metadata cannot be effectively auto-tagged.
