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

/** One GPU Chromium's GPU process reported (app.getGPUInfo('basic')). */
export interface GpuDeviceReport {
  vendor: string;
  device: string;
  description?: string;
  /** Chromium's numeric PCI vendor id (0x10DE NVIDIA, 0x1002 AMD, 0x8086 Intel…). */
  vendorId?: number;
  /** True when Chromium's GPU process chose this adapter (the active GPU). */
  active: boolean;
}

/** The main-process GPU report: every detected card + the preference in force. */
export interface MainProcessGpuReport {
  devices: GpuDeviceReport[];
  preference: AiDevicePreference;
}

/**
 * Stable identity key for a detected GPU — used as the dropdown option value
 * and the persisted aiDeviceTarget. Device strings are unique per vendor, so
 * `vendor|device` is collision-free in practice.
 */
export function gpuDeviceKey(gpu: Pick<GpuDeviceReport, 'vendor' | 'device'>): string {
  return `${gpu.vendor}|${gpu.device}`;
}

/**
 * Best-effort class hint for a detected GPU — the Chromium switch class that
 * matches this card ('auto' when unknown). WebGPU cannot select an adapter by
 * name, so picking a specific GPU in Settings maps to its class here; the
 * label in the dropdown shows the mapping.
 *
 * Vendor id decides where possible; name patterns kick in where a vendor
 * ships BOTH integrated and discrete cards (AMD Radeon(TM) Graphics = APU
 * iGPU vs Radeon RX = discrete; Intel UHD/HD = iGPU vs Intel Arc = discrete).
 */
export function classifyGpuDevice(
  gpu: Pick<GpuDeviceReport, 'vendor' | 'device' | 'vendorId'>,
): AiDevicePreference {
  const name = `${gpu.vendor} ${gpu.device}`.toLowerCase();
  const isNvidia = gpu.vendorId === 0x10de || name.includes('nvidia');
  const isIntel = gpu.vendorId === 0x8086 || name.includes('intel');
  const isAmd = gpu.vendorId === 0x1002 || name.includes('amd') || name.includes('advanced micro devices');

  if (isNvidia) return 'high-performance';
  if (isIntel) return name.includes('arc') ? 'high-performance' : 'low-power';
  if (isAmd) {
    // Discrete AMD: Radeon RX / Pro / VII / HD series.
    if (/(\brx\b|pro|vii|hd \d)/.test(name)) return 'high-performance';
    // Integrated AMD: APU iGPUs report as "Radeon(TM) Graphics", "Radeon
    // 780M/680M/610M", "Radeon Vega 8", …
    if (/(graphics|vega|\b\d{3}m\b)/.test(name)) return 'low-power';
    return 'auto';
  }
  // Qualcomm Adreno / Apple Silicon / ARM SoCs are all integrated.
  if (gpu.vendorId === 0x13b5 || name.includes('qualcomm') || name.includes('adreno') || name.includes('apple')) {
    return 'low-power';
  }
  return 'auto';
}

/** Human label for the class hint, used in the dropdown option text. */
export function gpuClassLabel(preference: AiDevicePreference): string {
  switch (preference) {
    case 'high-performance': return 'discrete';
    case 'low-power': return 'integrated';
    default: return 'auto';
  }
}
