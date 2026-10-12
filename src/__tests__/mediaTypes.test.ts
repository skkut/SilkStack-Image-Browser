// Media-type detection and MIME resolution — the shared helpers the grids, the
// hover preview and the modal all key off.
import { describe, it, expect } from 'vitest';
import {
  isVideoFileName,
  isGifFileName,
  isAnimatedMedia,
  resolveMediaMimeType,
} from '../utils/mediaTypes';

describe('isVideoFileName', () => {
  it('recognises every indexed video container', () => {
    for (const ext of ['.mp4', '.webm', '.mkv', '.mov', '.avi']) {
      expect(isVideoFileName(`clip${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isVideoFileName('CLIP.MP4')).toBe(true);
  });

  it('trusts a video MIME type over the extension', () => {
    // Records written by the indexer carry a real type; a mislabelled name
    // must not hide a video.
    expect(isVideoFileName('clip.bin', 'video/mp4')).toBe(true);
  });

  it('rejects still images, GIFs and missing names', () => {
    expect(isVideoFileName('photo.png')).toBe(false);
    expect(isVideoFileName('anim.gif')).toBe(false);
    expect(isVideoFileName(null)).toBe(false);
    expect(isVideoFileName(undefined, 'image/png')).toBe(false);
  });
});

describe('isGifFileName', () => {
  it('detects GIFs by extension and by type', () => {
    expect(isGifFileName('anim.gif')).toBe(true);
    expect(isGifFileName('anim.GIF')).toBe(true);
    expect(isGifFileName('mystery.bin', 'image/gif')).toBe(true);
  });

  it('rejects other images', () => {
    expect(isGifFileName('photo.png')).toBe(false);
    expect(isGifFileName(null)).toBe(false);
  });
});

describe('isAnimatedMedia', () => {
  it('covers videos and GIFs, and nothing else', () => {
    expect(isAnimatedMedia('clip.mp4')).toBe(true);
    expect(isAnimatedMedia('anim.gif')).toBe(true);
    expect(isAnimatedMedia('photo.webp')).toBe(false);
    expect(isAnimatedMedia('photo.png', 'image/png')).toBe(false);
  });
});

describe('resolveMediaMimeType', () => {
  it('maps each video container to its MIME type', () => {
    // This is what lets <video> pick the right demuxer for bytes that arrived
    // from the Electron handle mislabelled as image/jpeg.
    expect(resolveMediaMimeType('a.mp4')).toBe('video/mp4');
    expect(resolveMediaMimeType('a.webm')).toBe('video/webm');
    expect(resolveMediaMimeType('a.mkv')).toBe('video/x-matroska');
    expect(resolveMediaMimeType('a.mov')).toBe('video/quicktime');
    expect(resolveMediaMimeType('a.avi')).toBe('video/x-msvideo');
  });

  it('maps image types, and keeps the existing png fallback', () => {
    expect(resolveMediaMimeType('a.gif')).toBe('image/gif');
    expect(resolveMediaMimeType('a.jpeg')).toBe('image/jpeg');
    expect(resolveMediaMimeType('a.webp')).toBe('image/webp');
    expect(resolveMediaMimeType('a.png')).toBe('image/png');
    expect(resolveMediaMimeType('a.unknown')).toBe('image/png');
    expect(resolveMediaMimeType(null)).toBe('image/png');
  });
});
