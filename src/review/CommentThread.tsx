import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import { markdownComponents } from "@/lib/markdownLink";
import { Check, Copy, Pencil, Trash2, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Hint } from "@/components/Hint";
import { CommentEditor } from "./CommentEditor";
import { useCopyCommentForAgent } from "./commentForAgent";
import type { Comment } from "../types";

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// The 3px status rail color encodes the comment's state at a glance, replacing
// the old chunky pills: resolved → emerald, stale → amber, otherwise primary —
// matching the blue accent the diff puts on the line(s) the comment hangs off,
// so the card reads as part of the same annotation (editing shares primary; the
// open editor makes that state obvious on its own).
function railClass(c: Comment, isEditing: boolean): string {
  if (c.resolved && !isEditing) return "bg-emerald-500";
  if (c.stale && !isEditing) return "bg-amber-500";
  return "bg-primary";
}

const ICON_BTN = "size-7 text-muted-foreground hover:text-foreground";
const RESOLVE_BTN = "size-7 text-muted-foreground hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400";
const DEL_BTN = "size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive";

// Host-owned when an editor must outlive its thread: the diff pane re-creates
// a thread whenever the lines it hangs under change.
export type ThreadEditor = {
  open: ReadonlyMap<string, { wasBlank: boolean }>;
  textOf: (id: string) => string | undefined;
  onOpen: (id: string, wasBlank: boolean) => void;
  onClose: (id: string) => void;
  onText: (id: string, text: string) => void;
};

function useOwnEditor(autoOpenDrafts: boolean, comments: Comment[]): ThreadEditor {
  const [open, setOpen] = useState<ReadonlyMap<string, { wasBlank: boolean }>>(() => new Map());
  // Auto-open the editor for a newly-appeared empty (draft) comment. Adjusted
  // during render — not in an effect — so the editor opens in the same commit
  // with no stale-UI flash. `seen` guards against re-opening a closed comment
  // and prevents a render loop.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  if (autoOpenDrafts && comments.some((c) => !seen.has(c.id))) {
    const draft = comments.find((c) => !seen.has(c.id) && c.body.trim() === "");
    setSeen(new Set(comments.map((c) => c.id)));
    if (draft) setOpen((prev) => new Map(prev).set(draft.id, { wasBlank: true }));
  }
  return useMemo(
    () => ({
      open,
      textOf: () => undefined,
      onOpen: (id, wasBlank) => setOpen((prev) => new Map(prev).set(id, { wasBlank })),
      onClose: (id) => setOpen((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      }),
      onText: () => {},
    }),
    [open],
  );
}

export function CommentThread({
  comments,
  onEdit,
  onDelete,
  onToggleResolved,
  editor: hostEditor,
}: {
  comments: Comment[];
  onEdit: (id: string, body: string) => void;
  onDelete: (id: string) => void;
  onToggleResolved: (id: string) => void;
  editor?: ThreadEditor;
}) {
  const ownEditor = useOwnEditor(hostEditor == null, comments);
  const editor = hostEditor ?? ownEditor;
  // The comment pending a delete confirmation (drives the single ConfirmDialog).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Per-comment "copy for agent" clipboard + ✓ flash.
  const { copiedId, copy } = useCopyCommentForAgent();

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      {comments.map((c) => {
        const editing = editor.open.get(c.id);
        const isEditing = editing != null;
        const collapsed = c.resolved && !isEditing;
        return (
          <div
            key={c.id}
            data-comment-id={c.id}
            className={`group flex overflow-hidden rounded-xl border border-border/70 bg-card/60 shadow-sm${collapsed ? " opacity-70" : ""}`}
          >
            <div className={`w-[3px] shrink-0 ${railClass(c, isEditing)}`} />
            <div className="min-w-0 flex-1">
              {isEditing ? (
                <div className="px-4 py-3.5">
                  <CommentEditor
                    initialValue={editor.textOf(c.id) ?? c.body}
                    onChange={(text) => editor.onText(c.id, text)}
                    onSubmit={(body) => {
                      // Saving a never-saved draft while still blank is a no-op
                      // comment — discard it instead of persisting an empty one.
                      if (editing?.wasBlank && body.trim() === "") onDelete(c.id);
                      else onEdit(c.id, body);
                      editor.onClose(c.id);
                    }}
                    onCancel={() => {
                      // A never-saved draft (opened blank, still blank) is discarded.
                      if (editing?.wasBlank && c.body.trim() === "") onDelete(c.id);
                      editor.onClose(c.id);
                    }}
                  />
                </div>
              ) : collapsed ? (
                <div className="flex items-center gap-2.5 px-4 py-2.5">
                  <Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <Hint tip={c.body}>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {c.body.trim() === "" ? "Empty note" : c.body}
                    </span>
                  </Hint>
                  <Hint tip="Reopen">
                    <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Reopen" onClick={() => onToggleResolved(c.id)}>
                      <RotateCcw className="size-4" />
                    </Button>
                  </Hint>
                  <Hint tip="Delete">
                    <Button variant="ghost" size="icon-xs" className={DEL_BTN} aria-label="Delete" onClick={() => setConfirmId(c.id)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </Hint>
                </div>
              ) : (
                <div className="pl-4 pr-3 pt-2.5 pb-3.5">
                  <div className="mb-2 flex items-center gap-1.5">
                    {c.stale ? (
                      <span className="flex items-center gap-1 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                        <TriangleAlert className="size-3.5" /> stale
                      </span>
                    ) : (
                      <span className="text-[12px] text-muted-foreground/70">{relTime(c.createdAt)}</span>
                    )}
                    <div className="ml-auto flex items-center gap-0.5">
                      <Hint tip="Resolve">
                        <Button variant="ghost" size="icon-xs" className={RESOLVE_BTN} aria-label="Resolve" onClick={() => onToggleResolved(c.id)}>
                          <Check className="size-4" />
                        </Button>
                      </Hint>
                      <Hint tip="Edit">
                        <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Edit" onClick={() => editor.onOpen(c.id, c.body.trim() === "")}>
                          <Pencil className="size-4" />
                        </Button>
                      </Hint>
                      <Hint tip="Copy for agent">
                        <Button variant="ghost" size="icon-xs" className={ICON_BTN} aria-label="Copy for agent" onClick={() => copy(c)}>
                          {copiedId === c.id ? <Check className="size-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-4" />}
                        </Button>
                      </Hint>
                      <Hint tip="Delete">
                        <Button variant="ghost" size="icon-xs" className={DEL_BTN} aria-label="Delete" onClick={() => setConfirmId(c.id)}>
                          <Trash2 className="size-4" />
                        </Button>
                      </Hint>
                    </div>
                  </div>
                  {c.body.trim() === "" ? (
                    <button
                      className="self-start text-[13px] italic text-muted-foreground/70 transition-colors hover:text-foreground"
                      onClick={() => editor.onOpen(c.id, c.body.trim() === "")}
                    >
                      Empty note — click to edit
                    </button>
                  ) : (
                    <div className="prose prose-sm max-w-none break-words prose-pre:my-1.5 prose-pre:text-[12px] prose-code:text-[12px]">
                      <Markdown components={markdownComponents}>{c.body}</Markdown>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        open={confirmId != null}
        title="Delete this comment?"
        message="This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmId) onDelete(confirmId);
          setConfirmId(null);
        }}
        onCancel={() => setConfirmId(null)}
      />
    </div>
  );
}
