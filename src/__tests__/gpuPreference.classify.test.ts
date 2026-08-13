/**
 * classifyGpuDevice / gpuDeviceKey / gpuClassLabel — the best-effort class
 * hint that maps a detected GPU to the Chromium switch class. WebGPU cannot
 * target an adapter by name, so picking a card in Settings maps to its class;
 * these rules decide the mapping (vendor id where possible, name patterns for
 * vendors that ship BOTH integrated and discrete cards).
 */
import { describe, it, expect } from 'vitest';
import {
  classifyGpuDevice,
  gpuDeviceKey,
  gpuClassLabel,
  type GpuDeviceReport,
} from '../services/gpuPreference';

const gpu = (overrides: Partial<GpuDeviceReport>): GpuDeviceReport => ({
  vendor: 'NVIDIA',
  device: 'GeForce RTX 3060',
  active: false,
  ...overrides,
});

describe('classifyGpuDevice (best-effort class hint)', () => {
  it('NVIDIA is always discrete', () => {
    expect(classifyGpuDevice(gpu({ device: 'GeForce RTX 3060' }))).toBe('high-performance');
    expect(classifyGpuDevice(gpu({ device: 'Quadro P2200' }))).toBe('high-performance');
    expect(classifyGpuDevice(gpu({ device: 'GeForce MX450' }))).toBe('high-performance');
    // vendor id alone decides even with a non-descriptive name
    expect(classifyGpuDevice(gpu({ vendor: '', device: 'Opaque ID', vendorId: 0x10de }))).toBe('high-performance');
  });

  it('Intel UHD/HD/Iris are integrated; Arc is discrete', () => {
    expect(classifyGpuDevice(gpu({ vendor: 'Intel', device: 'Intel(R) UHD Graphics 630' }))).toBe('low-power');
    expect(classifyGpuDevice(gpu({ vendor: 'Intel', device: 'Intel(R) HD Graphics 4600' }))).toBe('low-power');
    expect(classifyGpuDevice(gpu({ vendor: 'Intel', device: 'Intel(R) Iris(R) Xe Graphics' }))).toBe('low-power');
    expect(classifyGpuDevice(gpu({ vendor: 'Intel', device: 'Intel(R) Arc(TM) A770 Graphics' }))).toBe('high-performance');
  });

  it('AMD APU iGPUs are integrated; RX/Pro/VII/HD are discrete', () => {
    expect(classifyGpuDevice(gpu({ vendor: 'AMD', device: 'AMD Radeon(TM) Graphics' }))).toBe('low-power');
    expect(classifyGpuDevice(gpu({ vendor: 'AMD', device: 'AMD Radeon 780M' }))).toBe('low-power');
    expect(classifyGpuDevice(gpu({ vendor: 'AMD', device: 'AMD Radeon Vega 8' }))).toBe('low-power');
    expect(classifyGpuDevice(gpu({ vendor: 'AMD', device: 'AMD Radeon RX 6600 XT' }))).toBe('high-performance');
    expect(classifyGpuDevice(gpu({ vendor: 'AMD', device: 'AMD Radeon Pro W6400' }))).toBe('high-performance');
    expect(classifyGpuDevice(gpu({ vendor: 'AMD', device: 'AMD Radeon VII' }))).toBe('high-performance');
    expect(classifyGpuDevice(gpu({ vendor: 'AMD', device: 'AMD Radeon HD 7970' }))).toBe('high-performance');
  });

  it('Qualcomm / Apple silicon are integrated', () => {
    expect(classifyGpuDevice(gpu({ vendor: 'Qualcomm', device: 'Adreno 740', vendorId: 0x13b5 }))).toBe('low-power');
    expect(classifyGpuDevice(gpu({ vendor: 'Apple', device: 'Apple M2' }))).toBe('low-power');
  });

  it('unknown vendors fall back to auto', () => {
    expect(classifyGpuDevice(gpu({ vendor: 'Microsoft', device: 'Basic Render Driver' }))).toBe('auto');
    expect(classifyGpuDevice(gpu({ vendor: 'Unknown', device: 'Opaque GPU', vendorId: 0 }))).toBe('auto');
  });
});

describe('gpuDeviceKey / gpuClassLabel', () => {
  it('gpuDeviceKey is a stable vendor|device identity', () => {
    expect(gpuDeviceKey(gpu({ vendor: 'NVIDIA', device: 'GeForce RTX 3060' }))).toBe('NVIDIA|GeForce RTX 3060');
  });

  it('gpuClassLabel maps the class to human text for the dropdown', () => {
    expect(gpuClassLabel('high-performance')).toBe('discrete');
    expect(gpuClassLabel('low-power')).toBe('integrated');
    expect(gpuClassLabel('auto')).toBe('auto');
    expect(gpuClassLabel('software')).toBe('auto');
  });
});
