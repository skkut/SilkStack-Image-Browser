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

// The Full JSON view is what reads the file, and in jsdom the real reader
// short-circuits to null (no electronAPI) — so the read contract (which
// image, how many times, what lands in the pane) is only observable through
// a spy. Everything else in the module is left real.
const { extractRawMock } = vi.hoisted(() => ({ extractRawMock: vi.fn() }));
vi.mock("../services/fileIndexer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/fileIndexer")>()),
  extractRawMetadataFromFile: extractRawMock,
}));

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
 * The panel is a stack of collapsible group cards — Tags, Prompt, Generation
 * details, Performance, Raw data. Each header is a disclosure control whose
 * state is remembered in localStorage, and Ctrl+F reopens the Prompt group
 * because the <mark> hits its counter reads live inside it.
 *
 * The file's own stats (dimensions, megapixels, aspect ratio, size) are not a
 * group — they sit under the timestamp in the header card, which carries the
 * groups' surface but has no disclosure control, so their anchor is a value
 * rather than a label.
 */

const GROUPS_KEY = "image_modal_metadata_groups";
const SIDEBAR_KEY = "image_modal_sidebar_collapsed";
const PROMPT = "a black cat sits on a mat, the cat is photorealistic";
/** The header stat line for makeImage's 1024×1024 default, unique in the panel. */
const STAT_MEGAPIXELS = "1.05 MP";

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
    extractRawMock.mockReset();
  });
  afterEach(() => cleanup());

  it("renders all five groups with their contents open", () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    for (const title of [
      "Tags",
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
    expect(screen.getByText(PROMPT)).toBeTruthy();                  // Prompt
    expect(screen.getByText("Seed")).toBeTruthy();                  // Generation details
    expect(screen.getByText("RTX 4090")).toBeTruthy();              // Performance
    expect(screen.getByText("Full JSON")).toBeTruthy();            // Raw data
    expect(screen.getByPlaceholderText("Add tag...")).toBeTruthy(); // Tags

    // The file stats live in the header card, which is not a group.
    expect(screen.getByText(STAT_MEGAPIXELS)).toBeTruthy();
  });

  it("opens the Raw data group on the Full JSON, with no Parsed view left", async () => {
    const { container } = render(
      <ImageModal image={makeImage()} onClose={() => {}} />,
    );

    // Full JSON is what the group is for — the parsed values are the sections
    // above it — so it is the first segment and the one already selected. The
    // selection is the default state, not the result of a click: no "choose
    // Full JSON" step exists any more.
    const fullJsonTab = screen.getByRole("button", { name: "Full JSON" });
    expect(fullJsonTab.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "JSON" }).getAttribute("aria-pressed"),
    ).toBe("false");

    // The retired view is gone in every sense: no segment, and none of its
    // explanatory sentence anywhere in the panel.
    expect(screen.queryByText("Parsed")).toBeNull();
    expect(container.textContent).not.toContain(
      "parsed metadata is in the sections above",
    );

    // The JSON view's <pre> is the parsed-object dump, so its absence proves
    // the Full JSON pane is the one mounted.
    for (const pre of Array.from(container.querySelectorAll("pre"))) {
      expect(pre.textContent).not.toContain("normalizedMetadata");
    }

    // jsdom has no electronAPI, so the file read itself resolves to null —
    // which is the Full JSON pane's empty-read banner, not the JSON view.
    await waitFor(() =>
      expect(screen.getByText(/Unable to load raw metadata/)).toBeTruthy(),
    );
  });

  it("leaves file actions out of the panel — it is a readout, not a toolbar", () => {
    render(
      <ImageModal image={makeImage()} directoryPath="/lib" onClose={() => {}} />,
    );

    // "Copy Raw Metadata" and "Show in Folder" used to sit as a two-button row
    // under the last group. Neither action was lost: right-clicking the image
    // offers Show in Folder, and the raw JSON is copied from the view that
    // shows it (the JSON/Full JSON panes' copy buttons).
    expect(screen.queryByText("Copy Raw Metadata")).toBeNull();
    expect(screen.queryByText("Show in Folder")).toBeNull();
  });

  it("reads the file once per image — not again on re-render or re-expand", async () => {
    extractRawMock.mockResolvedValue({ parameters: "Steps: 28" });
    const image = makeImage();
    const { rerender } = render(
      <ImageModal image={image} directoryPath="/lib" onClose={() => {}} />,
    );

    await waitFor(() => expect(extractRawMock).toHaveBeenCalledTimes(1));
    expect(extractRawMock).toHaveBeenCalledWith(
      expect.stringContaining("test.png"),
    );

    // A re-render — any parent state, a favourite toggle — must not re-read
    // the whole file over IPC.
    rerender(<ImageModal image={image} directoryPath="/lib" onClose={() => {}} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(extractRawMock).toHaveBeenCalledTimes(1);

    // Nor must folding the group away and re-opening it: the payload is still
    // in state. (Re-expanding is the cheap path — it never reaches the cache.)
    await toggle("Raw data");
    await toggle("Raw data");
    expect(screen.getByText("Steps: 28", { exact: false })).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(extractRawMock).toHaveBeenCalledTimes(1);
  });

  it("reads again for the next image and never draws the previous file's metadata", async () => {
    const first = makeImage({ id: "dir::first.png", name: "first.png" });
    const second = makeImage({ id: "dir::second.png", name: "second.png" });
    extractRawMock.mockResolvedValue({ parameters: "first payload" });
    const { rerender } = render(
      <ImageModal image={first} directoryPath="/lib" onClose={() => {}} />,
    );
    await waitFor(() => expect(extractRawMock).toHaveBeenCalledTimes(1));

    // The viewer keeps ONE ImageModal mounted while the user walks the grid,
    // so the second image is the same component with a new prop. Its read is
    // held open, so what the pane shows while the read is in flight is what
    // the assertion sees — a fast resolve could hide a stale payload.
    let resolveSecond: ((value: unknown) => void) | undefined;
    extractRawMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    rerender(<ImageModal image={second} directoryPath="/lib" onClose={() => {}} />);

    // The first file's payload must not survive under the second file's name.
    await waitFor(() => expect(screen.queryByText(/first payload/)).toBeNull());

    resolveSecond!({ parameters: "second payload" });
    await waitFor(() => expect(screen.getByText(/second payload/)).toBeTruthy());
    expect(extractRawMock).toHaveBeenCalledTimes(2);
    expect(extractRawMock).toHaveBeenLastCalledWith(
      expect.stringContaining("second.png"),
    );

    // …and stepping back is served from the cache in the same commit, with no
    // third read of a file already read.
    rerender(<ImageModal image={first} directoryPath="/lib" onClose={() => {}} />);
    expect(screen.getByText(/first payload/)).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(extractRawMock).toHaveBeenCalledTimes(2);
  });

  it("pairs the short generation rows two to a cell, and keeps text rows full width", () => {
    render(
      <ImageModal
        image={makeImage({
          metadata: {
            normalizedMetadata: {
              width: 1024,
              height: 1024,
              model: "flux1-dev",
              steps: 28,
              cfg_scale: 6.5,
              sampler: "euler",
              scheduler: "karras",
              clip_skip: 2,
              seed: 12345,
            },
          } as any,
        })}
        onClose={() => {}}
      />,
    );

    // The pair's own grid row is the nearest .grid ancestor of both labels.
    // Identity is the assertion, not the presence of a grid — the header
    // stats are a grid too.
    const gridOf = (label: string) => screen.getByText(label).closest(".grid");
    expect(gridOf("Steps")).toBe(gridOf("CFG Scale"));
    expect(gridOf("Clip Skip")).toBe(gridOf("Seed"));
    expect(gridOf("Sampler")).toBe(gridOf("Scheduler"));
    // …three distinct rows, not one four-cell grid.
    expect(gridOf("Steps")).not.toBe(gridOf("Sampler"));
    // Values that are file names or lists keep their own full-width row.
    expect(gridOf("Model")).toBeNull();
  });

  it("gives a lone value the whole row — never half a row beside an empty cell", () => {
    // makeImage's default metadata has no steps, cfg_scale, sampler or
    // scheduler; only Seed of the Clip Skip|Seed pair has a value.
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    // A pair with nothing at all renders nothing — an empty row would still
    // draw its divider on the divide-y stack.
    expect(screen.queryByText("Steps")).toBeNull();
    expect(screen.queryByText("Sampler")).toBeNull();

    // The survivor is not put in a two-column grid at all: a half-width row
    // beside an empty cell reads as a value that failed to load rather than
    // as one that has no pair.
    const seed = screen.getByText("Seed");
    expect(seed.closest(".grid")).toBeNull();

    // The group renders exactly the two rows that have values — Model, then
    // the unpaired Seed — so no slot was left empty either way.
    const group = seed.closest("div.divide-y")!;
    expect(group).not.toBeNull();
    const rows = Array.from(group.querySelectorAll('[class~="group/row"]'));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.textContent?.trim()).not.toBe("");
    }
  });

  it("puts the name and file stats on the same card surface as the groups", () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    // The stats grid's parent is the header card; a group's card is its
    // header button's parent. Bare text on the panel background made the
    // header read as page chrome beside five bounded cards.
    const headerCard = screen
      .getByText(STAT_MEGAPIXELS)
      .closest("div.grid")!.parentElement!;
    const groupCard = header("Tags").parentElement!;
    for (const el of [headerCard, groupCard]) {
      expect(el.className).toContain("bg-gray-900/50");
      expect(el.className).toContain("rounded-lg");
      expect(el.className).toContain("border-gray-700/50");
    }

    // It shares the surface, not the behaviour: the header card is not a
    // disclosure control and has no remembered state.
    expect(headerCard.querySelector("button[aria-expanded]")).toBeNull();
  });

  it("sets the timestamp in the standard readout color, not the accent", () => {
    const image = makeImage();
    render(<ImageModal image={image} onClose={() => {}} />);

    // The date is a value readout like the stats under it; the accent made
    // the timestamp the panel's one colored line.
    const dateRow = screen
      .getByText(new Date(image.lastModified).toLocaleString())
      .closest("p")!;
    expect(dateRow.className).toContain("text-gray-300");
    expect(dateRow.className).not.toContain("text-accent");
  });

  it("draws a generation row's label as an icon whose hover text is the name", () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    // `title` is the same native hover text every toolbar button uses.
    const icon = document.querySelector('[title="Seed"]');
    expect(icon).not.toBeNull();
    expect(icon!.querySelector("svg")).not.toBeNull();
    // Nothing but the icon is visible — the name survives as the row's
    // screen-reader text, not as a label taking room beside the value.
    expect(icon!.textContent).toBe("");
    expect(screen.getByText("Seed").className).toContain("sr-only");

    // The value hugs the icon — the header stats' rhythm — rather than being
    // flung to the far edge, where a short value in a pair row would
    // right-align to the middle of the card, against nothing.
    const iconRow = icon!.closest('[class~="group/row"]')!;
    expect(iconRow.className).not.toContain("justify-between");

    // Rows outside the generation group are untouched: the Performance
    // group's label is still ordinary visible text on a label/value row.
    const labelRow = screen.getByText("GPU Device");
    expect(labelRow.className).not.toContain("sr-only");
    expect(
      labelRow.closest('[class~="group/row"]')!.className,
    ).toContain("justify-between");
  });

  it("drops the contents and the aria-expanded state when a group is collapsed", async () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);
    expect(screen.getByText("Seed")).toBeTruthy();

    await toggle("Generation details");

    expect(header("Generation details").getAttribute("aria-expanded")).toBe("false");
    // AnimatePresence holds the subtree while the 200ms collapse runs, so the
    // rows leave the DOM a few frames after the click, not on it.
    await waitFor(() => expect(screen.queryByText("Seed")).toBeNull());
    // Sibling groups are untouched, and the header stats were never in a group.
    expect(screen.getByText("Full JSON")).toBeTruthy();
    expect(screen.getByText(STAT_MEGAPIXELS)).toBeTruthy();
  });

  it("persists the state of the group that was toggled, and only that group", async () => {
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    await toggle("Generation details");

    expect(lastWrittenGroups()).toEqual({
      tags: true,
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
    expect(header("Tags").getAttribute("aria-expanded")).toBe("true");
  });

  it("ignores a stored entry for the retired Image info group", () => {
    // Records written before the file stats moved into the header still carry
    // an `imageInfo` key. The merge only reads the fallback's keys, so the
    // entry is dropped: no header appears for it and nothing else is disturbed.
    vi.mocked(global.localStorage.getItem).mockImplementation((key) =>
      key === GROUPS_KEY ? JSON.stringify({ imageInfo: false }) : null,
    );
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    expect(hasHeader("Image info")).toBe(false);
    expect(header("Tags").getAttribute("aria-expanded")).toBe("true");
    // The stats it used to hold are still on screen — in the header now.
    expect(screen.getByText(STAT_MEGAPIXELS)).toBeTruthy();
  });

  it("survives an unreadable stored record by falling back to all-open", () => {
    vi.mocked(global.localStorage.getItem).mockImplementation((key) =>
      key === GROUPS_KEY ? "{not json" : null,
    );
    render(<ImageModal image={makeImage()} onClose={() => {}} />);

    expect(header("Tags").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Seed")).toBeTruthy();
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

  it("hides the metadata groups that need parsed metadata, keeping Tags and Raw data", () => {
    render(
      <ImageModal image={makeImage({ metadata: {} })} onClose={() => {}} />,
    );

    expect(screen.getByText("No normalized metadata available.")).toBeTruthy();
    expect(hasHeader("Tags")).toBe(true);
    expect(hasHeader("Raw data")).toBe(true);
    // The retired Image info group has no header in any state.
    expect(hasHeader("Image info")).toBe(false);
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
