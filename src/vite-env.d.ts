/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IMH_LICENSE_SECRET: string
  readonly VITE_APP_VERSION: string
  readonly VITE_AI_FEATURES_AVAILABLE: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Ambient type declarations for the optional ai-intelligence package.
// When the package is present, its own .d.ts files take precedence.
// When absent, these stubs let tsc resolve the dynamic import() in aiBridge.ts.
declare module '@ai-images-browser/ai-intelligence' {
  export interface LoadProgressReport {
    progress: number;
    text: string;
  }

  export class LLMTagGenerator {
    constructor(modelId: string, onProgress?: (report: LoadProgressReport) => void);
    initialize(): Promise<void>;
    generateTagsFromPrompt(prompt: string, systemPrompt?: string): Promise<string[]>;
    dispose(): void;
    readonly lastRawResponse: string | null;
  }

  export class TagGenerator {
    generateTagsFromPrompt(prompt: string): Promise<string[]>;
  }

  export class WebLLMEmbeddingProvider {
    constructor(
      modelId: string,
      dimension: number,
      onProgress?: (report: LoadProgressReport) => void,
    );
    readonly dimension: number;
    readonly modelId: string;
    initialize(): Promise<void>;
    embed(texts: string[]): Promise<Float32Array[]>;
    dispose(): void;
  }

  export const TAG_GENERATION_MODEL_ID: string;
  export const EMBEDDING_MODEL_ID: string;
  export const SYSTEM_PROMPT: string;

  // ── Shared engine (one engine, two records) ──────────────────────────

  export interface SharedEngineProgress {
    progress: number;
    text: string;
    modelId: string;
  }

  export class SharedMLEngine {
    static create(options?: {
      onProgress?: (report: SharedEngineProgress) => void;
    }): Promise<SharedMLEngine>;
    getChatEngine(): SharedChatEngine;
    getEmbeddingEngine(): SharedEmbeddingEngine;
    unload(): Promise<void>;
  }

  export interface SharedChatEngine {
    chat: {
      completions: {
        create(params: {
          messages: Array<{ role: string; content: string }>;
          max_tokens?: number;
          temperature?: number;
          model?: string;
        }): Promise<{ choices: Array<{ message: { content: string | null } }> }>;
      };
    };
    unload(): Promise<void>;
  }

  export interface SharedEmbeddingEngine {
    embeddings: {
      create(params: { input: string | string[]; model?: string }): Promise<unknown>;
    };
    unload(): Promise<void>;
  }

  // ── Semantic search ──────────────────────────────────────────────────

  export interface SemanticIndexEntry {
    imageId: string;
    text: string;
    textHash: string;
  }

  export interface SemanticVectorRecord {
    imageId: string;
    vector: Float32Array;
    textHash: string;
    modelId: string;
    dimension: number;
    updatedAt: number;
  }

  export interface SemanticSearchHit {
    imageId: string;
    score: number;
  }

  export const SEMANTIC_SEARCH_THRESHOLD: number;
  export const SEMANTIC_SEARCH_TOP_N: number;

  export class SemanticSearchEngine {
    constructor(embeddingProvider: unknown, threshold?: number, topN?: number);
    initialize(): Promise<void>;
    addEntries(entries: SemanticIndexEntry[]): Promise<void>;
    restore(records: SemanticVectorRecord[]): number;
    remove(imageIds: string[]): void;
    getTextHash(imageId: string): string | undefined;
    query(
      text: string,
      options?: { limit?: number; threshold?: number },
    ): Promise<SemanticSearchHit[]>;
    getStatus(): {
      initialized: boolean;
      indexedCount: number;
      modelId: string;
      dimension: number;
    };
    dispose(): void;
  }

  // ── GPU preference patch + AI worker (module-owned, moved 2026-08-12) ─

  export function applyGpuPreference(
    preference: AiDevicePreference,
    onAdapterInfo?: (info: DetectedGpuInfo) => void,
  ): void;

  export function createAiWorker(): Worker;

  // ── Semantic search coordinator (moved to the module 2026-08-12) ─────

  export interface SemanticIndexProgress {
    current: number;
    total: number;
    message: string;
  }

  export type SemanticProgressCallback = (progress: SemanticIndexProgress) => void;

  export interface SemanticIndexResult {
    indexed: number;
    skipped: number;
  }

  export interface SemanticSearchStatus {
    ready: boolean;
    indexed: number;
    modelId: string | null;
    dimension: number | null;
    error: string | null;
  }

  export interface SemanticIndexInput {
    id: string;
    prompt?: string;
    tags?: string[];
    models?: string[];
  }

  // ── Model catalog (Settings → AI Intelligence) ────────────────────

  export interface EmbeddingModelOption {
    modelId: string;
    dimension: number;
    label: string;
    description: string;
  }

  export interface TagModelOption {
    modelId: string;
    label: string;
    description: string;
  }

  export const EMBEDDING_MODEL_OPTIONS: EmbeddingModelOption[];
  export const TAG_MODEL_OPTIONS: TagModelOption[];

  export interface SemanticSearchCoordinatorOptions {
    onProgress?: SemanticProgressCallback;
    onGpuInfo?: (info: DetectedGpuInfo) => void;
    /** Footer chips: which model records are resident (worker push + eject). */
    onModelsStatus?: (status: AiModelsStatus) => void;
    isPremium?: () => boolean;
    devicePreference?: () => AiDevicePreference;
    /** User-selected embedding model id at send time; empty/unknown → the catalog default. */
    embedModelId?: () => string | undefined;
  }

  export interface AiModelsStatus {
    chatLoaded: boolean;
    embedLoaded: boolean;
    chatModelId: string | null;
    embedModelId: string | null;
    chatVramMb: number | null;
    embedVramMb: number | null;
  }

  export class SemanticSearchCoordinator {
    constructor(options?: SemanticSearchCoordinatorOptions);
    ensureInitialized(): Promise<void>;
    indexImages(images: SemanticIndexInput[]): Promise<SemanticIndexResult>;
    search(query: string, options?: { limit?: number; threshold?: number }): Promise<SemanticSearchHit[]>;
    clearIndex(): Promise<void>;
    cancelIndexing(): void;
    getStatus(): SemanticSearchStatus;
    unloadModels(): Promise<void>;
    getModelsStatus(): AiModelsStatus;
    dispose(): void;
  }

  // Stacking Engine
  export class StackingEngine {
    generatePromptHash(prompt: string): string;
    normalizePrompt(prompt: string): string;
    computePromptSimilarity(promptA: string, promptB: string): number;
    computeSimilarityGroupIds(input: {
      groups: Array<{ groupId: string; prompt: string }>;
      threshold?: number;
      onProgress?: (current: number, total: number, message: string) => void;
    }): Promise<{ groupIdToSimId: Map<string, string> }>;
  }

  // ── Stacking types ─────────────────────────────────────────────────

  export interface StackImage {
    id: string;
    name: string;
    handle?: unknown;
    thumbnailUrl?: string;
    thumbnailStatus?: string;
    thumbnailError?: string | null;
    metadata?: Record<string, unknown>;
    lastModified?: number;
    dimensions?: string;
    directoryId?: string;
    fileType?: string;
    isFavorite?: boolean;
    prompt?: string;
    stackGroupId?: string;
    isStackAnalyzed?: boolean;
    similarityGroupId?: string;
    [key: string]: any; // allow extra fields
  }

  export interface StackSubGroup {
    promptHash: string;
    prompt: string;
    imageIds: string[];
    coverImageId: string;
    size: number;
  }

  export interface ImageStack {
    id: string;
    coverImage: StackImage;
    images: StackImage[];
    count: number;
    subGroups?: StackSubGroup[];
    basePrompt?: string;
  }

  // ── Layout utilities ───────────────────────────────────────────────

  export interface LayoutRow {
    items: (StackImage | ImageStack)[];
    height: number;
    width: number;
  }

  export function getItemAspectRatio(item: StackImage | ImageStack): number;
  export function computeJustifiedLayout(
    items: (StackImage | ImageStack)[],
    containerWidth: number,
    targetRowHeight: number,
    gap?: number,
  ): LayoutRow[];

  // ── useImageStacking hook ───────────────────────────────────────────

  export function useImageStacking(
    images: StackImage[],
    isEnabled: boolean,
    sortOrder: 'asc' | 'desc' | 'date-asc' | 'date-desc' | 'random',
    displayStarredFirst: boolean,
    randomSeed: number,
  ): { stackedItems: (StackImage | ImageStack)[]; isStackingEnabled: boolean };

  // ── React components ────────────────────────────────────────────────

  export const StackCard: React.FC<{
    stack: ImageStack;
    onOpen: () => void;
  }>;

  export const SimilarityStackExpandedView: React.FC<{
    images: StackImage[];
    subGroups: { promptHash: string; prompt: string; label?: string; groupKey?: string; dimensions?: { label: string; value: string }[]; imageIds: string[] }[];
    onImageClick: (image: StackImage, event: React.MouseEvent) => void;
    selectedImages: Set<string>;
    onBack: () => void;
    imageSize?: number;
    thumbnailsDisabled: boolean;
    groupByDimensions?: string[];
    groupByToolbar?: React.ReactNode;
    onToggleFavorite: (imageId: string) => void;
    onToggleSelection: (imageId: string) => void;
    onDragStart: (image: StackImage, event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: (event: React.DragEvent<HTMLDivElement>) => void;
  }>;

  // The app's gpuPreference.ts is the open-source CONTRACT (the patch
  // implementation lives in the module); re-export its types so anything
  // importing them from the module path sees the same shape as the app.
  export { AiDevicePreference, DetectedGpuInfo } from './services/gpuPreference';
}
