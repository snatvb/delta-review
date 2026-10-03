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
    // Two groups: the repo's main copy, and its linked worktrees.
    await waitFor(() => expect(screen.getByText("Repositories")).toBeInTheDocument());
    expect(screen.getByText("Worktrees")).toBeInTheDocument();
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
});
