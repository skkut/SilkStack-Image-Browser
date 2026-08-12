// GPU device preference for AI-Intelligence inference — CONTRACT ONLY.
//
// The patch implementation (the `navigator.gpu.requestAdapter` wrapper that
// merges the preference into every WebLLM engine-creation call and captures
// `adapter.info` for the "Detected GPU" readout) lives in the closed-source
// ai-intelligence module (ai-intelligence/src/gpu/gpuPreference.ts). The
// module exports `applyGpuPreference`; the bridge calls it through the
// dynamic module import (see aiBridge.ts's engine factories).
//
// What stays here is the OPEN-SOURCE CONTRACT the app needs at build time:
// the preference values (persisted in the settings store) and the types
// (consumed by SettingsModal, the store, and the bridge's re-export). The
// implementation is deliberately absent — no-module builds must contain no
// working premium GPU steering.
//
// `AI_DEVICE_PREFERENCES` must stay in sync with the module's constant —
// the app reads it as a runtime value (the settings dropdown), and a runtime
// value cannot come from an absent module.

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
