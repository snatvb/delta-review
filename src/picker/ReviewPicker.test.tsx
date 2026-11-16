import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewPicker } from "./ReviewPicker";
import { __resetPickerCacheForTest } from "./pickerData";
import { __setInvokeForDev } from "../api";
import type { PickerData, PickerWorktree, ReviewEntry } from "../types";

// The demo repo: its main copy (branch "main", a review that matches that live
// branch) plus one linked worktree with no matching review.
const REVIEW: ReviewEntry = {
  id: "rev1",
  repoName: "demo",
  target: { repoPath: "/r/demo", worktree: "main", mode: "all-changes" },
  lastOpenedAt: "2026-06-26T10:00:00Z",
  commentCount: 3,
  staleCount: 1,
  resolvedCount: 0,
  viewedCount: 2,
  fileCount: 7,
};

const DATA: PickerData = {
  home: "/Users/me",
  worktrees: [
    { path: "/r/demo", branch: "main", isMain: true, lastCommitAt: "2026-06-26T09:00:00Z", dirty: false, repoName: "demo", repoId: "r1", review: REVIEW },
    { path: "/r/demo-spike", branch: "spike/idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false, repoName: "demo", repoId: "r1" },
  ],
};

function mock(data: PickerData) {
  __setInvokeForDev(async (cmd: string) => {
    if (cmd === "list_picker") return structuredClone(data) as never;
    throw new Error(`unexpected ${cmd}`);
  });
}

describe("ReviewPicker", () => {
  beforeEach(() => __resetPickerCacheForTest());

  it("lists repositories and worktrees as folders, opens one on click", async () => {
    mock(DATA);
    const opened: PickerWorktree[] = [];
    render(
      <ReviewPicker onOpenWorktree={(w) => opened.push(w)} onAddRepo={() => {}} onDeleteReview={async () => false} />,
    );
    // One group per repo: its header, then the main copy and the linked worktree.
    await waitFor(() => expect(screen.getByRole("button", { name: "Only demo" })).toBeInTheDocument());
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("spike/idea")).toBeInTheDocument();
    // The row carries the review that matches the folder's live branch.
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByText("spike/idea"));
    expect(opened.map((w) => w.path)).toEqual(["/r/demo-spike"]);
  });

  it("deletes the joined review but keeps the folder row", async () => {
    mock(DATA);
    const deleted: string[] = [];
    render(
      <ReviewPicker
        onOpenWorktree={() => {}}
        onAddRepo={() => {}}
        onDeleteReview={async (r) => {
          deleted.push(r.id);
          return true;
        }}
      />,
    );
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete review" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Delete review" })).not.toBeInTheDocument());
    // The folder is a real place — the row stays; only its review falls off.
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(deleted).toEqual(["rev1"]);
  });

  it("keeps the review when deletion was cancelled", async () => {
    mock(DATA);
    render(<ReviewPicker onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={async () => false} />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Delete review" }));
    await Promise.resolve();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete review" })).toBeInTheDocument();
  });

  it("filters the list as you type", async () => {
    mock(DATA);
    render(<ReviewPicker onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={async () => false} />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "spike" } });
    await waitFor(() => expect(screen.queryByText("main")).not.toBeInTheDocument());
    expect(screen.getByText("spike/idea")).toBeInTheDocument();
  });

  it("excludes the current worktree from the list, even when the mode differs", async () => {
    mock(DATA);
    render(
      <ReviewPicker
        current={{ repoPath: "/r/demo", mode: "uncommitted" }}
        onOpenWorktree={() => {}}
        onAddRepo={() => {}}
        onDeleteReview={async () => false}
      />,
    );
    await waitFor(() => expect(screen.getByText("spike/idea")).toBeInTheDocument());
    // /r/demo is the worktree we're currently in (different mode) → not a switch target.
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("excludes the current worktree even when its URL path carries a trailing separator", async () => {
    // The review window's repo param comes from libgit2's workdir form
    // ("/r/demo/" with the trailing slash), the row path is normalized —
    // a strict === would let the current folder reappear in its own palette.
    mock(DATA);
    render(
      <ReviewPicker
        current={{ repoPath: "/r/demo/", mode: "uncommitted" }}
        onOpenWorktree={() => {}}
        onAddRepo={() => {}}
        onDeleteReview={async () => false}
      />,
    );
    await waitFor(() => expect(screen.getByText("spike/idea")).toBeInTheDocument());
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("shows an add-repo affordance and a hint when there are no known repos", async () => {
    mock({ worktrees: [] });
    render(<ReviewPicker onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={async () => false} />);
    await waitFor(() => expect(screen.getByText(/no repos yet/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /add a repo/i })).toBeInTheDocument();
  });

  it("revalidates worktrees when the window regains focus", async () => {
    // A worktree created after the picker mounted (e.g. `git worktree add`) only shows
    // if the picker refetches; returning to the window is that trigger. (#refresh)
    const WITH_NEW: PickerData = {
      ...DATA,
      worktrees: [
        ...DATA.worktrees,
        { path: "/r/demo-fresh", branch: "fresh/wt", isMain: false, lastCommitAt: "2026-06-27T09:00:00Z", dirty: false, repoName: "demo", repoId: "r1" },
      ],
    };
    let calls = 0;
    __setInvokeForDev(async (cmd: string) => {
      if (cmd !== "list_picker") throw new Error(`unexpected ${cmd}`);
      calls += 1;
      return structuredClone(calls === 1 ? DATA : WITH_NEW) as never;
    });
    render(<ReviewPicker onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={async () => false} />);
    await waitFor(() => expect(screen.getByText("spike/idea")).toBeInTheDocument());
    expect(screen.queryByText("fresh/wt")).not.toBeInTheDocument();

    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(screen.getByText("fresh/wt")).toBeInTheDocument());
  });

  describe("grouped by repo", () => {
    const wt = (repo: string, name: string, at: string): PickerWorktree => ({
      path: `/r/${repo}/${name}`,
      branch: `feat/${name}`,
      isMain: false,
      lastCommitAt: at,
      dirty: false,
      repoName: repo,
      repoId: `id-${repo}`,
    });
    const MANY: PickerData = {
      worktrees: [
        wt("wotdev", "context_menu", "2026-06-26T10:00:00Z"),
        wt("wotdev", "team_score", "2026-06-25T10:00:00Z"),
        wt("wotdev", "mini_tank", "2026-06-24T10:00:00Z"),
        wt("wotdev", "old_one", "2026-06-01T10:00:00Z"),
        wt("wotdev", "older_one", "2026-05-01T10:00:00Z"),
        wt("pencil", "op-fig", "2026-06-26T12:00:00Z"),
      ],
    };
    const search = () => screen.getByRole("textbox");
    const renderPicker = (props: Partial<Parameters<typeof ReviewPicker>[0]> = {}) =>
      render(<ReviewPicker onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={async () => false} {...props} />);

    beforeEach(() => localStorage.clear());

    it("shows each repo's freshest worktrees and expands the rest on demand", async () => {
      mock(MANY);
      renderPicker();
      await waitFor(() => expect(screen.getByText("context_menu")).toBeInTheDocument());
      expect(screen.queryByText("old_one")).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("+ 2 more"));
      expect(screen.getByText("old_one")).toBeInTheDocument();
      expect(screen.getByText("older_one")).toBeInTheDocument();
    });

    it("orders repos by their freshest activity", async () => {
      mock(MANY);
      renderPicker();
      await waitFor(() => expect(screen.getByText("op-fig")).toBeInTheDocument());
      const headers = screen.getAllByRole("button", { name: /^Only / }).map((b) => b.getAttribute("aria-label"));
      expect(headers).toEqual(["Only pencil", "Only wotdev"]);
    });

    it("folds a repo with the arrow keys and remembers it", async () => {
      mock(MANY);
      const { unmount } = renderPicker();
      await waitFor(() => expect(screen.getByText("op-fig")).toBeInTheDocument());
      fireEvent.keyDown(search(), { key: "ArrowLeft" });
      expect(screen.queryByText("op-fig")).not.toBeInTheDocument();
      unmount();
      __resetPickerCacheForTest();
      renderPicker();
      await waitFor(() => expect(screen.getByText("context_menu")).toBeInTheDocument());
      expect(screen.queryByText("op-fig")).not.toBeInTheDocument();
    });

    it("searches inside folded repos", async () => {
      localStorage.setItem("delta.picker.collapsedRepos", JSON.stringify(["id-pencil"]));
      mock(MANY);
      renderPicker();
      await waitFor(() => expect(screen.getByText("context_menu")).toBeInTheDocument());
      expect(screen.queryByText("op-fig")).not.toBeInTheDocument();
      fireEvent.change(search(), { target: { value: "fig" } });
      expect(screen.getByText("op-fig")).toBeInTheDocument();
    });

    it("Tab narrows to the selected row's repo, Backspace on an empty query leaves it", async () => {
      mock(MANY);
      renderPicker();
      await waitFor(() => expect(screen.getByText("op-fig")).toBeInTheDocument());
      fireEvent.keyDown(search(), { key: "ArrowDown" });
      fireEvent.keyDown(search(), { key: "ArrowDown" });
      fireEvent.keyDown(search(), { key: "Tab" });
      expect(screen.getByRole("button", { name: "Leave wotdev" })).toBeInTheDocument();
      expect(screen.queryByText("op-fig")).not.toBeInTheDocument();
      expect(screen.getByText("older_one")).toBeInTheDocument();
      fireEvent.keyDown(search(), { key: "Backspace" });
      expect(screen.queryByRole("button", { name: "Leave wotdev" })).not.toBeInTheDocument();
      expect(screen.getByText("op-fig")).toBeInTheDocument();
    });

    it("Escape leaves the repo scope without reaching the frame that closes on Escape", async () => {
      mock(MANY);
      let frameEscapes = 0;
      render(
        <div onKeyDown={(e) => e.key === "Escape" && frameEscapes++}>
          <ReviewPicker onOpenWorktree={() => {}} onAddRepo={() => {}} onDeleteReview={async () => false} />
        </div>,
      );
      await waitFor(() => expect(screen.getByText("op-fig")).toBeInTheDocument());
      fireEvent.change(search(), { target: { value: "wotdev/" } });
      expect(screen.getByRole("button", { name: "Leave wotdev" })).toBeInTheDocument();
      fireEvent.keyDown(search(), { key: "Escape" });
      expect(screen.queryByRole("button", { name: "Leave wotdev" })).not.toBeInTheDocument();
      expect(frameEscapes).toBe(0);
      fireEvent.keyDown(search(), { key: "Escape" });
      expect(frameEscapes).toBe(1);
    });

    it("typing a repo prefix and a slash narrows to that repo and keeps the rest as the query", async () => {
      mock(MANY);
      renderPicker();
      await waitFor(() => expect(screen.getByText("op-fig")).toBeInTheDocument());
      fireEvent.change(search(), { target: { value: "wot/tank" } });
      expect(screen.getByRole("button", { name: "Leave wotdev" })).toBeInTheDocument();
      expect(search()).toHaveValue("tank");
      expect(screen.getByText("mini_tank")).toBeInTheDocument();
      expect(screen.queryByText("context_menu")).not.toBeInTheDocument();
    });

    it("puts the current review's repo first in the ⌘K frame", async () => {
      mock(MANY);
      renderPicker({ current: { repoPath: "/r/wotdev/context_menu", mode: "uncommitted" } });
      await waitFor(() => expect(screen.getByText("op-fig")).toBeInTheDocument());
      const headers = screen.getAllByRole("button", { name: /^Only / }).map((b) => b.getAttribute("aria-label"));
      expect(headers).toEqual(["Only wotdev", "Only pencil"]);
    });
  });
});
