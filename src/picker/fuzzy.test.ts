import { describe, it, expect } from "vitest";
import { fuzzyMatch, rankWorktrees, worktreeActivity } from "./fuzzy";
import type { PickerWorktree, ReviewEntry } from "../types";

function review(lastOpenedAt: string): ReviewEntry {
  return {
    id: "r",
    repoName: "demo",
    target: { repoPath: "/r/demo", worktree: "main", mode: "all-changes" },
    lastOpenedAt,
    commentCount: 0,
    staleCount: 0,
    resolvedCount: 0,
    viewedCount: 0,
    fileCount: 0,
  };
}

describe("fuzzyMatch", () => {
  it("matches a subsequence", () => {
    expect(fuzzyMatch("auth", "feat/auth")).not.toBeNull();
  });
  it("rejects a non-subsequence", () => {
    expect(fuzzyMatch("zzz", "feat/auth")).toBeNull();
  });
  it("empty query scores 0 (matches all)", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
  });
  it("is case-insensitive", () => {
    expect(fuzzyMatch("AUTH", "feat/auth")).not.toBeNull();
  });
});

describe("worktreeActivity", () => {
  it("prefers the joined review's last-open time over the branch's last commit", () => {
    const w: PickerWorktree = {
      path: "/r/demo", branch: "main", isMain: true,
      lastCommitAt: "2026-06-20T00:00:00Z", repoName: "demo", repoId: "r1",
      review: review("2026-06-26T00:00:00Z"),
    };
    expect(worktreeActivity(w)).toBe("2026-06-26T00:00:00Z");
  });
  it("falls back to the last commit without a review", () => {
    const w: PickerWorktree = {
      path: "/r/demo", branch: "main", isMain: true,
      lastCommitAt: "2026-06-20T00:00:00Z", repoName: "demo", repoId: "r1",
    };
    expect(worktreeActivity(w)).toBe("2026-06-20T00:00:00Z");
  });
});

describe("rankWorktrees", () => {
  const wt = (branch: string, repoName: string, lastCommitAt?: string): PickerWorktree => ({
    path: `/r/${branch}`,
    branch,
    isMain: false,
    lastCommitAt,
    dirty: false,
    repoName,
    repoId: "r1",
  });

  it("empty query sorts by activity desc", () => {
    const list = [wt("feat/a", "demo", "2026-06-20T00:00:00Z"), wt("feat/b", "demo", "2026-06-26T00:00:00Z")];
    expect(rankWorktrees(list, "").map((w) => w.branch)).toEqual(["feat/b", "feat/a"]);
  });
  it("a fresh review outranks a newer commit on another folder", () => {
    const withReview: PickerWorktree = {
      ...wt("feat/a", "demo", "2026-06-20T00:00:00Z"),
      review: review("2026-06-27T00:00:00Z"),
    };
    const list = [withReview, wt("feat/b", "demo", "2026-06-26T00:00:00Z")];
    expect(rankWorktrees(list, "").map((w) => w.branch)).toEqual(["feat/a", "feat/b"]);
  });
  it("filters by branch/repo query", () => {
    const list = [wt("feat/a", "demo"), wt("feat/b", "demo")];
    expect(rankWorktrees(list, "feat/a").map((w) => w.branch)).toEqual(["feat/a"]);
  });
  it("is searchable by worktree dir, branch, and repo name independently", () => {
    // worktree dir "spike-wt" (path tail) ≠ branch "feat/login" ≠ repo "acme".
    const w: PickerWorktree = { path: "/Users/me/code/spike-wt", branch: "feat/login", isMain: false, repoName: "acme", repoId: "r1" };
    expect(rankWorktrees([w], "spike")).toHaveLength(1); // worktree dir
    expect(rankWorktrees([w], "login")).toHaveLength(1); // branch
    expect(rankWorktrees([w], "acme")).toHaveLength(1); // repo
    expect(rankWorktrees([w], "zzz")).toHaveLength(0);
  });
});
