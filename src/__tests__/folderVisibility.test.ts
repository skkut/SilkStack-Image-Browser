import { describe, expect, it } from 'vitest';

import {
  createFolderVisibilityPredicate,
  getImageFolderPath,
  type FolderVisibilityContext,
} from '../utils/folderVisibility';
import type { Directory, IndexedImage } from '../types';

/**
 * The one folder rule.
 *
 * `filterAndSort` and both stack-window paths share
 * `createFolderVisibilityPredicate`; these tests pin the semantics it must
 * keep: disconnected drives and hidden folders contribute nothing, an
 * exclusion hides its whole subtree and outranks a selection, and
 * `includeSubfolders` extends a selected folder downward.
 */

const image = (id: string, directoryId = 'dir-1'): IndexedImage =>
  ({
    id,
    name: id.split('::').pop() ?? id,
    directoryId,
    metadata: {},
    metadataString: '',
    lastModified: 1000,
    models: [],
    loras: [],
  }) as IndexedImage;

const dir = (id: string, path: string, overrides: Partial<Directory> = {}): Directory =>
  ({
    id,
    name: id,
    path,
    handle: {} as FileSystemDirectoryHandle,
    ...overrides,
  }) as Directory;

const context = (
  overrides: Partial<FolderVisibilityContext> = {},
): FolderVisibilityContext => ({
  directories: [dir('dir-1', 'C:\\Images'), dir('dir-2', 'D:\\More')],
  selectedFolders: new Set<string>(),
  excludedFolders: new Set<string>(),
  includeSubfolders: true,
  ...overrides,
});

describe('getImageFolderPath', () => {
  it('joins the subfolder part of the id onto the directory path', () => {
    expect(getImageFolderPath(image('dir-1::concept/cat.png'), 'C:\\Images')).toBe(
      'c:/images/concept',
    );
  });

  it('resolves an image at the library root to the directory itself', () => {
    expect(getImageFolderPath(image('dir-1::cat.png'), 'C:\\Images')).toBe('c:/images');
  });

  it('falls back to the directory for ids in any other shape', () => {
    expect(getImageFolderPath(image('legacy-plain-name.png'), 'C:\\Images')).toBe('c:/images');
  });
});

describe('createFolderVisibilityPredicate', () => {
  it('shows every image when no folder is selected', () => {
    const visible = createFolderVisibilityPredicate(context());

    expect(visible(image('dir-1::a.png'))).toBe(true);
    expect(visible(image('dir-2::b.png', 'dir-2'))).toBe(true);
  });

  it('hides images from a disconnected directory', () => {
    // The removable-drive case: cached images stay in the store, but the
    // folder is offline and nothing in it may be rendered.
    const visible = createFolderVisibilityPredicate(
      context({
        directories: [
          dir('dir-1', 'C:\\Images'),
          dir('dir-2', 'D:\\More', { isConnected: false }),
        ],
      }),
    );

    expect(visible(image('dir-1::a.png'))).toBe(true);
    expect(visible(image('dir-2::b.png', 'dir-2'))).toBe(false);
  });

  it('hides images from a directory the sidebar marks invisible', () => {
    const visible = createFolderVisibilityPredicate(
      context({
        directories: [
          dir('dir-1', 'C:\\Images', { visible: false }),
          dir('dir-2', 'D:\\More'),
        ],
      }),
    );

    expect(visible(image('dir-1::a.png'))).toBe(false);
    expect(visible(image('dir-2::b.png', 'dir-2'))).toBe(true);
  });

  it('keeps only the selected folder when subfolders are included', () => {
    const visible = createFolderVisibilityPredicate(
      context({ selectedFolders: new Set(['c:/images']) }),
    );

    expect(visible(image('dir-1::a.png'))).toBe(true);
    expect(visible(image('dir-1::concept/cat.png'))).toBe(true);
    expect(visible(image('dir-2::b.png', 'dir-2'))).toBe(false);
  });

  it('drops subfolder images when includeSubfolders is off', () => {
    const visible = createFolderVisibilityPredicate(
      context({
        selectedFolders: new Set(['c:/images']),
        includeSubfolders: false,
      }),
    );

    expect(visible(image('dir-1::a.png'))).toBe(true);
    expect(visible(image('dir-1::concept/cat.png'))).toBe(false);
  });

  it('hides an excluded folder and its whole subtree', () => {
    const visible = createFolderVisibilityPredicate(
      context({ excludedFolders: new Set(['c:/images/concept']) }),
    );

    expect(visible(image('dir-1::concept/cat.png'))).toBe(false);
    expect(visible(image('dir-1::concept/deep/cat.png'))).toBe(false);
    expect(visible(image('dir-1::a.png'))).toBe(true);
    // A prefix match that is not a path segment must not hide a sibling.
    expect(visible(image('dir-1::conceptual/a.png'))).toBe(true);
  });

  it('lets an exclusion outrank a selection that contains it', () => {
    const visible = createFolderVisibilityPredicate(
      context({
        selectedFolders: new Set(['c:/images']),
        excludedFolders: new Set(['c:/images/concept']),
      }),
    );

    expect(visible(image('dir-1::a.png'))).toBe(true);
    expect(visible(image('dir-1::concept/cat.png'))).toBe(false);
  });

  it('hides an image whose directory is not in the library at all', () => {
    const visible = createFolderVisibilityPredicate(context());

    expect(visible(image('gone::a.png', 'gone'))).toBe(false);
  });
});
