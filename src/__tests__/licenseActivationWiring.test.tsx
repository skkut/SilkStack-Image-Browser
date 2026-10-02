import { describe, expect, it, vi } from 'vitest';

// ── License activation wiring ─────────────────────────────────────────
// The closed LicenseTab only REPORTS a partial license state; the open
// wrapper (SettingsModal → LicenseSettingsPanel) is what attaches the
// anti-tamper stamp. Get that stamp wrong and the failure is severe and
// user-visible: the gate rejects the freshly activated state and the
// auto-heal then ERASES the customer's key.
//
// So these tests drive the real wrapper with a fake closed component and
// assert the written state passes the real gate — and, for a subscription,
// that the stamp is the product-bound v2 formula (proved by flipping the
// product and watching verification fail).

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

/** The fake closed component: one button per activation partial. */
vi.mock('@ai-images-browser/ai-intelligence', () => ({
  LicenseTab: ({ onLicenseStateChange }: { onLicenseStateChange: (p: unknown) => void }) => (
    <div>
      <button
        data-testid="activate-lifetime"
        onClick={() =>
          onLicenseStateChange({
            licenseKey: 'LIFETIME-KEY',
            licenseStatus: 'valid',
            licenseEmail: 'buyer@example.com',
            licensePurchaseDate: '2026-09-01T12:00:00Z',
            licenseLastValidated: Date.now(),
            licenseProduct: 'lifetime',
            trialEndsAt: null,
            subscriptionCancelled: false,
          })
        }
      >
        activate lifetime
      </button>
      <button
        data-testid="activate-subscription"
        onClick={() =>
          onLicenseStateChange({
            licenseKey: 'TRIAL-KEY',
            licenseStatus: 'valid',
            licenseEmail: 'trial@example.com',
            licensePurchaseDate: '2026-10-01T12:00:00Z',
            licenseLastValidated: Date.now(),
            licenseProduct: 'subscription',
            trialEndsAt: 1_800_000_000_000,
            subscriptionCancelled: false,
          })
        }
      >
        activate subscription
      </button>
    </div>
  ),
}));

// SettingsModal statically imports these; the license tab never exercises
// them, so inert stand-ins keep the render quiet.
vi.mock('../services/semanticSearchEngine', () => ({
  getEmbeddingModelOptions: vi.fn().mockResolvedValue([]),
  getTagModelOptions: vi.fn().mockResolvedValue([]),
}));

vi.mock('../services/imageAnnotationsStorage', () => ({
  bulkSaveAnnotations: vi.fn().mockResolvedValue(true),
  saveAnnotation: vi.fn().mockResolvedValue(true),
  getAllTags: vi.fn().mockResolvedValue([]),
  loadAllAnnotations: vi.fn().mockResolvedValue(new Map()),
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SettingsModal from '../components/SettingsModal';
import { useSettingsStore } from '../store/useSettingsStore';
import { isAiFeaturesEnabled } from '../services/aiFeatureAccess';

/** Open Settings → License and activate via the fake closed component. */
async function activate(testId: string) {
  render(<SettingsModal isOpen onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /^License$/ }));
  fireEvent.click(await screen.findByTestId(testId));
}

describe('license activation wiring (SettingsModal → closed LicenseTab)', () => {
  it('a subscription activation is stamped so the gate accepts it', async () => {
    await activate('activate-subscription');

    const s = useSettingsStore.getState();
    expect(s.licenseKey).toBe('TRIAL-KEY');
    expect(s.licenseProduct).toBe('subscription');
    expect(s.licenseStatus).toBe('valid');
    // Display-only fields ride along untouched.
    expect(s.trialEndsAt).toBe(1_800_000_000_000);
    expect(s.subscriptionCancelled).toBe(false);

    // The gate recomputes the stamp from the stored state; a wrong formula
    // fails here AND wipes the key via the auto-heal.
    expect(isAiFeaturesEnabled()).toBe(true);
    expect(useSettingsStore.getState().licenseKey).toBe('TRIAL-KEY');
  });

  it("a subscription's stamp is product-bound (v2), not the legacy formula", async () => {
    await activate('activate-subscription');

    // Flipping the product must invalidate the stamp. Under the legacy
    // formula the product is not an input, so this would still verify and
    // a hand-edit could claim lifetime's unlimited offline trust.
    useSettingsStore.setState({ licenseProduct: 'lifetime' });
    expect(isAiFeaturesEnabled()).toBe(false);
  });

  it('a lifetime activation keeps the legacy stamp (rollback-compatible)', async () => {
    await activate('activate-lifetime');

    const s = useSettingsStore.getState();
    expect(s.licenseProduct).toBe('lifetime');
    expect(isAiFeaturesEnabled()).toBe(true);
  });
});
