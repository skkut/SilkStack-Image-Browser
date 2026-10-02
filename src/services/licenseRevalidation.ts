/**
 * Subscription re-validation — periodic freshness check for membership keys.
 *
 * A lifetime license is verified once and trusted forever. A subscription
 * can end (cancelled, failed charge, refund), and Gumroad never pushes that
 * to a desktop app — so the app pulls it: on launch, and at most once a day
 * per install, the stored key is re-verified against the single product it
 * was activated on.
 *
 * Failure policy — deliberately conservative:
 *   - THROWN (offline, IPC down)      → leave state untouched.
 *   - `invalid` (key not found)       → leave state untouched; log. Could be
 *                                       a transient Gumroad or config issue,
 *                                       and the offline grace window in
 *                                       aiFeatureAccess already bounds how
 *                                       long an unrenewed state stays usable.
 *   - `revoked` / `expired`           → apply. These are Gumroad stating a
 *                                       lifecycle fact (ended / refunded /
 *                                       charge failed); there is nothing to
 *                                       wait for.
 *   - `valid`                         → refresh the timestamp + display
 *                                       fields and re-stamp.
 *
 * This is a documented outbound call (same Gumroad endpoint as activation) —
 * see README + AGENTS.md.
 */

import { useSettingsStore } from '../store/useSettingsStore';
import { AI_MODULE_AVAILABLE, computeLicenseStamp } from './aiFeatureAccess';

/** Re-check a subscription at most once per day. */
export const REVALIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Same shape as aiBridge's loader: the compile-time guard lets Vite
 *  dead-code-eliminate the import() in the open-source build. */
async function loadModule() {
  if (!import.meta.env.VITE_AI_FEATURES_AVAILABLE) return null;
  try {
    return await import('@ai-images-browser/ai-intelligence');
  } catch (err) {
    console.warn('[licenseRevalidation] module unavailable:', err);
    return null;
  }
}

/** Single-flight: a React StrictMode double-mount must not double-request. */
let inFlight: Promise<void> | null = null;
/** Attempt clock: one request per day regardless of outcome, so a failed
 *  re-check (offline) isn't retried by every store change or remount. */
let lastAttemptAt = 0;

/**
 * Re-validate the stored license when due. Safe to call on every launch —
 * it no-ops for lifetime / unlicensed states and when the last check is
 * recent. Never throws.
 */
export function revalidateLicenseIfDue(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function run(): Promise<void> {
  if (!AI_MODULE_AVAILABLE) return;

  const s = useSettingsStore.getState();
  // Only subscriptions can lapse. Lifetime (and null = pre-field, always
  // lifetime) keys are never re-checked — matches their offline rule.
  if (s.licenseProduct !== 'subscription') return;
  if (!s.licenseKey) return;
  if (Date.now() - s.licenseLastValidated < REVALIDATION_INTERVAL_MS) return;
  if (Date.now() - lastAttemptAt < REVALIDATION_INTERVAL_MS) return;
  lastAttemptAt = Date.now();

  const mod = await loadModule();
  if (!mod) return;

  let outcome;
  try {
    outcome = await mod.verifyStoredLicense(s.licenseKey, 'subscription');
  } catch (err) {
    // Offline / IPC failure: leave everything as it was.
    console.warn('[licenseRevalidation] re-check failed:', err);
    return;
  }

  const result = mod.statusFromGumroadResponse(outcome);

  if (result.status === 'invalid') {
    // Ambiguous (transient API / config problem). Do not drop the customer;
    // the offline grace window is the bound on a stale state.
    console.warn('[licenseRevalidation] key no longer recognized; leaving state untouched');
    return;
  }

  // Re-read: the store may have changed while the request was in flight
  // (e.g. the user removed the license in Settings).
  const current = useSettingsStore.getState();
  if (current.licenseKey !== s.licenseKey) return;

  const ts = Date.now();
  const patch: Record<string, unknown> = {
    licenseStatus: result.status,
    licenseEmail: result.email,
    licensePurchaseDate: result.purchaseDate,
    licenseProduct: result.productKind,
    trialEndsAt: result.trialEndsAt,
    subscriptionCancelled: result.cancelled,
    licenseLastValidated: ts,
  };

  // Always stamp: for a premium result the gate recomputes and requires it,
  // and for 'revoked'/'expired' a correct stamp keeps the stored state
  // coherent (a later re-activation of the same key re-stamps anyway).
  patch.licenseStamp = computeLicenseStamp(s.licenseKey, result.status, ts, result.productKind);

  current.setLicenseState(patch as Parameters<typeof current.setLicenseState>[0]);
}
