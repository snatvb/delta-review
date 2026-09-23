import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { CommentIndex } from "./CommentIndex";
import type { Comment } from "../types";

const comments: Comment[] = [
  { id: "l", scope: "line", anchor: { file: "src/a.ts", side: "new", startLine: 22, endLine: null, snippet: "x" }, body: "line note", stale: true, resolved: false, createdAt: "t", updatedAt: "t" },
];

describe("CommentIndex", () => {
  it("lists anchored comments and jumps on click", () => {
    const onJump = vi.fn();
    render(<CommentIndex open onOpenChange={() => {}} comments={comments} onJump={onJump} />);
    // Path is split so the filename (last segment) is always visible. (#r4)
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
    expect(screen.getByText(/L22/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("line note"));
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ id: "l" }));
  });

  it("ignores stale on resolved comments — no header count, no entry badge", () => {
    const mixed: Comment[] = [
      { id: "open", scope: "line", anchor: { file: "src/a.ts", side: "new", startLine: 10, endLine: null, snippet: "x" }, body: "open stale", stale: true, resolved: false, createdAt: "t", updatedAt: "t" },
      { id: "res", scope: "line", anchor: { file: "src/b.ts", side: "new", startLine: 20, endLine: null, snippet: "y" }, body: "resolved stale", stale: true, resolved: true, createdAt: "t", updatedAt: "t" },
    ];
    render(<CommentIndex open onOpenChange={() => {}} comments={mixed} onJump={() => {}} />);
    // Header counts only the open stale comment, not the resolved one.
    expect(screen.getByText(/1 stale/)).toBeInTheDocument();
    // Only the open comment carries the "⚠ stale" entry badge.
    expect(screen.getAllByText("⚠ stale")).toHaveLength(1);
  });

  it("offers stale cards resolve + delete but no edit", () => {
    const onToggleResolved = vi.fn();
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    render(
      <CommentIndex
        open onOpenChange={() => {}} comments={comments} onJump={() => {}}
        onEdit={onEdit} onDelete={onDelete} onToggleResolved={onToggleResolved}
      />,
    );
    expect(screen.getByTitle("Resolve")).toBeInTheDocument();
    expect(screen.getByTitle("Delete")).toBeInTheDocument();
    expect(screen.queryByTitle("Edit")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Resolve"));
    expect(onToggleResolved).toHaveBeenCalledWith("l");

    // Delete goes through the confirm dialog before reaching onDelete.
    fireEvent.click(screen.getByTitle("Delete"));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("l");
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("edits fresh cards inline; saving persists and closes the editor", () => {
    const onEdit = vi.fn();
    const onJump = vi.fn();
    const fresh: Comment[] = [{ ...comments[0], id: "f", stale: false, body: "draft text" }];
    render(
      <CommentIndex
        open onOpenChange={() => {}} comments={fresh} onJump={onJump}
        onEdit={onEdit} onDelete={vi.fn()} onToggleResolved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTitle("Edit"));
    const area = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(area.value).toBe("draft text");
    // Typing inside the editor must not count as a card click (no jump).
    fireEvent.click(area);
    expect(onJump).not.toHaveBeenCalled();
    fireEvent.change(area, { target: { value: "rewritten" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(onEdit).toHaveBeenCalledWith("f", "rewritten");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("resolved cards swap resolve for reopen", () => {
    const onToggleResolved = vi.fn();
    const done: Comment[] = [{ ...comments[0], id: "d", stale: true, resolved: true }];
    render(
      <CommentIndex
        open onOpenChange={() => {}} comments={done} onJump={() => {}}
        onEdit={vi.fn()} onDelete={vi.fn()} onToggleResolved={onToggleResolved}
      />,
    );
    expect(screen.queryByTitle("Resolve")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Reopen"));
    expect(onToggleResolved).toHaveBeenCalledWith("d");
  });

  describe("delete all", () => {
    it("needs a second tap on the soft-red confirm to fire", () => {
      const onDeleteAll = vi.fn();
      render(
        <CommentIndex
          open onOpenChange={() => {}} comments={comments} onJump={() => {}}
          onDelete={vi.fn()} onDeleteAll={onDeleteAll}
        />,
      );
      // First tap swaps the button for the confirm — nothing fires yet.
      fireEvent.click(screen.getByRole("button", { name: "Delete all comments" }));
      expect(onDeleteAll).not.toHaveBeenCalled();
      const confirm = screen.getByRole("button", { name: "Confirm delete all comments" });
      expect(confirm.className).toContain("bg-destructive/10");
      // Second tap fires.
      fireEvent.click(confirm);
      expect(onDeleteAll).toHaveBeenCalledTimes(1);
      // And the idle button is back.
      expect(screen.getByRole("button", { name: "Delete all comments" })).toBeInTheDocument();
    });

    it("reverts the confirm on its own after a beat", () => {
      vi.useFakeTimers();
      const onDeleteAll = vi.fn();
      render(
        <CommentIndex
          open onOpenChange={() => {}} comments={comments} onJump={() => {}}
          onDelete={vi.fn()} onDeleteAll={onDeleteAll}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete all comments" }));
      act(() => { vi.advanceTimersByTime(3100); });
      expect(onDeleteAll).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Delete all comments" })).toBeInTheDocument();
      vi.useRealTimers();
    });

    it("reverts the confirm on Escape", () => {
      const onDeleteAll = vi.fn();
      render(
        <CommentIndex
          open onOpenChange={() => {}} comments={comments} onJump={() => {}}
          onDelete={vi.fn()} onDeleteAll={onDeleteAll}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete all comments" }));
      fireEvent.keyDown(screen.getByRole("button", { name: "Confirm delete all comments" }), { key: "Escape" });
      expect(onDeleteAll).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Delete all comments" })).toBeInTheDocument();
    });

    it("hides the button when there is nothing to delete", () => {
      render(
        <CommentIndex
          open onOpenChange={() => {}} comments={[]} onJump={() => {}}
          onDelete={vi.fn()} onDeleteAll={vi.fn()}
        />,
      );
      expect(screen.queryByRole("button", { name: "Delete all comments" })).not.toBeInTheDocument();
    });
  });
});
