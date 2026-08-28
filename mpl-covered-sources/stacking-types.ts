/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// ── Stacking Types ──────────────────────────────────────────────────────
// These types define the minimal image shape needed by the stacking hook,
// components, and layout algorithm. They are structural subsets of the
// main app's `IndexedImage` — any `IndexedImage` is assignable to `StackImage`.

export interface StackImage {
  id: string;
  name: string;
  handle?: unknown;
  thumbnailUrl?: string;
  thumbnailStatus?: string;
  thumbnailHandle?: unknown;
  thumbnailError?: string | null;
  metadata?: Record<string, unknown>;
  metadataString?: string;
  lastModified?: number;
  models?: string[];
  loras?: unknown[];
  scheduler?: string;
  prompt?: string;
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  seed?: number;
  dimensions?: string;
  directoryName?: string;
  directoryId?: string;
  enrichmentState?: string;
  fileSize?: number;
  fileType?: string;
  isFavorite?: boolean;
  tags?: string[];
  autoTags?: string[];
  stackGroupId?: string;
  isStackAnalyzed?: boolean;
  similarityGroupId?: string;
}

/**
 * Sub-group within a stack — images sharing the exact same prompt.
 * A similarity-based stack may contain multiple sub-groups, each with
 * its own prompt label displayed above its images in the drill-down view.
 */
export interface StackSubGroup {
  promptHash: string;
  prompt: string;
  label?: string;         // Human-readable label for the sub-group (e.g. "SDXL · a cat")
  groupKey?: string;       // Raw compound grouping key
  dimensions?: { label: string; value: string }[];  // Dimension heading/value pairs for separate display
  imageIds: string[];
  coverImageId: string;
  size: number;
}

/**
 * Stack of images grouped by similar prompt.
 * When similarity merging is active, subGroups contains one entry per
 * distinct exact prompt within the similarity group.
 */
export interface ImageStack {
  id: string;
  coverImage: StackImage;
  images: StackImage[];
  count: number;
  subGroups?: StackSubGroup[];
  basePrompt?: string;
}
