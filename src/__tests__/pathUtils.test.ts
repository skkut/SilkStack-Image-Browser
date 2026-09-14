import { describe, expect, it } from 'vitest';
import { getImageAbsolutePath, isAbsolutePath, quotePathForClipboard } from '../utils/pathUtils';

/**
 * `getImageAbsolutePath` feeds the context menu's Copy Image Path / Show in
 * Folder / Open in Native Viewer actions, so these cases pin down the three id
 * shapes the app has produced over time (see DevSemanticSearchTester's
 * `filePathFromImageId`) plus the casing guarantee that made `normalizePath`
 * unusable here.
 */
describe('getImageAbsolutePath', () => {
  it('returns empty string for a missing image', () => {
    expect(getImageAbsolutePath(null)).toBe('');
    expect(getImageAbsolutePath(undefined)).toBe('');
  });

  it('prefers the handle path over reconstructing from id and directory', () => {
    expect(
      getImageAbsolutePath(
        {
          id: 'dirId::cat.webp',
          name: 'cat.webp',
          handle: { _filePath: 'C:\\Real\\Location\\cat.webp' },
        },
        'C:\\Wrong\\Guess'
      )
    ).toBe('C:\\Real\\Location\\cat.webp');
  });

  it('ignores a handle whose _filePath is not a usable string', () => {
    expect(
      getImageAbsolutePath(
        { id: 'dirId::cat.webp', name: 'cat.webp', handle: { _filePath: 42 } },
        'C:\\Pics'
      )
    ).toBe('C:\\Pics\\cat.webp');
    expect(
      getImageAbsolutePath(
        { id: 'dirId::cat.webp', name: 'cat.webp', handle: { _filePath: '' } },
        'C:\\Pics'
      )
    ).toBe('C:\\Pics\\cat.webp');
    expect(
      getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp', handle: null }, 'C:\\Pics')
    ).toBe('C:\\Pics\\cat.webp');
  });

  it('joins the id path segment onto the directory with backslashes', () => {
    expect(
      getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp' }, 'C:\\Pics')
    ).toBe('C:\\Pics\\cat.webp');
  });

  it('resolves an image in a scanned subfolder into that subfolder', () => {
    // The old `${directoryPath}/${image.name}` construction dropped the
    // subfolder entirely when `name` held only the basename.
    expect(
      getImageAbsolutePath({ id: 'dirId::2026-09\\cat.webp', name: 'cat.webp' }, 'C:\\Pics')
    ).toBe('C:\\Pics\\2026-09\\cat.webp');
  });

  it('normalizes forward slashes in the relative part to the base separator', () => {
    expect(
      getImageAbsolutePath({ id: 'dirId::2026-09/cat.webp', name: 'cat.webp' }, 'C:\\Pics')
    ).toBe('C:\\Pics\\2026-09\\cat.webp');
  });

  it('preserves the original casing of directory and file name', () => {
    expect(
      getImageAbsolutePath({ id: 'dirId::Cat.WebP', name: 'Cat.WebP' }, 'C:\\Users\\Ksara\\Pics')
    ).toBe('C:\\Users\\Ksara\\Pics\\Cat.WebP');
  });

  it('joins with forward slashes when the directory uses them', () => {
    expect(
      getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp' }, '/home/ksara/pics')
    ).toBe('/home/ksara/pics/cat.webp');
  });

  it('does not double the separator on a directory with a trailing slash', () => {
    expect(
      getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp' }, 'C:\\Pics\\')
    ).toBe('C:\\Pics\\cat.webp');
  });

  it('joins onto a filesystem root without dropping the root', () => {
    expect(getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp' }, '/')).toBe(
      '/cat.webp'
    );
  });

  it('returns an already-absolute id segment as-is (current indexer shape)', () => {
    expect(getImageAbsolutePath({ id: 'dirId::H:\\Images\\cat.webp' }, 'C:\\Ignored')).toBe(
      'H:\\Images\\cat.webp'
    );
  });

  it('returns a UNC id segment as-is', () => {
    expect(
      getImageAbsolutePath({ id: 'dirId::\\\\server\\share\\cat.webp' }, 'C:\\Ignored')
    ).toBe('\\\\server\\share\\cat.webp');
  });

  it('treats a bare id with no separator as the path (legacy shape)', () => {
    expect(getImageAbsolutePath({ id: 'H:\\Images\\cat.webp' }, 'C:\\Ignored')).toBe(
      'H:\\Images\\cat.webp'
    );
    expect(getImageAbsolutePath({ id: '2026-09/cat.webp' }, 'C:\\Pics')).toBe(
      'C:\\Pics\\2026-09\\cat.webp'
    );
  });

  it('falls back to the name when the id carries no path segment', () => {
    expect(getImageAbsolutePath({ id: 'dirId::', name: 'cat.webp' }, 'C:\\Pics')).toBe(
      'C:\\Pics\\cat.webp'
    );
    expect(getImageAbsolutePath({ name: 'cat.webp' }, 'C:\\Pics')).toBe('C:\\Pics\\cat.webp');
  });

  it('returns the relative path rather than throwing when no directory is known', () => {
    expect(getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp' })).toBe('cat.webp');
    expect(getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp' }, null)).toBe(
      'cat.webp'
    );
    expect(getImageAbsolutePath({ id: 'dirId::cat.webp', name: 'cat.webp' }, '')).toBe('cat.webp');
  });

  it('returns empty string when nothing at all identifies the file', () => {
    expect(getImageAbsolutePath({})).toBe('');
    expect(getImageAbsolutePath({}, 'C:\\Pics')).toBe('');
  });
});

describe('isAbsolutePath', () => {
  it('recognizes drive letters, UNC shares and POSIX roots', () => {
    expect(isAbsolutePath('C:\\Pics\\cat.webp')).toBe(true);
    expect(isAbsolutePath('c:/pics/cat.webp')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share\\cat.webp')).toBe(true);
    expect(isAbsolutePath('/home/ksara/cat.webp')).toBe(true);
  });

  it('rejects relative paths and empty values', () => {
    expect(isAbsolutePath('cat.webp')).toBe(false);
    expect(isAbsolutePath('2026-09/cat.webp')).toBe(false);
    expect(isAbsolutePath('')).toBe(false);
  });
});

describe('quotePathForClipboard', () => {
  it('encloses the path in double quotes, as Windows "Copy as path" does', () => {
    expect(quotePathForClipboard('C:\\Pics\\cat.webp')).toBe('"C:\\Pics\\cat.webp"');
  });

  it('keeps a path containing spaces as a single pasteable token', () => {
    expect(quotePathForClipboard('C:\\My Pictures\\cat.webp')).toBe('"C:\\My Pictures\\cat.webp"');
  });

  it('quotes the end-to-end result of resolving an image', () => {
    expect(
      quotePathForClipboard(
        getImageAbsolutePath({ id: 'dirId::2026-09/cat.webp', name: 'cat.webp' }, 'C:\\My Pics')
      )
    ).toBe('"C:\\My Pics\\2026-09\\cat.webp"');
  });
});
