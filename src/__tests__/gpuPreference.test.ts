/**
 * gpuPreference tests — the `navigator.gpu.requestAdapter` patch that steers
 * the WebGPU adapter for AI-Intelligence inference.
 *
 * The module captures the original requestAdapter ONCE per bundle, so every
 * test starts from a fresh module instance (vi.resetModules + dynamic
 * import) with a stubbed navigator.gpu. jsdom has no navigator.gpu — the
 * helper must no-op there, which the first two cases verify.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

type AnyRecord = Record<string, unknown>;

/** Fresh module + fake navigator.gpu. Returns the module's applyGpuPreference
 *  and the fake gpu surface (every request recorded in `calls`). */
async function freshHarness(options?: {
  noGpu?: boolean;
  noRequestAdapter?: boolean;
  failInfo?: boolean;
}) {
  vi.resetModules();
  const calls: Array<AnyRecord | undefined> = [];
  // A pre-handled rejection: the wrapper's try/catch still sees the rejection,
  // but the harness never trips an unhandled-rejection handler.
  const rejectingInfo = Promise.reject(new Error('adapter.info unavailable'));
  rejectingInfo.catch(() => {});
  const requestAdapter = vi.fn(async (opts?: AnyRecord) => {
    calls.push(opts);
    return {
      info: options?.failInfo
        ? rejectingInfo
        : Promise.resolve({ vendor: 'NVIDIA', device: 'RTX 4090', description: 'd', architecture: 'a' }),
    };
  });
  vi.stubGlobal('navigator', {
    ...navigator,
    gpu: options?.noGpu ? undefined : options?.noRequestAdapter ? {} : { requestAdapter },
  });
  const mod = await import('../services/gpuPreference');
  return { applyGpuPreference: mod.applyGpuPreference, requestAdapter, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyGpuPreference', () => {
  it('no-ops when navigator.gpu is missing (jsdom)', async () => {
    const h = await freshHarness({ noGpu: true });
    expect(() => h.applyGpuPreference('high-performance')).not.toThrow();
  });

  it('no-ops when navigator.gpu lacks requestAdapter', async () => {
    const h = await freshHarness({ noRequestAdapter: true });
    expect(() => h.applyGpuPreference('software')).not.toThrow();
  });

  it("'auto' forwards the original options verbatim (browser default)", async () => {
    const h = await freshHarness();
    h.applyGpuPreference('auto');
    const originalOpts = { powerPreference: 'high-performance' as const };
    await (navigator as any).gpu.requestAdapter(originalOpts);
    expect(h.requestAdapter).toHaveBeenCalledTimes(1);
    expect(h.calls[0]).toEqual(originalOpts);
  });

  it('high-performance overrides a conflicting caller powerPreference', async () => {
    const h = await freshHarness();
    h.applyGpuPreference('high-performance');
    await (navigator as any).gpu.requestAdapter({ powerPreference: 'low-power' });
    expect(h.calls[0]).toEqual({ powerPreference: 'high-performance' });
  });

  it("'low-power' merges powerPreference while preserving other options", async () => {
    const h = await freshHarness();
    h.applyGpuPreference('low-power');
    await (navigator as any).gpu.requestAdapter({ forceFallbackAdapter: false });
    expect(h.calls[0]).toEqual({ forceFallbackAdapter: false, powerPreference: 'low-power' });
  });

  it("'software' merges forceFallbackAdapter (SwiftShader)", async () => {
    const h = await freshHarness();
    h.applyGpuPreference('software');
    await (navigator as any).gpu.requestAdapter({ powerPreference: 'high-performance' });
    expect(h.calls[0]).toEqual({ powerPreference: 'high-performance', forceFallbackAdapter: true });
  });

  it('reports the detected adapter to the callback with the request-time preference', async () => {
    const h = await freshHarness();
    const onInfo = vi.fn();
    h.applyGpuPreference('low-power', onInfo);
    await (navigator as any).gpu.requestAdapter({});
    for (let i = 0; i < 5; i += 1) await Promise.resolve(); // adapter.info settles
    expect(onInfo).toHaveBeenCalledWith({
      vendor: 'NVIDIA',
      device: 'RTX 4090',
      description: 'd',
      architecture: 'a',
      preference: 'low-power',
    });
  });

  it('re-apply swaps pref + callback without stacking wrappers', async () => {
    const h = await freshHarness();
    const first = vi.fn();
    const second = vi.fn();
    h.applyGpuPreference('high-performance', first);
    await (navigator as any).gpu.requestAdapter({});
    h.applyGpuPreference('low-power', second);
    await (navigator as any).gpu.requestAdapter({});
    for (let i = 0; i < 5; i += 1) await Promise.resolve();

    expect(h.requestAdapter).toHaveBeenCalledTimes(2); // original called twice — one wrapper
    expect(h.calls[0]).toEqual({ powerPreference: 'high-performance' });
    expect(h.calls[1]).toEqual({ powerPreference: 'low-power' });
    // Each request completes (and reports) before the next begins — the
    // wrapper resolves only after adapter.info, so request 1 reports through
    // `first` under high-performance, request 2 through `second` under
    // low-power. No wrapper stacking: the original saw exactly two calls.
    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ preference: 'high-performance' }));
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ preference: 'low-power' }));
  });

  it('adapter.info rejection is non-fatal — the request still succeeds', async () => {
    const h = await freshHarness({ failInfo: true });
    const onInfo = vi.fn();
    h.applyGpuPreference('auto', onInfo);
    const adapter = await (navigator as any).gpu.requestAdapter({});
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(adapter).not.toBeNull();
    expect(onInfo).not.toHaveBeenCalled();
  });
});
