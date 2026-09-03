import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The stores call localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it (and sessionStorage, read by
// ImageModal) before any module import.
vi.hoisted(() => {
  const makeStorage = () => ({
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn(() => null),
  } as Storage);
  global.localStorage = makeStorage();
  global.sessionStorage = makeStorage();
  // jsdom ships no ResizeObserver — ImageModal observes the zoom container.
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  global.ResizeObserver = ResizeObserverMock as any;
});

import React from "react";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import ImageModal from "../components/ImageModal";
import type { IndexedImage } from "../types";

/**
 * ImageModal find-in-prompt (Ctrl+F) regression.
 *
 * Ctrl+F docks a search bar atop the metadata sidebar; typing searches only
 * the Prompt text and highlights every match with <mark class="search-hit">;
 * the counter shows the active position; Enter/Shift+Enter cycle with wrap;
 * Esc closes the bar, clears highlights, and (only if Ctrl+F itself expanded
 * a collapsed sidebar) restores the collapsed state.
 */

const PROMPT = "a black cat sits on a mat, the cat is photorealistic";

function makeImage(overrides: Partial<IndexedImage> = {}): IndexedImage {
  return {
    id: "dir::test.png",
    name: "test.png",
    handle: {} as FileSystemFileHandle,
    metadata: {
      normalizedMetadata: {
        width: 1024,
        height: 1024,
        prompt: PROMPT,
        negativePrompt: "",
      } as any,
    },
    metadataString: "",
    lastModified: Date.now(),
    models: [],
    loras: [],
    scheduler: "",
    ...overrides,
  } as IndexedImage;
}

const openFind = async (opts: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  await act(async () => {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true, metaKey: false, ...opts });
  });
};

describe("ImageModal find-in-prompt", () => {
  beforeEach(() => {
    // Drop call history AND any seeded implementation between tests.
    vi.mocked(global.localStorage.getItem).mockReset();
    vi.mocked(global.localStorage.setItem).mockReset();
  });
  afterEach(() => cleanup());

  it("opens via Ctrl+F, highlights all prompt matches and counts them", async () => {
    const { container } = render(<ImageModal image={makeImage()} onClose={() => {}} />);

    await openFind();
    const input = screen.getByPlaceholderText("Find in prompt");

    await act(async () => {
      fireEvent.change(input, { target: { value: "cat" } });
    });

    expect(container.querySelectorAll("mark.search-hit").length).toBe(2);
    expect(screen.getByTestId("search-counter").textContent).toBe("1 / 2");

    // Case-insensitive: a differently-cased query still matches both hits.
    await act(async () => {
      fireEvent.change(input, { target: { value: "CAT" } });
    });
    expect(container.querySelectorAll("mark.search-hit").length).toBe(2);
    expect(screen.getByTestId("search-counter").textContent).toBe("1 / 2");
  });

  it("matches regex-special characters as a literal phrase", async () => {
    render(
      <ImageModal
        image={makeImage({
          metadata: {
            normalizedMetadata: { prompt: "total: $5.00 (cat).", model: "" } as any,
          },
        })}
        onClose={() => {}}
      />,
    );
    await openFind();
    const input = screen.getByPlaceholderText("Find in prompt");
    await act(async () => {
      fireEvent.change(input, { target: { value: "$5.00" } });
    });
    expect(screen.getByTestId("search-counter").textContent).toBe("1 / 1");
  });

  it("Enter and Shift+Enter cycle the active match with wrap-around", async () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    await openFind();
    const input = screen.getByPlaceholderText("Find in prompt");
    await act(async () => {
      fireEvent.change(input, { target: { value: "cat" } });
    });
    expect(screen.getByTestId("search-counter").textContent).toBe("1 / 2");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" }); // → match 2
    });
    expect(screen.getByTestId("search-counter").textContent).toBe("2 / 2");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" }); // wraps → match 1
    });
    expect(screen.getByTestId("search-counter").textContent).toBe("1 / 2");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", shiftKey: true }); // prev wraps → match 2
    });
    expect(screen.getByTestId("search-counter").textContent).toBe("2 / 2");
  });

  it("Escape in the input closes search and clears highlights without closing the modal", async () => {
    const onClose = vi.fn();
    const { container } = render(<ImageModal image={makeImage()} onClose={onClose} />);

    await openFind();
    const input = screen.getByPlaceholderText("Find in prompt");
    await act(async () => {
      fireEvent.change(input, { target: { value: "cat" } });
    });
    expect(container.querySelectorAll("mark.search-hit").length).toBe(2);

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(screen.queryByPlaceholderText("Find in prompt")).toBeNull();
    expect(container.querySelectorAll("mark.search-hit").length).toBe(0);
    expect(onClose).not.toHaveBeenCalled();

    // A second Escape (now window-level) falls through to closing the modal.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape on the window while search is open closes only the search", async () => {
    const onClose = vi.fn();
    render(<ImageModal image={makeImage()} onClose={onClose} />);

    await openFind();
    expect(screen.getByPlaceholderText("Find in prompt")).toBeTruthy();

    // Focus is outside the search bar (it never received focus), so the
    // window-level handler must close the search — not the modal.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(screen.queryByPlaceholderText("Find in prompt")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Ctrl+F expands a collapsed sidebar (seeded localStorage) and restores it on close", async () => {
    vi.mocked(global.localStorage.getItem).mockImplementation((key) =>
      key === "image_modal_sidebar_collapsed" ? "true" : null,
    );
    const onClose = vi.fn();
    render(<ImageModal image={makeImage()} onClose={onClose} />);

    // Cmd+F path (metaKey, no ctrlKey) — bar opens though the sidebar was collapsed.
    await openFind({ metaKey: true, ctrlKey: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(vi.mocked(global.localStorage.setItem)).toHaveBeenLastCalledWith(
      "image_modal_sidebar_collapsed",
      "false",
    );

    const input = screen.getByPlaceholderText("Find in prompt");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(vi.mocked(global.localStorage.setItem)).toHaveBeenLastCalledWith(
      "image_modal_sidebar_collapsed",
      "true",
    );
  });

  it("arrow keys inside the search input do not navigate the image", async () => {
    const onNavigateNext = vi.fn();
    const onNavigatePrevious = vi.fn();
    render(
      <ImageModal
        image={makeImage()}
        onClose={() => {}}
        onNavigateNext={onNavigateNext}
        onNavigatePrevious={onNavigatePrevious}
      />,
    );

    await openFind();
    const input = screen.getByPlaceholderText("Find in prompt");
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowRight" });
      fireEvent.keyDown(input, { key: "ArrowLeft" });
      fireEvent.keyDown(input, { key: "Delete" });
    });
    expect(onNavigateNext).not.toHaveBeenCalled();
    expect(onNavigatePrevious).not.toHaveBeenCalled();
  });

  it("shows a 'no prompt' hint and 0 / 0 for an image without a prompt", async () => {
    const { container } = render(
      <ImageModal image={makeImage({ metadata: {} })} onClose={() => {}} />,
    );

    await openFind();
    const input = screen.getByPlaceholderText("Find in prompt");
    await act(async () => {
      fireEvent.change(input, { target: { value: "cat" } });
    });

    expect(container.querySelectorAll("mark.search-hit").length).toBe(0);
    expect(screen.getByTestId("search-counter").textContent).toBe("0 / 0");
    expect(screen.getByText("no prompt")).toBeTruthy();
  });
});
