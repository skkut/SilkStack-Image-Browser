import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, beforeAll } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Resolve the component through Vite's glob rather than a static import: an
// open-source checkout without the private ai-intelligence directory gets an
// empty map and the tests skip, instead of failing module resolution.
const ALBUM_VIEW_KEY = '../../ai-intelligence/src/components/AlbumsView.tsx';
const albumViewModules = import.meta.glob(
  '../../ai-intelligence/src/components/AlbumsView.tsx',
);

// The module owns this database name. Duplicated only so the reset helper
// compiles and runs when the module is absent (the suite is skipped then).
const ALBUMS_DB_NAME = 'silkstack-albums';

let AlbumsView: React.ComponentType<Record<string, unknown>> | null = null;

async function resetDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(ALBUMS_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

const images = [
  { id: 'img-a', name: 'a.png', directoryId: 'C:/images' },
  { id: 'img-b', name: 'b.png', directoryId: 'C:/images' },
];

/** The header button is disabled until membership loads; the empty-state CTA
 *  is always live. Click whichever "Add photos" control is enabled. */
async function clickAddPhotos(): Promise<void> {
  await screen.findByText('This album is empty');
  const candidates = screen.getAllByRole('button', { name: /add photos/i });
  const enabled = candidates.find(
    (button) => !(button as HTMLButtonElement).disabled,
  );
  expect(enabled).toBeTruthy();
  fireEvent.click(enabled!);
}

describe.skipIf(!albumViewModules[ALBUM_VIEW_KEY])('AlbumsView', () => {
  beforeAll(async () => {
    const module = (await albumViewModules[ALBUM_VIEW_KEY]()) as {
      default: React.ComponentType<Record<string, unknown>>;
    };
    AlbumsView = module.default;
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates an album, adds photos, and removes a photo from it', async () => {
    render(React.createElement(AlbumsView!, { images }));

    // Empty state → create the first album.
    await screen.findByText('No albums yet');
    fireEvent.click(screen.getByRole('button', { name: /create your first album/i }));

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Training set' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create album$/ }));

    // The new album opens straight into its (empty) detail view.
    await screen.findByRole('heading', { name: 'Training set' });
    expect(await screen.findByText('This album is empty')).toBeTruthy();

    // Add two photos through the picker.
    await clickAddPhotos();
    await screen.findByText('Add photos to Training set');
    fireEvent.click(screen.getByTitle('a.png'));
    fireEvent.click(screen.getByTitle('b.png'));
    fireEvent.click(screen.getByRole('button', { name: /add 2 photos/i }));

    await screen.findByTitle('a.png');
    expect(await screen.findByText('2 photos added to the album.')).toBeTruthy();

    // Select one photo and remove it from the album only. The header's bulk
    // action and the card's hover X share an accessible name, so take the
    // bulk control (first in DOM order).
    fireEvent.click(screen.getAllByRole('button', { name: 'Select photo' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: /remove from album/i })[0]);

    await waitFor(() => {
      expect(screen.queryByTitle('a.png')).toBeNull();
    });
    expect(screen.getByTitle('b.png')).toBeTruthy();
    expect(await screen.findByText('1 photo removed from the album.')).toBeTruthy();
  });

  it('returns to the overview and shows the album card with its count', async () => {
    render(React.createElement(AlbumsView!, { images }));

    await screen.findByText('No albums yet');
    fireEvent.click(screen.getByRole('button', { name: /create your first album/i }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Favourites' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create album$/ }));
    await screen.findByRole('heading', { name: 'Favourites' });

    await clickAddPhotos();
    await screen.findByText('Add photos to Favourites');
    fireEvent.click(screen.getByTitle('a.png'));
    fireEvent.click(screen.getByRole('button', { name: /add 1 photo/i }));
    await screen.findByTitle('a.png');

    fireEvent.click(screen.getByRole('button', { name: /^Albums$/ }));

    await screen.findByRole('button', { name: 'Open album Favourites' });
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Open album Favourites' }).textContent,
      ).toContain('1 photo');
    });
  });

  it('does not offer photos from disconnected folders, and offers them again once connected', async () => {
    const allImages = [
      ...images,
      { id: 'img-offline', name: 'offline.png', directoryId: 'D:/offline' },
    ];
    const offline = new Set(['D:/offline']);

    const view = render(
      React.createElement(AlbumsView!, {
        images: allImages,
        unavailableDirectoryIds: offline,
      }),
    );

    await screen.findByText('No albums yet');
    fireEvent.click(screen.getByRole('button', { name: /create your first album/i }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Drive check' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create album$/ }));
    await screen.findByRole('heading', { name: 'Drive check' });

    await clickAddPhotos();
    await screen.findByText('Add photos to Drive check');

    // The detached drive's photo is not offered...
    expect(screen.queryByTitle('offline.png')).toBeNull();
    expect(screen.getByTitle('a.png')).toBeTruthy();

    // ...and appears live when the drive reconnects.
    view.rerender(
      React.createElement(AlbumsView!, {
        images: allImages,
        unavailableDirectoryIds: new Set<string>(),
      }),
    );
    expect(await screen.findByTitle('offline.png')).toBeTruthy();
  });

  it('stops resolving thumbnails for existing album entries on a disconnected folder', async () => {
    const allImages = [
      ...images,
      { id: 'img-offline', name: 'offline.png', directoryId: 'D:/offline' },
    ];
    const offline = new Set(['D:/offline']);

    const view = render(
      React.createElement(AlbumsView!, { images: allImages }),
    );

    await screen.findByText('No albums yet');
    fireEvent.click(screen.getByRole('button', { name: /create your first album/i }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Detach check' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create album$/ }));
    await screen.findByRole('heading', { name: 'Detach check' });

    await clickAddPhotos();
    await screen.findByText('Add photos to Detach check');
    fireEvent.click(screen.getByTitle('offline.png'));
    fireEvent.click(screen.getByRole('button', { name: /add 1 photo/i }));
    await screen.findByTitle('offline.png');
    expect(screen.queryByText('Unavailable')).toBeNull();

    // Disconnect → the row stays in the album, but its thumbnail is gone.
    view.rerender(
      React.createElement(AlbumsView!, {
        images: allImages,
        unavailableDirectoryIds: offline,
      }),
    );
    await waitFor(() => {
      expect(screen.getByText('Unavailable')).toBeTruthy();
    });

    // Reconnect → the same membership renders again.
    view.rerender(
      React.createElement(AlbumsView!, {
        images: allImages,
        unavailableDirectoryIds: new Set<string>(),
      }),
    );
    await waitFor(() => {
      expect(screen.queryByText('Unavailable')).toBeNull();
    });
    expect(screen.getByTitle('offline.png')).toBeTruthy();
  });
});
