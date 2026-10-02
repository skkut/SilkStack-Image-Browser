/**
 * License-field rehydration backfill — the upgrade path for settings
 * persisted before the subscription product existed.
 *
 * The critical property is NON-DESTRUCTIVE: a pre-upgrade install has a
 * v1 stamp that covers (key, status, timestamp) and nothing else. The
 * backfilled fields must therefore be exactly the values the stamp
 * verification reads as "legacy lifetime" (null / null / false) — any
 * other choice would fail verification, trip the auto-heal, and erase a
 * paying customer's key on first launch after update.
 */
import { describe, it, expect, vi } from 'vitest';

const localStorageMock = vi.hoisted(() => {
  let seed: string | null = null;
  const mock = {
    setSeed: (value: string | null) => {
      seed = value;
    },
    getItem: vi.fn(() => seed),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  };
  global.localStorage = mock as unknown as Storage;
  return mock;
});

/** Drain microtasks so persist hydration settles after the dynamic import. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

const LEGACY_TS = 1_750_000_000_000;

/**
 * Seed a pre-upgrade licensed state. Two-phase on purpose: the stamp must
 * be computed BEFORE the seeded import, but computeLicenseStamp itself
 * pulls in the store (which hydrates at module load). So compute it on a
 * throwaway graph first — the value depends only on the build-time secret
 * and its inputs, so it stays valid for the freshly seeded graph.
 */
async function seedLegacyLicense() {
  vi.resetModules();
  const { computeLicenseStamp } = await import('../services/aiFeatureAccess');
  const stamp = computeLicenseStamp('OLD-KEY', 'valid', LEGACY_TS);

  localStorageMock.setSeed(
    JSON.stringify({
      state: {
        licenseKey: 'OLD-KEY',
        licenseStatus: 'valid',
        licenseEmail: 'buyer@example.com',
        licensePurchaseDate: '2025-06-01T00:00:00Z',
        licenseLastValidated: LEGACY_TS,
        licenseStamp: stamp,
      },
    }),
  );
  return stamp;
}

describe('useSettingsStore — license field backfill', () => {
  it('backfills the product fields for a pre-upgrade state, preserving the rest', async () => {
    const stamp = await seedLegacyLicense();
    vi.resetModules();
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();

    const s = useSettingsStore.getState();
    expect(s.licenseProduct).toBeNull(); // null = "legacy lifetime", not 'lifetime'
    expect(s.trialEndsAt).toBeNull();
    expect(s.subscriptionCancelled).toBe(false);
    // Untouched:
    expect(s.licenseKey).toBe('OLD-KEY');
    expect(s.licenseStatus).toBe('valid');
    expect(s.licenseStamp).toBe(stamp);
  });

  it('preserves a recorded subscription product', async () => {
    // Same two-phase trick; the seed carries a post-upgrade field set.
    vi.resetModules();
    const { computeLicenseStamp } = await import('../services/aiFeatureAccess');
    const stamp = computeLicenseStamp('TRIAL-KEY', 'valid', LEGACY_TS, 'subscription');
    localStorageMock.setSeed(
      JSON.stringify({
        state: {
          licenseKey: 'TRIAL-KEY',
          licenseStatus: 'valid',
          licenseEmail: 'trial@example.com',
          licensePurchaseDate: null,
          licenseLastValidated: LEGACY_TS,
          licenseStamp: stamp,
          licenseProduct: 'subscription',
          trialEndsAt: 1_760_000_000_000,
          subscriptionCancelled: true,
        },
      }),
    );

    vi.resetModules();
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();

    const s = useSettingsStore.getState();
    expect(s.licenseProduct).toBe('subscription');
    expect(s.trialEndsAt).toBe(1_760_000_000_000);
    expect(s.subscriptionCancelled).toBe(true);
  });

  it('coerces an unrecognized product value to null', async () => {
    localStorageMock.setSeed(
      JSON.stringify({ state: { licenseKey: '', licenseStatus: 'unchecked', licenseProduct: 'gift' } }),
    );
    vi.resetModules();
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();

    expect(useSettingsStore.getState().licenseProduct).toBeNull();
  });

  it('a pre-upgrade licensed install stays premium after hydration', async () => {
    // The end-to-end compat guarantee: backfill + stamp + gate together.
    await seedLegacyLicense();
    vi.resetModules();
    const { useSettingsStore } = await import('../store/useSettingsStore');
    await flush();
    const { isAiFeaturesEnabled } = await import('../services/aiFeatureAccess');

    expect(isAiFeaturesEnabled()).toBe(true);
    // Not healed — the key survives the upgrade untouched.
    expect(useSettingsStore.getState().licenseKey).toBe('OLD-KEY');
  });
});
