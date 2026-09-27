// Jumping to a file (tree click) must preload its diff, so scrolling to a distant
// file doesn't land on a blank card while the fetch starts. In headless render the
// viewport has zero height, so no section auto-mounts — the ONLY way the fetch fires
// is the jump preload, which isolates the behavior under test.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { render, waitFor, fireEvent, act } from "@testing-library/react";

const getFileDiff = vi.fn();
vi.mock("../api", () => ({
  api: { getFileDiff: (...a: unknown[]) => getFileDiff(...a) },
  __setInvokeForDev: vi.fn(),
}));

import { VirtualDiffPane } from "./VirtualDiffPane";
import type { Anchor, Comment, FileEntry, Target } from "../types";

const target: Target = { repoPath: "/r", mode: "all-changes" };
const files: FileEntry[] = [
  { path: "near.ts", status: "modified", additions: 3, deletions: 1, binary: false },
  { path: "far.ts", status: "modified", additions: 5, deletions: 2, binary: false },
];
const noop = () => {};

function paneEl(
  jump: { file: string; n: number } | null,
  prefetch: { file: string; n: number } | null = null,
) {
  return (
    <VirtualDiffPane
      target={target}
      files={files}
      theme="light"
      layout="unified"
      viewedFiles={new Set()}
      comments={[]}
      jump={jump}
      prefetch={prefetch}
      onToggleViewed={noop}
      onAddComment={noop}
      onAddFileComment={noop}
      onEditComment={noop}
      onDeleteComment={noop}
      onToggleResolvedComment={noop}
    />
  );
}

describe("VirtualDiffPane jump", () => {
  beforeEach(() => {
    getFileDiff.mockReset();
    getFileDiff.mockResolvedValue({ status: "modified", binary: false, newContent: "x\n" });
  });

  it("preloads a jumped-to file's diff so its card isn't blank on arrival", async () => {
    const { rerender } = render(paneEl(null));
    expect(getFileDiff).not.toHaveBeenCalled(); // nothing mounts in a zero-height viewport

    rerender(paneEl({ file: "far.ts", n: 1 })); // tree click → jump
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith(target, "far.ts"));
  });

  it("preloads a hovered file's diff via the prefetch signal (before any click)", async () => {
    const { rerender } = render(paneEl(null));
    expect(getFileDiff).not.toHaveBeenCalled();

    rerender(paneEl(null, { file: "far.ts", n: 1 })); // tree hover → prefetch
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledWith(target, "far.ts"));
  });
});

// Sections only mount once viewportH > 0, which in happy-dom never happens on its
// own (no layout → clientHeight 0). Give every element a tall clientHeight so the
// pane reports a real viewport and its rows/buttons render.
describe("VirtualDiffPane comment affordances", () => {
  const oneFile: FileEntry[] = [{ path: "a.ts", status: "modified", additions: 4, deletions: 0, binary: false }];
  const content = { status: "modified", binary: false, oldContent: "", newContent: "a\nb\nc\nd\n" };
  let clientHeightDesc: PropertyDescriptor | undefined;
  let elementFromPoint: typeof document.elementFromPoint;

  beforeAll(() => {
    clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
    elementFromPoint = document.elementFromPoint;
  });
  afterAll(() => {
    if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
    document.elementFromPoint = elementFromPoint;
  });
  beforeEach(() => {
    getFileDiff.mockReset();
    getFileDiff.mockResolvedValue(content);
  });

  function pane(
    comments: Comment[],
    onAddComment: (a: Anchor, body: string) => void,
    onDeleteComment: (id: string) => void = noop,
  ) {
    return (
      <VirtualDiffPane
        target={target}
        files={oneFile}
        theme="light"
        layout="unified"
        viewedFiles={new Set()}
        comments={comments}
        onToggleViewed={noop}
        onAddComment={onAddComment}
        onAddFileComment={noop}
        onEditComment={noop}
        onDeleteComment={onDeleteComment}
        onToggleResolvedComment={noop}
      />
    );
  }

  const addBtn = (c: ReturnType<typeof render>, line: number) =>
    c.container.querySelector(`[aria-label="comment on line ${line}"]`) as HTMLButtonElement | null;

  it("`+` click adds a single-line comment", async () => {
    const onAddComment = vi.fn();
    const c = render(pane([], onAddComment));
    await waitFor(() => expect(addBtn(c, 2)).toBeTruthy());
    fireEvent.click(addBtn(c, 2)!);
    expect(onAddComment).toHaveBeenCalledTimes(1);
    expect(onAddComment).toHaveBeenCalledWith({ file: "a.ts", side: "new", startLine: 2, endLine: null, snippet: "b" }, "");
  });

  it("`+` click on a line that already has a thread doesn't add a second comment", async () => {
    const onAddComment = vi.fn();
    const onDeleteComment = vi.fn();
    const existing: Comment = {
      id: "c1", scope: "line",
      anchor: { file: "a.ts", side: "new", startLine: 2, endLine: null, snippet: "b" },
      body: "already noted", stale: false, resolved: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const c = render(pane([existing], onAddComment, onDeleteComment));
    await waitFor(() => expect(addBtn(c, 2)).toBeTruthy());
    fireEvent.click(addBtn(c, 2)!);
    expect(onAddComment).not.toHaveBeenCalled();
    expect(onDeleteComment).not.toHaveBeenCalled(); // real content stays — no dup, no loss
  });

  it("`+` pressed again while the draft is still empty discards it — no empty comment lingers", async () => {
    const onAddComment = vi.fn();
    const onDeleteComment = vi.fn();
    const existing: Comment = {
      id: "c1", scope: "line",
      anchor: { file: "a.ts", side: "new", startLine: 2, endLine: null, snippet: "b" },
      body: "", stale: false, resolved: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const c = render(pane([existing], onAddComment, onDeleteComment));
    await waitFor(() => expect(addBtn(c, 2)).toBeTruthy());
    fireEvent.click(addBtn(c, 2)!);
    expect(onAddComment).not.toHaveBeenCalled();
    expect(onDeleteComment).toHaveBeenCalledWith("c1");
  });

  it("dragging from `+` creates a range comment over the swept rows", async () => {
    const onAddComment = vi.fn();
    const c = render(pane([], onAddComment));
    await waitFor(() => expect(addBtn(c, 2)).toBeTruthy());
    // The drag tracks rows via elementFromPoint; stand in for hit-testing by
    // resolving the pointer position to the row being swept over.
    document.elementFromPoint = (() => c.container.querySelector('[data-row-index="3"]')) as typeof document.elementFromPoint;
    fireEvent.pointerDown(addBtn(c, 2)!, { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 30 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(onAddComment).toHaveBeenCalledTimes(1); // no single-line click alongside the range
    expect(onAddComment).toHaveBeenCalledWith({ file: "a.ts", side: "new", startLine: 2, endLine: 4, snippet: "b\nc\nd" }, "");
  });
});
