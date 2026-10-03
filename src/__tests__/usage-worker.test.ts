// @vitest-environment node
//
// Covers the server half of the anonymous usage ping
// (cloudflare/usage-worker/src/index.js). The worker is plain JS with a
// structural contract, so the fake request/env below stand in for the
// Workers runtime.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

import workerModule from '../../cloudflare/usage-worker/src/index.js';

interface DataPoint {
  indexes: string[];
  blobs: string[];
}

interface FakeRequest {
  method: string;
  headers: { get: (name: string) => string | null };
  cf?: { country: string };
  json: () => Promise<unknown>;
}

interface WorkerEnv {
  SILKSTACK_USAGE: { writeDataPoint: (point: DataPoint) => void };
}

const worker = workerModule as unknown as {
  fetch: (request: FakeRequest, env: WorkerEnv) => Promise<Response>;
};

const makeRequest = (
  body: unknown,
  opts: {
    method?: string;
    country?: string;
    contentLength?: string;
    jsonThrows?: boolean;
  } = {},
): FakeRequest => ({
  method: opts.method ?? 'POST',
  headers: {
    get: (name: string) =>
      name === 'content-length' ? (opts.contentLength ?? null) : null,
  },
  cf: opts.country ? { country: opts.country } : undefined,
  json: opts.jsonThrows
    ? async () => {
        throw new Error('invalid json');
      }
    : async () => body,
});

describe('usage worker', () => {
  // Typed explicitly: vitest 4's untyped vi.fn() is a callable/constructable
  // union with no call signature, which does not satisfy WorkerEnv.
  let writeDataPoint: Mock<(point: DataPoint) => void>;
  let env: WorkerEnv;

  beforeEach(() => {
    writeDataPoint = vi.fn<(point: DataPoint) => void>();
    env = { SILKSTACK_USAGE: { writeDataPoint } };
  });

  const validBody = { id: 'abc-123', v: '2.3.0', os: 'win32', plan: 'pro' };

  it('writes one data point for a valid ping', async () => {
    const res = await worker.fetch(
      makeRequest(validBody, { country: 'DE' }),
      env,
    );

    expect(res.status).toBe(204);
    expect(writeDataPoint).toHaveBeenCalledTimes(1);

    const point = writeDataPoint.mock.calls[0][0] as DataPoint;
    expect(point.indexes).toEqual(['abc-123']);
    // blob order is the dashboard's column order — country, version, os, plan
    expect(point.blobs).toEqual(['DE', '2.3.0', 'win32', 'pro']);
  });

  it('accepts the trial plan alongside free and pro', async () => {
    const res = await worker.fetch(
      makeRequest({ ...validBody, plan: 'trial' }),
      env,
    );

    expect(res.status).toBe(204);
    expect(
      (writeDataPoint.mock.calls[0][0] as DataPoint).blobs[3],
    ).toBe('trial');
  });

  it('derives the country from the edge and defaults to XX when absent', async () => {
    await worker.fetch(makeRequest(validBody, { country: 'BR' }), env);
    await worker.fetch(makeRequest(validBody), env);

    expect((writeDataPoint.mock.calls[0][0] as DataPoint).blobs[0]).toBe('BR');
    expect((writeDataPoint.mock.calls[1][0] as DataPoint).blobs[0]).toBe('XX');
  });

  it('accepts old or future clients carrying extra fields', async () => {
    const res = await worker.fetch(
      makeRequest({ ...validBody, extra: 'ignored', future: 1 }),
      env,
    );

    expect(res.status).toBe(204);
    expect((writeDataPoint.mock.calls[0][0] as DataPoint).blobs).toEqual([
      'XX',
      '2.3.0',
      'win32',
      'pro',
    ]);
  });

  it('rejects non-POST methods', async () => {
    const res = await worker.fetch(makeRequest(validBody, { method: 'GET' }), env);

    expect(res.status).toBe(405);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const res = await worker.fetch(makeRequest(null, { jsonThrows: true }), env);

    expect(res.status).toBe(400);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('rejects a missing, empty or oversized install id', async () => {
    for (const id of [undefined, '', 'x'.repeat(65), 42]) {
      const res = await worker.fetch(makeRequest({ ...validBody, id }), env);
      expect(res.status).toBe(400);
    }
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('rejects an unknown plan or non-string version/os', async () => {
    for (const body of [
      { ...validBody, plan: 'lifetime' },
      { ...validBody, plan: undefined },
      { ...validBody, v: 230 },
      { ...validBody, os: null },
    ]) {
      const res = await worker.fetch(makeRequest(body), env);
      expect(res.status).toBe(400);
    }
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('rejects an oversized body before parsing it', async () => {
    const res = await worker.fetch(
      makeRequest(validBody, { contentLength: '2048' }),
      env,
    );

    expect(res.status).toBe(413);
    expect(writeDataPoint).not.toHaveBeenCalled();
  });

  it('truncates overlong string fields instead of rejecting the client', async () => {
    const res = await worker.fetch(
      makeRequest({ ...validBody, v: 'x'.repeat(100), os: 'y'.repeat(100) }),
      env,
    );

    expect(res.status).toBe(204);
    const point = writeDataPoint.mock.calls[0][0] as DataPoint;
    expect(point.blobs[1]).toHaveLength(32);
    expect(point.blobs[2]).toHaveLength(32);
  });
});
