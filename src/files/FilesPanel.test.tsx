// src/files/FilesPanel.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilesPanel } from "./FilesPanel";
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
    // Totals: +5 / −5 — values no individual row shows, so they're unique to the header.
    expect(screen.getByText("+5")).toBeInTheDocument();
    expect(screen.getByText("−5")).toBeInTheDocument();
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
});
