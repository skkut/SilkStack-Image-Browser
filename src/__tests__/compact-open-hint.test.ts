import { describe, it, expect, vi, beforeEach } from 'vitest';

// The stores read localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it before any module import. This file
// needs its *own* stub rather than the shared one: the shared jsdom storage
// returns the same value for every key, which would satisfy the compact-mode
// guard below no matter what was seeded, and the test would pass for the wrong
// reason.
vi.hoisted(() => {
  const store = new Map<string, string>();
  const makeStorage = () =>
    ({
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => store.clear()),
      length: 0,
      key: vi.fn(() => null),
      __store: store,
    }) as unknown as Storage;
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
});

import { compactOpenHint } from '../hooks/useImageSelection';
import {
  COMPACT_MODE_STORAGE_KEY,
  COMPACT_PANEL_STORAGE_KEY,
  COMPACT_SCALE_STORAGE_KEY,
  DEFAULT_SIDEBAR_SHARE,
  MAX_SIDEBAR_SHARE,
  SIDEBAR_SHARE_STORAGE_KEY,
  clampSidebarShare,
  compactSidebarWidth,
  computeCompactContentSize,
} from '../utils/windowSizing';
import type { IndexedImage } from '../types';

/**
 * The size the main window pre-shapes a viewer to, before the window is shown.
 *
 * It has to agree with what the viewer itself will ask for, or the window opens
 * at one size and is resized to another a moment later — the two-step the whole
 * compact mode is built to avoid. The panel is the part that has to be reasoned
 * about twice, because the open-hint and the viewer reach it by different
 * routes: the hint reads storage, the viewer reads its own state, and both have
 * to land on the same number.
 *
 * Exported for these tests rather than exercised through the hook: reaching it
 * through a rendered grid would cost a full harness to assert four values that
 * are a pure function of storage.
 */

const WORK_AREA = 1000;

/** The panel's width at the default share, against the work area. */
const PANEL = compactSidebarWidth(WORK_AREA, DEFAULT_SIDEBAR_SHARE);

const image = (overrides: Partial<IndexedImage> = {}): IndexedImage =>
  ({
    id: 'dir::test.png',
    name: 'test.png',
    metadata: {},
    metadataString: '',
    lastModified: Date.now(),
    models: [],
    loras: [],
    scheduler: '',
    dimensions: '400x300',
    ...overrides,
  }) as IndexedImage;

const seed = (key: string, value: string) =>
  (global.localStorage as any).__store.set(key, value);

beforeEach(() => {
  (global.localStorage as any).__store.clear();
  // jsdom reports 0 for the screen's work-area fields, which would fall back to
  // window.innerWidth — pin both so the expected numbers are the ones written
  // here rather than whatever the fallback happens to be.
  Object.defineProperty(window.screen, 'availWidth', {
    value: WORK_AREA,
    configurable: true,
  });
  Object.defineProperty(window.screen, 'availHeight', {
    value: WORK_AREA,
    configurable: true,
  });
  Object.defineProperty(window, 'innerWidth', { value: WORK_AREA, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: WORK_AREA, configurable: true });
});

describe('the open-hint that pre-sizes a viewer window', () => {
  it('says nothing at all outside compact mode', () => {
    // The common case, and the one that must stay free: the payload is handed
    // to every viewer the app opens, so a hint that spoke up here would reshape
    // the ordinary viewer window for everyone.
    seed(COMPACT_PANEL_STORAGE_KEY, 'true');

    expect(compactOpenHint(image())).toEqual({});
  });

  it('marks the window compact without a size it cannot compute', () => {
    // A file whose dimensions the indexer could not read. The window still has
    // to open in the mode — the viewer would otherwise start as an ordinary one
    // and have to be corrected — it just opens at the default size and lets the
    // renderer apply the fit once it has the decoded bitmap.
    seed(COMPACT_MODE_STORAGE_KEY, 'true');

    const hint = compactOpenHint(image({ dimensions: undefined }));

    expect(hint).toEqual({ compact: true });
  });

  it('reserves nothing for a panel the user never docked', () => {
    // The state a user who has not touched the panel is in, and the one that
    // must not grow a window: absent means "never asked", not "ask by default".
    seed(COMPACT_MODE_STORAGE_KEY, 'true');

    expect(compactOpenHint(image())).toEqual({
      compact: true,
      compactContentWidth: 400 + 16,
      compactContentHeight: 348,
    });
  });

  it('reserves the panel it is going to be shown with', () => {
    // The reason the hint exists at all: the window opens *with* the panel
    // rather than widening to hold it a moment after the user sees it.
    seed(COMPACT_MODE_STORAGE_KEY, 'true');
    seed(COMPACT_PANEL_STORAGE_KEY, 'true');

    expect(compactOpenHint(image())).toEqual({
      compact: true,
      compactContentWidth: 400 + 16 + PANEL,
      compactContentHeight: 348,
    });
  });

  it('reserves the share that was dragged, not the default one', () => {
    // Read through the same clamp the viewer's own init uses, so a share the
    // user set is the share the window is shaped around before the viewer has
    // had a chance to say anything. Seeded at the ceiling — a share dragged as
    // far as it goes — read symbolically rather than as a literal, because the
    // point is only that it differs from the default: a literal goes stale the
    // next time a bound moves and silently collapses this into the test above.
    seed(COMPACT_MODE_STORAGE_KEY, 'true');
    seed(COMPACT_PANEL_STORAGE_KEY, 'true');
    seed(SIDEBAR_SHARE_STORAGE_KEY, String(MAX_SIDEBAR_SHARE));

    const panel = compactSidebarWidth(WORK_AREA, MAX_SIDEBAR_SHARE);
    // Without this, a ceiling that converged on the default would leave both
    // assertions above true while testing nothing.
    expect(panel).not.toBe(PANEL);
    expect(compactOpenHint(image()).compactContentWidth).toBe(400 + 16 + panel);
  });

  it('reads a corrupt share as one that was never chosen', () => {
    // The same reading the viewer takes, so the pre-size and the viewer agree
    // rather than the window opening at one width and settling at another.
    seed(COMPACT_MODE_STORAGE_KEY, 'true');
    seed(COMPACT_PANEL_STORAGE_KEY, 'true');
    seed(SIDEBAR_SHARE_STORAGE_KEY, 'not-a-number');

    expect(
      compactSidebarWidth(
        WORK_AREA,
        clampSidebarShare(Number('not-a-number')),
      ),
    ).toBe(PANEL);
    expect(compactOpenHint(image()).compactContentWidth).toBe(400 + 16 + PANEL);
  });

  it('carries the remembered scale into the size it asks for', () => {
    // The reduction from a hand-drag is applied before the window is shown, for
    // the same reason the panel is: the size is settled before there is anything
    // on screen to watch move.
    //
    // Asserted against the rule rather than against numbers, because what this
    // pins is the *call*: `computeCompactContentSize` now takes seven positional
    // arguments from here, and two of them are numbers that would be silently
    // plausible if they were swapped — the window would simply be shaped to the
    // wrong size, with nothing failing.
    seed(COMPACT_MODE_STORAGE_KEY, 'true');
    seed(COMPACT_PANEL_STORAGE_KEY, 'true');
    seed(COMPACT_SCALE_STORAGE_KEY, '0.5');
    seed(SIDEBAR_SHARE_STORAGE_KEY, String(MAX_SIDEBAR_SHARE));

    const reserved = compactSidebarWidth(WORK_AREA, MAX_SIDEBAR_SHARE);
    const rule = computeCompactContentSize(
      400,
      300,
      WORK_AREA,
      WORK_AREA,
      0.5,
      1,
      reserved,
    )!;

    const hint = compactOpenHint(image());

    expect(hint.compactContentWidth).toBe(rule.contentWidth);
    expect(hint.compactContentHeight).toBe(rule.contentHeight);
  });

  it('sizes the window to the reduction, for a file with room to be reduced', () => {
    // The complement of the assertion above, on a picture larger than the
    // display: a reduction below 1 is a share of the *screen*, so it is here —
    // where the fit is what fills the work area — that it changes the window.
    // A small file is already narrower than either size, so its reduction is
    // spent on background rather than on the frame, and the two are equal.
    seed(COMPACT_MODE_STORAGE_KEY, 'true');
    seed(COMPACT_PANEL_STORAGE_KEY, 'true');

    seed(COMPACT_SCALE_STORAGE_KEY, '1');
    const full = compactOpenHint(image({ dimensions: '2000x1500' }));

    seed(COMPACT_SCALE_STORAGE_KEY, '0.5');
    const reduced = compactOpenHint(image({ dimensions: '2000x1500' }));

    expect(reduced.compactContentWidth!).toBeLessThan(full.compactContentWidth!);
    expect(reduced.compactContentHeight!).toBeLessThan(full.compactContentHeight!);
  });
});
