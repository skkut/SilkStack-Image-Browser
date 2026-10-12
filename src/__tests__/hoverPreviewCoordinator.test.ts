// @vitest-environment jsdom
//
// Hover-preview policy tests. The coordinator is the piece that decides when a
// hover is allowed to cost a full read of the media file, so these pin the
// things that would quietly hurt on a large library: the dwell delay, the
// one-preview-at-a-time rule, the size guard, and the cache bounds.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import {
  hoverPreview,
  HOVER_DWELL_MS,
  MAX_PREVIEW_BYTES,
  CACHE_MAX_ENTRIES,
  CACHE_MAX_BYTES,
} from '../services/hoverPreviewCoordinator';
import { useSettingsStore } from '../store/useSettingsStore';

let objectUrlCount = 0;
const revoked: string[] = [];

/** A file handle stand-in — this is the shape the Electron mock exposes. */
const makeHandle = (name: string, type: string, bytes = 1024) => ({
  name,
  getFile: async () => new File([new Uint8Array(bytes)], name, { type }),
});

const makeSource = (overrides: Record<string, unknown> = {}) => ({
  id: 'dir::clip.mp4',
  name: 'clip.mp4',
  fileType: 'video/mp4',
  fileSize: 1024,
  lastModified: 111,
  handle: makeHandle('clip.mp4', 'image/jpeg'),
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  objectUrlCount = 0;
  revoked.length = 0;
  hoverPreview.clear();
  useSettingsStore.getState().setAutoplayVideoPreviews(true);

  // jsdom implements neither of these.
  (URL as any).createObjectURL = vi.fn(() => `blob:preview-${(objectUrlCount += 1)}`);
  (URL as any).revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  hoverPreview.clear();
  vi.useRealTimers();
});

/** Let the dwell elapse and the load settle. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS + 10);
};

describe('hoverPreview eligibility', () => {
  it('ignores still images — no bytes are read at all', async () => {
    const source = makeSource({ name: 'photo.png', fileType: 'image/png' });
    const session = hoverPreview.activate(source);
    await settle();

    expect(await session.url).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('previews animated GIFs as well as videos', async () => {
    const source = makeSource({
      id: 'dir::anim.gif',
      name: 'anim.gif',
      fileType: 'image/gif',
      handle: makeHandle('anim.gif', 'image/gif'),
    });
    const session = hoverPreview.activate(source);
    await settle();

    expect(await session.url).toBe('blob:preview-1');
  });

  it('is a no-op while the setting is off', async () => {
    useSettingsStore.getState().setAutoplayVideoPreviews(false);

    const session = hoverPreview.activate(makeSource());
    await settle();

    expect(await session.url).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('refuses media above the size guard instead of reading it', async () => {
    const session = hoverPreview.activate(makeSource({ fileSize: MAX_PREVIEW_BYTES + 1 }));
    await settle();

    expect(await session.url).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('needs a readable handle', async () => {
    const session = hoverPreview.activate(makeSource({ handle: undefined }));
    await settle();

    expect(await session.url).toBeNull();
  });
});

describe('hoverPreview dwell and supersession', () => {
  it('reads nothing for a pointer that does not rest on the card', async () => {
    const session = hoverPreview.activate(makeSource());

    // Sweep past: the pointer leaves well before the dwell elapses.
    await vi.advanceTimersByTimeAsync(HOVER_DWELL_MS / 2);
    session.cancel();
    await settle();

    expect(await session.url).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('loads once the pointer rests for the dwell delay', async () => {
    const session = hoverPreview.activate(makeSource());
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    await settle();

    expect(await session.url).toBe('blob:preview-1');
  });

  it('supersedes an in-flight preview when another card is hovered', async () => {
    const first = hoverPreview.activate(makeSource());
    const second = hoverPreview.activate(
      makeSource({ id: 'dir::other.mp4', name: 'other.mp4' }),
    );
    await settle();

    expect(await first.url).toBeNull();
    expect(await second.url).toBe('blob:preview-1');
  });

  it('keeps a cancelled load’s bytes in the cache instead of discarding them', async () => {
    const source = makeSource();
    const session = hoverPreview.activate(source);
    await settle();
    await session.url;

    // Leave, then come back: the second visit must not touch the disk again.
    session.cancel();
    const again = hoverPreview.activate(source);
    expect(await again.url).toBe('blob:preview-1');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});

describe('hoverPreview cache bounds', () => {
  it('evicts the least recently used preview and revokes its URL', async () => {
    const sources = Array.from({ length: CACHE_MAX_ENTRIES + 1 }, (_, i) =>
      makeSource({ id: `dir::clip${i}.mp4`, name: `clip${i}.mp4` }),
    );

    for (const source of sources) {
      const session = hoverPreview.activate(source);
      await settle();
      await session.url;
      session.cancel();
    }

    // The oldest URL is released; the newest is not.
    expect(revoked).toContain('blob:preview-1');
    expect(revoked).not.toContain(`blob:preview-${CACHE_MAX_ENTRIES + 1}`);
  });

  it('never evicts the preview the pointer is currently on', async () => {
    // Fill the cache, keeping each URL so the victims can be identified.
    const sources = Array.from({ length: CACHE_MAX_ENTRIES }, (_, i) =>
      makeSource({ id: `dir::clip${i}.mp4`, name: `clip${i}.mp4` }),
    );
    const urls: string[] = [];
    for (const source of sources) {
      const session = hoverPreview.activate(source);
      await settle();
      urls.push((await session.url) as string);
      session.cancel();
    }

    // Come back to the oldest: it is now both on screen and most recently used.
    const revisit = hoverPreview.activate(sources[0]);
    await settle();
    const onScreen = await revisit.url;
    expect(onScreen).toBe(urls[0]);

    // Push one more preview through. Eviction has to take a different entry —
    // revoking this one would kill the video the pointer is resting on.
    const extra = hoverPreview.activate(makeSource({ id: 'dir::extra.mp4', name: 'extra.mp4' }));
    await settle();
    await extra.url;

    expect(revoked).not.toContain(onScreen);
    expect(revoked).toContain(urls[1]);
  });

  it('still plays a preview too large for the cache to retain', async () => {
    // Between the cache bound and the size guard: it must be shown, not evicted
    // out from under itself. The file is a stand-in rather than real bytes —
    // only `size` and `type` are consulted.
    const oversized = {
      name: 'big.mp4',
      type: 'video/mp4',
      size: CACHE_MAX_BYTES + 1,
    } as unknown as File;

    const session = hoverPreview.activate(
      makeSource({ id: 'dir::big.mp4', name: 'big.mp4', handle: { getFile: async () => oversized } }),
    );
    await settle();

    const url = await session.url;
    expect(url).toBe('blob:preview-1');
    expect(revoked).not.toContain(url);
  });
});

describe('hoverPreview MIME correction', () => {
  it('re-types bytes the Electron handle mislabels as image/jpeg', async () => {
    const session = hoverPreview.activate(makeSource());
    await settle();
    await session.url;

    // The blob handed to the media element must carry a video type, or the
    // demuxer picks the wrong parser for the container.
    const [blob] = (URL.createObjectURL as unknown as { mock: { calls: Blob[][] } }).mock
      .calls[0];
    expect(blob.type).toBe('video/mp4');
  });

  it('leaves a correctly-typed browser File untouched', async () => {
    const file = new File([new Uint8Array(2048)], 'clip.mp4', { type: 'video/mp4' });
    const session = hoverPreview.activate(
      makeSource({ handle: { name: 'clip.mp4', getFile: async () => file } }),
    );
    await settle();
    await session.url;

    const [blob] = (URL.createObjectURL as unknown as { mock: { calls: Blob[][] } }).mock
      .calls[0];
    // Same object, not a re-wrapped copy — a browser File stays disk-backed.
    expect(blob).toBe(file);
  });
});
