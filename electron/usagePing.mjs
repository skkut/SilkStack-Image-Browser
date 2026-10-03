/**
 * Anonymous usage ping.
 *
 * Once per 24h the packaged app POSTs a small JSON body to the SilkStack usage
 * endpoint: a random install ID (created on first run, persisted in
 * `<userData>/usage.json`), the app version, the OS, and the plan — free, pro,
 * or a subscription whose free trial is still running. The country is derived
 * by the server from the connection and the IP is discarded — see README →
 * "License, privacy & offline use".
 *
 * What it never sends: the license key, the license e-mail, folder or file
 * names, image counts, prompts, tags, search queries — anything from the
 * library. The whole server side lives in cloudflare/usage-worker/.
 *
 * This module is deliberately dependency-free (no `electron` import): main.mjs
 * passes in the paths and values, and the network call, clock and filesystem
 * are injectable so the behavior is unit-testable without Electron.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Deployed Cloudflare Worker — see cloudflare/usage-worker/. */
export const USAGE_ENDPOINT = 'https://silkstack.ksaravanakumar.workers.dev/';
export const PING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 5000;
export const STATE_FILE_NAME = 'usage.json';

/**
 * Collapses the app's license state into the three plan values the endpoint
 * accepts: `trial` while a subscription's free trial is still running, `pro`
 * for any other premium state, `free` otherwise.
 *
 * `offline-valid` counts as pro: the license is trusted locally while the
 * machine is offline, and reporting it as free would make a paying user look
 * like a churned one for as long as the network is down.
 *
 * The trial test mirrors `deriveLicenseLabel` in the closed-source module
 * (premium status AND the subscription product AND a trial end still in the
 * future) — the stored status alone cannot separate trial / active /
 * cancelled, since all three are `valid`. Mirroring the rule keeps the
 * dashboard's `trial` bucket and the "Trial — N days left" label in Settings
 * from ever disagreeing about the same install.
 *
 * @typedef {object} PlanInput
 * @property {string} [licenseStatus]      Raw stored status.
 * @property {string} [licenseProduct]     `subscription` is the only product with a trial;
 *                                         `lifetime` / null / missing mean no trial.
 * @property {number | null} [trialEndsAt] End of a subscription's free trial (ms since epoch).
 * @property {number} [now]                Injectable clock (ms since epoch).
 */

/**
 * @param {PlanInput} [input]
 * @returns {'free' | 'pro' | 'trial'}
 */
export function mapPlan({ licenseStatus, licenseProduct, trialEndsAt, now = Date.now() } = {}) {
  if (licenseStatus !== 'valid' && licenseStatus !== 'offline-valid') {
    return 'free';
  }

  // A trial end exactly at `now` is already over — same boundary as
  // `daysUntil` in the label logic (`ms <= 0` is not a trial).
  const trialRunning =
    licenseProduct === 'subscription' &&
    typeof trialEndsAt === 'number' &&
    trialEndsAt > now;

  return trialRunning ? 'trial' : 'pro';
}

async function readState(statePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    return {
      anonymousId:
        typeof parsed?.anonymousId === 'string' && parsed.anonymousId.length > 0
          ? parsed.anonymousId
          : null,
      lastPing: Number.isFinite(parsed?.lastPing) ? parsed.lastPing : 0,
    };
  } catch {
    return { anonymousId: null, lastPing: 0 };
  }
}

async function writeState(statePath, state) {
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
}

/**
 * All inputs are injected by main.mjs (or by tests), which is what keeps this
 * module free of an `electron` import. The JSDoc typedef is load-bearing, not
 * decoration: it is the declared contract TypeScript checks call sites against
 * (without it, tsc infers an options object from only the defaulted bindings).
 *
 * @typedef {object} UsagePingOptions
 * @property {string} [userDataPath]    Electron's `app.getPath('userData')`.
 * @property {string} [appVersion]      Electron's `app.getVersion()`.
 * @property {string} [platform]        `process.platform`.
 * @property {string} [licenseStatus]   Raw license state; `mapPlan` collapses it to free/pro/trial.
 * @property {string} [licenseProduct]  Stored product kind; a trial exists only for 'subscription'.
 * @property {number | null} [trialEndsAt] End of a subscription's free trial (ms since epoch).
 * @property {typeof fetch} [fetchImpl] Injectable for tests; defaults to global fetch.
 * @property {number} [now]             Injectable clock (ms since epoch).
 * @property {number} [timeoutMs]       Abort timeout for the request.
 */

/**
 * Sends the ping if one is due. Resolves to true only when a ping was
 * delivered; every failure path (no network, blocked endpoint, unwritable
 * disk) resolves to false and must never disturb the app.
 *
 * @param {UsagePingOptions} [options]
 * @returns {Promise<boolean>} true only when a ping was actually delivered.
 */
export async function maybeSendUsagePing({
  userDataPath,
  appVersion,
  platform,
  licenseStatus,
  licenseProduct,
  trialEndsAt,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  try {
    if (!userDataPath || typeof fetchImpl !== 'function') {
      return false;
    }

    const statePath = path.join(userDataPath, STATE_FILE_NAME);
    const state = await readState(statePath);

    // Create and persist the ID before anything network-related: a failed
    // send (offline launch, blocked endpoint) must never cost the install a
    // new identity, or every offline day would count as another user.
    if (!state.anonymousId) {
      state.anonymousId = crypto.randomUUID();
      await writeState(statePath, state);
    }

    if (now - state.lastPing < PING_INTERVAL_MS) {
      return false;
    }

    const response = await fetchImpl(USAGE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: state.anonymousId,
        v: appVersion ?? 'unknown',
        os: platform ?? 'unknown',
        plan: mapPlan({ licenseStatus, licenseProduct, trialEndsAt, now }),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Exactly the Worker's success status — not a generic `response.ok`. A
    // 200 from anything else sitting on the URL (the Hello World placeholder
    // that was live before the Worker's first deploy) must not count as a
    // delivery, or the day would be marked pinged while nothing was recorded.
    if (response?.status !== 204) {
      return false;
    }

    // Only a delivered ping resets the clock, so an offline launch retries on
    // the next launch instead of silently skipping a day.
    await writeState(statePath, { ...state, lastPing: now });
    return true;
  } catch {
    return false;
  }
}
