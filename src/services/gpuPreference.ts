// GPU device preference for AI-Intelligence inference.
//
// WebLLM (the module's engine) has no device-selection API — its MLCEngineConfig
// exposes no device/gpu field, and the engine hardcodes
// `navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })`
// internally. WebGPU itself only returns the browser-chosen default adapter —
// it cannot enumerate GPUs by name. The only user-steerable knobs are
// `powerPreference` (which Chromium maps to the discrete GPU on dual-GPU
// machines) and `forceFallbackAdapter` (software / SwiftShader).
//
// This module patches `navigator.gpu.requestAdapter` so the preference is
// merged into every engine-creation call, and captures `adapter.info` at
// request time for the "Detected GPU" readout in Settings.
//
// Dependency-free on purpose: it is bundled into BOTH the renderer and the AI
// worker (separate module instances, separate `navigator.gpu` contexts — the
// patch state never crosses contexts).

export type AiDevicePreference = 'auto' | 'high-performance' | 'low-power' | 'software';

export const AI_DEVICE_PREFERENCES: readonly AiDevicePreference[] = [
  'auto',
  'high-performance',
  'low-power',
  'software',
];

export interface DetectedGpuInfo {
  vendor: string;
  device: string;
  description?: string;
  architecture?: string;
  /** The preference in force when the adapter was requested. */
  preference: AiDevicePreference;
}

// Structural WebGPU types — inlined like the module does (no @webgpu/types
// dependency; TS's lib.dom WebGPU types don't cover adapter.info).
interface RequestAdapterOptions {
  powerPreference?: 'default' | 'high-performance' | 'low-power';
  forceFallbackAdapter?: boolean;
}
interface GpuAdapterInfoLike {
  vendor: string;
  device: string;
  description?: string;
  architecture?: string;
}
interface GpuAdapterLike {
  info?: Promise<GpuAdapterInfoLike>;
}
interface GpuLike {
  requestAdapter(options?: RequestAdapterOptions): Promise<GpuAdapterLike | null>;
}
type RequestAdapterFn = (options?: RequestAdapterOptions) => Promise<GpuAdapterLike | null>;

// ── Patch state (one wrapper per bundle, never stacked) ───────────────
let originalRequestAdapter: RequestAdapterFn | null = null;
let currentPref: AiDevicePreference = 'auto';
let currentOnInfo: ((info: DetectedGpuInfo) => void) | null = null;

function getGpu(): GpuLike | null {
  if (typeof navigator === 'undefined') return null;
  const gpu = (navigator as unknown as { gpu?: GpuLike }).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return null;
  return gpu;
}

function mergedOptions(
  pref: AiDevicePreference,
  original: RequestAdapterOptions | undefined,
): RequestAdapterOptions {
  if (pref === 'auto') return original ?? {}; // pass through: browser default
  if (pref === 'software') return { ...original, forceFallbackAdapter: true };
  return { ...original, powerPreference: pref }; // 'high-performance' | 'low-power'
}

/**
 * Apply (or swap) the AI device preference in the current context. Idempotent:
 * the original `requestAdapter` is captured once per bundle; later calls only
 * swap the active preference and the info callback. Safe no-op when WebGPU is
 * unavailable (jsdom, non-WebGPU machines). Even `'auto'` keeps the patch
 * installed so adapter-info capture keeps working — the original options are
 * forwarded verbatim, so WebLLM's hardcoded high-performance hint still flows
 * through unchanged.
 */
export function applyGpuPreference(
  preference: AiDevicePreference,
  onAdapterInfo?: (info: DetectedGpuInfo) => void,
): void {
  const gpu = getGpu();
  if (!gpu) return;

  if (!originalRequestAdapter) {
    originalRequestAdapter = gpu.requestAdapter.bind(gpu);
    const wrapped: RequestAdapterFn = async (options) => {
      const pref = currentPref; // the preference active when the adapter was requested
      const adapter = await originalRequestAdapter!(mergedOptions(pref, options));
      if (adapter && currentOnInfo) {
        try {
          const adapterInfo = await adapter.info; // spec: Promise<GPUAdapterInfo>
          if (adapterInfo) {
            currentOnInfo({ ...adapterInfo, preference: pref });
          }
        } catch {
          // adapter.info rejection is non-fatal — the request itself succeeded
        }
      }
      return adapter;
    };
    (gpu as { requestAdapter: RequestAdapterFn }).requestAdapter = wrapped;
  }
  currentPref = preference;
  currentOnInfo = onAdapterInfo ?? null;
}
