import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Hint } from "@/components/Hint";
import { CommitMetaBody } from "@/components/CommitMetaTip";
import { Check, Copy, MessageSquareDashed, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { useResizableWidth, usePaneResize, PaneResizer, COMMENTS_PANE } from "../lib/resizablePane";
import { pointSuffix } from "../diff/imagePoints";
import { CommentEditor } from "./CommentEditor";
import { useCopyCommentForAgent } from "./commentForAgent";
import type { Comment, CommitMeta } from "../types";

// Split so the dir can truncate while the filename (last segment) + line range
// always stay visible. (#r4)
function locationParts(c: Comment): { dir: string; name: string; suffix: string } {
  const a = c.anchor;
  if (!a) return { dir: "", name: "—", suffix: "" };
  const slash = a.file.lastIndexOf("/");
  const dir = slash >= 0 ? a.file.slice(0, slash + 1) : "";
  const name = slash >= 0 ? a.file.slice(slash + 1) : a.file;
  // Image point comments locate by their pin ("x30% y62%"), like a line number.
  const suffix = a.x != null && a.y != null
    ? pointSuffix(a.x, a.y)
    : a.startLine == null
      ? "file"
      : a.endLine && a.endLine !== a.startLine ? `L${a.startLine}–${a.endLine}` : `L${a.startLine}`;
  return { dir, name, suffix };
}

const ICON_BTN = "size-6 rounded-md text-muted-foreground hover:text-foreground";
const RESOLVE_BTN = "size-6 rounded-md text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400";
const DEL_BTN = "size-6 rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive";

export function CommentIndex({
  open, onOpenChange, comments, onJump, onEdit, onDelete, onDeleteAll, onToggleResolved, commitMeta,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  // Loaded branch commits keyed by full oid — powers the handed-off chip's rich
  // hover (subject/author/date). Older commits may fall outside the loaded page;
  // those chips fall back to the oid-only tooltip.
  commitMeta?: Map<string, CommitMeta>;
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
  // Overlay panel — NOT part of the layout. It floats over the diff's right
  // side (absolute), so the diff pane never makes room for it: the old in-flow
  // aside animated its width on open/close, resizing the virtualized diff every
  // frame — the jank this replaces. The open/close animation is transform +
  // opacity only, compositor properties that don't relayout or repaint the diff
  // underneath.
  //
  // Content stays mounted through the close animation (via `render`) so it can
  // fade out before unmounting. Reduced-motion neutralizes the transition
  // app-wide, so open/close is then instant.
  // Resizable, persisted width; the divider lives on the panel's left edge (it
  // grows leftward), hanging in the 12px gap the panel floats in.
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
  // Per-comment "copy for agent" clipboard + ✓ flash.
  const { copiedId, copy } = useCopyCommentForAgent();

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
      // Same file: by line, with image points ordered by their y fraction (the
      // top-to-bottom order their pins render in), like the diff pane sorts them.
      if (fa === fb) {
        const la = a.anchor?.startLine ?? 0, lb = b.anchor?.startLine ?? 0;
        if (la !== lb) return la - lb;
        return (a.anchor?.y ?? 0) - (b.anchor?.y ?? 0);
      }
      return fa.localeCompare(fb);
    });
  // A resolved comment is no longer "stale" — resolving is the acknowledgement,
  // so it drops out of both the count and its per-entry badge below.
  const staleCount = anchored.filter((c) => c.stale && !c.resolved).length;

  return (
    <aside
      aria-hidden={!open}
      style={{ width: commentsWidth }}
      className={`absolute inset-y-3 right-3 z-30 flex flex-col rounded-xl border border-border bg-background shadow-2xl ring-1 ring-foreground/5 transition-[opacity,translate] duration-200 ease-out dark:ring-foreground/10 ${
        open ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-3 opacity-0"
      }`}
    >
      {visible && (
      // The card look the app's floating surfaces share (see ConfirmDialog).
      // bg-background keeps the bg-card comment cards one notch elevated in both
      // themes, as they were on the old transparent panel.
      <div data-testid="comment-index" className="flex h-full min-h-0 flex-col pt-3">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[12px]">
        <span className="text-[15px] font-semibold text-foreground">Comments</span>
        <span className="text-muted-foreground/50">·</span>
        <span className="text-[12px] text-muted-foreground">{anchored.length}</span>
        {staleCount > 0 && (
          <Hint tip={`${staleCount} stale comment${staleCount === 1 ? "" : "s"}`}>
            <span className="ml-auto flex items-center gap-1 rounded-md squircle bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-400">
              ⚠ {staleCount} stale
            </span>
          </Hint>
        )}
        <span className="ml-auto flex items-center gap-1">
          {onDeleteAll && anchored.length > 0 && (
            confirmingAll ? (
              <Hint tip="Click again to delete every comment in this review">
                <Button
                  variant="ghost"
                  className="h-6 gap-1 rounded-md bg-destructive/10 px-2 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                  aria-label="Confirm delete all comments"
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
              </Hint>
            ) : (
              <Hint tip="Delete all comments">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-6 rounded-md text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label="Delete all comments"
                  onClick={() => setConfirmingAll(true)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </Hint>
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
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-3 pb-3 pt-2">
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
                <Hint
                  tip={
                    <CommitMetaBody
                      meta={commitMeta?.get(c.commit)}
                      oid={c.commit}
                      note="Comment handed off to this commit — click the card to open it"
                    />
                  }
                >
                  <span className="shrink-0 rounded-md squircle bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {c.commit.slice(0, 7)}
                  </span>
                </Hint>
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
                while editing — the editor owns the card. Copy needs no callbacks,
                so the cluster always has at least one action. */}
            {!editing && (
              <div
                className="absolute right-1.5 top-1.5 z-10 flex items-center gap-0.5 rounded-md border border-border/70 bg-card p-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                onClick={(e) => e.stopPropagation()}
              >
                {onToggleResolved && (c.resolved ? (
                  <Hint tip="Reopen">
                    <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Reopen" onClick={() => onToggleResolved(c.id)}>
                      <RotateCcw className="size-3.5" />
                    </Button>
                  </Hint>
                ) : (
                  <Hint tip="Resolve">
                    <Button variant="ghost" size="icon-xs" className={RESOLVE_BTN} aria-label="Resolve" onClick={() => onToggleResolved(c.id)}>
                      <Check className="size-3.5" />
                    </Button>
                  </Hint>
                ))}
                {/* Stale cards keep their edit pencil off — see the prop comment. */}
                {onEdit && !c.stale && (
                  <Hint tip="Edit">
                    <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Edit" onClick={() => setEditingId(c.id)}>
                      <Pencil className="size-3.5" />
                    </Button>
                  </Hint>
                )}
                <Hint tip="Copy for agent">
                  <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Copy for agent" onClick={() => copy(c)}>
                    {copiedId === c.id ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
                  </Button>
                </Hint>
                {onDelete && (
                  <Hint tip="Delete">
                    <Button variant="ghost" size="icon-xs" className={DEL_BTN} aria-label="Delete" onClick={() => setConfirmId(c.id)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </Hint>
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
      {open && <PaneResizer edge="left" label="Resize comments panel" resizing={resizing} separatorProps={separatorProps} />}
    </aside>
  );
}
