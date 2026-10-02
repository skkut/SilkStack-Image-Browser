import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Subscription re-validation ────────────────────────────────────────
// The app-side scheduler that pulls subscription lifecycle changes from
// Gumroad (a documented outbound call). The closed module is mocked: what
// is under test here is the POLICY — when a request is made, which
// outcomes are applied, and which leave the stored state alone.

vi.hoisted(() => {
  global.localStorage = {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

const mocks = vi.hoisted(() => ({
  verifyStoredLicense: vi.fn(),
  statusFromGumroadResponse: vi.fn(),
}));

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  verifyStoredLicense: mocks.verifyStoredLicense,
  statusFromGumroadResponse: mocks.statusFromGumroadResponse,
}));

const DAY_MS = 24 * 60 * 60 * 1000;

/** Realistic verification result; override per test. */
const result = (over: Record<string, unknown> = {}) => ({
  status: 'valid',
  email: 'trial@example.com',
  purchaseDate: '2026-10-01T12:00:00Z',
  productKind: 'subscription',
  cancelled: false,
  trialEndsAt: null,
  ...over,
});

/**
 * Fresh module graph (the service holds per-process single-flight and
 * backoff state), then seed a subscription that is `ageMs` past its last
 * successful check.
 */
async function setup(ageMs: number, over: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useSettingsStore } = await import('../store/useSettingsStore');
  const { revalidateLicenseIfDue } = await import('../services/licenseRevalidation');
  const { computeLicenseStamp } = await import('../services/aiFeatureAccess');

  const ts = Date.now() - ageMs;
  useSettingsStore.setState({
    licenseKey: 'TRIAL-KEY',
    licenseStatus: 'valid',
    licenseEmail: 'trial@example.com',
    licensePurchaseDate: '2026-10-01T12:00:00Z',
    licenseLastValidated: ts,
    licenseProduct: 'subscription',
    licenseStamp: computeLicenseStamp('TRIAL-KEY', 'valid', ts, 'subscription'),
    trialEndsAt: null,
    subscriptionCancelled: false,
    ...over,
  });

  return { useSettingsStore, revalidateLicenseIfDue, computeLicenseStamp };
}

beforeEach(() => {
  mocks.verifyStoredLicense.mockReset();
  mocks.statusFromGumroadResponse.mockReset();
  mocks.statusFromGumroadResponse.mockReturnValue(result());
});

describe('revalidateLicenseIfDue — when a request is made', () => {
  it('does not call when the last check is recent', async () => {
    const { revalidateLicenseIfDue } = await setup(60 * 60 * 1000); // 1h

    await revalidateLicenseIfDue();

    expect(mocks.verifyStoredLicense).not.toHaveBeenCalled();
  });

  it('does not call for a lifetime license, however stale', async () => {
    const { revalidateLicenseIfDue } = await setup(365 * DAY_MS, {
      licenseProduct: 'lifetime',
    });

    await revalidateLicenseIfDue();

    expect(mocks.verifyStoredLicense).not.toHaveBeenCalled();
  });

  it('does not call for legacy states with no recorded product', async () => {
    const { revalidateLicenseIfDue } = await setup(365 * DAY_MS, {
      licenseProduct: null,
    });

    await revalidateLicenseIfDue();

    expect(mocks.verifyStoredLicense).not.toHaveBeenCalled();
  });

  it('calls once for a due subscription, against its own product', async () => {
    const { revalidateLicenseIfDue } = await setup(2 * DAY_MS);

    await revalidateLicenseIfDue();

    expect(mocks.verifyStoredLicense).toHaveBeenCalledTimes(1);
    expect(mocks.verifyStoredLicense).toHaveBeenCalledWith('TRIAL-KEY', 'subscription');
  });

  it('single-flights concurrent calls (StrictMode double-mount)', async () => {
    const { revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    mocks.verifyStoredLicense.mockResolvedValue({ success: true });

    await Promise.all([revalidateLicenseIfDue(), revalidateLicenseIfDue()]);

    expect(mocks.verifyStoredLicense).toHaveBeenCalledTimes(1);
  });

  it('backs off after a failure instead of retrying on every call', async () => {
    const { revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    mocks.verifyStoredLicense.mockRejectedValue(new Error('offline'));

    await revalidateLicenseIfDue();
    await revalidateLicenseIfDue();

    expect(mocks.verifyStoredLicense).toHaveBeenCalledTimes(1);
  });
});

describe('revalidateLicenseIfDue — what gets written', () => {
  it('a valid result refreshes the timestamp and re-stamps for the gate', async () => {
    const { useSettingsStore, revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    const before = useSettingsStore.getState().licenseLastValidated;
    mocks.verifyStoredLicense.mockResolvedValue({ success: true });

    await revalidateLicenseIfDue();

    const s = useSettingsStore.getState();
    expect(s.licenseLastValidated).toBeGreaterThan(before);
    expect(s.licenseStatus).toBe('valid');
    expect(s.licenseEmail).toBe('trial@example.com');

    // The refreshed state must pass the real gate (stamp recomputed with
    // the product-bound formula, timestamp inside the grace window).
    const { isAiFeaturesEnabled } = await import('../services/aiFeatureAccess');
    expect(isAiFeaturesEnabled()).toBe(true);
  });

  it("a cancelled-but-paid subscription stays premium, flagged for display", async () => {
    const { useSettingsStore, revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    mocks.statusFromGumroadResponse.mockReturnValue(result({ cancelled: true }));
    mocks.verifyStoredLicense.mockResolvedValue({ success: true });

    await revalidateLicenseIfDue();

    const s = useSettingsStore.getState();
    expect(s.licenseStatus).toBe('valid');
    expect(s.subscriptionCancelled).toBe(true);
    const { isAiFeaturesEnabled } = await import('../services/aiFeatureAccess');
    expect(isAiFeaturesEnabled()).toBe(true);
  });

  it('a revoked subscription is applied immediately', async () => {
    const { useSettingsStore, revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    mocks.statusFromGumroadResponse.mockReturnValue(result({ status: 'revoked' }));
    mocks.verifyStoredLicense.mockResolvedValue({ success: false });

    await revalidateLicenseIfDue();

    expect(useSettingsStore.getState().licenseStatus).toBe('revoked');
    const { isAiFeaturesEnabled } = await import('../services/aiFeatureAccess');
    expect(isAiFeaturesEnabled()).toBe(false);
  });

  it('an offline failure leaves the state untouched', async () => {
    const { useSettingsStore, revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    const before = useSettingsStore.getState();
    mocks.verifyStoredLicense.mockRejectedValue(new Error('offline'));

    await revalidateLicenseIfDue();

    const after = useSettingsStore.getState();
    expect(after.licenseLastValidated).toBe(before.licenseLastValidated);
    expect(after.licenseStamp).toBe(before.licenseStamp);
    expect(after.licenseStatus).toBe('valid');
    expect(after.licenseKey).toBe('TRIAL-KEY');
  });

  it('an "invalid" answer leaves the state untouched (the grace window bounds it)', async () => {
    const { useSettingsStore, revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    const before = useSettingsStore.getState();
    mocks.statusFromGumroadResponse.mockReturnValue(result({ status: 'invalid' }));
    mocks.verifyStoredLicense.mockResolvedValue({ success: false });

    await revalidateLicenseIfDue();

    const after = useSettingsStore.getState();
    expect(after.licenseStatus).toBe('valid');
    expect(after.licenseLastValidated).toBe(before.licenseLastValidated);
    expect(after.licenseKey).toBe('TRIAL-KEY');
  });

  it('drops the write when the key changed while the request was in flight', async () => {
    const { useSettingsStore, revalidateLicenseIfDue } = await setup(2 * DAY_MS);
    mocks.verifyStoredLicense.mockImplementation(async () => {
      // The user removed the license in Settings mid-request.
      useSettingsStore.setState({ licenseKey: '', licenseStatus: 'unchecked' });
      return { success: true };
    });

    await revalidateLicenseIfDue();

    // The removal must not be overwritten by the late response.
    const s = useSettingsStore.getState();
    expect(s.licenseKey).toBe('');
    expect(s.licenseStatus).toBe('unchecked');
  });
});
