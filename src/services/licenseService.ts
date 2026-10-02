/**
 * License Service — minimal open-source types and defaults.
 *
 * The Zustand store needs LicenseState / LicenseStatus to type the
 * persisted license fields, and getDefaultLicenseState() for
 * initialization / reset.  Everything else — verification logic,
 * Gumroad API calls, and the License tab UI — lives in the closed-source
 * ai-intelligence module and is only reachable when that module is
 * present at build time AND the user activates a license.
 */

// ── Types ─────────────────────────────────────────────────────────────

/** Possible license states. */
export type LicenseStatus =
  | 'unchecked'       // No key has been entered or validated yet
  | 'valid'           // Key is valid and premium features are unlocked
  | 'invalid'         // Key was rejected by Gumroad (wrong / fake)
  | 'expired'         // Subscription-based license has lapsed
  | 'revoked'         // License was refunded or cancelled
  | 'offline-valid'   // Previously validated but can't reach API (still trusted)
  | 'verifying';      // Currently checking with the API

/**
 * Which Gumroad product a license key belongs to.
 *
 * - `lifetime`     — the one-time product; trusted offline indefinitely.
 * - `subscription` — the membership (possibly still inside its free trial).
 *                    It can lapse, so offline trust is bounded by the app's
 *                    grace window and the key is re-validated periodically.
 */
export type LicenseProduct = 'lifetime' | 'subscription';

/** The stored license state persisted alongside other settings. */
export interface LicenseState {
  licenseKey: string;
  licenseStatus: LicenseStatus;
  licenseEmail: string;
  licensePurchaseDate: string | null;
  licenseLastValidated: number; // Date.now() timestamp
  /** HMAC stamp — proves the state wasn't edited by hand in settings.json. */
  licenseStamp: string;
  /**
   * Which product the key was activated against. Bound into the stamp for
   * subscriptions because it decides the offline rule — deleting or editing
   * it must not silently grant a subscription lifetime's offline trust.
   * `null` means "activated before this field existed", i.e. lifetime.
   */
  licenseProduct: LicenseProduct | null;
  /**
   * Display-only: end of a subscription's free trial (ms since epoch).
   * NEVER gates — Gumroad owns the trial/charge lifecycle, and a paid
   * period's end is not reported by the verify API.
   */
  trialEndsAt: number | null;
  /** Display-only: subscription cancelled, still inside the paid period. */
  subscriptionCancelled: boolean;
}

// ── Default state ─────────────────────────────────────────────────────

export function getDefaultLicenseState(): LicenseState {
  return {
    licenseKey: '',
    licenseStatus: 'unchecked',
    licenseEmail: '',
    licensePurchaseDate: null,
    licenseLastValidated: 0,
    licenseStamp: '',
    licenseProduct: null,
    trialEndsAt: null,
    subscriptionCancelled: false,
  };
}
