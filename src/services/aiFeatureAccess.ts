/**
 * AI Feature Access — single source of truth for all premium gating.
 *
 * Every premium-dependent decision (UI visibility, feature execution,
 * license validity) routes through the helpers below.
 *
 * LICENSE INTEGRITY: a stored premium state is honored only while it carries
 * the stamp that matches it (`computeLicenseStamp`); a missing or mismatched
 * stamp reads as no license at all.  Every writer of license state must
 * re-stamp, and every reader goes through the helpers below — that invariant
 * is the one thing this file exists to keep.
 *
 *   compile-time  │  runtime (license)  │  result
 *   ──────────────┼─────────────────────┼─────────
 *   module absent │  any                │  false
 *   module present│  no license         │  false
 *   module present│  premium + stamp OK │  true
 *
 * OFFLINE RULES (per product):
 *   lifetime     — trusted indefinitely (unchanged behavior).
 *   subscription — trusted only while the last successful verification is
 *                  within OFFLINE_GRACE_MS, and re-validated on launch.
 *                  Expiry is Non-destructive: the state is kept so the next
 *                  successful re-validation restores access without the
 *                  customer re-entering the key.
 */

import { useSettingsStore } from '../store/useSettingsStore';
import { getDefaultLicenseState, type LicenseProduct } from '../services/licenseService';

// ── Secrets ───────────────────────────────────────────────────────────

/** Build-time constant injected by Vite — a rebuild is required to change it. */
const SECRET: string = import.meta.env.VITE_IMH_LICENSE_SECRET;

// ── Compile-time guard ────────────────────────────────────────────────

export const AI_MODULE_AVAILABLE: boolean = import.meta.env.VITE_AI_FEATURES_AVAILABLE;

// ── Stamp ─────────────────────────────────────────────────────────────

/** How long a subscription keeps working without a successful re-check. */
export const OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/** Cheap synchronous keyed hash — runs on every render. */
function hashPayload(payload: string): string {
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) + hash) ^ payload.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/** Legacy payload: binds key + status + timestamp. */
function payloadV1(key: string, status: string, timestamp: number): string {
  return `${SECRET}:${key}:${status}:${timestamp}`;
}

/**
 * Product-bound payload, used for subscriptions only. The product field is
 * part of the stamped payload because it decides the offline rule.
 *
 * Lifetime deliberately keeps the v1 payload: its rule matches the legacy
 * one, and an unchanged stamp means a version rollback cannot invalidate an
 * existing customer's license.
 */
function payloadV2(key: string, status: string, timestamp: number, product: string): string {
  return `${SECRET}:${key}:${status}:${timestamp}:${product}:v2`;
}

/** Public: use this whenever you need to stamp newly-activated state. */
export function computeLicenseStamp(
  licenseKey: string,
  licenseStatus: string,
  licenseLastValidated: number,
  licenseProduct: LicenseProduct | null = null,
): string {
  return licenseProduct === 'subscription'
    ? hashPayload(payloadV2(licenseKey, licenseStatus, licenseLastValidated, licenseProduct))
    : hashPayload(payloadV1(licenseKey, licenseStatus, licenseLastValidated));
}

/** Does `stamp` prove this exact state was written by us? */
function verifyLicenseStamp(
  licenseKey: string,
  licenseStatus: string,
  licenseLastValidated: number,
  licenseProduct: LicenseProduct | null,
  stamp: string,
): boolean {
  if (!stamp) return false;
  const expected =
    licenseProduct === 'subscription'
      ? hashPayload(payloadV2(licenseKey, licenseStatus, licenseLastValidated, licenseProduct))
      : hashPayload(payloadV1(licenseKey, licenseStatus, licenseLastValidated));
  return stamp === expected;
}

// ── Premium check ─────────────────────────────────────────────────────

/** The store fields the license checks read. */
interface LicenseSnapshot {
  licenseStatus: string;
  licenseStamp: string;
  licenseKey: string;
  licenseLastValidated: number;
  licenseProduct: LicenseProduct | null;
}

/** Premium-looking status with an intact, matching stamp. */
function isLicenseStampValid(s: LicenseSnapshot): boolean {
  if (s.licenseStatus !== 'valid' && s.licenseStatus !== 'offline-valid') return false;
  return verifyLicenseStamp(
    s.licenseKey,
    s.licenseStatus,
    s.licenseLastValidated,
    s.licenseProduct,
    s.licenseStamp,
  );
}

/**
 * Has a subscription gone past the offline grace window? Lifetime licenses
 * (and legacy states with no recorded product — historically lifetime)
 * never do.
 */
function isBeyondOfflineGrace(s: LicenseSnapshot): boolean {
  if (s.licenseProduct !== 'subscription') return false;
  return Date.now() - s.licenseLastValidated > OFFLINE_GRACE_MS;
}

/** Full entitlement check: genuine stamp AND the product's offline rule. */
function checkPremiumStatus(s: LicenseSnapshot): boolean {
  if (!isLicenseStampValid(s)) return false;
  if (isBeyondOfflineGrace(s)) return false;
  return true;
}

/**
 * React hook helper: subscribe to every field the license checks read.
 * Kept in one place so a new field can't be wired into two hooks and
 * forgotten in the third.
 */
function useLicenseSnapshot(): LicenseSnapshot {
  return {
    licenseStatus: useSettingsStore((st) => st.licenseStatus),
    licenseStamp: useSettingsStore((st) => st.licenseStamp),
    licenseKey: useSettingsStore((st) => st.licenseKey),
    licenseLastValidated: useSettingsStore((st) => st.licenseLastValidated),
    licenseProduct: useSettingsStore((st) => st.licenseProduct),
  };
}

/** Imperative: true when the license is valid AND the stamp verifies. */
export function isAiFeaturesEnabled(): boolean {
  if (!AI_MODULE_AVAILABLE) return false;
  const s = useSettingsStore.getState();
  if (!isLicenseStampValid(s)) {
    // Clear ONLY state whose stamp does not match, so the UI never shows a
    // stale premium indicator. A subscription that merely ran past its
    // offline grace keeps its state: wiping the key here would force
    // re-entry even though the subscription is still paid.
    if (s.licenseStatus === 'valid' || s.licenseStatus === 'offline-valid') {
      s.setLicenseState(getDefaultLicenseState());
    }
    return false;
  }
  return !isBeyondOfflineGrace(s);
}

/**
 * Imperative: true when premium is unlocked AND the stamp is valid.
 * Use in store actions / non-react contexts; also clears state whose stamp
 * does not match.
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
  const snapshot = useLicenseSnapshot();
  if (!AI_MODULE_AVAILABLE) return false;
  return checkPremiumStatus(snapshot);
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
  const snapshot = useLicenseSnapshot();

  if (!AI_MODULE_AVAILABLE) return false;
  if (!checkPremiumStatus(snapshot)) return false;
  return userPref;
}

/**
 * Reactive hook: the effective semantic-search toggle — user preference AND
 * master AI-features toggle AND premium gate AND stamp valid.
 */
export function useSemanticSearchEnabled(): boolean {
  const userPref = useSettingsStore((s) => s.isSemanticSearchEnabled);
  const masterEnabled = useSettingsStore((s) => s.aiFeaturesEnabled);
  const snapshot = useLicenseSnapshot();

  if (!masterEnabled) return false;
  if (!AI_MODULE_AVAILABLE) return false;
  if (!checkPremiumStatus(snapshot)) return false;
  return userPref;
}
