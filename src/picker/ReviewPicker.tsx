// The shared "open a review" picker: one flat, searchable list of folders —
// known repositories (their main working copy) and their linked worktrees — with
// an "Add a repo…" action at the right of the search box. A row's identity is
// its FOLDER: the branch shown is the one checked out right now, and the row
// carries the review that opening it would resume. There are deliberately no
// "recent branches" here — picking a branch you can't check out from the picker
// was a fiction (every row of one folder opens the same place), and remembered
// branches outlive their merges. Mounted in two frames — the Home window and
// the ⌘K overlay — which supply their own chrome.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { rankWorktrees } from "./fuzzy";
import { usePickerData } from "./usePickerData";
import { worktreeIdentity, worktreeMeta } from "./pickerUi";
import { Trash2, FolderPlus } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import type { PickerWorktree, ReviewEntry, Target } from "../types";

export interface ReviewPickerProps {
  /** Current review's target, excluded from the list (⌘K frame). Omit on Home. */
  current?: Target;
  onOpenWorktree: (w: PickerWorktree) => void;
  onAddRepo: () => void;
  onDeleteReview: (r: ReviewEntry) => Promise<boolean>;
}

type Group = "repo" | "worktree";
type Row = { key: string; group: Group; node: ReactNode; onActivate: () => void; onDelete?: () => void };

/** Section label shown on the first row of each "repo"/"worktree" run. */
function groupLabel(g: Group): string {
  return g === "repo" ? "Repositories" : "Worktrees";
}

// Virtualized list metrics (px). A repo can have dozens of worktrees, so mounting
// every row is the picker's open cost — we render only the rows in the viewport.
const ROW_H = 50;
const LABEL_H = 24;
const PAD = 6;
const OVERSCAN = 220;
const DEFAULT_VIEWPORT = 420;

type Cell = { top: number; height: number; key: string } & (
  | { kind: "label"; text: string }
  | { kind: "row"; i: number }
);

function worktreeNode(w: PickerWorktree): ReactNode {
  return (
    <>
      {worktreeIdentity(w.repoName, w.path, w.branch)}
      {worktreeMeta(w)}
    </>
  );
}

export function ReviewPicker({ current, onOpenWorktree, onAddRepo, onDeleteReview }: ReviewPickerProps) {
  // Seeds from the shared cache for an instant reopen, then revalidates on mount and
  // whenever the window regains focus, so freshly-created worktrees show up. (#refresh)
  const data = usePickerData();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(DEFAULT_VIEWPORT);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Last real pointer position — ignore scroll-induced mousemove (same coords) so
  // it can't hijack keyboard selection when a row scrolls under a still cursor.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  // Reviews deleted this session: the folder row stays (it's a real place), but
  // its joined review — counts, delete button, resume-on-open — drops off.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());

  async function deleteReviewOf(w: PickerWorktree) {
    const r = w.review;
    if (!r) return;
    if (await onDeleteReview(r)) {
      setDeletedIds((prev) => new Set(prev).add(r.id));
    }
    inputRef.current?.focus();
  }

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Exclude the worktree you're currently viewing — it's not a switch target. Keyed
  // on the worktree path, not mode/base: switching the diff-mode dropdown shouldn't
  // make the current review reappear in the picker.
  const isCurrentWorktree = (path: string) => current != null && path === current.repoPath;

  const visible = (w: PickerWorktree): PickerWorktree =>
    w.review && deletedIds.has(w.review.id) ? { ...w, review: null } : w;

  const ranked = data
    ? rankWorktrees(data.worktrees.filter((w) => !isCurrentWorktree(w.path)).map(visible), query)
    : [];
  // Repositories first, then linked worktrees — the two things the picker offers.
  const rows: Row[] = [
    ...ranked.filter((w) => w.isMain).map((w): Row => ({ key: `wt-${w.path}`, group: "repo", node: worktreeNode(w), onActivate: () => onOpenWorktree(w), onDelete: w.review ? () => void deleteReviewOf(w) : undefined })),
    ...ranked.filter((w) => !w.isMain).map((w): Row => ({ key: `wt-${w.path}`, group: "worktree", node: worktreeNode(w), onActivate: () => onOpenWorktree(w), onDelete: w.review ? () => void deleteReviewOf(w) : undefined })),
  ];
  const labels = rows.map((row, i) => (i === 0 || rows[i - 1].group !== row.group ? groupLabel(row.group) : null));

  const clampedSel = rows.length === 0 ? 0 : Math.min(sel, rows.length - 1);

  // Measure the scroll viewport so we only render the rows inside it (+ overscan).
  useLayoutEffect(() => {
    const h = listRef.current?.clientHeight ?? 0;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    if (h > 0) setViewportH(h);
  }, [data]);

  // Lay rows + group labels out as absolutely-positioned cells with known offsets.
  const cells: Cell[] = [];
  let y = PAD;
  for (let i = 0; i < rows.length; i++) {
    if (labels[i]) {
      cells.push({ kind: "label", text: labels[i]!, top: y, height: LABEL_H, key: `label-${i}` });
      y += LABEL_H;
    }
    cells.push({ kind: "row", i, top: y, height: ROW_H, key: rows[i].key });
    y += ROW_H;
  }
  const totalHeight = y + PAD;
  const visibleCells = cells.filter((c) => c.top + c.height >= scrollTop - OVERSCAN && c.top <= scrollTop + viewportH + OVERSCAN);

  // Keep the keyboard-selected row in view — its cell may not be rendered, so scroll
  // by computed offset rather than scrollIntoView.
  useEffect(() => {
    const el = listRef.current;
    const cell = cells.find((c) => c.kind === "row" && c.i === clampedSel);
    if (!el || !cell) return;
    if (cell.top < el.scrollTop) el.scrollTop = cell.top - PAD;
    else if (cell.top + cell.height > el.scrollTop + el.clientHeight) el.scrollTop = cell.top + cell.height - el.clientHeight + PAD;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampedSel]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(rows.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      rows[clampedSel]?.onActivate();
    } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      rows[clampedSel]?.onDelete?.();
    }
  }

  function onItemMouseMove(e: React.MouseEvent, i: number) {
    const p = lastPointer.current;
    if (p && p.x === e.clientX && p.y === e.clientY) return;
    lastPointer.current = { x: e.clientX, y: e.clientY };
    setSel(i);
  }

  const noRepos = data != null && data.worktrees.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKey}>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 pr-1.5">
        <input
          ref={inputRef}
          autoFocus
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className="h-11 min-w-0 flex-1 bg-transparent px-4 text-[14px] outline-none placeholder:text-muted-foreground/70"
          placeholder="Search repos & worktrees…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
        />
        <button
          type="button"
          onClick={onAddRepo}
          title="Add a repo…"
          aria-label="Add a repo…"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-muted/40 pl-2.5 pr-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <FolderPlus className="size-3.5" /> Add repo
          <Kbd keys="⌘O" className="bg-background/60" />
        </button>
      </div>
      <div
        ref={listRef}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto"
      >
        {data == null ? (
          <div className="px-4 py-8 text-center text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            {noRepos ? (
              <>No repos yet — add one above, or run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">dr</code> in a repo.</>
            ) : (
              "No matches"
            )}
          </div>
        ) : (
          <div style={{ position: "relative", height: totalHeight }}>
            {visibleCells.map((c) =>
              c.kind === "label" ? (
                <div
                  key={c.key}
                  style={{ position: "absolute", top: c.top, height: c.height, left: PAD, right: PAD }}
                  className="flex items-end px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70"
                >
                  {c.text}
                </div>
              ) : (
                <div
                  key={c.key}
                  data-index={c.i}
                  style={{ position: "absolute", top: c.top, height: c.height, left: PAD, right: PAD }}
                  className={`group flex items-center rounded-md ${c.i === clampedSel ? "bg-accent text-accent-foreground" : "hover:bg-muted/60"}`}
                  onMouseMove={(e) => onItemMouseMove(e, c.i)}
                >
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 items-center gap-2.5 px-3 text-left outline-none"
                    onClick={() => rows[c.i].onActivate()}
                  >
                    {rows[c.i].node}
                  </button>
                  {rows[c.i].onDelete && (
                    <button
                      type="button"
                      title="Delete review (⌘⌫)"
                      aria-label="Delete review"
                      onClick={rows[c.i].onDelete}
                      className={`mr-2 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${c.i === clampedSel ? "visible" : "invisible group-hover:visible"}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ),
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-4 border-t border-border/70 px-4 py-1.5 text-[11px] text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>⌘⌫ delete</span>
      </div>
    </div>
  );
}
