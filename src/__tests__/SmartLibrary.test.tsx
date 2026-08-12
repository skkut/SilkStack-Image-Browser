import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Stacks from '../components/SmartLibrary';
import { useImageStore } from '../store/useImageStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { computeLicenseStamp } from '../services/aiFeatureAccess';

// Mock the ai-intelligence package — provides stub components that mirror
// the originals' DOM output for integration tests of the wrapper layer.
// These are loaded via React.lazy, so the test must use waitFor/findBy*
// to allow the Suspense boundary to resolve.
vi.mock('@ai-images-browser/ai-intelligence', () => {
  const MockStackCard = ({ stack, onOpen, onContextMenu }: any) => (
    <button
      onClick={onOpen}
      onContextMenu={(e: any) => onContextMenu && onContextMenu(stack.coverImage, e)}
      type="button"
    >
      <span>{stack.count} images</span>
    </button>
  );
  const MockSimilarityStackExpandedView = ({ onBack, images, subGroups, onContextMenu }: any) => (
    <div>
      <button onClick={onBack} type="button">
        Library
      </button>
      <span>{images.length} images</span>
      <span>{subGroups.length} prompt variations</span>
      {/* One card per image, mirroring the real SubGroupImageCard's right-click */}
      {images.map((img: any) => (
        <div
          key={img.id}
          data-testid={`expanded-card-${img.id}`}
          onContextMenu={(e: any) => onContextMenu && onContextMenu(img, e)}
        >
          {img.id}
        </div>
      ))}
    </div>
  );
  return {
    StackCard: MockStackCard,
    SimilarityStackExpandedView: MockSimilarityStackExpandedView,
  };
});

// Mock Lucide icons using the original module to preserve all standard icon exports
vi.mock('lucide-react', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
  };
});

// Mock electron API safely without overwriting global.window object properties
if (typeof global.window !== 'undefined') {
  (global.window as any).electronAPI = {
    openImageViewer: vi.fn(),
  };
}

describe('Stacks Scroll Position and DOM Preservation', () => {
  it('keeps the grid container completely untouched in the DOM and layouts the expanded stack view absolutely over it', async () => {
    // Populate mock store data — images need stackGroupId for stacking to work
    const mockImages = [
      { id: '1', prompt: 'test prompt A', directoryId: 'dir1', lastModified: 1000, stackGroupId: 'hash-a' },
      { id: '2', prompt: 'test prompt A', directoryId: 'dir1', lastModified: 900, stackGroupId: 'hash-a' },
      { id: '3', prompt: 'test prompt A', directoryId: 'dir1', lastModified: 800, stackGroupId: 'hash-a' },
      { id: '4', prompt: 'test prompt B', directoryId: 'dir1', lastModified: 700, stackGroupId: 'hash-b' },
    ] as any;

    // Both images and filteredImages are seeded: the app derives filteredImages
    // from images, and a settings change can trigger a re-filter (e.g. the
    // semantic-search sync below), which recomputes from `images`.
    useImageStore.setState({
      images: mockImages,
      filteredImages: mockImages,
      directories: [{ id: 'dir1', path: 'C:/test' }] as any,
      scanSubfolders: false,
    });

    // Stack UI is premium-gated: a valid license is required for
    // StackCardWrapper to render the card contents.
    useSettingsStore.setState({
      licenseStatus: 'valid',
      licenseKey: 'TEST-KEY',
      licenseLastValidated: Date.now(),
      licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', Date.now()),
    });

    const { container } = render(<Stacks />);

    // Grid container should be in DOM and visible
    const gridContainer = container.querySelector('#smart-library-grid-container') as HTMLElement;
    expect(gridContainer).not.toBeNull();
    expect(gridContainer.className).toBe('flex-1 min-h-0 overflow-y-auto');

    // Wait for React.lazy Suspense to resolve, then click the stack card button.
    // findByText uses waitFor under the hood and retries until the element appears.
    const openBtn = await screen.findByText(/images/i);
    fireEvent.click(openBtn);

    // Expanded view should be rendered (SimilarityStackExpandedView shows "Library" back button)
    const libraryBtn = await screen.findByText(/Library/i);
    expect(libraryBtn).toBeDefined();

    // Grid content is replaced by drill-down view (scroll position saved in refs,
    // restored via useEffect when closing). Footer remains visible below.
    const gridContainerAfterOpen = container.querySelector('#smart-library-grid-container') as HTMLElement;
    expect(gridContainerAfterOpen).toBeNull();

    // Footer should still be visible
    expect(container.querySelector('footer')).not.toBeNull();
  });

  it('opens the right-click context menu on images inside the expanded stack view', async () => {
    // Same store setup as the test above — two images grouped into one stack.
    const mockImages = [
      { id: '1', prompt: 'test prompt A', directoryId: 'dir1', lastModified: 1000, stackGroupId: 'hash-a', metadata: {} },
      { id: '2', prompt: 'test prompt A', directoryId: 'dir1', lastModified: 900, stackGroupId: 'hash-a', metadata: {} },
    ] as any;

    useImageStore.setState({
      images: mockImages,
      filteredImages: mockImages,
      directories: [{ id: 'dir1', path: 'C:/test' }] as any,
      scanSubfolders: false,
    });

    useSettingsStore.setState({
      licenseStatus: 'valid',
      licenseKey: 'TEST-KEY',
      licenseLastValidated: Date.now(),
      licenseStamp: computeLicenseStamp('TEST-KEY', 'valid', Date.now()),
    });

    const { container } = render(<Stacks />);

    // Open the stack drill-down view
    const openBtn = await screen.findByText(/images/i);
    fireEvent.click(openBtn);

    // Right-click an image card inside the expanded view
    const expandedCard = await screen.findByTestId('expanded-card-1');
    fireEvent.contextMenu(expandedCard);

    // Context menu should be visible with the standard actions
    const menu = container.querySelector('.context-menu-class');
    expect(menu).not.toBeNull();
    expect(screen.getByText('Copy to Clipboard')).toBeDefined();

    // Escape closes ONLY the menu — a window-level Escape handler (like
    // App's stack-view close) must not fire while the menu is open.
    let windowEscCount = 0;
    const escSpy = () => { windowEscCount++; };
    window.addEventListener('keydown', escSpy);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.context-menu-class')).toBeNull();
    expect(windowEscCount).toBe(0);

    // With the menu closed, Escape passes through to window-level handlers
    // (App's stack-view close) — nothing may swallow it.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(windowEscCount).toBe(1);
    window.removeEventListener('keydown', escSpy);

    // Re-open, then clicking outside the menu also closes it
    fireEvent.contextMenu(expandedCard);
    expect(container.querySelector('.context-menu-class')).not.toBeNull();
    fireEvent.click(document.body);
    expect(container.querySelector('.context-menu-class')).toBeNull();
  });
});
