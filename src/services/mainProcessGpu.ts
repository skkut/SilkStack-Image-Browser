// Main-process GPU reporting — the app-side fetch for the "Detected GPUs"
// readout in Settings → AI Intelligence.
//
// The worker-side detection (navigator.gpu.requestAdapter → adapter.info,
// module's gpu/gpuPreference.ts) only fires after a model load and can
// silently fail (adapter.info rejection / patch never installed / blank
// opaque vendor+device ids on some drivers). Electron's main process knows
// every GPU Chromium detected — including which one the GPU process chose
// (honoring force_high_performance_gpu / force_low_power_gpu) — from the
// moment the GPU process starts, so it can be reported at app start with no
// model involved. The renderer-side adapter.info report later refreshes the
// single inference-GPU value after a load.
//
// Browser fallback: no electronAPI (plain vite preview / tests) → no-op.

import { useImageStore } from '../store/useImageStore';

export async function fetchMainProcessGpuInfo(): Promise<void> {
  try {
    const report = await window.electronAPI?.getGpuInfo?.();
    if (!report?.devices?.length) return;

    const { setDetectedGpuDevices, setDetectedGpuInfo } = useImageStore.getState();
    setDetectedGpuDevices(report.devices);

    // Seed the single "inference GPU" value from the active adapter — the
    // setter persists it so Settings shows it without waiting for a load.
    // Blank names are skipped (the setter guards them) so a driver that
    // reports opaque ids never blanks the readout.
    const active = report.devices.find((d) => d.active);
    if (active) {
      setDetectedGpuInfo({
        vendor: active.vendor,
        device: active.device,
        description: active.description,
        preference: report.preference,
      });
    }
  } catch {
    // Best-effort: leave the persisted value (or the post-load report) in place.
  }
}
