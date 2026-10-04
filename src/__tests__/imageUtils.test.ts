import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { copyImageToClipboard, getAspectRatio } from '../utils/imageUtils';

// jsdom has no canvas backing store, real bitmap decoding, or clipboard —
// stub the pieces copyImageToClipboard depends on and assert on what is
// handed to navigator.clipboard.write.

class FakeClipboardItem {
  items: Record<string, Blob>;
  constructor(items: Record<string, Blob>) {
    this.items = items;
  }
}

const makeImage = (name: string, type: string, content = 'image-data') => {
  const file = new File([content], name, { type });
  return {
    handle: { getFile: vi.fn().mockResolvedValue(file) },
  } as any;
};

describe('copyImageToClipboard', () => {
  let writtenItems: FakeClipboardItem[];
  let writeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writtenItems = [];

    // Canvas: fake 2D context + toBlob producing a PNG blob
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: vi.fn().mockReturnValue({ drawImage: vi.fn() }),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value: vi.fn((callback: (blob: Blob | null) => void) => {
        callback(new Blob(['png-bytes'], { type: 'image/png' }));
      }),
    });

    // Bitmap decoding: fake dimensions
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ width: 10, height: 10 }));

    // Clipboard write: capture the items instead of touching a real clipboard
    writeMock = vi.fn(async (items: FakeClipboardItem[]) => {
      writtenItems = items;
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: writeMock },
    });

    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('re-encodes JPEG files to PNG before writing (Chromium rejects image/jpeg)', async () => {
    const result = await copyImageToClipboard(makeImage('photo.jpg', 'image/jpeg'));

    expect(result.success).toBe(true);
    expect(writtenItems).toHaveLength(1);
    expect(Object.keys(writtenItems[0].items)).toEqual(['image/png']);
    expect(writeMock).toHaveBeenCalledTimes(1);
  });

  it('writes PNG files directly without re-encoding', async () => {
    const result = await copyImageToClipboard(makeImage('render.png', 'image/png'));

    expect(result.success).toBe(true);
    expect(Object.keys(writtenItems[0].items)).toEqual(['image/png']);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('writes WebP files directly (supported on write in Chromium)', async () => {
    const result = await copyImageToClipboard(makeImage('render.webp', 'image/webp'));

    expect(result.success).toBe(true);
    expect(Object.keys(writtenItems[0].items)).toEqual(['image/webp']);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('refuses non-image files with a clear error', async () => {
    const result = await copyImageToClipboard(makeImage('clip.mp4', 'video/mp4'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Only image files');
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('reports clipboard write failures', async () => {
    writeMock.mockRejectedValueOnce(new Error('Type Image/jpeg not supported on write'));
    const result = await copyImageToClipboard(makeImage('photo.jpg', 'image/jpeg'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('not supported on write');
  });
});

describe('getAspectRatio', () => {
  it('snaps near-misses to the ratio people actually name', () => {
    // 2252×4000 reduces exactly to 563:1000, which says nothing to anyone —
    // it is 0.09% off 9:16, so that is the answer given.
    expect(getAspectRatio(2252, 4000)).toBe('9:16');
    expect(getAspectRatio(4000, 2252)).toBe('16:9');
    expect(getAspectRatio(1920, 1080)).toBe('16:9');
    expect(getAspectRatio(1536, 1024)).toBe('3:2');
    expect(getAspectRatio(1024, 1024)).toBe('1:1');
    // 960×1176 reduces to 40:49 — 2.04% off 4:5, and 9:11 (the closest small
    // fraction) is not a name anyone uses, so the named list decides: 4:5.
    expect(getAspectRatio(960, 1176)).toBe('4:5');
    expect(getAspectRatio(1176, 960)).toBe('5:4');
    // 1344×768 is 1.56% off 16:9 — inside the window, so it gets the name.
    expect(getAspectRatio(1344, 768)).toBe('16:9');
  });

  it('keeps the exact reduced ratio when nothing named is close', () => {
    // 896×1152 is an SDXL bucket (7:9) that misses 4:5 by 2.78% — just
    // outside the window — so its bucket name survives.
    expect(getAspectRatio(896, 1152)).toBe('7:9');
    expect(getAspectRatio(4000, 1000)).toBe('4:1');
  });

  it('returns null for missing or invalid dimensions', () => {
    expect(getAspectRatio(undefined, 100)).toBeNull();
    expect(getAspectRatio(100, undefined)).toBeNull();
    expect(getAspectRatio(0, 0)).toBeNull();
    expect(getAspectRatio(NaN, 100)).toBeNull();
  });
});
