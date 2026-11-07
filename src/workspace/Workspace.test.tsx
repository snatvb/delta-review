// src/workspace/Workspace.test.tsx — opens its target on mount; mode switch re-opens in place
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const openReview = vi.fn();
const openTarget = vi.fn();
const refreshReview = vi.fn();
const listCommits = vi.fn();
const computeDiff = vi.fn();
const getBaseStrategy = vi.fn();
vi.mock("../api", () => ({
  api: {
    openReview: (...a: unknown[]) => openReview(...a),
    openTarget: (...a: unknown[]) => openTarget(...a),
    refreshReview: (...a: unknown[]) => refreshReview(...a),
    listCommits: (...a: unknown[]) => listCommits(...a),
    computeDiff: (...a: unknown[]) => computeDiff(...a),
    // The base chip asks for the repo strategy on mount; default = auto.
    getBaseStrategy: (...a: unknown[]) => getBaseStrategy(...a),
    setBaseStrategy: vi.fn(),
    listBranches: vi.fn().mockResolvedValue({ branches: [], suggested: null }),
    saveReview: vi.fn(),
    exportReview: vi.fn(),
    getFileDiff: vi.fn(),
    // The empty-session path renders <NothingToReview>, which enumerates the repo's
    // other worktrees; default to none so it shows its placeholder.
    listWorktrees: vi.fn().mockResolvedValue([]),
    showPicker: vi.fn(),
    // Already-installed → the header CLI CTA hides itself, keeping these tests focused.
    cliStatus: vi.fn().mockResolvedValue({ supported: true, installed: true, path: "/usr/local/bin/delta" }),
    installCli: vi.fn(),
  },
}));

// Capture the event handlers the Workspace registers so tests can fire them.
let fsChanged: ((e: { payload: { paths: string[]; gitMeta: boolean } }) => void) | null = null;
let setMode: ((e: { payload: string }) => void) | null = null;
let reopen: (() => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: never }) => void) => {
    if (name === "fs:changed") fsChanged = cb as never;
    if (name === "cli:set-mode") setMode = cb as never;
    if (name === "review:reopen") reopen = cb as never;
    return Promise.resolve(() => {});
  },
}));

import { Workspace } from "./Workspace";
import { api } from "../api";
import { setChangeDetection } from "../changeDetection";
import { setHideIgnoredFiles } from "../ignoredFilesPref";
import { setHideViewedFiles } from "../hideViewedFilesPref";
import { setViewedStatsExclude } from "../viewedStatsPref";
import type { FileDiff, Target } from "../types";

const target: Target = { repoPath: "/r", mode: "all-changes" };
const minimalSession = {
  review: { id: "x", target: { repoPath: "/r", worktree: "main", mode: "all-changes" }, comments: [], viewed: [], snapshot: { baseOid: "b", capturedAt: "t" }, createdAt: "t", lastOpenedAt: "t", version: 1 },
  summary: { files: [], baseLabel: "main", headLabel: "wt" },
  vcs: "git",
};
const fileSession = {
  ...minimalSession,
  summary: { files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false }], baseLabel: "main", headLabel: "wt" },
};
// A review with one regular and one .deltaignore'd file — the eye-toggle's case.
const ignoredSession = {
  ...minimalSession,
  summary: {
    files: [
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
      { path: "src/gen.ts", status: "modified", additions: 0, deletions: 0, binary: false, ignored: true },
    ],
    baseLabel: "main",
    headLabel: "wt",
  },
};
const COMMITS = [
  { oid: "o0", shortOid: "o0aaaaa", subject: "third", author: "me", time: 3 },
  { oid: "o1", shortOid: "o1bbbbb", subject: "second", author: "me", time: 2 },
  { oid: "o2", shortOid: "o2ccccc", subject: "first", author: "me", time: 1 },
];
const commitTarget: Target = { repoPath: "/r", mode: "commit", commit: "o1" };

describe("Workspace", () => {
  beforeEach(() => {
    openReview.mockReset();
    openTarget.mockReset();
    refreshReview.mockReset();
    listCommits.mockReset().mockResolvedValue({ commits: [], hasMore: false });
    computeDiff.mockReset().mockResolvedValue({ files: [], baseLabel: "p", headLabel: "c" });
    getBaseStrategy.mockReset().mockResolvedValue(null);
    fsChanged = null;
    setMode = null;
    reopen = null;
    setChangeDetection("on");
  });

  it("opens the review for its target on mount", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());
    expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes", base: undefined });
  });

  it("opens the review on its canonical mode, not 'commit'", async () => {
    // A ?mode=commit cold-start review still opens canonically (branch-vs-base);
    // commit mode is a display overlay, never the persisted review mode.
    openReview.mockResolvedValue(fileSession);
    listCommits.mockResolvedValue({ commits: COMMITS, hasMore: false });
    render(<Workspace target={commitTarget} />);
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "branch-vs-base", base: undefined }));
    expect(openTarget).not.toHaveBeenCalled();
  });

  it("applies an explicit --mode forwarded from the CLI in place (cli:set-mode)", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());
    openReview.mockClear();

    act(() => setMode?.({ payload: "uncommitted" }));
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted", base: undefined }));
    expect(openTarget).not.toHaveBeenCalled();
  });

  it("shows the base chip with its resolved base on base-diffing modes only (#base)", async () => {
    openReview.mockResolvedValue({ ...minimalSession, summary: { ...minimalSession.summary, baseLabel: "dev" } });
    getBaseStrategy.mockResolvedValue(null); // auto
    render(<Workspace target={target} />); // all-changes → base participates
    const chip = await screen.findByRole("button", { name: /base branch/i });
    expect(chip).toHaveTextContent("vs");
    expect(chip).toHaveTextContent("dev");
    expect(chip).toHaveTextContent("(auto)");

    // Switching to a mode without a base hides the chip.
    openReview.mockClear();
    act(() => setMode?.({ payload: "uncommitted" }));
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "uncommitted", base: undefined }));
    expect(screen.queryByRole("button", { name: /base branch/i })).toBeNull();
  });

  it("a pinned repo strategy badges the chip and the URL carries an explicit base (#base)", async () => {
    getBaseStrategy.mockResolvedValue({ kind: "branch", name: "dev" });
    // The persisted review echoes the injected base back, like the real backend.
    openReview.mockResolvedValue({ ...minimalSession, review: { ...minimalSession.review, target: { repoPath: "/r", worktree: "main", mode: "all-changes", base: "dev" } } });
    render(<Workspace target={{ ...target, base: "dev" }} />);
    const chip = await screen.findByRole("button", { name: /base branch/i });
    expect(chip).toHaveTextContent("dev");
    expect(chip).not.toHaveTextContent("(auto)"); // explicit override → no badge
    expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes", base: "dev" });
  });

  it("renders the commit stepper in commit mode and steps to the next commit", async () => {
    openReview.mockResolvedValue(fileSession);
    listCommits.mockResolvedValue({ commits: COMMITS, hasMore: false });
    computeDiff.mockResolvedValue(fileSession.summary); // pinned commit has files → panes render
    render(<Workspace target={commitTarget} />);

    // Stepper shows the pinned commit's position (o1 is index 1 of 3) + its short oid.
    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("2/3"));
    expect(screen.getByRole("button", { name: /diff mode/i })).toHaveTextContent("o1bbbbb");
    expect(openTarget).not.toHaveBeenCalled(); // no window spawned for the overlay

    // Stepping "next" advances to o2 and recomputes that commit's isolated diff.
    computeDiff.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /next commit/i }));
    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("3/3"));
    expect(computeDiff).toHaveBeenCalledWith(expect.objectContaining({ mode: "commit", commit: "o2" }));
  });

  it("loads the next page when stepping past the last loaded commit", async () => {
    openReview.mockResolvedValue(fileSession);
    listCommits.mockImplementation((_t: unknown, skip: number) =>
      Promise.resolve(skip === 0 ? { commits: COMMITS, hasMore: true } : { commits: [{ ...COMMITS[0], oid: "o3", shortOid: "o3ddddd" }], hasMore: false }),
    );
    computeDiff.mockResolvedValue(fileSession.summary);
    render(<Workspace target={{ ...commitTarget, commit: "o2" }} />);

    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("3/3+"));
    fireEvent.click(screen.getByRole("button", { name: /next commit/i }));
    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("4/4"));
    expect(listCommits).toHaveBeenLastCalledWith(expect.anything(), 3, 100);
  });

  it("shows the stepper in 'Last commit' mode too, anchored at the newest commit", async () => {
    openReview.mockResolvedValue(fileSession);
    listCommits.mockResolvedValue({ commits: COMMITS, hasMore: false });
    render(<Workspace target={{ repoPath: "/r", mode: "last-commit" }} />);
    // Stepper appears at HEAD (index 0 → "1/3") even though no commit is pinned.
    await waitFor(() => expect(screen.getByTestId("commit-stepper")).toHaveTextContent("1/3"));
    // Trigger still reads the canonical mode (not pinned), and no commit diff is fetched.
    expect(screen.getByRole("button", { name: /diff mode/i })).toHaveTextContent("Last commit");
    expect(computeDiff).not.toHaveBeenCalled();
    // Prev is disabled at HEAD; Next (older) is enabled.
    expect(screen.getByRole("button", { name: /previous commit/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /next commit/i })).toBeEnabled();
  });

  it("a filesystem change surfaces a Refresh button instead of updating the diff in place (#12)", async () => {
    openReview.mockResolvedValue(fileSession); // showing src/a.ts
    // The re-diff swaps in a differently-named file, so we can tell whether it
    // was applied to the screen or merely staged behind the Refresh button.
    refreshReview.mockResolvedValue({
      ...minimalSession,
      summary: { files: [{ path: "src/zzztest.ts", status: "modified", additions: 2, deletions: 0, binary: false }], baseLabel: "main", headLabel: "wt" },
    });
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    // No Refresh button until something changes.
    expect(screen.queryByRole("button", { name: /^refresh$/i })).toBeNull();

    // The watcher reports a change to a file we're showing.
    await act(async () => {
      fsChanged?.({ payload: { paths: ["src/a.ts"], gitMeta: false } });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument());
    expect(refreshReview).toHaveBeenCalled();
    // The diff was NOT updated in place — the new file isn't shown yet.
    expect(screen.queryAllByText(/zzztest\.ts/)).toHaveLength(0);

    // Clicking Refresh applies the pending change and clears the button.
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^refresh$/i })).toBeNull());
    await waitFor(() => expect(screen.queryAllByText(/zzztest\.ts/).length).toBeGreaterThan(0));
  });

  it("re-diffs on demand from the icon button when nothing was detected", async () => {
    openReview.mockResolvedValue(fileSession);
    refreshReview.mockResolvedValue(fileSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /re-diff now/i }));
    await waitFor(() => expect(refreshReview).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: /re-diff now/i })).toBeEnabled());
  });

  it("keeps compact Refresh clickable and its keyboard shortcut working", async () => {
    openReview.mockResolvedValue(fileSession);
    refreshReview.mockResolvedValue({
      ...fileSession,
      summary: { ...fileSession.summary, files: [{ ...fileSession.summary.files[0], path: "src/b.ts" }] },
    });
    render(<Workspace target={target} />);
    await screen.findByTestId("diff-pane");
    await act(async () => {
      fsChanged?.({ payload: { paths: ["src/a.ts"], gitMeta: false } });
    });

    const refresh = await screen.findByRole("button", { name: "Refresh" });
    expect(refresh).toHaveTextContent(/^Refresh$/);
    fireEvent.keyDown(window, { key: "r", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument());
    expect(screen.getByText("b.ts")).toBeInTheDocument();

    refreshReview.mockClear();
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    await waitFor(() => expect(refreshReview).toHaveBeenCalledOnce());
  });

  it("keeps the Refresh spinner up until the pane's reload lands, not just the re-diff IPC (#refresh-feedback)", async () => {
    openReview.mockResolvedValue(fileSession);
    refreshReview.mockResolvedValue(fileSession);
    // Sections only mount once viewportH > 0, which never happens on its own in
    // happy-dom (no layout → clientHeight 0) — mirror VirtualDiffPane.test's stub.
    const clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight")!;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
    try {
      render(<Workspace target={target} />);
      await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

      // A file reload that stays pending pins the spinner (the icon button is the
      // spinner's proxy here: disabled while refreshing)…
      let release!: (v: FileDiff) => void;
      vi.mocked(api.getFileDiff).mockImplementation(() => new Promise<FileDiff>((r) => { release = r; }));
      fireEvent.click(screen.getByRole("button", { name: /re-diff now/i }));
      await waitFor(() => expect(refreshReview).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByRole("button", { name: /re-diff now/i })).toBeDisabled());

      // …and only the reload settling re-enables it — the old code stopped the
      // spinner right as the heavy re-render began, which read as a hang.
      release({ status: "modified", additions: 0, deletions: 0, binary: false } as FileDiff);
      await waitFor(() => expect(screen.getByRole("button", { name: /re-diff now/i })).toBeEnabled());
      vi.mocked(api.getFileDiff).mockReset(); // back to the default instant-resolve mock
    } finally {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
    }
  });

  it("stops the Refresh spinner when the reload empties the diff — no pane to settle it (#refresh-feedback)", async () => {
    openReview.mockResolvedValue(fileSession);
    refreshReview.mockResolvedValue(minimalSession); // everything got committed → empty diff
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /re-diff now/i }));
    // The empty state renders INSTEAD of the diff pane, so nothing would ever
    // report the reload as settled — the stand-in must stop the spinner anyway.
    await waitFor(() => expect(screen.getByRole("button", { name: /re-diff now/i })).toBeEnabled());
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());
  });

  it("ignores a git-meta event whose re-diff is unchanged — no spurious Refresh (#12)", async () => {
    // A `.git/index` stat-refresh (e.g. starting a dev server) fires git-meta with
    // no paths, but the diff is byte-identical. Returning the same session means
    // sig === sigRef, so nothing should surface.
    openReview.mockResolvedValue(fileSession); // showing src/a.ts
    refreshReview.mockResolvedValue(fileSession); // identical re-diff — nothing changed
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    await act(async () => {
      fsChanged?.({ payload: { paths: [], gitMeta: true } });
      // Resume past `await refreshReview` and drain its continuation so a
      // (wrongly) staged refresh would have rendered before we assert its absence.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshReview).toHaveBeenCalled(); // the re-diff ran…
    // …and found nothing to show.
    expect(screen.queryByRole("button", { name: /refresh/i })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: /re-diff now/i })).toBeEnabled());
  });

  it("coalesces fs events that arrive during a re-diff into one follow-up", async () => {
    openReview.mockResolvedValue(fileSession);
    let finishFirst: (s: typeof fileSession) => void = () => {};
    refreshReview
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(fileSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    await act(async () => {
      fsChanged?.({ payload: { paths: ["src/a.ts"], gitMeta: false } });
      fsChanged?.({ payload: { paths: ["src/b.ts"], gitMeta: false } });
      fsChanged?.({ payload: { paths: [], gitMeta: true } });
    });
    expect(refreshReview).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirst(fileSession);
    });
    await waitFor(() => expect(refreshReview).toHaveBeenCalledTimes(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(refreshReview).toHaveBeenCalledTimes(2);
  });

  it("skips the background re-diff when change detection is off", async () => {
    openReview.mockResolvedValue(fileSession);
    setChangeDetection("off");
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    await act(async () => {
      fsChanged?.({ payload: { paths: ["src/a.ts"], gitMeta: true } });
    });
    expect(refreshReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /re-diff now/i })).toBeEnabled();
  });

  it("reopens the review when the backend reuses this window for another branch", async () => {
    openReview.mockResolvedValue(minimalSession);
    render(<Workspace target={target} />);
    await waitFor(() => expect(reopen).not.toBeNull());
    openReview.mockClear();

    act(() => reopen?.());
    await waitFor(() => expect(openReview).toHaveBeenCalledWith({ repoPath: "/r", mode: "all-changes", base: undefined }));
  });

  it("opens the comments pane in the nothing-to-review state (#empty-review)", async () => {
    // The user reviews uncommitted agent work, leaves comments, the agent commits —
    // the diff is now empty, but the comments must still be reachable: the pane is
    // the only place a comment with no diff left can be read, resolved, or deleted.
    openReview.mockResolvedValue({
      ...minimalSession,
      review: {
        ...minimalSession.review,
        comments: [{ id: "c1", scope: "line", anchor: { file: "src/a.ts", side: "new", startLine: 3, endLine: null, snippet: "x" }, body: "why?", stale: true, resolved: false, createdAt: "t", updatedAt: "t" }],
      },
    });
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByText(/nothing to review/i)).toBeInTheDocument());

    // The toolbar button reflects the count and toggles the pane open.
    expect(screen.queryByTestId("comment-index")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /comments/i }));
    await waitFor(() => expect(screen.getByTestId("comment-index")).toBeInTheDocument());
    expect(screen.getByText("why?")).toBeInTheDocument();
  });

  it("still surfaces Refresh on a git-meta event that moves the diff (commit/checkout) (#12)", async () => {
    openReview.mockResolvedValue(fileSession);
    // A commit/checkout: the snapshot oid moved, so sig changes even though no
    // working-tree path was reported — the button must still appear.
    refreshReview.mockResolvedValue({
      ...fileSession,
      review: { ...fileSession.review, snapshot: { baseOid: "moved", capturedAt: "t2" } },
    });
    render(<Workspace target={target} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /copy for agents/i })).toBeInTheDocument());

    await act(async () => {
      fsChanged?.({ payload: { paths: [], gitMeta: true } });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument());
  });

  // The eye toggle on the tree's "Ignored (N)" group row hides .deltaignore'd
  // files from the diff pane. The choice persists (localStorage) and syncs
  // across open review windows.
  describe("ignored-files toggle", () => {
    // Sections only mount once viewportH > 0, which never happens on its own in
    // happy-dom (no layout → clientHeight 0) — mirror VirtualDiffPane.test's stub
    // so the ignored card's header (and its "ignored" badge) actually renders.
    let clientHeightDesc: PropertyDescriptor | undefined;
    beforeAll(() => {
      clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
    });
    afterAll(() => {
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
    });

    beforeEach(() => {
      // The pref caches its value at module scope, so localStorage.clear() alone
      // wouldn't reset it between tests — write through the setter.
      setHideIgnoredFiles("off");
      localStorage.removeItem("delta.hideIgnoredFiles");
      openReview.mockResolvedValue(ignoredSession);
      listCommits.mockResolvedValue({ commits: [], hasMore: false });
      vi.mocked(api.getFileDiff).mockResolvedValue({ status: "modified", binary: false, oldContent: "a\n", newContent: "b\n" } as FileDiff);
    });

    it("hides the ignored card from the diff pane, not from the tree, and persists", async () => {
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      // The ignored file renders as a (collapsed) card with its badge; the tree
      // carries its own "Ignored (1)" group outside the pane.
      await waitFor(() => expect(within(pane).getByText("ignored")).toBeInTheDocument());
      expect(screen.getByText("Ignored (1)")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Hide ignored files (1)" }));
      expect(within(pane).queryByText("ignored")).not.toBeInTheDocument();
      // The regular file's card is untouched.
      expect(within(pane).getByText("a.ts")).toBeInTheDocument();
      // The tree's Ignored group survives — hiding is pane-only.
      expect(screen.getByText("Ignored (1)")).toBeInTheDocument();
      // Persisted for reloads / other windows.
      expect(localStorage.getItem("delta.hideIgnoredFiles")).toBe("on");

      // And back: the card returns.
      fireEvent.click(screen.getByRole("button", { name: "Show ignored files (1)" }));
      await waitFor(() => expect(within(pane).getByText("ignored")).toBeInTheDocument());
      expect(localStorage.getItem("delta.hideIgnoredFiles")).toBe("off");
    });

    it("adopts a hidden-state change made in another window (storage event)", async () => {
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("ignored")).toBeInTheDocument());

      act(() => {
        localStorage.setItem("delta.hideIgnoredFiles", "on");
        window.dispatchEvent(new StorageEvent("storage", { key: "delta.hideIgnoredFiles", newValue: "on" }));
      });
      await waitFor(() => expect(within(pane).queryByText("ignored")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Show ignored files (1)" })).toHaveAttribute("aria-pressed", "true");
    });

    it("offers no toggle when the review has no ignored files", async () => {
      openReview.mockResolvedValue(fileSession);
      render(<Workspace target={target} />);
      await screen.findByTestId("diff-pane");
      expect(screen.queryByRole("button", { name: /ignored files/i })).not.toBeInTheDocument();
    });

    it("shows an empty state with a way back when every file is ignored and hidden", async () => {
      setHideIgnoredFiles("on");
      openReview.mockResolvedValue({
        ...minimalSession,
        summary: { files: [{ path: "src/gen.ts", status: "modified", additions: 0, deletions: 0, binary: false, ignored: true }], baseLabel: "main", headLabel: "wt" },
      });
      render(<Workspace target={target} />);
      expect(await screen.findByText("Every file in this review is ignored.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Show ignored files" }));
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("ignored")).toBeInTheDocument());
    });
  });

  describe("test-files toggle", () => {
    let clientHeightDesc: PropertyDescriptor | undefined;
    const testSession = {
      ...fileSession,
      summary: {
        ...fileSession.summary,
        files: [
          fileSession.summary.files[0],
          { ...fileSession.summary.files[0], path: "src/a.test.ts", additions: 9, deletions: 4 },
          { ...fileSession.summary.files[0], path: "tests/setup.ts", additions: 20, deletions: 8 },
        ],
      },
    };

    beforeAll(() => {
      clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
    });
    afterAll(() => {
      if (clientHeightDesc) {
        Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
      }
    });
    beforeEach(() => {
      setHideIgnoredFiles("off");
      setHideViewedFiles("off");
      setViewedStatsExclude("off");
      vi.mocked(api.saveReview).mockClear();
      localStorage.removeItem("delta.hideTestFiles");
      window.dispatchEvent(new StorageEvent("storage", { key: "delta.hideTestFiles", newValue: null }));
      openReview.mockResolvedValue(testSession);
      vi.mocked(api.getFileDiff).mockResolvedValue({ status: "modified", binary: false, oldContent: "a\n", newContent: "b\n" } as FileDiff);
    });

    it("hides tests from both panes and all file stats, persists and restores", async () => {
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.test.ts")).toBeInTheDocument());
      const toggle = screen.getByRole("button", { name: "Hide test files (2)" });
      expect(toggle).toHaveAttribute("aria-pressed", "false");
      const toggleColors = toggle.className;
      expect(toggle.querySelector(".lucide-flask-conical")).not.toBeNull();
      expect(toggle.querySelector(".lucide-flask-conical-off")).toBeNull();
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("0 / 3 viewed");
      const totals = screen.getByRole("button", { name: "Toggle unviewed-only totals" });
      expect(totals).toHaveTextContent("+30 −12");
      expect(screen.getByLabelText("+10 / −4 under src")).toBeInTheDocument();

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(toggle.className).toBe(toggleColors);
      expect(toggle.querySelector(".lucide-flask-conical-off")).not.toBeNull();
      expect(toggle.querySelector(".lucide-flask-conical")).toBeNull();
      expect(within(pane).queryByText("a.test.ts")).not.toBeInTheDocument();
      expect(within(pane).queryByText("setup.ts")).not.toBeInTheDocument();
      expect(within(pane).getByText("a.ts")).toBeInTheDocument();
      const tree = screen.getByTestId("files-tree");
      expect(within(tree).queryByText("a.test.ts")).not.toBeInTheDocument();
      expect(within(tree).queryByText("tests")).not.toBeInTheDocument();
      expect(within(tree).getByText("a.ts")).toBeInTheDocument();
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("0 / 1 viewed");
      expect(totals).toHaveTextContent("+1");
      expect(totals).not.toHaveTextContent("−12");
      expect(screen.getByLabelText("+1 / −0 under src")).toBeInTheDocument();
      expect(localStorage.getItem("delta.hideTestFiles")).toBe("on");

      fireEvent.click(screen.getByRole("button", { name: "Show test files (2)" }));
      expect(toggle.className).toBe(toggleColors);
      expect(toggle.querySelector(".lucide-flask-conical")).not.toBeNull();
      expect(toggle.querySelector(".lucide-flask-conical-off")).toBeNull();
      await waitFor(() => expect(within(pane).getByText("a.test.ts")).toBeInTheDocument());
      expect(within(pane).getByText("setup.ts")).toBeInTheDocument();
      const treeCheckbox = within(tree).getByRole("button", { name: "viewed src/a.test.ts" });
      expect(treeCheckbox.querySelector(".lucide-check")).toBeNull();
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("0 / 3 viewed");
      expect(totals).toHaveTextContent("+30 −12");
      expect(localStorage.getItem("delta.hideTestFiles")).toBe("off");
    });

    it("syncs changes from another window", async () => {
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.test.ts")).toBeInTheDocument());
      act(() => {
        localStorage.setItem("delta.hideTestFiles", "on");
        window.dispatchEvent(new StorageEvent("storage", { key: "delta.hideTestFiles", newValue: "on" }));
      });
      expect(within(pane).queryByText("a.test.ts")).not.toBeInTheDocument();
      expect(within(screen.getByTestId("files-tree")).queryByText("a.test.ts")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("0 / 1 viewed");
      expect(screen.getByRole("button", { name: "Show test files (2)" })).toHaveAttribute("aria-pressed", "true");
    });

    it("can be armed before the review has tests", async () => {
      openReview.mockResolvedValue(fileSession);
      render(<Workspace target={target} />);
      await screen.findByTestId("diff-pane");
      fireEvent.click(screen.getByRole("button", { name: "Hide test files (0)" }));
      expect(screen.getByRole("button", { name: "Show test files (0)" })).toHaveAttribute("aria-pressed", "true");
    });

    it("offers a way back when every file is a hidden test", async () => {
      openReview.mockResolvedValue({
        ...testSession,
        summary: { ...testSession.summary, files: testSession.summary.files.slice(1) },
      });
      render(<Workspace target={target} />);
      await screen.findByTestId("diff-pane");
      fireEvent.click(screen.getByRole("button", { name: "Hide test files (2)" }));
      expect(screen.getByText("Every file in this review is a test file.")).toBeInTheDocument();
      expect(screen.getByText("Test files are hidden.")).toBeInTheDocument();
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("0 / 0 viewed");
      expect(screen.getByRole("textbox", { name: "Search files" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show test files" }));
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.test.ts")).toBeInTheDocument());
    });

    it("combines with viewed and ignored filters without marking tests viewed", async () => {
      openReview.mockResolvedValue({
        ...testSession,
        review: { ...testSession.review, viewed: [{ file: "src/a.ts", diffHash: "" }] },
        summary: {
          ...testSession.summary,
          files: [...testSession.summary.files, { ...fileSession.summary.files[0], path: "src/gen.ts", ignored: true }],
        },
      });
      render(<Workspace target={target} />);
      await screen.findByTestId("diff-pane");
      fireEvent.click(screen.getByRole("button", { name: "Hide viewed files (1)" }));
      fireEvent.click(screen.getByRole("button", { name: "Hide ignored files (1)" }));
      fireEvent.click(screen.getByRole("button", { name: "Hide test files (2)" }));
      expect(screen.getByText("All files are hidden by the current filters.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Show test files" }));
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.test.ts")).toBeInTheDocument());
      expect(within(pane).queryByText("a.ts")).not.toBeInTheDocument();
      expect(within(pane).queryByText("gen.ts")).not.toBeInTheDocument();
      expect(within(pane).getByRole("button", { name: "viewed src/a.test.ts" })).toHaveAttribute("aria-pressed", "false");
    });

    it("filters search and list mode too, without clearing the filter on source navigation", async () => {
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      const search = screen.getByRole("textbox", { name: "Search files" });
      const tree = screen.getByTestId("files-tree");
      fireEvent.change(search, { target: { value: "a.test" } });
      expect(within(tree).getByText("a.test.ts")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Hide test files (2)" }));
      expect(within(pane).queryByText("a.test.ts")).not.toBeInTheDocument();
      expect(within(tree).getByText("No files match “a.test”.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("radio", { name: "List" }));
      expect(within(tree).queryByText("src/a.test.ts")).not.toBeInTheDocument();
      fireEvent.change(search, { target: { value: "a.ts" } });
      fireEvent.click(within(tree).getByText("src/a.ts"));
      expect(screen.getByRole("button", { name: "Show test files (2)" })).toHaveAttribute("aria-pressed", "true");

      fireEvent.click(screen.getByRole("button", { name: "Show test files (2)" }));
      fireEvent.change(search, { target: { value: "a.test" } });
      expect(within(tree).getByText("src/a.test.ts")).toBeInTheDocument();
    });

    it("preserves hidden viewed marks and excludes tests from folder checkboxes", async () => {
      openReview.mockResolvedValue({
        ...testSession,
        review: { ...testSession.review, viewed: [{ file: "src/a.test.ts", diffHash: "test-hash" }] },
      });
      render(<Workspace target={target} />);
      await screen.findByTestId("diff-pane");
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("1 / 3 viewed");

      fireEvent.click(screen.getByRole("button", { name: "Hide test files (2)" }));
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("0 / 1 viewed");
      expect(screen.getByRole("button", { name: "Hide viewed files (0)" })).toBeInTheDocument();
      expect(api.saveReview).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "viewed folder src" }));
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("1 / 1 viewed");
      await waitFor(() => expect(api.saveReview).toHaveBeenCalled());
      const saves = vi.mocked(api.saveReview).mock.calls;
      expect(saves[saves.length - 1][0].viewed).toEqual([
        { file: "src/a.test.ts", diffHash: "test-hash" },
        { file: "src/a.ts", diffHash: "" },
      ]);

      fireEvent.click(screen.getByRole("button", { name: "Show test files (2)" }));
      expect(screen.getByLabelText("Files viewed")).toHaveTextContent("2 / 3 viewed");
      const tree = screen.getByTestId("files-tree");
      expect(within(tree).getByRole("button", { name: "viewed src/a.test.ts" }).querySelector(".lucide-check")).not.toBeNull();
      expect(within(tree).getByRole("button", { name: "viewed tests/setup.ts" }).querySelector(".lucide-check")).toBeNull();
    });

    it("reveals a hidden test when jumping to its comment", async () => {
      openReview.mockResolvedValue({
        ...testSession,
        review: {
          ...testSession.review,
          comments: [{
            id: "ct", scope: "line", body: "check test",
            anchor: { file: "src/a.test.ts", side: "new", startLine: 1, endLine: null, snippet: null },
            stale: false, resolved: false, createdAt: "t", updatedAt: "t",
          }],
        },
      });
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      fireEvent.click(screen.getByRole("button", { name: "Hide test files (2)" }));
      expect(within(pane).queryByText("a.test.ts")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Comments (1)" }));
      fireEvent.click(screen.getByRole("button", { name: "Jump to comment on src/a.test.ts" }));
      await waitFor(() => expect(within(pane).getByText("a.test.ts")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Hide test files (2)" })).toHaveAttribute("aria-pressed", "false");
    });
  });

  // The CheckCheck toggle in the workspace toolbar hides viewed files' cards
  // from the diff pane (Settings → General exposes the same pref). The choice
  // persists (localStorage) and syncs across open review windows; the tree
  // keeps every row, so unmarking stays possible.
  describe("viewed-files toggle", () => {
    // Sections only mount once viewportH > 0, which never happens on its own in
    // happy-dom (no layout → clientHeight 0) — mirror the ignored suite's stub
    // so the cards (and their "Viewed" buttons) actually render.
    let clientHeightDesc: PropertyDescriptor | undefined;
    beforeAll(() => {
      clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
      Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
    });
    afterAll(() => {
      if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
    });

    beforeEach(() => {
      // The pref caches its value at module scope, so localStorage.clear() alone
      // wouldn't reset it between tests — write through the setter.
      setHideViewedFiles("off");
      localStorage.removeItem("delta.hideViewedFiles");
      openReview.mockResolvedValue(fileSession);
      listCommits.mockResolvedValue({ commits: [], hasMore: false });
      vi.mocked(api.getFileDiff).mockResolvedValue({ status: "modified", binary: false, oldContent: "a\n", newContent: "b\n" } as FileDiff);
    });

    it("a card leaves the pane the moment its file is marked viewed while the toggle is on", async () => {
      // Two files so the pane keeps a live card — with one file the pane would
      // unmount into the all-viewed empty state (that path has its own test).
      openReview.mockResolvedValue({
        ...fileSession,
        summary: {
          files: [
            { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
            { path: "src/b.ts", status: "modified", additions: 1, deletions: 0, binary: false },
          ],
          baseLabel: "main",
          headLabel: "wt",
        },
      });
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());

      // Arm the mode first (the count is 0 — nothing viewed yet)…
      fireEvent.click(screen.getByRole("button", { name: "Hide viewed files (0)" }));
      expect(screen.getByRole("button", { name: "Show viewed files (0)" })).toHaveAttribute("aria-pressed", "true");
      expect(localStorage.getItem("delta.hideViewedFiles")).toBe("on");
      // …then review: marking viewed from the card itself drops it right away.
      fireEvent.click(within(pane).getByRole("button", { name: "viewed src/a.ts" }));
      await waitFor(() => expect(within(pane).queryByText("a.ts")).not.toBeInTheDocument());
      expect(within(pane).getByText("b.ts")).toBeInTheDocument();

      // The tree keeps its row — that's where the mark comes off again. The
      // mode itself stays armed (nothing viewed → nothing to drop, both cards
      // show); turning it off is one click.
      fireEvent.click(screen.getByRole("button", { name: "viewed src/a.ts" }));
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());
      const armed = screen.getByRole("button", { name: "Show viewed files (0)" });
      expect(armed).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(armed);
      expect(screen.getByRole("button", { name: "Hide viewed files (0)" })).toHaveAttribute("aria-pressed", "false");
      expect(localStorage.getItem("delta.hideViewedFiles")).toBe("off");
    });

    it("hides already-viewed cards from the pane, not from the tree, and persists", async () => {
      openReview.mockResolvedValue({
        ...fileSession,
        review: { ...fileSession.review, viewed: [{ file: "src/a.ts", diffHash: "" }] },
        summary: {
          files: [
            { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
            { path: "src/b.ts", status: "modified", additions: 1, deletions: 0, binary: false },
          ],
          baseLabel: "main",
          headLabel: "wt",
        },
      });
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());

      fireEvent.click(screen.getByRole("button", { name: "Hide viewed files (1)" }));
      await waitFor(() => expect(within(pane).queryByText("a.ts")).not.toBeInTheDocument());
      // The unviewed file's card is untouched.
      expect(within(pane).getByText("b.ts")).toBeInTheDocument();
      // The tree keeps the viewed row (checkbox still there) — hiding is pane-only.
      expect(screen.getByRole("button", { name: "viewed src/a.ts" })).toBeInTheDocument();
      // Persisted for reloads / other windows.
      expect(localStorage.getItem("delta.hideViewedFiles")).toBe("on");

      // And back: the card returns.
      fireEvent.click(screen.getByRole("button", { name: "Show viewed files (1)" }));
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());
      expect(localStorage.getItem("delta.hideViewedFiles")).toBe("off");
    });

    it("adopts a hidden-state change made in another window (storage event)", async () => {
      openReview.mockResolvedValue({
        ...fileSession,
        review: { ...fileSession.review, viewed: [{ file: "src/a.ts", diffHash: "" }] },
      });
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());

      act(() => {
        localStorage.setItem("delta.hideViewedFiles", "on");
        window.dispatchEvent(new StorageEvent("storage", { key: "delta.hideViewedFiles", newValue: "on" }));
      });
      await waitFor(() => expect(within(pane).queryByText("a.ts")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Show viewed files (1)" })).toHaveAttribute("aria-pressed", "true");
    });

    it("shows an empty state with a way back when every file is viewed and hidden", async () => {
      setHideViewedFiles("on");
      openReview.mockResolvedValue({
        ...fileSession,
        review: { ...fileSession.review, viewed: [{ file: "src/a.ts", diffHash: "" }] },
      });
      render(<Workspace target={target} />);
      expect(await screen.findByText("Every file in this review is viewed.")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Show viewed files" }));
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());
    });

    it("jumping to a comment in a hidden viewed file unmarks the file so the jump lands", async () => {
      openReview.mockResolvedValue({
        ...fileSession,
        review: {
          ...fileSession.review,
          viewed: [{ file: "src/a.ts", diffHash: "" }],
          comments: [{
            id: "c1", scope: "line", body: "check this",
            anchor: { file: "src/a.ts", side: "new", startLine: 1, endLine: null, snippet: null },
            stale: false, resolved: false, createdAt: "t", updatedAt: "t",
          }],
        },
        summary: {
          files: [
            { path: "src/a.ts", status: "modified", additions: 1, deletions: 0, binary: false },
            { path: "src/b.ts", status: "modified", additions: 1, deletions: 0, binary: false },
          ],
          baseLabel: "main",
          headLabel: "wt",
        },
      });
      render(<Workspace target={target} />);
      const pane = await screen.findByTestId("diff-pane");
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());

      // Hide the viewed file, then jump to its comment from the index.
      fireEvent.click(screen.getByRole("button", { name: "Hide viewed files (1)" }));
      await waitFor(() => expect(within(pane).queryByText("a.ts")).not.toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: "Comments (1)" }));
      fireEvent.click(screen.getByRole("button", { name: "Jump to comment on src/a.ts" }));

      // The mark came off and the card returned — the jump has somewhere to land.
      await waitFor(() => expect(within(pane).getByText("a.ts")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Show viewed files (0)" })).toBeInTheDocument();
    });
  });
});
