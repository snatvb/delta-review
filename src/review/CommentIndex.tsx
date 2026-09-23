import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Check, MessageSquareDashed, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useResizableWidth, usePaneResize, PaneResizer, COMMENTS_PANE } from "../lib/resizablePane";
import { CommentEditor } from "./CommentEditor";
import type { Comment } from "../types";

// Split so the dir can truncate while the filename (last segment) + line range
// always stay visible. (#r4)
function locationParts(c: Comment): { dir: string; name: string; suffix: string } {
  const a = c.anchor;
  if (!a) return { dir: "", name: "—", suffix: "" };
  const slash = a.file.lastIndexOf("/");
  const dir = slash >= 0 ? a.file.slice(0, slash + 1) : "";
  const name = slash >= 0 ? a.file.slice(slash + 1) : a.file;
  const suffix = a.startLine == null
    ? "file"
    : a.endLine && a.endLine !== a.startLine ? `L${a.startLine}–${a.endLine}` : `L${a.startLine}`;
  return { dir, name, suffix };
}

const ICON_BTN = "size-6 rounded-md text-muted-foreground hover:text-foreground";
const RESOLVE_BTN = "size-6 rounded-md text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400";
const DEL_BTN = "size-6 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive";

export function CommentIndex({
  open, onOpenChange, comments, onJump, onEdit, onDelete, onDeleteAll, onToggleResolved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  onJump: (comment: Comment) => void;
  // Card actions. A stale comment is unreachable in the diff (its anchor no longer
  // resolves to a row, so no thread — and no buttons — render there) and commit-mode
  // filters it out entirely, so the index is the only place it can be acted on.
  // Editing stays off for stale — the text it was written against is gone — but
  // resolve + delete must work, else the comment is stuck in the review and the
  // agent export with no way out.
  onEdit?: (id: string, body: string) => void;
  onDelete?: (id: string) => void;
  // Clears every comment in one save. Gated behind the inline two-tap confirm.
  onDeleteAll?: () => void;
  onToggleResolved?: (id: string) => void;
}) {
  // Inset right panel — part of the layout, not an overlay. The <aside>'s width
  // animates 0↔20rem, so the diff pane makes room smoothly instead of snapping.
  // The jank this used to cause: animating width resizes the sibling diff pane
  // every frame, and a naive width observer there re-renders the whole virtualized
  // list each time. The diff pane now DEBOUNCES its width state (see
  // VirtualDiffPane's ResizeObserver), so during this transition the rows reflow
  // natively — cheap — with zero React re-renders; viewportW commits once it
  // settles. The content is pinned to the right edge and revealed by the widening
  // aside, so it reads as sliding in from the side. (#4)
  //
  // Content stays mounted through the close animation (via `render`) so it can
  // slide out before unmounting. Reduced-motion neutralizes the transition
  // app-wide, so open/close is then instant.
  // Resizable, persisted comments panel; the divider lives on its left edge (the
  // pane grows leftward). `resizing` suppresses the open/close width transition so
  // the edge tracks the pointer instead of easing behind it.
  const [commentsWidth, setCommentsWidth] = useResizableWidth(COMMENTS_PANE);
  const { resizing, separatorProps } = usePaneResize(COMMENTS_PANE, commentsWidth, setCommentsWidth, "left");

  const [render, setRender] = useState(open);
  // Mount immediately on open by adjusting state during render (no effect cascade);
  // the effect only DEFERS unmount until the close animation finishes.
  if (open && !render) setRender(true);
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(() => setRender(false), 220);
    return () => clearTimeout(t);
  }, [open]);
  const visible = open || render;

  // The comment being edited inline (editor swaps in for the body) and the one
  // pending a delete confirmation (drives the single ConfirmDialog).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  // "Delete all" uses an inline two-tap confirm — the button morphs into a soft-red
  // Confirm and the second click fires. No modal to dismiss; the confirm also
  // reverts on its own after a beat (and on Escape) so a stray later click can't
  // wipe everything.
  const [confirmingAll, setConfirmingAll] = useState(false);
  const allConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!confirmingAll) return;
    allConfirmTimer.current = setTimeout(() => setConfirmingAll(false), 3000);
    return () => {
      if (allConfirmTimer.current) clearTimeout(allConfirmTimer.current);
    };
  }, [confirmingAll]);

  const anchored = comments
    .filter((c) => c.scope !== "general")
    .sort((a, b) => {
      const fa = a.anchor?.file ?? "", fb = b.anchor?.file ?? "";
      return fa === fb ? (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0) : fa.localeCompare(fb);
    });
  // A resolved comment is no longer "stale" — resolving is the acknowledgement,
  // so it drops out of both the count and its per-entry badge below.
  const staleCount = anchored.filter((c) => c.stale && !c.resolved).length;

  return (
    <aside
      aria-hidden={!open}
      style={{ width: open ? commentsWidth : 0 }}
      className={`relative shrink-0 ${resizing ? "" : "transition-[width] duration-200 ease-out"}`}
    >
      {/* Clip only the sliding content — the resize divider (rendered after) sits in
          the gutter to the panel's left and must NOT be clipped by the aside. */}
      <div className="absolute inset-0 overflow-hidden">
      {visible && (
      // Floating layout (#pad): transparent panel, no borders, PAD inset; the comment
      // cards float on the canvas. Pinned to the right edge (absolute) so the widening
      // aside reveals it in place — the slide — and the fixed width keeps the content
      // from reflowing while the aside animates.
      <div data-testid="comment-index" style={{ width: commentsWidth }} className="absolute right-0 top-0 flex h-full min-h-0 flex-col pt-3.5">
      <div className="flex h-8 shrink-0 items-center gap-2 pl-0 pr-3.5 text-[12px]">
        <span className="text-[15px] font-semibold text-foreground">Comments</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-[12px] text-muted-foreground">{anchored.length}</span>
        {staleCount > 0 && (
          <span
            className="ml-auto flex items-center gap-1 rounded-md squircle bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400"
            title={`${staleCount} stale comment${staleCount === 1 ? "" : "s"}`}
          >
            ⚠ {staleCount} stale
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {onDeleteAll && anchored.length > 0 && (
            confirmingAll ? (
              <Button
                variant="ghost"
                className="h-6 gap-1 rounded-md bg-destructive/10 px-2 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                aria-label="Confirm delete all comments"
                title="Click again to delete every comment in this review"
                onClick={() => {
                  setConfirmingAll(false);
                  onDeleteAll();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setConfirmingAll(false);
                  }
                }}
              >
                <Trash2 className="size-3.5" /> Delete all?
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 rounded-md text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                aria-label="Delete all comments"
                title="Delete all comments"
                onClick={() => setConfirmingAll(true)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-6 rounded-md bg-foreground/[0.04] text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground"
            aria-label="Close comments"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto pl-0 pr-3.5 pb-3.5 pt-2">
        {anchored.length === 0 && (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <span className="flex size-11 items-center justify-center rounded-2xl squircle bg-muted/60 text-muted-foreground/70">
              <MessageSquareDashed className="size-[22px]" strokeWidth={1.5} />
            </span>
            <p className="mt-3 text-[13px] font-medium text-foreground">No comments yet</p>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground/70">Hover a line in the diff to add one.</p>
          </div>
        )}
        {anchored.map((c) => {
          // A <button> can't host the action buttons, so the card is a div with the
          // button role; the editor swap-in and the hover action cluster opt out of
          // the jump (editor via its wrapper, actions via stopPropagation).
          const editing = editingId === c.id;
          const { dir, name, suffix } = locationParts(c);
          const actionable = Boolean(onToggleResolved || (onEdit && !c.stale) || onDelete);
          return (
          <div
            key={c.id}
            role="button"
            tabIndex={editing ? -1 : 0}
            aria-label={`Jump to comment on ${c.anchor?.file ?? "file"}`}
            className={`group relative flex w-full min-w-0 shrink-0 cursor-pointer flex-col items-start gap-1 overflow-hidden rounded-lg border border-border bg-card px-3 py-2.5 text-left text-[13px] shadow-xs hover:border-foreground/25 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 dark:shadow-none${c.resolved ? " opacity-55" : ""}`}
            onClick={() => { if (!editing) onJump(c); }}
            onKeyDown={(e) => {
              if (editing) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onJump(c);
              }
            }}
          >
            <span className="flex w-full min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
              {/* The dir truncates first (shrink-[9999]); the filename falls back to
                  truncating only when it alone overflows; the line range stays pinned. */}
              <span className="flex min-w-0 flex-1 items-baseline overflow-hidden">
                {dir && <span className="min-w-0 shrink-[9999] truncate text-muted-foreground/55">{dir}</span>}
                <span className="min-w-0 truncate text-foreground/80">{name}</span>
                <span className="ml-1 shrink-0 text-muted-foreground/70">{suffix}</span>
              </span>
              {c.commit && (
                <span
                  className="shrink-0 rounded-md squircle bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  title={`Comment handed off to commit ${c.commit} — click the card to open that commit`}
                >
                  {c.commit.slice(0, 7)}
                </span>
              )}
              {c.stale && !c.resolved && <span className="shrink-0 rounded-md squircle bg-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">⚠ stale</span>}
              {c.resolved && <span className="shrink-0 rounded-md squircle bg-emerald-500/15 px-1.5 py-0.5 text-emerald-600 dark:text-emerald-400">✓</span>}
            </span>
            {editing && onEdit ? (
              <div className="w-full" onClick={(e) => e.stopPropagation()}>
                <CommentEditor
                  initialValue={c.body}
                  onSubmit={(body) => {
                    onEdit(c.id, body);
                    setEditingId(null);
                  }}
                  onCancel={() => setEditingId(null)}
                />
              </div>
            ) : c.body.trim() === "" ? (
              <span className="italic text-muted-foreground/70">Empty note</span>
            ) : (
              <span className="line-clamp-2 w-full break-words text-foreground">{c.body}</span>
            )}
            {/* Hover action cluster, top-right over the header line (the solid card
                backdrop keeps it legible over the location text it covers). Hidden
                while editing — the editor owns the card. */}
            {actionable && !editing && (
              <div
                className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-border/70 bg-card p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                {onToggleResolved && (c.resolved ? (
                  <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Reopen" title="Reopen" onClick={() => onToggleResolved(c.id)}>
                    <RotateCcw className="size-3.5" />
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon-xs" className={RESOLVE_BTN} aria-label="Resolve" title="Resolve" onClick={() => onToggleResolved(c.id)}>
                    <Check className="size-3.5" />
                  </Button>
                ))}
                {/* Stale cards keep their edit pencil off — see the prop comment. */}
                {onEdit && !c.stale && (
                  <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Edit" title="Edit" onClick={() => setEditingId(c.id)}>
                    <Pencil className="size-3.5" />
                  </Button>
                )}
                {onDelete && (
                  <Button variant="ghost" size="icon-xs" className={DEL_BTN} aria-label="Delete" title="Delete" onClick={() => setConfirmId(c.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            )}
          </div>
          );
        })}
      </div>
      <ConfirmDialog
        open={confirmId != null}
        title="Delete this comment?"
        message="This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmId) {
            if (editingId === confirmId) setEditingId(null);
            onDelete?.(confirmId);
          }
          setConfirmId(null);
        }}
        onCancel={() => setConfirmId(null)}
      />
      </div>
      )}
      </div>
      {open && <PaneResizer edge="left" label="Resize comments panel" resizing={resizing} separatorProps={separatorProps} />}
    </aside>
  );
}
