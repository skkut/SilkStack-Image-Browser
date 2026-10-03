// @vitest-environment node
//
// Covers the client half of the anonymous usage ping (electron/usagePing.mjs).
// The payload-shape test is the important one: it pins down exactly which four
// fields may ever leave the machine, so any future addition to the ping has to
// consciously change this file — and with it, the README's privacy section.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  maybeSendUsagePing,
  mapPlan,
  USAGE_ENDPOINT,
  PING_INTERVAL_MS,
  STATE_FILE_NAME,
} from '../../electron/usagePing.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

describe('usagePing', () => {
  let dir: string;

  // Guard rail: an omitted fetchImpl defaults to global fetch, so a test that
  // forgets to inject one would silently hit the live endpoint. Break it here
  // so a mistake is loud instead of a stray production data point.
  let realFetch: typeof fetch;

  beforeEach(async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('real network is disabled in tests')),
    ) as unknown as typeof fetch;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silkstack-usage-'));
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const readState = async () =>
    JSON.parse(await fs.readFile(path.join(dir, STATE_FILE_NAME), 'utf-8'));

  const sendWith = (
    fetchImpl: unknown,
    now = NOW,
    license: {
      status?: string;
      product?: string | null;
      trialEndsAt?: number | null;
    } = {},
  ) =>
    maybeSendUsagePing({
      userDataPath: dir,
      appVersion: '2.3.0',
      platform: 'win32',
      licenseStatus: license.status ?? 'valid',
      licenseProduct: license.product,
      trialEndsAt: license.trialEndsAt ?? null,
      fetchImpl: fetchImpl as typeof fetch,
      now,
    });

  it('sends exactly four fields on first run, and remembers the ping time', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    await expect(sendWith(fetchImpl)).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(USAGE_ENDPOINT);
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body);
    // The entire payload. If this assertion ever fails, something new is
    // leaving the machine — update the README before updating this test.
    expect(Object.keys(body).sort()).toEqual(['id', 'os', 'plan', 'v']);
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.v).toBe('2.3.0');
    expect(body.os).toBe('win32');
    expect(body.plan).toBe('pro');

    const state = await readState();
    expect(state.anonymousId).toBe(body.id);
    expect(state.lastPing).toBe(NOW);
  });

  it('reports a subscription inside its free trial as "trial", then "pro" once it converts', async () => {
    const trial = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await expect(
      sendWith(trial, NOW, { product: 'subscription', trialEndsAt: NOW + 3 * DAY }),
    ).resolves.toBe(true);
    expect(JSON.parse(trial.mock.calls[0][1].body).plan).toBe('trial');

    // Same key, same product — the trial end has passed and the charge went
    // through, so the next day's ping must read as a paying customer.
    const converted = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await expect(
      sendWith(converted, NOW + PING_INTERVAL_MS, {
        product: 'subscription',
        trialEndsAt: NOW + DAY,
      }),
    ).resolves.toBe(true);
    expect(JSON.parse(converted.mock.calls[0][1].body).plan).toBe('pro');
  });

  it('throttles to one ping per 24h and sends again after the interval', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });

    await expect(sendWith(fetchImpl, NOW)).resolves.toBe(true);
    await expect(sendWith(fetchImpl, NOW + HOUR)).resolves.toBe(false);
    await expect(sendWith(fetchImpl, NOW + PING_INTERVAL_MS - 1)).resolves.toBe(
      false,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(sendWith(fetchImpl, NOW + PING_INTERVAL_MS)).resolves.toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Same identity across both pings.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).id).toBe(
      JSON.parse(fetchImpl.mock.calls[1][1].body).id,
    );
  });

  it('keeps the install id when a send fails, and retries on the next launch', async () => {
    const offline = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(sendWith(offline)).resolves.toBe(false);

    // The id was minted and persisted even though nothing was delivered...
    const firstAttemptId = JSON.parse(offline.mock.calls[0][1].body).id;
    const state = await readState();
    expect(state.anonymousId).toBe(firstAttemptId);

    // ...and the clock was not reset, so the next launch tries again — with
    // the same identity. An offline day must never mint a second user.
    const online = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await expect(sendWith(online, NOW + 1000)).resolves.toBe(true);
    expect(JSON.parse(online.mock.calls[0][1].body).id).toBe(firstAttemptId);
  });

  it('requires the worker\'s 204 — an HTTP-success response from anything else is not a delivery', async () => {
    // The deployed URL answered 200 "Hello World!" while the Worker was still
    // undeployed; a lenient ok-check would have marked every ping delivered
    // while Analytics Engine recorded nothing.
    const placeholder = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await expect(sendWith(placeholder)).resolves.toBe(false);
    expect((await readState()).lastPing).toBe(0);

    const rejected = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    await expect(sendWith(rejected)).resolves.toBe(false);
    expect((await readState()).lastPing).toBe(0);
  });

  it('never throws, whatever is missing or broken', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      maybeSendUsagePing({
        userDataPath: undefined,
        appVersion: '2.3.0',
        platform: 'win32',
        licenseStatus: 'valid',
        fetchImpl: fetchImpl as typeof fetch,
        now: NOW,
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    // A non-function fetchImpl is refused. (Passing `undefined` explicitly
    // would NOT test this: default parameters substitute global fetch for
    // undefined — which is exactly why the guard rail above exists.)
    await expect(
      maybeSendUsagePing({
        userDataPath: dir,
        appVersion: '2.3.0',
        platform: 'win32',
        licenseStatus: 'valid',
        fetchImpl: null as unknown as typeof fetch,
        now: NOW,
      }),
    ).resolves.toBe(false);
  });

  it('maps license states to free/pro/trial', () => {
    // Premium with no trial data at all — lifetime keys, and settings.json
    // written before licenseProduct / trialEndsAt existed.
    expect(mapPlan({ licenseStatus: 'valid', now: NOW })).toBe('pro');
    expect(mapPlan({ licenseStatus: 'offline-valid', now: NOW })).toBe('pro');

    const trial = { licenseProduct: 'subscription', trialEndsAt: NOW + 3 * DAY, now: NOW };
    expect(mapPlan({ licenseStatus: 'valid', ...trial })).toBe('trial');
    // An offline launch mid-trial is still a trial — the label logic agrees.
    expect(mapPlan({ licenseStatus: 'offline-valid', ...trial })).toBe('trial');

    // Trial over (or exactly at its end): a paying subscriber, not a trial.
    expect(
      mapPlan({ licenseStatus: 'valid', licenseProduct: 'subscription', trialEndsAt: NOW - DAY, now: NOW }),
    ).toBe('pro');
    expect(
      mapPlan({ licenseStatus: 'valid', licenseProduct: 'subscription', trialEndsAt: NOW, now: NOW }),
    ).toBe('pro');

    // Only the subscription product can trial: a lifetime key carrying a
    // stray trial end (or the pre-field null) must never be reported as one.
    expect(
      mapPlan({ licenseStatus: 'valid', licenseProduct: 'lifetime', trialEndsAt: NOW + DAY, now: NOW }),
    ).toBe('pro');
    expect(
      mapPlan({ licenseStatus: 'valid', licenseProduct: null, trialEndsAt: NOW + DAY, now: NOW }),
    ).toBe('pro');

    // Non-premium states are free even with a future trial end on disk.
    for (const status of ['unchecked', 'verifying', 'invalid', 'expired', 'revoked', undefined]) {
      expect(mapPlan({ licenseStatus: status, ...trial })).toBe('free');
    }
  });
});
