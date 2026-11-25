// Jumping to a file (tree click) must preload its diff, so scrolling to a distant
// file doesn't land on a blank card while the fetch starts. In headless render the
// viewport has zero height, so no section auto-mounts — the ONLY way the fetch fires
// is the jump preload, which isolates the behavior under test.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { render, waitFor, fireEvent, act, screen, within } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";

const getFileDiff = vi.fn();
const getBinaryFileDiff = vi.fn();
vi.mock("../api", () => ({
  api: {
    getFileDiff: (...a: unknown[]) => getFileDiff(...a),
    getBinaryFileDiff: (...a: unknown[]) => getBinaryFileDiff(...a),
    binaryBlobUrl: (_t: unknown, path: string, side: string, mime: string) => `blob://${side}/${path}?${mime}`,
  },
  __setInvokeForDev: vi.fn(),
}));

import { VirtualDiffPane } from "./VirtualDiffPane";
import { anchorFromSpans, scopeForAnchor } from "../review/anchorSpans";
import type { Anchor, AnchorSpan, Comment, FileEntry, Target } from "../types";

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
      onSetCommentSpans={noop}
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
        onSetCommentSpans={noop}
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
    expect(onAddComment).toHaveBeenCalledWith({ file: "a.ts", side: "new", spans: [{ side: "new", start: 2, end: 2, text: "b" }] }, "");
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
    expect(onAddComment).toHaveBeenCalledWith({ file: "a.ts", side: "new", spans: [{ side: "new", start: 2, end: 4, text: "b\nc\nd" }] }, "");
  });
});

// Selection-occurrence highlighting (#occ): picking text inside one row
// highlights the string's other occurrences across the same file's shown lines;
// collapsing the selection clears them. Same fake-viewport harness as above.
describe("VirtualDiffPane selection occurrences", () => {
  const oneFile: FileEntry[] = [{ path: "a.ts", status: "modified", additions: 3, deletions: 0, binary: false }];
  const content = { status: "modified", binary: false, oldContent: "", newContent: "foo bar\nfoo\nbaz\n" };
  let clientHeightDesc: PropertyDescriptor | undefined;

  beforeAll(() => {
    clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
  });
  afterAll(() => {
    if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
  });
  beforeEach(() => {
    getFileDiff.mockReset();
    getFileDiff.mockResolvedValue(content);
  });

  function pane() {
    return (
      <VirtualDiffPane
        target={target}
        files={oneFile}
        theme="light"
        layout="unified"
        viewedFiles={new Set()}
        comments={[]}
        jump={null}
        prefetch={null}
        onToggleViewed={noop}
        onAddComment={noop}
      onSetCommentSpans={noop}
        onAddFileComment={noop}
        onEditComment={noop}
        onDeleteComment={noop}
        onToggleResolvedComment={noop}
      />
    );
  }

  // Occurrence mark spans (#occ) are absolutely-positioned children of a row's
  // code cell, tinted with the primary token (find's amber marks would need ⌘F).
  const occMarks = (c: ReturnType<typeof render>, row: number) =>
    c.container.querySelectorAll(`[data-row-index="${row}"] .diff-line-syntax-raw > span[class*="bg-primary"]`);

  // Make a real in-row selection: a Range over chars [start, end) of the row's
  // first text node (the syntax template may wrap the text in token spans).
  function selectInRow(c: ReturnType<typeof render>, row: number, start: number, end: number) {
    const code = c.container.querySelector(`[data-row-index="${row}"] .diff-line-syntax-raw`);
    const walker = document.createTreeWalker(code!, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    const sel = document.getSelection();
    expect(text).toBeTruthy();
    expect(sel).toBeTruthy();
    const r = document.createRange();
    r.setStart(text!, start);
    r.setEnd(text!, end);
    sel!.removeAllRanges();
    sel!.addRange(r);
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
  }

  it("selecting part of a word highlights its occurrences across the file", async () => {
    const c = render(pane());
    await waitFor(() => expect(c.container.querySelector('[data-row-index="0"]')).toBeTruthy());
    selectInRow(c, 0, 0, 3); // "foo" of "foo bar"
    await waitFor(() => expect(occMarks(c, 1)).toHaveLength(1));
    expect(occMarks(c, 1)[0].getAttribute("style")).toContain("width: 3ch");
    expect(occMarks(c, 0)).toHaveLength(1); // the picked occurrence is marked too
    expect(occMarks(c, 2)).toHaveLength(0); // "baz" — no match
  });

  it("collapsing the selection clears the marks", async () => {
    const c = render(pane());
    await waitFor(() => expect(c.container.querySelector('[data-row-index="0"]')).toBeTruthy());
    selectInRow(c, 0, 0, 3);
    await waitFor(() => expect(occMarks(c, 1)).toHaveLength(1));
    document.getSelection()!.removeAllRanges();
    act(() => { document.dispatchEvent(new Event("selectionchange")); });
    await waitFor(() => expect(occMarks(c, 1)).toHaveLength(0));
  });
});

// Binary cards are commentable (#point): file-scope notes and image point
// threads render under the fixed-height placeholder/compare area — the threads
// used to need a diff model a binary file never has, which made the header's
// "comment on file" button create comments no one ever saw. Same fake-viewport
// harness as above; useBinaryFile's fetch resolves through the mocked api.
describe("VirtualDiffPane binary card comments", () => {
  let clientHeightDesc: PropertyDescriptor | undefined;

  beforeAll(() => {
    clientHeightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 900 });
  });
  afterAll(() => {
    if (clientHeightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDesc);
  });
  beforeEach(() => {
    getFileDiff.mockReset();
    getBinaryFileDiff.mockReset();
    getBinaryFileDiff.mockResolvedValue({ oldSize: 45, newSize: 1536 });
  });

  const imgFile: FileEntry = { path: "logo.png", status: "modified", additions: 0, deletions: 0, binary: true };
  const binFile: FileEntry = { path: "model.bin", status: "modified", additions: 0, deletions: 0, binary: true };

  function pane(files: FileEntry[], comments: Comment[]) {
    return (
      <VirtualDiffPane
        target={target}
        files={files}
        theme="light"
        layout="unified"
        viewedFiles={new Set()}
        comments={comments}
        onToggleViewed={noop}
        onAddComment={noop}
      onSetCommentSpans={noop}
        onAddFileComment={noop}
        onEditComment={noop}
        onDeleteComment={noop}
        onToggleResolvedComment={noop}
      />
    );
  }

  it("renders a file-scope comment thread under a non-image binary placeholder", async () => {
    const note: Comment = {
      id: "b1", scope: "file",
      anchor: { file: "model.bin", side: "new", startLine: null, endLine: null, snippet: null },
      body: "Where does this blob come from?", stale: false, resolved: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const c = render(pane([binFile], [note]));
    await waitFor(() => expect(c.container.querySelector('[data-file="model.bin"]')).toBeTruthy());
    await waitFor(() => expect(screen.getByText("Where does this blob come from?")).toBeInTheDocument());
  });

  it("renders point-comment threads with pin headers under an image card", async () => {
    const pin: Comment = {
      id: "p1", scope: "point",
      anchor: { file: "logo.png", side: "new", startLine: null, endLine: null, snippet: null, x: 0.42, y: 0.36 },
      body: "The wordmark is blurry here.", stale: false, resolved: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const c = render(pane([imgFile], [pin]));
    await waitFor(() => expect(c.container.querySelector('[data-file="logo.png"]')).toBeTruthy());
    await waitFor(() => expect(screen.getByText("The wordmark is blurry here.")).toBeInTheDocument());
    expect(screen.getByText("x42% y36%")).toBeInTheDocument();
  });
});

describe("VirtualDiffPane selecting more lines for an open comment", () => {
  const oneFile: FileEntry[] = [{ path: "a.ts", status: "modified", additions: 12, deletions: 0, binary: false }];
  const content = { status: "modified", binary: false, oldContent: "", newContent: "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n" };
  const spies = { add: vi.fn(), setSpans: vi.fn(), del: vi.fn() };
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
    for (const spy of Object.values(spies)) spy.mockReset();
  });

  function Harness({ initial = [], fd = content, layout = "unified" }: { initial?: Comment[]; fd?: typeof content; layout?: "unified" | "split" }) {
    const [comments, setComments] = useState<Comment[]>(initial);
    const apply = useMemo(() => ({
      add: (a: Anchor) => setComments((cs) => [...cs, { id: `c${cs.length + 1}`, scope: scopeForAnchor(a), anchor: a, body: "", stale: false, resolved: false, createdAt: "t", updatedAt: "t" }]),
      setSpans: (id: string, spans: AnchorSpan[]) => setComments((cs) => cs.map((c) => (c.id === id ? { ...c, anchor: anchorFromSpans("a.ts", spans) } : c))),
      del: (id: string) => setComments((cs) => cs.filter((c) => c.id !== id)),
    }), []);
    useEffect(() => { getFileDiff.mockResolvedValue(fd); }, [fd]);
    return (
      <VirtualDiffPane
        target={target}
        files={oneFile}
        theme="light"
        layout={layout}
        viewedFiles={new Set()}
        comments={comments}
        onToggleViewed={noop}
        onAddComment={(a, body) => { spies.add(a, body); apply.add(a); }}
        onSetCommentSpans={(id, spans) => { spies.setSpans(id, spans); apply.setSpans(id, spans); }}
        onDeleteComment={(id) => { spies.del(id); apply.del(id); }}
        onAddFileComment={noop}
        onEditComment={noop}
        onToggleResolvedComment={noop}
      />
    );
  }

  const line = (n: number): AnchorSpan => ({ side: "new", start: n, end: n, text: content.newContent.split("\n")[n - 1] });
  const plusOf = (c: ReturnType<typeof render>, n: number) =>
    c.container.querySelector(`[aria-label="comment on line ${n}"]`) as HTMLButtonElement | null;
  const plusInRow = (c: ReturnType<typeof render>, row: number) =>
    c.container.querySelector(`[data-row-index="${row}"] [data-add-comment]`) as HTMLButtonElement | null;
  const areaOf = (c: ReturnType<typeof render>) => c.container.querySelector("[data-comment-id] textarea") as HTMLTextAreaElement | null;
  const row = (c: ReturnType<typeof render>, i: number) => c.container.querySelector(`[data-row-index="${i}"]`) as HTMLElement;
  const blockBottomOfRow = (c: ReturnType<typeof render>, i: number) => parseFloat(row(c, i).style.top) + parseFloat(row(c, i).style.height);
  const blockTop = (c: ReturnType<typeof render>) => parseFloat((areaOf(c)!.closest(".delta-comment-ui") as HTMLElement).style.top);
  const railShadow = (c: ReturnType<typeof render>, i: number) => (row(c, i).firstElementChild as HTMLElement).style.boxShadow;

  async function openDraftOn(c: ReturnType<typeof render>, n: number) {
    await waitFor(() => expect(plusOf(c, n)).toBeTruthy());
    fireEvent.click(plusOf(c, n)!);
    await waitFor(() => expect(areaOf(c)).toBeTruthy());
  }

  it("`+` on another line joins the comment whose editor is open instead of starting a new one", async () => {
    const c = render(<Harness />);
    await openDraftOn(c, 2);
    fireEvent.click(plusOf(c, 5)!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(1));
    expect(spies.setSpans).toHaveBeenCalledWith("c1", [line(2), line(5)]);
    expect(spies.add).toHaveBeenCalledTimes(1);
    expect(c.container.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("moves the editor under the lowest selected line, keeping its text and focus", async () => {
    const c = render(<Harness />);
    await openDraftOn(c, 2);
    expect(blockTop(c)).toBe(blockBottomOfRow(c, 1));
    fireEvent.change(areaOf(c)!, { target: { value: "typed note" } });
    fireEvent.click(plusOf(c, 5)!);
    await waitFor(() => expect(areaOf(c)?.value).toBe("typed note"));
    expect(blockTop(c)).toBe(blockBottomOfRow(c, 4));
    expect(document.activeElement).toBe(areaOf(c));
  });

  it("`+` on a selected line unselects it; unselecting the last line of a blank draft discards the draft", async () => {
    const c = render(<Harness />);
    await openDraftOn(c, 2);
    fireEvent.click(plusOf(c, 5)!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(1));
    fireEvent.click(plusOf(c, 2)!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenLastCalledWith("c1", [line(5)]));
    expect(spies.del).not.toHaveBeenCalled();
    fireEvent.click(plusOf(c, 5)!);
    await waitFor(() => expect(spies.del).toHaveBeenCalledWith("c1"));
    expect(c.container.querySelector("[data-comment-id]")).toBeNull();
  });

  it("unselecting the last line of a comment that has text asks first; Cancel keeps everything", async () => {
    const c = render(<Harness />);
    await openDraftOn(c, 2);
    fireEvent.change(areaOf(c)!, { target: { value: "typed note" } });
    fireEvent.click(plusOf(c, 2)!);
    const dialog = await screen.findByRole("alertdialog");
    expect(spies.del).not.toHaveBeenCalled();
    expect(spies.setSpans).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(areaOf(c)?.value).toBe("typed note");
    fireEvent.click(plusOf(c, 2)!);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(spies.del).toHaveBeenCalledWith("c1");
  });

  it("a drag joins the open comment as one run", async () => {
    const c = render(<Harness />);
    await openDraftOn(c, 2);
    document.elementFromPoint = (() => row(c, 9)) as typeof document.elementFromPoint;
    fireEvent.pointerDown(plusOf(c, 8)!, { button: 0 });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 30 }));
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(spies.setSpans).toHaveBeenCalledWith("c1", [line(2), { side: "new", start: 8, end: 10, text: "h\ni\nj" }]);
    expect(spies.add).toHaveBeenCalledTimes(1);
  });

  it("a deleted line joins the same comment as an old-side span", async () => {
    const c = render(<Harness fd={{ status: "modified", binary: false, oldContent: "x\ny\n", newContent: "a\nb\nc\n" }} />);
    await waitFor(() => expect(plusInRow(c, 3)).toBeTruthy());
    fireEvent.click(plusInRow(c, 3)!);
    await waitFor(() => expect(areaOf(c)).toBeTruthy());
    fireEvent.click(plusInRow(c, 0)!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(1));
    expect(spies.setSpans).toHaveBeenCalledWith("c1", [{ side: "new", start: 2, end: 2, text: "b" }, { side: "old", start: 1, end: 1, text: "x" }]);
  });

  it("gives the selected rows the comment accent and leaves the lines between alone", async () => {
    const c = render(<Harness />);
    await openDraftOn(c, 2);
    expect(railShadow(c, 1)).toContain("--color-emerald-500");
    fireEvent.click(plusOf(c, 5)!);
    await waitFor(() => expect(railShadow(c, 4)).toContain("var(--primary)"));
    expect(railShadow(c, 1)).toContain("var(--primary)");
    for (const between of [2, 3, 5]) expect(railShadow(c, between)).toContain("--color-emerald-500");
  });

  it("in the split view a paired row's left `+` selects the deleted line, its right `+` the added one, and a context row joins from either side", async () => {
    const c = render(<Harness layout="split" fd={{ status: "modified", binary: false, oldContent: "c\nx\n", newContent: "c\ny\n" }} />);
    const plusInCell = (row: number, side: string) =>
      c.container.querySelector(`[data-row-index="${row}"] [data-add-comment="${side}"]`) as HTMLButtonElement | null;
    await waitFor(() => expect(plusInCell(1, "old")).toBeTruthy());
    fireEvent.click(plusInCell(1, "old")!);
    await waitFor(() => expect(areaOf(c)).toBeTruthy());
    fireEvent.click(plusInCell(1, "new")!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(1));
    expect(spies.setSpans).toHaveBeenCalledWith("c1", [{ side: "new", start: 2, end: 2, text: "y" }, { side: "old", start: 2, end: 2, text: "x" }]);
    fireEvent.click(plusInCell(0, "old")!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(2));
    expect(spies.setSpans).toHaveBeenLastCalledWith("c1", [{ side: "new", start: 1, end: 2, text: "c\ny" }, { side: "old", start: 2, end: 2, text: "x" }]);

    const accentOf = (row: number, column: number) =>
      (c.container.querySelectorAll(`[data-row-index="${row}"]`)[column].firstElementChild as HTMLElement).style.boxShadow;
    expect(accentOf(0, 0)).toContain("var(--primary)");
    expect(accentOf(0, 1)).toContain("var(--primary)");
    expect(accentOf(1, 0)).toContain("var(--primary)");
    expect(accentOf(1, 1)).toContain("var(--primary)");
  });

  it("a paired row's selected side alone is marked when the other side isn't selected", async () => {
    const c = render(<Harness layout="split" fd={{ status: "modified", binary: false, oldContent: "c\nx\n", newContent: "c\ny\n" }} />);
    const plusInCell = (row: number, side: string) =>
      c.container.querySelector(`[data-row-index="${row}"] [data-add-comment="${side}"]`) as HTMLButtonElement | null;
    await waitFor(() => expect(plusInCell(1, "new")).toBeTruthy());
    fireEvent.click(plusInCell(0, "old")!);
    await waitFor(() => expect(areaOf(c)).toBeTruthy());
    fireEvent.click(plusInCell(1, "new")!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(1));
    expect(spies.setSpans).toHaveBeenLastCalledWith("c1", [{ side: "new", start: 1, end: 2, text: "c\ny" }]);
    const accentOf = (row: number, column: number) =>
      (c.container.querySelectorAll(`[data-row-index="${row}"]`)[column].firstElementChild as HTMLElement).style.boxShadow;
    expect(accentOf(1, 1)).toContain("var(--primary)");
    expect(accentOf(1, 0)).toContain("--color-rose-500");
  });

  it("a saved comment takes lines too once it is opened for editing", async () => {
    const saved: Comment = {
      id: "s1", scope: "line", body: "saved", stale: false, resolved: false, createdAt: "t", updatedAt: "t",
      anchor: anchorFromSpans("a.ts", [line(2)]),
    };
    const c = render(<Harness initial={[saved]} />);
    await waitFor(() => expect(c.container.querySelector('[data-comment-id="s1"]')).toBeTruthy());
    fireEvent.click(plusOf(c, 5)!);
    await waitFor(() => expect(spies.add).toHaveBeenCalledTimes(1));
    fireEvent.click(within(c.container.querySelector('[data-comment-id="s1"]')!).getByRole("button", { name: "Edit" }));
    fireEvent.click(plusOf(c, 6)!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(1));
    expect(spies.setSpans).toHaveBeenCalledWith("s1", [line(2), line(6)]);
  });

  it("a comment stored before spans existed gains lines the same way", async () => {
    const legacy: Comment = {
      id: "l1", scope: "line", body: "", stale: false, resolved: false, createdAt: "t", updatedAt: "t",
      anchor: { file: "a.ts", side: "new", startLine: 2, endLine: null, snippet: "b" },
    };
    const c = render(<Harness initial={[legacy]} />);
    await waitFor(() => expect(areaOf(c)).toBeTruthy());
    fireEvent.click(plusOf(c, 5)!);
    await waitFor(() => expect(spies.setSpans).toHaveBeenCalledTimes(1));
    expect(spies.setSpans).toHaveBeenCalledWith("l1", [line(2), line(5)]);
  });
});
