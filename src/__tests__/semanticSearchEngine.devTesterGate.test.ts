/**
 * SemanticSearchCoordinator premium-gate wiring (app vs dev tester).
 *
 * The coordinator boundary feeds the closed module a single `isPremium`
 * boolean. App coordinators must gate on master ∧ license
 * (`isAiModelFeaturesEnabled`) — the master toggle's "no model in VRAM"
 * promise. Dev-tester coordinators pass `skipMasterCheck` so the tester
 * gates on the LICENSE alone (`isAiFeaturesEnabled`): its window is already
 * premium-gated at entry (Ctrl+Y is license-only) and loads only on an
 * explicit button click, so the master toggle — which governs the MAIN APP
 * — must not lock it. The license check always applies.
 *
 * The real coordinator wrapper + the real aiFeatureAccess/settings chain are
 * exercised with real store state; only the closed module is mocked (a
 * capturing coordinator records the injected callbacks).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real persisted stores need a working localStorage (file-backed localStorage
// can be inert on some machines — see the `--localstorage-file` warning).
const localStorageMock = vi.hoisted(() => {
  const mock = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  };
  global.localStorage = mock as unknown as Storage;
  return mock;
});

// The module mock's coordinator records the options the wrapper injected —
// isPremium is the callback under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const constructed = vi.hoisted<Array<{ opts: any }>>(() => []);

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  SemanticSearchCoordinator: class {
    constructor(opts: unknown) {
      constructed.push({ opts });
    }
    async ensureInitialized(): Promise<void> {}
  },
}));

// Imported statically so license/master state can be driven through the REAL
// store — the wrapper's isPremium closures read the same instance.
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';

const setLicense = (valid: boolean) => {
  const ts = valid ? Date.now() : 0;
  const key = valid ? 'TEST-KEY-1234' : '';
  useSettingsStore.setState({
    licenseKey: key,
    licenseStatus: valid ? 'valid' : 'unchecked',
    licenseEmail: '',
    licensePurchaseDate: null,
    licenseLastValidated: ts,
    licenseStamp: key ? computeLicenseStamp(key, valid ? 'valid' : 'unchecked', ts) : '',
  });
};

describe('SemanticSearchCoordinator premium gate (app vs dev tester)', () => {
  beforeEach(() => {
    localStorageMock.getItem.mockClear();
    setLicense(true);
    // Master OFF is the interesting state — the whole point of this test.
    useSettingsStore.setState({ aiFeaturesEnabled: false });
    constructed.length = 0;
  });

  afterEach(() => {
    useSettingsStore.setState({ aiFeaturesEnabled: true }); // restore the default
  });

  /**
   * Build a wrapper, force module-coordinator construction via
   * ensureInitialized(), and return the captured isPremium callback.
   */
  const lastPremiumCheck = async (skipMasterCheck: boolean): Promise<() => boolean> => {
    const { SemanticSearchCoordinator } = await import('../services/semanticSearchEngine');
    const coordinator = new SemanticSearchCoordinator(
      undefined,
      undefined,
      undefined,
      undefined,
      skipMasterCheck,
    );
    await coordinator.ensureInitialized(); // lazy: constructs the module coordinator
    expect(constructed).toHaveLength(1);
    return constructed[0].opts.isPremium as () => boolean;
  };

  it('app coordinator: master off + license valid → gate CLOSED', async () => {
    const isPremium = await lastPremiumCheck(false);
    expect(isPremium()).toBe(false);
  });

  it('app coordinator: master on + license valid → gate OPEN', async () => {
    useSettingsStore.setState({ aiFeaturesEnabled: true });
    const isPremium = await lastPremiumCheck(false);
    expect(isPremium()).toBe(true);
  });

  it('dev-tester coordinator (skipMasterCheck): master off + license valid → gate OPEN', async () => {
    const isPremium = await lastPremiumCheck(true);
    expect(isPremium()).toBe(true);
  });

  it('dev-tester coordinator (skipMasterCheck): still CLOSED without a license', async () => {
    setLicense(false);
    const isPremium = await lastPremiumCheck(true);
    expect(isPremium()).toBe(false);
  });
});
