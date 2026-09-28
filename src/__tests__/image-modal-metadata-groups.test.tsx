import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The stores call localStorage at module load, and this jsdom setup ships a
// non-functional localStorage — stub it (and sessionStorage, read by
// ImageModal) before any module import.
vi.hoisted(() => {
  const makeStorage = () =>
    ({
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(() => null),
    }) as unknown as Storage;
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
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
  waitFor,
} from "@testing-library/react";
import ImageModal from "../components/ImageModal";
import type { IndexedImage } from "../types";

/**
 * ImageModal metadata sidebar groups.
 *
 * The panel is a stack of collapsible group cards — Tags, Image info, Prompt,
 * Generation details, Performance, Raw data. Each header is a disclosure
 * control whose state is remembered in localStorage, and Ctrl+F reopens the
 * Prompt group because the <mark> hits its counter reads live inside it.
 */

const GROUPS_KEY = "image_modal_metadata_groups";
const SIDEBAR_KEY = "image_modal_sidebar_collapsed";
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
        negativePrompt: "blurry",
        model: "flux1-dev",
        seed: 12345,
        _analytics: { generation_time_ms: 5000, gpu_device: "RTX 4090" },
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

/**
 * The group header button labelled `title`. Anchored on aria-expanded — the
 * disclosure attribute is set on the headers and nowhere else in the modal —
 * because the visible text is not unique: "Prompt" is both a group title and
 * the label PromptBlock renders above its <pre>.
 */
const header = (title: string): HTMLButtonElement => {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ).filter((b) => (b.textContent ?? "").trim().startsWith(title));
  if (found.length !== 1) {
    throw new Error(`expected one "${title}" group header, found ${found.length}`);
  }
  return found[0];
};

const hasHeader = (title: string) => {
  try {
    header(title);
    return true;
  } catch {
    return false;
  }
};

const toggle = async (title: string) => {
  await act(async () => {
    fireEvent.click(header(title));
  });
};

/** The parsed group state most recently written to storage, or null. */
const lastWrittenGroups = (): Record<string, boolean> | null => {
  const calls = vi.mocked(global.localStorage.setItem).mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i][0] === GROUPS_KEY) return JSON.parse(calls[i][1] as string);
  }
  return null;
};

describe("ImageModal metadata groups", () => {
  beforeEach(() => {
    vi.mocked(global.localStorage.getItem).mockReset();
    vi.mocked(global.localStorage.setItem).mockReset();
  });
  afterEach(() => cleanup());

  it("renders all six groups with their contents open", () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    for (const title of [
      "Tags",
      "Image info",
      "Prompt",
      "Generation details",
      "Performance",
      "Raw data",
    ]) {
      expect(header(title).getAttribute("aria-expanded")).toBe("true");
    }

    // One representative surface from each group. Labels are used rather than
    // the values for the readout groups: a value can legitimately appear in
    // more than one row, a label is the row's identity.
    expect(screen.getByText("Dimensions")).toBeTruthy();          // Image info
    expect(screen.getByText(PROMPT)).toBeTruthy();
    expect(screen.getByText("Seed")).toBeTruthy();                // Generation details
    expect(screen.getByText("RTX 4090")).toBeTruthy();            // Performance
    expect(screen.getByText("Parsed")).toBeTruthy();              // Raw data
    expect(screen.getByPlaceholderText("Add tag...")).toBeTruthy(); // Tags
  });

  it("drops the contents and the aria-expanded state when a group is collapsed", async () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    expect(screen.getByText("Dimensions")).toBeTruthy();

    await toggle("Image info");

    expect(header("Image info").getAttribute("aria-expanded")).toBe("false");
    // AnimatePresence holds the subtree while the 200ms collapse runs, so the
    // rows leave the DOM a few frames after the click, not on it.
    await waitFor(() => expect(screen.queryByText("Dimensions")).toBeNull());
    // Sibling groups are untouched.
    expect(screen.getByText("Seed")).toBeTruthy();
  });

  it("persists the state of the group that was toggled, and only that group", async () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    await toggle("Generation details");

    expect(lastWrittenGroups()).toEqual({
      tags: true,
      imageInfo: true,
      prompt: true,
      generation: false,
      performance: true,
      raw: true,
    });
  });

  it("opens a group that was left closed in storage", () => {
    vi.mocked(global.localStorage.getItem).mockImplementation((key) =>
      key === GROUPS_KEY ? JSON.stringify({ generation: false }) : null,
    );
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    expect(header("Generation details").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Seed")).toBeNull();
    // A key the record omits merges back to the default rather than reading as
    // closed.
    expect(header("Image info").getAttribute("aria-expanded")).toBe("true");
  });

  it("survives an unreadable stored record by falling back to all-open", () => {
    vi.mocked(global.localStorage.getItem).mockImplementation((key) =>
      key === GROUPS_KEY ? "{not json" : null,
    );
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    expect(header("Tags").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Dimensions")).toBeTruthy();
  });

  it("reopens a collapsed Prompt group for Ctrl+F and closes it again on exit", async () => {
    vi.mocked(global.localStorage.getItem).mockImplementation((key) =>
      key === GROUPS_KEY ? JSON.stringify({ prompt: false }) : null,
    );
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    expect(header("Prompt").getAttribute("aria-expanded")).toBe("false");
    const writesBeforeSearch = vi.mocked(global.localStorage.setItem).mock.calls.length;

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true, metaKey: false });
    });
    const input = screen.getByPlaceholderText("Find in prompt");
    await act(async () => {
      fireEvent.change(input, { target: { value: "cat" } });
    });

    // The marks live in the Prompt group, so the search can only count them
    // with that group mounted.
    expect(header("Prompt").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("search-counter").textContent).toBe("1 / 2");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(header("Prompt").getAttribute("aria-expanded")).toBe("false");
    // The auto open/close is the search's doing, not the user's choice, so it
    // must not overwrite what the panel remembers.
    expect(vi.mocked(global.localStorage.setItem).mock.calls.length).toBe(
      writesBeforeSearch,
    );
  });

  it("hides the metadata groups that need parsed metadata, keeping Tags, Image info and Raw data", () => {
    render(
      <ImageModal image={makeImage({ metadata: {} })} onClose={() => {}} />,
    );

    expect(screen.getByText("No normalized metadata available.")).toBeTruthy();
    expect(hasHeader("Tags")).toBe(true);
    expect(hasHeader("Image info")).toBe(true);
    expect(hasHeader("Raw data")).toBe(true);
    expect(hasHeader("Prompt")).toBe(false);
    expect(hasHeader("Generation details")).toBe(false);
    expect(hasHeader("Performance")).toBe(false);
  });

  it("clips a group only while it is animating, never once it has settled open", async () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    // The tag autocomplete dropdown is `absolute` inside the Tags group, and
    // the panel body is already overflow-y-auto. An extra clip that outlived
    // the animation would slice those suggestions to a sliver — but a clip
    // that is missing during the collapse lets the rows spill out of the
    // shrinking card. So it must be present exactly while height is moving.
    const body = () =>
      header("Tags").parentElement!.querySelector(":scope > div") as HTMLElement;

    expect(body().style.overflow).not.toBe("hidden");

    await toggle("Tags"); // collapse
    expect(body().style.overflow).toBe("hidden");

    await toggle("Tags"); // re-expand — still moving, so still clipped
    expect(body().style.overflow).toBe("hidden");
    await waitFor(() => expect(body().style.overflow).not.toBe("hidden"));
  });

  it("sets the prompt in the UI font at the row size, not monospace", () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    // Tailwind's preflight puts a monospace family on the `pre` ELEMENT, so
    // deleting a font-mono class does not move a <pre> out of monospace — the
    // block has to carry an explicit font-sans. Without one the prompt stayed
    // 16px monospace while every row around it was 14px sans.
    const prompt = screen.getByText(PROMPT);
    expect(prompt.tagName).toBe("PRE");
    expect(prompt.className).toContain("font-sans");
    expect(prompt.className).not.toContain("font-mono");
    expect(prompt.className).toContain("text-sm");
  });

  it("keeps every <pre> block in the panel in the UI font", async () => {
    const { container } = render(
      <ImageModal image={makeImage()} onClose={() => {}} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("JSON"));
    });

    // Asserted over every <pre> rather than the one asked about, because the
    // trap is element-level and invisible: Tailwind's preflight sets a
    // monospace family on the `pre` ELEMENT, so any of these left without an
    // explicit font-sans stays monospace no matter which classes it carries.
    // There are three — the prompt, the negative prompt, and the JSON view.
    const pres = Array.from(container.querySelectorAll("pre"));
    expect(pres.length).toBeGreaterThanOrEqual(3);
    for (const pre of pres) {
      expect(pre.className).toContain("font-sans");
      expect(pre.className).not.toContain("font-mono");
    }
  });

  it("leaves the sidebar collapse write as the last one Ctrl+F makes", async () => {
    vi.mocked(global.localStorage.getItem).mockImplementation((key) =>
      key === SIDEBAR_KEY ? "true" : null,
    );
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    await act(async () => {
      fireEvent.keyDown(window, { key: "f", ctrlKey: true, metaKey: false });
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Group state is written on the click path only, never from an effect, so
    // no write of ours can land after this one.
    expect(vi.mocked(global.localStorage.setItem)).toHaveBeenLastCalledWith(
      SIDEBAR_KEY,
      "false",
    );
  });
});
