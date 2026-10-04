import { describe, expect, it, vi, beforeEach } from 'vitest';

// The menu bar reads the persisted settings store (license gate for the Undo
// item and the Help upsell), so it needs the same localStorage stand-in every
// persisted-store suite carries.
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

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CustomMenuBar from '../components/CustomMenuBar';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp, OFFLINE_GRACE_MS } from '../services/aiFeatureAccess';
import { getDefaultLicenseState } from '../services/licenseService';

// Help → "Try Premium" is an upsell for FREE users only: it routes to the
// Settings License tab while premium is locked, and disappears — in-app AND in
// the native Electron menu — the moment premium access is unlocked. The suite
// is skipped in the no-module path (no License tab exists at all), same
// convention as the other module-dependent suites.
describe.skipIf(!import.meta.env.VITE_AI_FEATURES_AVAILABLE)(
  'CustomMenuBar — Help menu',
  () => {
    let pushMenuState: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // The bar renders only when the Electron bridge is present; the same
      // bridge carries the native-menu visibility push.
      pushMenuState = vi.fn();
      (global.window as any).electronAPI = {
        setTryPremiumMenuVisible: pushMenuState,
      };
      // The master AI switch is NOT part of the gate, but reset it anyway so a
      // test that flips it cannot leak into the next one.
      useSettingsStore.setState({ ...getDefaultLicenseState(), aiFeaturesEnabled: true });
    });

    const openHelpMenu = () => {
      // Menus open on mousedown (not click) — the handler is onMouseDown.
      fireEvent.mouseDown(screen.getByText('Help'));
    };

    const renderBar = () => {
      const onOpenSettings = vi.fn();
      render(
        <CustomMenuBar
          onOpenSettings={onOpenSettings}
          onAddFolder={vi.fn()}
          onToggleView={vi.fn()}
        />,
      );
      return onOpenSettings;
    };

    it('routes Try Premium to the License tab for a free user', () => {
      const onOpenSettings = renderBar();

      openHelpMenu();
      fireEvent.mouseDown(screen.getByText('Try Premium'));

      expect(onOpenSettings).toHaveBeenCalledWith('license');
    });

    it('tells the native menu to show the item for a free user', () => {
      renderBar();

      expect(pushMenuState).toHaveBeenLastCalledWith(true);
    });

    it('hides the item once premium is active', () => {
      const validatedAt = Date.now();
      useSettingsStore.setState({
        licenseStatus: 'valid',
        licenseKey: 'TEST-KEY',
        licenseLastValidated: validatedAt,
        licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', validatedAt),
      });

      renderBar();
      openHelpMenu();

      expect(screen.queryByText('Try Premium')).toBeNull();
      expect(pushMenuState).toHaveBeenLastCalledWith(false);
    });

    it('keeps the item hidden when a premium user switches AI features off', () => {
      // The master AI switch is a preference, not an entitlement, so it must
      // never feed this gate: a paying user who turns the features off would
      // otherwise be upsold the license they already own. Premium comes from
      // the license alone.
      const validatedAt = Date.now();
      useSettingsStore.setState({
        licenseStatus: 'valid',
        licenseKey: 'TEST-KEY',
        licenseLastValidated: validatedAt,
        licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', validatedAt),
        aiFeaturesEnabled: false,
      });

      renderBar();
      openHelpMenu();

      expect(screen.queryByText('Try Premium')).toBeNull();
      expect(pushMenuState).toHaveBeenLastCalledWith(false);
    });

    it('hides the item for a running trial', () => {
      // A trial unlocks the premium features, so its user is not a "free"
      // user — same verdict as `deriveLicenseLabel`'s "Trial — N days left".
      const validatedAt = Date.now();
      useSettingsStore.setState({
        licenseStatus: 'valid',
        licenseKey: 'TRIAL-KEY',
        licenseLastValidated: validatedAt,
        licenseProduct: 'subscription',
        trialEndsAt: validatedAt + 3 * 24 * 60 * 60 * 1000,
        licenseStamp: computeLicenseStamp('TRIAL-KEY', 'valid', validatedAt, 'subscription'),
      });

      renderBar();
      openHelpMenu();

      expect(screen.queryByText('Try Premium')).toBeNull();
      expect(pushMenuState).toHaveBeenLastCalledWith(false);
    });

    it('shows the item again when a subscription lapses past the offline grace', () => {
      // Features are locked again, so the user needs the path back to the
      // License tab.
      const validatedAt = Date.now() - OFFLINE_GRACE_MS - 60_000;
      useSettingsStore.setState({
        licenseStatus: 'offline-valid',
        licenseKey: 'LAPSED-KEY',
        licenseLastValidated: validatedAt,
        licenseProduct: 'subscription',
        licenseStamp: computeLicenseStamp('LAPSED-KEY', 'offline-valid', validatedAt, 'subscription'),
      });

      renderBar();
      openHelpMenu();

      expect(screen.getByText('Try Premium')).not.toBeNull();
      expect(pushMenuState).toHaveBeenLastCalledWith(true);
    });

    it('routes About to the About tab', () => {
      const onOpenSettings = renderBar();

      openHelpMenu();
      fireEvent.mouseDown(screen.getByText('About'));

      expect(onOpenSettings).toHaveBeenCalledWith('about');
    });
  },
);
