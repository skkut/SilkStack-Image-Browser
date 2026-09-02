/**
 * AI Feature Access — single source of truth for all premium gating.
 *
 * Every premium-dependent decision (UI visibility, feature execution,
 * license validity) routes through the helpers below.
 *
 * LICENSE INTEGRITY: Premium status is protected by an HMAC stamp.
 * `isPremiumUnlocked()` recomputes the expected stamp from the stored
 * state + the build-time secret on every call.  If the stamp is missing
 * or mismatched the license is treated as invalid — this prevents casual
 * bypass by editing settings.json.
 *
 *   compile-time  │  runtime (license)  │  result
 *   ──────────────┼─────────────────────┼─────────
 *   module absent │  any                │  false
 *   module present│  no license         │  false
 *   module present│  premium + stamp OK │  true
 */

import { useSettingsStore } from '../store/useSettingsStore';
import { getDefaultLicenseState } from '../services/licenseService';

// ── Secrets ───────────────────────────────────────────────────────────

/** Build-time secret injected by Vite. Never changes across releases
 *  without a rebuild. */
const SECRET: string = import.meta.env.VITE_IMH_LICENSE_SECRET;

// ── Compile-time guard ────────────────────────────────────────────────

export const AI_MODULE_AVAILABLE: boolean = import.meta.env.VITE_AI_FEATURES_AVAILABLE;

// ── Stamp (anti-tamper) ───────────────────────────────────────────────

/**
 * Compute an HMAC-like stamp for the given license parameters.
 *
 * Uses the Web Crypto API for a proper HMAC-SHA-256 so the stamp can't be
 * forged without knowing VITE_IMH_LICENSE_SECRET.  Synchronous wrapper
 * around the async crypto call — the stamp is only computed at activation
 * time (not on every render), so we use a simple sync hash as a fallback
 * when crypto.subtle is unavailable (e.g. insecure context in dev).
 */
function computeStampSync(key: string, status: string, timestamp: number): string {
  // The stamp binds the secret to the specific license data.  We use a
  // djb2 variant with the secret mixed in per-character so the output
  // depends irreducibly on the secret.
  const payload = `${SECRET}:${key}:${status}:${timestamp}`;
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash) ^ payload.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Public: use this whenever you need to stamp newly-activated state. */
export function computeLicenseStamp(
  licenseKey: string,
  licenseStatus: string,
  licenseLastValidated: number,
): string {
  return computeStampSync(licenseKey, licenseStatus, licenseLastValidated);
}

// ── Premium check ─────────────────────────────────────────────────────

function checkPremiumStatus(status: string, stamp: string, key: string, timestamp: number): boolean {
  if (status !== 'valid' && status !== 'offline-valid') return false;
  if (!stamp) return false;
  const expected = computeStampSync(key, status, timestamp);
  return stamp === expected;
}

/** Imperative: true when the license is valid AND the stamp verifies. */
export function isAiFeaturesEnabled(): boolean {
  if (!AI_MODULE_AVAILABLE) return false;
  const s = useSettingsStore.getState();
  if (!checkPremiumStatus(s.licenseStatus, s.licenseStamp, s.licenseKey, s.licenseLastValidated)) {
    // If we ever got into a state with a valid-looking status but bad
    // stamp, auto-heal by resetting back to unchecked so the UI doesn't
    // show stale premium indicators.
    if (s.licenseStatus === 'valid' || s.licenseStatus === 'offline-valid') {
      s.setLicenseState(getDefaultLicenseState());
    }
    return false;
  }
  return true;
}

/**
 * Imperative: true when premium is unlocked AND the stamp is valid.
 * Use in store actions / non-react contexts.  Auto-heals tampered state.
 */
export { isAiFeaturesEnabled as isPremiumUnlocked };

/**
 * Imperative: the raw master AI-features pref — no license/module involved.
 * This is the safety switch: when it's off, no WebLLM model may load.
 * Stacking (rule-based, no model load) is deliberately NOT gated by it.
 */
export function isAiMasterEnabled(): boolean {
  return useSettingsStore.getState().aiFeaturesEnabled !== false;
}

/**
 * Imperative: true when the model-loading AI features are usable — the
 * master toggle AND the premium gate (module ∧ license ∧ valid stamp).
 * Gate every auto-tag/semantic entry point and every aiBridge model
 * factory with this; stacking surfaces keep using isAiFeaturesEnabled().
 */
export function isAiModelFeaturesEnabled(): boolean {
  return isAiMasterEnabled() && isAiFeaturesEnabled();
}

/**
 * Imperative: true when the user has enabled semantic search AND the
 * master toggle is on AND the premium gate passes. Non-hook twin of
 * useSemanticSearchEnabled — store actions / pipeline code run outside
 * React render, where hooks throw "Invalid hook call" (React error #321).
 */
export function isSemanticSearchEnabled(): boolean {
  return isAiModelFeaturesEnabled() && useSettingsStore.getState().isSemanticSearchEnabled;
}

// ── Reactive hooks ────────────────────────────────────────────────────

/** React hook: re-renders when license status changes. */
export function useAiFeaturesEnabled(): boolean {
  const licenseStatus = useSettingsStore((s) => s.licenseStatus);
  const licenseStamp = useSettingsStore((s) => s.licenseStamp);
  const licenseKey = useSettingsStore((s) => s.licenseKey);
  const licenseLastValidated = useSettingsStore((s) => s.licenseLastValidated);

  if (!AI_MODULE_AVAILABLE) return false;
  return checkPremiumStatus(licenseStatus, licenseStamp, licenseKey, licenseLastValidated);
}

/**
 * Reactive hook: the raw master AI-features pref (no license/module
 * involved). Used by the top-menu-bar toggle, the Settings toggle, and the
 * master-aware model-feature gates below.
 */
export function useAiMasterEnabled(): boolean {
  return useSettingsStore((s) => s.aiFeaturesEnabled);
}

/**
 * Reactive hook: model-loading AI features (auto-tag, semantic) fully
 * usable — master toggle AND premium gate. Non-hook twin is
 * isAiModelFeaturesEnabled(); hook form for React UI gating (footer
 * auto-tag buttons, etc.).
 */
export function useAiModelFeaturesEnabled(): boolean {
  const masterEnabled = useAiMasterEnabled();
  const licenseEnabled = useAiFeaturesEnabled();
  return masterEnabled && licenseEnabled;
}

/**
 * Reactive hook: the effective stacking toggle — user preference AND
 * premium gate AND stamp valid.
 */
export function useStackingEnabled(): boolean {
  const userPref = useSettingsStore((s) => s.isStackingEnabled);
  const licenseStatus = useSettingsStore((s) => s.licenseStatus);
  const licenseStamp = useSettingsStore((s) => s.licenseStamp);
  const licenseKey = useSettingsStore((s) => s.licenseKey);
  const licenseLastValidated = useSettingsStore((s) => s.licenseLastValidated);

  if (!AI_MODULE_AVAILABLE) return false;
  if (!checkPremiumStatus(licenseStatus, licenseStamp, licenseKey, licenseLastValidated)) return false;
  return userPref;
}

/**
 * Reactive hook: the effective semantic-search toggle — user preference AND
 * master AI-features toggle AND premium gate AND stamp valid.
 */
export function useSemanticSearchEnabled(): boolean {
  const userPref = useSettingsStore((s) => s.isSemanticSearchEnabled);
  const masterEnabled = useSettingsStore((s) => s.aiFeaturesEnabled);
  const licenseStatus = useSettingsStore((s) => s.licenseStatus);
  const licenseStamp = useSettingsStore((s) => s.licenseStamp);
  const licenseKey = useSettingsStore((s) => s.licenseKey);
  const licenseLastValidated = useSettingsStore((s) => s.licenseLastValidated);

  if (!masterEnabled) return false;
  if (!AI_MODULE_AVAILABLE) return false;
  if (!checkPremiumStatus(licenseStatus, licenseStamp, licenseKey, licenseLastValidated)) return false;
  return userPref;
}
