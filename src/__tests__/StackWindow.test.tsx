import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.hoisted(() => {
  // The settings/image stores read localStorage at module load.
  global.localStorage = {
    getItem: vi.fn().mockReturnValue('true'),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(),
  } as any;
});

import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import StackWindow from '../components/StackWindow';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';
import type { LicenseStatus } from '../services/licenseService';
import type { StackWindowPayload } from '../types';

/**
 * The popped-out stack window's own logic.
 *
 * This renderer has an EMPTY image store, so almost everything it does is a
 * deliberate departure from the in-app drill-down: it waits for a payload over
 * a handshake instead of reading the store, it keeps favourites locally while
 * forwarding the write to the window that owns the library, and it reads
 * thumbnails from the on-disk cache rather than the store-bound thumbnail
 * manager. Each of those is asserted below.
 *
 * The package view is mocked, as elsewhere in this suite — the real one needs
 * the ai-intelligence build, and what is under test here is the props and IPC
 * this component feeds it.
 */

/** See SmartLibrary.test.tsx — the stamp is a hash over (key, status, time). */
const validLicense = (): {
  licenseStatus: LicenseStatus;
  licenseKey: string;
  licenseLastValidated: number;
  licenseStamp: string;
} => {
  const now = Date.now();
  return {
    licenseStatus: 'valid',
    licenseKey: 'TEST-KEY',
    licenseLastValidated: now,
    licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', now),
  };
};

vi.mock('@ai-images-browser/ai-intelligence', () => ({
  // The real view drops its two leave-this-view buttons when it is the whole
  // content of a window, and this window always is one — so the mock mirrors
  // that, which is what makes `data-standalone` an assertion about the flag
  // this component passes rather than about the mock's own rendering.
  SimilarityStackExpandedView: ({ images, onBack, isStandaloneWindow, onToggleFavorite, onToggleSelection }: any) => (
    <div data-testid="stack-view" data-standalone={String(!!isStandaloneWindow)}>
      {!isStandaloneWindow && (
        <button onClick={onBack} type="button">
          Back
        </button>
      )}
      {images.map((img: any) => (
        <div
          key={img.id}
          data-testid={`card-${img.id}`}
          data-thumbnail={img.thumbnailUrl ?? ''}
          data-status={img.thumbnailStatus ?? ''}
        >
          <span>{img.isFavorite ? 'starred' : 'unstarred'}</span>
          <button onClick={() => onToggleFavorite(img.id)} type="button">
            {`fav-${img.id}`}
          </button>
          <button onClick={() => onToggleSelection(img.id)} type="button">
            {`sel-${img.id}`}
          </button>
        </div>
      ))}
    </div>
  ),
}));

// The fallback's CHOICE is what this component decides, so the marker keeps it
// distinct from the blob URL of a cache hit — but the marker wraps the REAL
// path resolution (`getImageAbsolutePath`, unmocked) rather than replacing it.
// That is the point: which of the two path sources the rebuilt handle can
// actually reach is the question these tests exist to answer, and a mock that
// returned `image.name` would answer it by assumption.
vi.mock('../utils/mediaUrl', async () => {
  const { getImageAbsolutePath, isAbsolutePath } = await vi.importActual<any>('../utils/pathUtils');
  return {
    getImageMediaUrl: (image: any, directoryPath?: string | null) => {
      const resolved = getImageAbsolutePath(image, directoryPath);
      // The real builder refuses a relative path rather than letting the
      // protocol resolve it against the MAIN process's cwd (see `toMediaUrl`),
      // and the mock keeps that gate: without it every path would look
      // resolvable and the fallback tests would assert nothing.
      return isAbsolutePath(resolved) ? `media://${resolved}` : null;
    },
  };
});

const payloadImage = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `dir-1::img-${n}.png`,
  name: `img-${n}.png`,
  directoryId: 'dir-1',
  fileType: 'image/png',
  metadata: {},
  metadataString: '',
  lastModified: 1700000000000 + n,
  models: [],
  loras: [],
  scheduler: '',
  dimensions: '512x512',
  isFavorite: false,
  ...overrides,
});

const PAYLOAD: StackWindowPayload = {
  groupKey: 'group-9',
  basePrompt: 'a blue cat',
  imageList: [payloadImage(1), payloadImage(2)] as any,
  directoryPaths: { 'dir-1': 'C:\\Images' },
};

let deliver: ((payload: StackWindowPayload) => void) | null;
let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  deliver = null;
  api = {
    stackWindowReady: vi.fn(),
    stackWindowClose: vi.fn(),
    stackWindowAction: vi.fn(),
    openImageViewer: vi.fn().mockResolvedValue({ success: true }),
    getThumbnail: vi.fn().mockResolvedValue({ success: false }),
    onStackWindowUpdate: vi.fn((cb: (p: StackWindowPayload) => void) => {
      deliver = cb;
      return () => {};
    }),
    // The window follows the OS theme, same as the viewer window.
    getTheme: vi.fn().mockResolvedValue({ shouldUseDarkColors: true }),
    onThemeUpdated: vi.fn(() => () => {}),
  };
  (window as any).electronAPI = api;

  // A licensed install: the stack view itself is gated on AI features.
  useSettingsStore.setState(validLicense());

  // jsdom has no object-URL support, and creating one is how this component
  // turns cached bytes into something an <img> can use.
  (URL as any).createObjectURL = vi.fn(() => 'blob:stack-thumb');
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  delete (window as any).electronAPI;
});

/** Mount, then hand the window its payload the way main does. */
const mountWithPayload = async (payload: StackWindowPayload = PAYLOAD) => {
  render(<StackWindow />);
  await waitFor(() => expect(api.onStackWindowUpdate).toHaveBeenCalled());
  await act(async () => {
    deliver?.(payload);
  });
};

describe('the popped-out stack window', () => {
  it('announces itself, then waits for the payload', async () => {
    // The handshake only works in this order: the window tells main it is
    // listening, and main replies. Announcing before the listener exists would
    // drop the reply on the floor and leave the window loading forever.
    render(<StackWindow />);

    expect(screen.getByText('Loading stack…')).toBeTruthy();
    await waitFor(() => expect(api.stackWindowReady).toHaveBeenCalledTimes(1));
  });

  it('renders the stack from the payload it is handed', async () => {
    await mountWithPayload();

    expect(screen.queryByText('Loading stack…')).toBeNull();
    expect(screen.getByText('a blue cat')).toBeTruthy();
    expect(screen.getByText('2 images')).toBeTruthy();
    expect(screen.getByTestId('card-dir-1::img-1.png')).toBeTruthy();
  });

  it('follows the stack as the main window refreshes it', async () => {
    // A popped-out stack is live: `useStackWindowSync` re-resolves the group
    // in the main window and sends a new payload whenever the library changes.
    // The window must replace its image list rather than keep the snapshot it
    // opened with.
    await mountWithPayload();

    await act(async () => {
      deliver?.({
        ...PAYLOAD,
        imageList: [payloadImage(1), payloadImage(2), payloadImage(3)] as any,
      });
    });

    expect(screen.getByText('3 images')).toBeTruthy();
    expect(screen.getByTestId('card-dir-1::img-3.png')).toBeTruthy();
  });

  it('drops images that left the stack', async () => {
    await mountWithPayload();

    await act(async () => {
      deliver?.({ ...PAYLOAD, imageList: [payloadImage(2)] as any });
    });

    expect(screen.getByText('1 image')).toBeTruthy();
    expect(screen.queryByTestId('card-dir-1::img-1.png')).toBeNull();
    expect(screen.getByTestId('card-dir-1::img-2.png')).toBeTruthy();
  });

  it('reuses a thumbnail it already resolved when a newcomer arrives', async () => {
    // Re-resolving every member on each refresh would mean a cache read and a
    // fresh blob URL per image for a stack that may hold dozens — the refresh
    // only has to look up the images it has not drawn yet.
    api.getThumbnail.mockResolvedValue({
      success: true,
      data: new Uint8Array([1, 2, 3]).buffer,
    });

    await mountWithPayload();
    await waitFor(() =>
      expect(screen.getByTestId('card-dir-1::img-2.png').getAttribute('data-status')).toBe('ready'),
    );
    api.getThumbnail.mockClear();

    await act(async () => {
      deliver?.({
        ...PAYLOAD,
        imageList: [payloadImage(1), payloadImage(2), payloadImage(3)] as any,
      });
    });

    expect(api.getThumbnail).toHaveBeenCalledTimes(1);
    expect(api.getThumbnail).toHaveBeenCalledWith('dir-1::img-3.png-1700000000003');
    // The retained cards still hold the URLs they resolved with.
    expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-thumbnail')).toBe(
      'blob:stack-thumb',
    );
    expect(screen.getByTestId('card-dir-1::img-2.png').getAttribute('data-thumbnail')).toBe(
      'blob:stack-thumb',
    );
  });

  it('says the stack is empty when every image is gone, instead of spinning', async () => {
    // The group dissolved or its files were deleted. An empty image list is a
    // completed answer, not a missing one — only `payload === null` means the
    // handshake has not finished.
    await mountWithPayload();

    await act(async () => {
      deliver?.({ ...PAYLOAD, imageList: [] });
    });

    expect(screen.getByText('This stack is empty')).toBeTruthy();
    expect(screen.queryByText('Loading stack…')).toBeNull();
  });

  it('reconstructs the images with a handle the view can render', async () => {
    // The whole image list arrives without handles (they cannot cross IPC), and
    // the cards read `image.handle` for their preview paths — so the rebuild is
    // load-bearing, not decoration.
    await mountWithPayload();

    const card = screen.getByTestId('card-dir-1::img-2.png');
    expect(card.textContent).toContain('img-2.png');
  });

  it('forwards a favourite to the window that owns the library', async () => {
    // The local flip is what makes the star feel instant; the forward is what
    // makes it survive, because this renderer's store holds no images at all
    // and could never write the annotation itself.
    await mountWithPayload();

    await act(async () => {
      screen.getByText('fav-dir-1::img-1.png').click();
    });

    expect(api.stackWindowAction).toHaveBeenCalledWith({
      type: 'toggleFavorite',
      imageId: 'dir-1::img-1.png',
    });
    expect(screen.getByTestId('card-dir-1::img-1.png').textContent).toContain('starred');
    // …and the other member is untouched.
    expect(screen.getByTestId('card-dir-1::img-2.png').textContent).toContain('unstarred');
  });

  it('keeps selection local — there is no library to select into', async () => {
    await mountWithPayload();

    await act(async () => {
      screen.getByText('sel-dir-1::img-1.png').click();
    });

    // Selection is view state; nothing is forwarded, so nothing can leak a
    // selection into the main window's store.
    expect(api.stackWindowAction).not.toHaveBeenCalled();
  });

  it('tells the stack view it is a window of its own', async () => {
    // That flag is what removes the view's Library button and close X: this
    // window has no library behind it to go back to, so both would be lies.
    await mountWithPayload();

    expect(screen.getByTestId('stack-view').getAttribute('data-standalone')).toBe('true');
    expect(screen.queryByText('Back')).toBeNull();
  });

  it('closes on Escape, through the main process', async () => {
    // Same close path the view's own buttons use — Escape is now the window's
    // primary in-app exit, the buttons having been removed as meaningless here.
    await mountWithPayload();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(api.stackWindowClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape even before the payload arrives', async () => {
    // The payload is asked for exactly once, on mount, so a handshake that
    // never completes leaves the spinner up forever. Escape is the one exit
    // that does not depend on that reply, which is why the listener is
    // registered by the component rather than by the stack view inside it.
    render(<StackWindow />);
    expect(screen.getByText('Loading stack…')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    expect(api.stackWindowClose).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape to a text field that has focus', async () => {
    await mountWithPayload();

    const field = document.createElement('input');
    field.type = 'text';
    document.body.appendChild(field);
    field.focus();

    await act(async () => {
      fireEvent.keyDown(field, { key: 'Escape' });
    });
    field.remove();

    expect(api.stackWindowClose).not.toHaveBeenCalled();
  });

  it('still closes when a grouping checkbox has focus', async () => {
    // A checkbox is an <input> too, but Escape is not its to consume — and the
    // header's Group-by toolbar is nothing but checkboxes, so a blanket INPUT
    // guard would disable the shortcut for anyone who had just clicked one.
    await mountWithPayload();

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    document.body.appendChild(toggle);
    toggle.focus();

    await act(async () => {
      fireEvent.keyDown(toggle, { key: 'Escape' });
    });
    toggle.remove();

    expect(api.stackWindowClose).toHaveBeenCalledTimes(1);
  });

  it('answers a cached thumbnail with a blob URL', async () => {
    api.getThumbnail.mockResolvedValue({
      success: true,
      data: new Uint8Array([1, 2, 3]).buffer,
    });

    await mountWithPayload();

    // BOTH assertions matter, and the second is the one that was missing when
    // this window shipped broken: the card draws an <img> only for `ready`
    // plus a URL, so a URL arriving without its status spins forever. Asserting
    // the URL alone tests this component's own convention rather than the
    // contract the card actually reads.
    await waitFor(() =>
      expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-thumbnail')).toBe(
        'blob:stack-thumb',
      ),
    );
    expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-status')).toBe('ready');
    // Read through the key the main window's own manager caches under.
    expect(api.getThumbnail).toHaveBeenCalledWith('dir-1::img-1.png-1700000000001');
  });

  it('falls back to the file itself when the cache has no thumbnail', async () => {
    // A cache MISS is the ordinary case the window was failing on, not an edge
    // case: the cache only holds thumbnails the main window has already had
    // reason to generate. The empty `data` here is the shape the handler
    // actually returns for a miss (`{success: true, data: null}`), not a
    // failure — the two are easy to conflate and only one of them means "no
    // thumbnail yet".
    api.getThumbnail.mockResolvedValue({ success: true, data: null });

    await mountWithPayload();

    await waitFor(() =>
      expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-thumbnail')).toBe(
        'media://C:\\Images\\img-1.png',
      ),
    );
    expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-status')).toBe('ready');
  });

  it('resolves that fallback from the file path the payload carries', async () => {
    // The directory map is a convenience, not a guarantee: an image whose
    // `directoryId` is missing from it has no base to join its relative id
    // onto. The handle's `_filePath` is the app's first-choice source (see
    // `getImageAbsolutePath`) and the only one that needs no lookup at all, so
    // it is carried across IPC explicitly — `handle` itself cannot be.
    api.getThumbnail.mockResolvedValue({ success: true, data: null });

    await mountWithPayload({
      ...PAYLOAD,
      // Deliberately empty: nothing here can resolve without the handle path.
      directoryPaths: {},
      imageList: [payloadImage(1, { handlePath: 'C:\\Elsewhere\\img-1.png' })] as any,
    });

    await waitFor(() =>
      expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-thumbnail')).toBe(
        'media://C:\\Elsewhere\\img-1.png',
      ),
    );
  });

  it('ignores a thumbnail URL inherited from the main window', async () => {
    // The payload is serialized from the main window's store, where a blob URL
    // for this very image may already exist — and a blob URL is scoped to the
    // renderer that minted it. Inheriting one would leave the card pointing at
    // a URL that cannot resolve in this window, and `ready` would make the card
    // draw it rather than recover.
    api.getThumbnail.mockResolvedValue({ success: true, data: null });

    await mountWithPayload({
      ...PAYLOAD,
      imageList: [
        payloadImage(1, { thumbnailUrl: 'blob:from-the-main-window', thumbnailStatus: 'ready' }),
      ] as any,
    });

    await waitFor(() =>
      expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-thumbnail')).toBe(
        'media://C:\\Images\\img-1.png',
      ),
    );
    expect(
      screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-thumbnail'),
    ).not.toBe('blob:from-the-main-window');
  });

  it('settles on an error when nothing can be resolved at all', async () => {
    // A still with no cached thumbnail, no handle path and no directory to join
    // its relative id onto — the state an image is in when its folder has been
    // removed from the library. The card has no error branch of its own, so
    // this cannot make it draw anything; what it must not do is leave the image
    // claiming to still be loading, which is indistinguishable from a slow disk
    // and hides the fact that nothing is coming.
    api.getThumbnail.mockResolvedValue({ success: true, data: null });

    await mountWithPayload({ ...PAYLOAD, directoryPaths: {}, imageList: [payloadImage(1)] as any });

    await waitFor(() =>
      expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-status')).toBe('error'),
    );
    expect(screen.getByTestId('card-dir-1::img-1.png').getAttribute('data-thumbnail')).toBe('');
  });

  it('does not pretend a video file is an image', async () => {
    // A poster frame has to be decoded; pointing an <img> at an .mp4 would show
    // a broken image rather than the card's own placeholder.
    api.getThumbnail.mockResolvedValue({ success: false });

    await mountWithPayload({
      ...PAYLOAD,
      imageList: [
        payloadImage(1, { id: 'dir-1::clip.mp4', name: 'clip.mp4', fileType: 'video/mp4' }),
      ] as any,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(
      screen.getByTestId('card-dir-1::clip.mp4').getAttribute('data-thumbnail'),
    ).toBe('');
    // `error`, not a lingering `loading`: the card shows its video placeholder
    // either way, but a state that never resolves is a lie about what happened.
    expect(screen.getByTestId('card-dir-1::clip.mp4').getAttribute('data-status')).toBe('error');
  });

  it('says so when the stack view is not available, rather than showing an empty pane', async () => {
    // An unlicensed install: the grid still draws its stack badges from
    // persisted groups, so this window is reachable — and a drag bar over a
    // blank body reads as a broken window.
    useSettingsStore.setState({
      licenseStatus: 'none',
      licenseKey: '',
      licenseLastValidated: 0,
      licenseStamp: '',
    } as any);

    await mountWithPayload();

    expect(screen.getByText('Stack view is not available')).toBeTruthy();
    // The bar above it still carries what the window is.
    expect(screen.getByText('a blue cat')).toBeTruthy();
  });
});
