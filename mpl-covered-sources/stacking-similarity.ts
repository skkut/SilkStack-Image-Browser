/**
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Stacking similarity primitives — the MPL-covered core of the stacking
 * engine (Image-MetaHub lineage: `utils/similarityMetrics.ts` + the public
 * `computeSimilarityGroups` worker), split out of `stacking-engine.ts` on
 * 2026-08-28 so the covered source can be published to the open repository
 * (`mpl-covered-sources/`).
 *
 * Contents:
 * - Prompt normalization, tokenization and FNV-1a hashing for exact-match
 *   grouping (sync, main thread)
 * - Hybrid Jaccard/Levenshtein similarity with a threshold-derived jaccard
 *   prefilter ((threshold − 0.4) / 0.6 — 0.75 for the 0.85 default)
 * - The self-contained Web Worker script string that clusters O(n²) pairs
 *   off the main thread (token bucketing, union-find, caller-supplied
 *   threshold — default 0.85)
 *
 * Pure computation only — no persistence, no state management, no I/O.
 */

// ── Levenshtein Distance ─────────────────────────────────────────────

function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;

  const matrix: number[][] = Array(len1 + 1)
    .fill(null)
    .map(() => Array(len2 + 1).fill(0));

  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[len1][len2];
}

function normalizedLevenshtein(str1: string, str2: string): number {
  if (str1 === str2) return 1.0;
  if (str1.length === 0 && str2.length === 0) return 1.0;
  if (str1.length === 0 || str2.length === 0) return 0.0;
  // Guard: the O(len²) DP matrix for very long prompts can exhaust worker
  // memory and kill the worker SILENTLY (no onerror → a promise that hangs
  // forever). Above 4M cells the component clamps to 0: the pair then scores
  // 0.6·jaccard, which clears the match bar only when jaccard ≥ 0.667 — and
  // such a pair is itself shorter than 4M cells in nearly every case, so the
  // DP runs. The clamp only ever loses the rare long-pair high-jaccard match.
  if (str1.length * str2.length > 4_000_000) return 0.0;
  const distance = levenshteinDistance(str1, str2);
  const maxLen = Math.max(str1.length, str2.length);
  return 1 - distance / maxLen;
}

// ── Tokenization ─────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'should', 'could', 'may', 'might', 'must', 'can',
  'masterpiece', 'best', 'quality', 'high', 'highly', 'detailed', 'ultra',
  'photorealistic', 'realistic', 'professional', 'artwork', 'digital',
  'art', 'illustration', '4k', '8k', '16k', 'uhd', 'hd',
]);

export function tokenizeForSimilarity(text: string): Set<string> {
  const cleanedText = text.replace(/[(\[]\s*([^)\]]+?)\s*:\s*[\d.]+\s*[)\]]/g, '$1');
  const tokens = cleanedText
    .toLowerCase()
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => token.replace(/^[(\[]+|[)\]]+$/g, ''))
    .filter((token) => token.length > 0)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !/^\d+$/.test(token));
  return new Set(tokens);
}

// ── Similarity Functions ─────────────────────────────────────────────

export function jaccardSimilarity(str1: string, str2: string): number {
  const tokens1 = tokenizeForSimilarity(str1);
  const tokens2 = tokenizeForSimilarity(str2);
  if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;
  const intersection = new Set([...tokens1].filter((token) => tokens2.has(token)));
  const union = new Set([...tokens1, ...tokens2]);
  return intersection.size / union.size;
}

export function hybridSimilarity(str1: string, str2: string, threshold: number = 0.85): number {
  const jaccard = jaccardSimilarity(str1, str2);
  // Exact prefilter, generalized over the threshold: hybrid =
  // 0.6·jaccard + 0.4·levenshtein and levenshtein ≤ 1, so a score ≥ threshold
  // REQUIRES jaccard ≥ (threshold − 0.4) / 0.6. Below that the O(len²) DP
  // cannot change any threshold decision — return the lower bound 0.6·jaccard
  // (< threshold) and skip the DP entirely. This keeps the return value below
  // the match threshold, so results are identical to the full formula.
  //
  // The constant is DERIVED, never hard-coded: 0.75 for the 0.85 default,
  // 0.667 for 0.80. Pinning it at 0.75 while matching at 0.80 would silently
  // drop pairs in jaccard ∈ [0.667, 0.75) that clear the bar on Levenshtein.
  const minJaccard = (threshold - 0.4) / 0.6;
  if (jaccard < minJaccard) return jaccard * 0.6;
  const levenshtein = normalizedLevenshtein(str1, str2);
  return jaccard * 0.6 + levenshtein * 0.4;
}

// ── Prompt Normalization ─────────────────────────────────────────────

export function normalizePrompt(prompt: string): string {
  // Metadata parsers feed raw JSON fields here (e.g. an InvokeAI chunk whose
  // prompt is a number) — crash-proof the normalizer instead of the callers.
  if (typeof prompt !== 'string') return '';
  if (!prompt) return '';
  let normalized = prompt.toLowerCase();
  normalized = normalized.replace(/<lora:[^>]+>/gi, '');
  normalized = normalized.replace(/\b(steps?|seed|cfg\s*scale|sampler|size):\s*[\d.]+/gi, '');
  normalized = normalized.replace(/\bmodel\s+hash:\s*[a-f0-9]+/gi, '');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}

// ── Text Hashing (FNV-1a) ────────────────────────────────────────────

/** FNV-1a hash of arbitrary text, without normalization. */
export function generateTextHash(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function generatePromptHash(prompt: string): string {
  return generateTextHash(normalizePrompt(prompt));
}

// ── Keyword Extraction ───────────────────────────────────────────────

export function extractKeywords(prompt: string, topN: number = 5): string[] {
  const normalized = normalizePrompt(prompt);
  const tokens = tokenizeForSimilarity(normalized);
  return [...tokens]
    .filter((token) => token.length >= 3)
    .filter((token) => !/^\d+$/.test(token))
    .slice(0, topN);
}

export function shareKeywords(
  prompt1: string,
  prompt2: string,
  minShared: number = 2
): boolean {
  const keywords1 = new Set(extractKeywords(prompt1, 10));
  const keywords2 = new Set(extractKeywords(prompt2, 10));
  const sharedCount = [...keywords1].filter((kw) => keywords2.has(kw)).length;
  return sharedCount >= minShared;
}

// ── Web Worker (self-contained, no external imports) ────────────────

/**
 * The worker script string. All computation functions are inlined so the
 * worker has zero dependencies — it runs via a Blob URL and needs no
 * module resolution at all.
 */
export function getWorkerScript(): string {
  // We construct the worker by serializing the core algorithm functions.
  // The factory pattern keeps each function scoped and avoids global leaks.
  return `
/* ── Levenshtein ─────────────────────────────────── */
function levenshteinDistance(str1, str2) {
  var len1 = str1.length, len2 = str2.length;
  var matrix = new Array(len1 + 1);
  for (var i = 0; i <= len1; i++) {
    matrix[i] = new Array(len2 + 1);
    matrix[i][0] = i;
  }
  for (var j = 0; j <= len2; j++) matrix[0][j] = j;
  for (var i = 1; i <= len1; i++) {
    for (var j = 1; j <= len2; j++) {
      var cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[len1][len2];
}

function normalizedLevenshtein(str1, str2) {
  if (str1 === str2) return 1.0;
  if (str1.length === 0 && str2.length === 0) return 1.0;
  if (str1.length === 0 || str2.length === 0) return 0.0;
  // Guard: the O(len²) DP matrix for very long prompts can exhaust worker
  // memory and kill this worker SILENTLY (no onerror -> the caller's
  // promise hangs forever). Clamp to 0 so the pair never merges.
  if (str1.length * str2.length > 4000000) return 0.0;
  return 1 - levenshteinDistance(str1, str2) / Math.max(str1.length, str2.length);
}

/* ── Tokenization ────────────────────────────────── */
var STOP_WORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for',
  'of','with','by','from','as','is','was','are','were','been',
  'be','have','has','had','do','does','did','will','would',
  'should','could','may','might','must','can',
  'masterpiece','best','quality','high','highly','detailed','ultra',
  'photorealistic','realistic','professional','artwork','digital',
  'art','illustration','4k','8k','16k','uhd','hd'
]);

function tokenize(text) {
  var cleaned = text.replace(/[(\\\\[]\\\\s*([^)\\\\]]+?)\\\\s*:\\\\s*[\\\\d.]+\\\\s*[)\\\\]]/g, '$1');
  var tokens = cleaned.toLowerCase().split(/[\\s,]+/);
  var result = new Set();
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i].trim();
    if (!t) continue;
    t = t.replace(/^[(\\\\[]+|[)\\\\]]+$/g, '');
    if (!t) continue;
    if (STOP_WORDS.has(t)) continue;
    if (/^\\d+$/.test(t)) continue;
    result.add(t);
  }
  return result;
}

function normalize(prompt) {
  if (!prompt) return '';
  var n = prompt.toLowerCase();
  n = n.replace(/<lora:[^>]+>/gi, '');
  n = n.replace(/\\b(steps?|seed|cfg\\s*scale|sampler|size):\\s*[\\d.]+/gi, '');
  n = n.replace(/\\bmodel\\s+hash:\\s*[a-f0-9]+/gi, '');
  n = n.replace(/\\s+/g, ' ').trim();
  return n;
}

/* ── Similarity ──────────────────────────────────── */
function jaccardSimilarity(str1, str2) {
  var t1 = tokenize(str1), t2 = tokenize(str2);
  if (t1.size === 0 && t2.size === 0) return 1.0;
  if (t1.size === 0 || t2.size === 0) return 0.0;
  var intersection = 0;
  t1.forEach(function(t) { if (t2.has(t)) intersection++; });
  var union = new Set(t1); t2.forEach(function(t) { union.add(t); });
  return intersection / union.size;
}

function hybridSimilarity(str1, str2, threshold) {
  var j = jaccardSimilarity(str1, str2);
  // Exact prefilter (same as the main-thread twin), derived from the
  // threshold: the levenshtein component is <= 1, so score >= threshold
  // requires j >= (threshold - 0.4) / 0.6. Below that the O(len²) DP cannot
  // change any threshold decision - skip it.
  var minJaccard = (threshold - 0.4) / 0.6;
  if (j < minJaccard) return j * 0.6;
  return j * 0.6 + normalizedLevenshtein(str1, str2) * 0.4;
}

/* ── Main: receive message, compute, post back ───── */
self.onmessage = function(e) {
  var data = e.data;
  var groups = data.groups;
  var threshold = data.threshold;

  // Report entry BEFORE the (sync, message-free) precompute so the caller's
  // watchdog knows the worker is alive and the footer isn't pinned on a
  // stale message.
  self.postMessage({ type: 'progress', current: 0, total: groups.length, message: 'Analyzing prompt similarities...' });

  // ── Pre-normalize entries ──
  var entries = new Array(groups.length);
  for (var i = 0; i < groups.length; i++) {
    var np = normalize(groups[i].prompt);
    entries[i] = { groupId: groups[i].groupId, prompt: np, tokens: tokenize(np) };
  }

  // ── Phase 1: Token bucketing ──
  var MIN_SHARED = 1;
  var buckets = [];
  for (var i = 0; i < entries.length; i++) {
    var added = false;
    for (var b = 0; b < buckets.length; b++) {
      var bucket = buckets[b];
      for (var k = 0; k < bucket.length; k++) {
        var j = bucket[k];
        var shared = 0;
        entries[i].tokens.forEach(function(t) {
          if (entries[j].tokens.has(t)) shared++;
        });
        if (shared >= MIN_SHARED) { bucket.push(i); added = true; break; }
      }
      if (added) break;
    }
    if (!added) buckets.push([i]);
  }

  var totalPairs = 0;
  for (var b = 0; b < buckets.length; b++) {
    var n = buckets[b].length;
    totalPairs += (n * (n - 1)) / 2;
  }

  // ── Phase 2: Union-Find clustering ──
  var parent = new Array(entries.length);
  var rank = new Array(entries.length);
  for (var i = 0; i < entries.length; i++) { parent[i] = i; rank[i] = 0; }

  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x, y) {
    var rx = find(x), ry = find(y);
    if (rx === ry) return;
    if (rank[rx] < rank[ry]) parent[rx] = ry;
    else if (rank[rx] > rank[ry]) parent[ry] = rx;
    else { parent[ry] = rx; rank[rx]++; }
  }

  var PROGRESS_EVERY = Math.max(1, Math.floor(totalPairs / 20));
  var cmpCount = 0;
  var lastProgress = 0;
  // Time-based floor on progress posts: for large libraries the pair-count
  // cadence alone can leave minutes of silence (footer pinned on a stale
  // message, watchdog nearly tripping). Post at least every second.
  var lastPostTime = 0;

  for (var b = 0; b < buckets.length; b++) {
    var bucket = buckets[b];
    for (var a = 0; a < bucket.length; a++) {
      for (var c = a + 1; c < bucket.length; c++) {
        var idxA = bucket[a], idxB = bucket[c];
        if (find(idxA) === find(idxB)) { cmpCount++; continue; }
        var score = hybridSimilarity(entries[idxA].prompt, entries[idxB].prompt, threshold);
        if (score >= threshold) union(idxA, idxB);
        cmpCount++;
        if (cmpCount - lastProgress >= PROGRESS_EVERY || Date.now() - lastPostTime >= 1000) {
          lastProgress = cmpCount;
          lastPostTime = Date.now();
          self.postMessage({ type: 'progress', current: cmpCount, total: totalPairs, message: 'Comparing prompt similarity...' });
        }
      }
    }
  }

  // ── Phase 3: Build result ──
  var rootToSimId = {};
  for (var i = 0; i < entries.length; i++) {
    var root = find(i);
    if (!(root in rootToSimId)) rootToSimId[root] = entries[i].groupId;
  }

  var result = [];
  for (var i = 0; i < entries.length; i++) {
    result.push([entries[i].groupId, rootToSimId[find(i)]]);
  }

  self.postMessage({ type: 'result', groupIdToSimId: result });
};
`;
}
