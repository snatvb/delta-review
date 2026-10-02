// src/files/FilesPanel.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
import { setViewedStatsExclude } from "../viewedStatsPref";
import type { FileEntry } from "../types";

const files: FileEntry[] = [
  { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
];

describe("FilesPanel", () => {
  it("shows the empty state when there are no files", () => {
    render(<FilesPanel files={[]} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
  });

  it("renders the header, viewed count, toggle, and tree container", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    expect(screen.getByTitle("Files viewed")).toHaveTextContent("0 / 1 viewed");
    expect(screen.getByTestId("files-tree")).toBeInTheDocument();
    // shadcn ToggleGroup renders items as role="radio" within a radiogroup
    expect(screen.getByRole("radio", { name: /list/i })).toBeInTheDocument();
  });

  it("shows the viewed count in the header", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    expect(screen.getByTitle("Files viewed")).toHaveTextContent("1 / 1 viewed");
  });

  it("shows the global diff count (sum across files) in the header", () => {
    const multi: FileEntry[] = [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
      { path: "src/b.ts", status: "modified", additions: 2, deletions: 4, binary: false },
    ];
    render(<FilesPanel files={multi} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    // Totals: +5 / −5. Folder rollups can equal the header (a one-file folder's
    // sum is its file's row), so assert on the counter button itself.
    const counter = screen.getByRole("button", { name: "Toggle unviewed-only totals" });
    expect(counter.textContent).toContain("+5");
    expect(counter.textContent).toContain("−5");
  });

  describe("unviewed-only totals pref", () => {
    // The pref module caches its value at first read, so tests must flip it via
    // the setter (not raw localStorage) and always restore it.
    afterEach(() => setViewedStatsExclude("off"));

    it("counts viewed files in the totals by default (pref off)", () => {
      const multi: FileEntry[] = [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
        { path: "src/b.ts", status: "modified", additions: 2, deletions: 4, binary: false },
      ];
      render(<FilesPanel files={multi} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      const counter = screen.getByRole("button", { name: "Toggle unviewed-only totals" });
      expect(counter.textContent).toContain("+5");
      expect(counter.textContent).toContain("−5");
    });

    it("excludes viewed files from the totals when the pref is on", () => {
      setViewedStatsExclude("on");
      // Counts chosen so every header value differs from every row value.
      const multi: FileEntry[] = [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
        { path: "src/b.ts", status: "modified", additions: 2, deletions: 5, binary: false },
        { path: "src/c.ts", status: "modified", additions: 4, deletions: 9, binary: false },
      ];
      render(<FilesPanel files={multi} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      // Header = b + c only: +6 / −14 (rows are 2/5 and 4/9).
      const counter = screen.getByRole("button", { name: "Toggle unviewed-only totals" });
      expect(counter.textContent).toContain("+6");
      expect(counter.textContent).toContain("−14");
      expect(counter.textContent).not.toContain("+9"); // the all-files total never shows
      // The tooltip names what was excluded, so the shrunken number reads deliberate.
      expect(screen.getByTitle(/\+6 \/ −14 left to review — 1 viewed file excluded/)).toBeInTheDocument();
      // The progress chip still counts every file.
      expect(screen.getByTitle("Files viewed")).toHaveTextContent("1 / 3 viewed");
      // Per-file row numbers stay untouched — including the viewed file's.
      expect(screen.getByText("+3")).toBeInTheDocument();
    });

    it("shows no +/− totals when every file is viewed and the pref is on", () => {
      setViewedStatsExclude("on");
      render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      // The header collapses to +0/−0 (hidden spans), while the file row keeps
      // its own numbers — so assert on the header tooltip, not on "+3", which
      // the row legitimately still renders.
      expect(screen.getByTitle(/\+0 \/ −0 left to review — 1 viewed file excluded/)).toBeInTheDocument();
      expect(screen.getByText("+3")).toBeInTheDocument(); // the row's number survives
    });

    it("toggles the mode by clicking the header counter (no trip to Settings)", () => {
      // Counts chosen so every header value differs from every row value in
      // both modes (header: +10/−15 off, +7/−14 on; rows: 3/1, 2/5, 5/9).
      const multi: FileEntry[] = [
        { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
        { path: "src/b.ts", status: "modified", additions: 2, deletions: 5, binary: false },
        { path: "src/c.ts", status: "modified", additions: 5, deletions: 9, binary: false },
      ];
      render(<FilesPanel files={multi} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/a.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      const counter = screen.getByRole("button", { name: "Toggle unviewed-only totals" });
      expect(counter).toHaveAttribute("aria-pressed", "false");
      expect(counter.textContent).toContain("+10"); // counts everything
      fireEvent.click(counter);
      expect(counter).toHaveAttribute("aria-pressed", "true");
      expect(counter.textContent).toContain("+7"); // only b+c are left
      expect(counter.textContent).toContain("−14");
      fireEvent.click(counter);
      expect(counter.textContent).toContain("+10"); // and back
    });
  });

  it("groups ignored files in a collapsed section and leaves them out of the counts", () => {
    const withIgnored: FileEntry[] = [
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
      { path: "gen/api.ts", status: "modified", additions: 0, deletions: 0, binary: false, ignored: true },
    ];
    render(<FilesPanel files={withIgnored} selected={null} onSelect={() => {}} viewedFiles={new Set(["gen/api.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    expect(screen.getByTitle("Files viewed")).toHaveTextContent("0 / 1 viewed");
    expect(screen.getByText("Ignored (1)")).toBeInTheDocument();
    expect(screen.queryByText("api.ts")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Ignored (1)"));
    expect(screen.getByText("api.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "viewed gen/api.ts" })).not.toBeInTheDocument();
  });

  it("omits the tree-indent spacer in list mode", () => {
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    // Tree mode (default): file rows carry the chevron-column spacer.
    expect(screen.getAllByTestId("tree-indent").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("radio", { name: /list/i }));
    expect(screen.queryByTestId("tree-indent")).not.toBeInTheDocument();
  });

  it("renders the file row and selects it on click", () => {
    const onSelect = vi.fn();
    render(<FilesPanel files={files} selected={null} onSelect={onSelect} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    const leaf = screen.getByText("a.ts"); // tree mode shows the leaf name under src/
    expect(leaf).toBeInTheDocument();
    fireEvent.click(leaf);
    expect(onSelect).toHaveBeenCalledWith("src/a.ts");
  });

  it("toggles viewed via the row affordance", () => {
    const onToggleViewed = vi.fn();
    render(<FilesPanel files={files} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={onToggleViewed} onSetViewedBulk={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /viewed src\/a\.ts/i }));
    expect(onToggleViewed).toHaveBeenCalledWith("src/a.ts");
  });

  it("labels a renamed file with its old path via a tooltip", () => {
    const renamed: FileEntry[] = [
      { path: "src/auth/token.ts", oldPath: "src/auth/session.ts", status: "renamed", additions: 0, deletions: 0, binary: false },
    ];
    render(<FilesPanel files={renamed} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
    expect(screen.getByTitle("Renamed from src/auth/session.ts")).toBeInTheDocument();
  });

  it("does not scroll the tree when a folder is collapsed or expanded", () => {
    // Collapsing/expanding a folder reshapes the tree but must not move the
    // scroller — the active file only follows selection/keyboard/scroll-spy,
    // never a folder toggle. (regression: folder toggle yanked the pane back
    // to the out-of-view active file)
    const scrollSpy = vi.spyOn(Element.prototype, "scrollTo").mockImplementation(() => {});
    try {
      const multi: FileEntry[] = [
        { path: "lib/c.ts", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "lib/d.ts", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
        { path: "src/b.ts", status: "modified", additions: 1, deletions: 0, binary: false },
      ];
      // src/a.ts is the active file; lib/ is a sibling folder that doesn't contain it.
      render(<FilesPanel files={multi} selected="src/a.ts" onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      // Mount scrolls the initially-selected file into view — that's expected; only
      // the folder toggles below must leave the scroller untouched.
      scrollSpy.mockClear();
      fireEvent.click(screen.getByText("lib")); // collapse
      fireEvent.click(screen.getByText("lib")); // expand
      expect(scrollSpy).not.toHaveBeenCalled();
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it("prefetches a file's diff after the pointer rests on its row (debounced)", () => {
    vi.useFakeTimers();
    try {
      const onPrefetch = vi.fn();
      render(<FilesPanel files={files} selected={null} onSelect={() => {}} onPrefetch={onPrefetch} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      // mouseOver is what React uses to synthesize onMouseEnter (mouseenter doesn't bubble).
      fireEvent.mouseOver(screen.getByText("a.ts"));
      expect(onPrefetch).not.toHaveBeenCalled(); // debounced, not fired on entry
      vi.advanceTimersByTime(110);
      expect(onPrefetch).toHaveBeenCalledWith("src/a.ts");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("folder viewed checkbox", () => {
    const tree: FileEntry[] = [
      { path: "lib/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
      { path: "lib/sub/b.ts", status: "modified", additions: 1, deletions: 0, binary: false },
      { path: "other/c.ts", status: "modified", additions: 1, deletions: 0, binary: false },
    ];

    it("marks every file under a folder (nested included) from an empty checkbox", () => {
      const onSetViewedBulk = vi.fn();
      render(<FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={onSetViewedBulk} />);
      const btn = screen.getByRole("button", { name: "viewed folder lib" });
      expect(btn).toHaveAttribute("title", "Mark all viewed (2 files)");
      fireEvent.click(btn);
      const [paths, viewed] = onSetViewedBulk.mock.calls[0];
      expect([...paths].sort()).toEqual(["lib/a.ts", "lib/sub/b.ts"]); // nested files too, no outsiders
      expect(viewed).toBe(true);
    });

    it("shows the dash state when only some files are viewed, and clears on click", () => {
      const onSetViewedBulk = vi.fn();
      render(<FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set(["lib/a.ts"])} onToggleViewed={() => {}} onSetViewedBulk={onSetViewedBulk} />);
      const btn = screen.getByRole("button", { name: "viewed folder lib" });
      expect(btn).toHaveAttribute("title", "Clear viewed (1/2)");
      fireEvent.click(btn);
      const [paths, viewed] = onSetViewedBulk.mock.calls[0];
      expect(paths).toHaveLength(2);
      expect(viewed).toBe(false);
    });

    it("shows the checked state when every file is viewed, and clears on click", () => {
      const onSetViewedBulk = vi.fn();
      render(<FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set(["lib/a.ts", "lib/sub/b.ts"])} onToggleViewed={() => {}} onSetViewedBulk={onSetViewedBulk} />);
      const btn = screen.getByRole("button", { name: "viewed folder lib" });
      expect(btn).toHaveAttribute("title", "Clear viewed (2/2)");
      fireEvent.click(btn);
      expect(onSetViewedBulk).toHaveBeenCalledWith(expect.arrayContaining(["lib/a.ts", "lib/sub/b.ts"]), false);
    });

    it("rolls the parent folder up from nested folders (dash when a nested file is viewed)", () => {
      render(<FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set(["lib/sub/b.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      expect(screen.getByRole("button", { name: "viewed folder lib" })).toHaveAttribute("title", "Clear viewed (1/2)");
      expect(screen.getByRole("button", { name: "viewed folder lib/sub" })).toHaveAttribute("title", "Clear viewed (1/1)");
    });

    it("toggles the checkbox without collapsing the folder", () => {
      const onSetViewedBulk = vi.fn();
      render(<FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={onSetViewedBulk} />);
      fireEvent.click(screen.getByRole("button", { name: "viewed folder lib" }));
      expect(screen.getByText("a.ts")).toBeInTheDocument(); // still expanded — click stopped at the checkbox
      expect(onSetViewedBulk).toHaveBeenCalled();
    });

    it("keeps the checkbox when the same folder also holds ignored files (no Ignored-group overwrite)", () => {
      // The Ignored group rebuilds folder paths that exist in the main tree
      // (godot/game/icons holds both a reviewable png and an ignored .import).
      // Its zeroed rollup must not overwrite the real folder's entry — that
      // used to strip the checkbox +/− stats from every folder containing at
      // least one ignored file, i.e. most high-level folders.
      const mixed: FileEntry[] = [
        { path: "godot/game/classes/class.ron", status: "modified", additions: 11, deletions: 1, binary: false },
        { path: "godot/game/icons/hunter.png", status: "modified", additions: 5, deletions: 0, binary: false },
        { path: "godot/game/icons/hunter.png.import", status: "modified", additions: 0, deletions: 0, binary: false, ignored: true },
      ];
      const onSetViewedBulk = vi.fn();
      render(<FilesPanel files={mixed} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={onSetViewedBulk} />);
      expect(screen.getByRole("button", { name: "viewed folder godot" })).toHaveAttribute("title", "Mark all viewed (2 files)");
      expect(screen.getByRole("button", { name: "viewed folder godot/game" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "viewed folder godot/game/icons" })).toBeInTheDocument();
      expect(screen.getByTitle("+16 / −1 under godot")).toBeInTheDocument();
      // Bulk still acts on reviewable files only — the .import stays out.
      fireEvent.click(screen.getByRole("button", { name: "viewed folder godot" }));
      expect(onSetViewedBulk.mock.calls[0][0].sort()).toEqual(["godot/game/classes/class.ron", "godot/game/icons/hunter.png"]);
    });

    it("renders no checkbox on the Ignored group or in list mode", () => {
      const withIgnored: FileEntry[] = [...tree, { path: "gen/api.ts", status: "modified", additions: 0, deletions: 0, binary: false, ignored: true }];
      const { rerender } = render(
        <FilesPanel files={withIgnored} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />,
      );
      expect(screen.queryByRole("button", { name: "viewed folder /:ignored" })).not.toBeInTheDocument();
      rerender(
        <FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />,
      );
      fireEvent.click(screen.getByRole("radio", { name: /list/i }));
      expect(screen.queryByRole("button", { name: /viewed folder/ })).not.toBeInTheDocument();
    });
  });

  describe("folder +/− rollup", () => {
    const tree: FileEntry[] = [
      { path: "lib/a.ts", status: "modified", additions: 3, deletions: 1, binary: false },
      { path: "lib/sub/b.ts", status: "modified", additions: 9, deletions: 2, binary: false },
      { path: "other/c.ts", status: "modified", additions: 7, deletions: 4, binary: false },
    ];
    afterEach(() => setViewedStatsExclude("off"));

    it("sums descendant changes on folder rows (exact numbers in the tooltip)", () => {
      render(<FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      expect(screen.getByTitle("+12 / −3 under lib")).toBeInTheDocument();
      expect(screen.getByTitle("+9 / −2 under lib/sub")).toBeInTheDocument();
      expect(screen.getByTitle("+7 / −4 under other")).toBeInTheDocument();
      // The compacted rollup renders on the row itself, not just the tooltip.
      expect(screen.getByText("+12")).toBeInTheDocument();
    });

    it("skips viewed files in unviewed-only mode", () => {
      setViewedStatsExclude("on");
      render(<FilesPanel files={tree} selected={null} onSelect={() => {}} viewedFiles={new Set(["lib/a.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      // lib lost a.ts (+3/−1); lib/sub keeps its sum (nothing viewed inside),
      // but its tooltip still names the mode.
      expect(screen.getByTitle("+9 / −2 left under lib (unviewed-only)")).toBeInTheDocument();
      expect(screen.getByTitle("+9 / −2 left under lib/sub (unviewed-only)")).toBeInTheDocument();
    });

    it("renders no rollup on the Ignored group (ignored files never count)", () => {
      const withIgnored: FileEntry[] = [...tree, { path: "gen/api.ts", status: "modified", additions: 5, deletions: 5, binary: false, ignored: true }];
      render(<FilesPanel files={withIgnored} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      expect(screen.queryByTitle(/under \/:ignored/)).not.toBeInTheDocument();
    });
  });

  // fmtCount is module-private — exercised through the rendered rows, folder
  // rollups, and the header counter. Rule: ≥10,000 compacts to "Nk" (floor);
  // 9,999 and below stay exact. Tooltips keep full precision.
  describe("large-number compaction", () => {
    const big: FileEntry[] = [
      { path: "src/huge.ts", status: "modified", additions: 156_048, deletions: 0, binary: false },
      { path: "src/big.ts", status: "modified", additions: 17_280, deletions: 0, binary: false },
      { path: "lib/near.ts", status: "modified", additions: 9_999, deletions: 0, binary: false },
      { path: "lib/edge.ts", status: "modified", additions: 1, deletions: 10_000, binary: false },
    ];
    const counter = () => screen.getByRole("button", { name: "Toggle unviewed-only totals" });

    it("compacts ≥10k everywhere it renders, keeps sub-10k exact", () => {
      render(<FilesPanel files={big} selected={null} onSelect={() => {}} viewedFiles={new Set()} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
      // Rows: 156048 → 156k, 17280 → 17k, 9999 stays exact.
      expect(screen.getByText("+156k")).toBeInTheDocument();
      expect(screen.getByText("+17k")).toBeInTheDocument();
      expect(screen.getByText("+9999")).toBeInTheDocument();
      // Header: 156048+17280+9999+1 = 183328 → 183k; −10000 → −10k.
      expect(counter().textContent).toContain("+183k");
      expect(counter().textContent).toContain("−10k");
      // Folder lib crosses the threshold that its rows don't: 9999+1 = 10000.
      expect(screen.getByTitle("+10000 / −10000 under lib")).toBeInTheDocument(); // exact in the tooltip
      expect(screen.getByText("+10k")).toBeInTheDocument(); // compacted on the folder row
    });

    it("compacts the unviewed-only totals the same way", () => {
      setViewedStatsExclude("on");
      try {
        // Viewing the two biggest files leaves 9999+1 additions and 10000 deletions.
        render(<FilesPanel files={big} selected={null} onSelect={() => {}} viewedFiles={new Set(["src/huge.ts", "src/big.ts"])} onToggleViewed={() => {}} onSetViewedBulk={() => {}} />);
        expect(counter().textContent).toContain("+10k");
        expect(counter().textContent).toContain("−10k");
        expect(counter().textContent).not.toContain("+183k");
        // src still renders a row-level rollup of zero → no stats span at all.
        expect(screen.queryByTitle(/under src/)).not.toBeInTheDocument();
      } finally {
        setViewedStatsExclude("off");
      }
    });
  });
});
