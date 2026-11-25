// The shared "open a review" picker: known repositories and their linked
// worktrees, grouped by repo, searchable, with an "Add a repo…" action at the
// right of the search box. A row's identity is its FOLDER: the branch shown is
// the one checked out right now, and the row carries the review that opening it
// would resume. There are deliberately no "recent branches" here — picking a
// branch you can't check out from the picker was a fiction (every row of one
// folder opens the same place), and remembered branches outlive their merges.
// Mounted in two frames — the Home window and the ⌘K overlay — which supply
// their own chrome.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { rankWorktrees } from "./fuzzy";
import { usePickerData } from "./usePickerData";
import { relTime, worktreeIdentity, worktreeMeta } from "./pickerUi";
import {
  buildPickerItems,
  itemRepoId,
  loadCollapsedRepos,
  moveRepo,
  saveCollapsedRepos,
  scopeFromQuery,
  type PickerItem,
  type RepoScope,
} from "./pickerGroups";
import { dropIndex, slides, type RepoBox } from "./repoDrag";
import { sameFolder } from "../lib/sameFolder";
import { cn } from "../lib/utils";
import { REPO_SORTS, useRepoSort, type RepoSort } from "../repoSortPref";
import { useRepoOrder } from "../repoOrderPref";
import { Trash2, FolderPlus, ChevronRight, ChevronDown, ArrowUpDown, ListFilter, X } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { Hint } from "@/components/Hint";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import type { PickerWorktree, ReviewEntry, Target } from "../types";

export interface ReviewPickerProps {
  /** Current review's target, excluded from the list (⌘K frame). Omit on Home. */
  current?: Target;
  onOpenWorktree: (w: PickerWorktree) => void;
  onAddRepo: () => void;
  onDeleteReview: (r: ReviewEntry) => Promise<boolean>;
}

type Row = {
  key: string;
  height: number;
  repoId: string;
  node: ReactNode;
  onActivate: () => void;
  onDelete?: () => void;
  onScope?: () => void;
  onPress?: (event: React.PointerEvent<HTMLButtonElement>) => void;
};

type RepoDrag = { repoId: string; from: number; slot: number };

// Virtualized list metrics (px). A repo can have dozens of worktrees, so mounting
// every row is the picker's open cost — we render only the rows in the viewport.
const WORKTREE_H = 50;
const REPO_H = 34;
const MORE_H = 28;
const PAD = 6;
const OVERSCAN = 220;
const DEFAULT_VIEWPORT = 420;
const CELL_FRAME = { position: "absolute", left: PAD, right: PAD } as const;
const DRAG_THRESHOLD = 4;
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_SPEED = 0.75;

type Cell = { top: number; height: number; key: string; i: number };

function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => event.stopPropagation();
  window.addEventListener("click", swallow, { capture: true });
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

function worktreeNode(w: PickerWorktree, nested: boolean): ReactNode {
  return (
    <div className={`flex min-w-0 flex-1 items-center gap-2.5 ${nested ? "pl-5" : ""}`}>
      {worktreeIdentity(w.repoName, w.path, w.branch, { inRepoGroup: true })}
      {worktreeMeta(w)}
    </div>
  );
}

function repoNode(item: Extract<PickerItem, { kind: "repo" }>): ReactNode {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${item.collapsed ? "" : "rotate-90"}`} />
      <span className="truncate text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">{item.repoName}</span>
      <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">{item.total}</span>
      {item.lastActivity && <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{relTime(item.lastActivity)}</span>}
    </div>
  );
}

function moreNode(hidden: number): ReactNode {
  return <span className="pl-5 text-[11px] text-muted-foreground">+ {hidden} more</span>;
}

function rowHeight(item: PickerItem): number {
  if (item.kind === "repo") {
    return REPO_H;
  }
  return item.kind === "more" ? MORE_H : WORKTREE_H;
}

function RepoSortMenu({ onClosed }: { onClosed: () => void }) {
  const [sort, setSort] = useRepoSort();
  const current = REPO_SORTS.find((item) => item.value === sort)!.shortLabel;
  return (
    <DropdownMenu>
      <Hint tip="Sort repos">
        <DropdownMenuTrigger
          aria-label={`Sort repos: ${current}`}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-muted/40 px-2 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowUpDown className="size-3.5" />
          {current}
          <ChevronDown className="size-3 shrink-0" />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent
        align="end"
        onKeyDown={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        <DropdownMenuRadioGroup aria-label="Sort repos" value={sort} onValueChange={(value) => setSort(value as RepoSort)}>
          {REPO_SORTS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              {item.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="max-w-[15rem] px-2 py-1 text-[11px] text-muted-foreground">
          {sort === "manual" ? "Drag a repo to arrange the list." : "Dragging a repo arranges it manually."}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ReviewPicker({ current, onOpenWorktree, onAddRepo, onDeleteReview }: ReviewPickerProps) {
  // Seeds from the shared cache for an instant reopen, then revalidates on mount and
  // whenever the window regains focus, so freshly-created worktrees show up. (#refresh)
  const data = usePickerData();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<RepoScope | null>(null);
  const [sort, setRepoSort] = useRepoSort();
  const [repoOrder, setRepoOrder] = useRepoOrder();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsedRepos);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
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
  const [repoDrag, setRepoDrag] = useState<RepoDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDrag.current?.(), []);

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
  // on the worktree folder (form-tolerant: the URL's path and the row's path come
  // from different layers), not mode/base: switching the diff-mode dropdown shouldn't
  // make the current review reappear in the picker.
  const isCurrentWorktree = (path: string) =>
    current != null && sameFolder(path, current.repoPath);

  const visible = (w: PickerWorktree): PickerWorktree =>
    w.review && deletedIds.has(w.review.id) ? { ...w, review: null } : w;

  const all = data?.worktrees ?? [];
  const currentRepoId = all.find((w) => isCurrentWorktree(w.path))?.repoId;
  const ranked = rankWorktrees(all.filter((w) => !isCurrentWorktree(w.path)).map(visible), query);
  const searching = query.trim() !== "";
  const canDrag = data != null && !searching && scope == null;
  const itemsFor = (forScope: RepoScope | null) =>
    buildPickerItems({ ranked, scope: forScope, collapsed, expanded, searching, pinnedRepoId: currentRepoId, sort, repoOrder });
  const items = itemsFor(scope);

  function persistCollapsed(next: ReadonlySet<string>) {
    setCollapsed(next);
    saveCollapsedRepos(next);
  }

  function setRepoCollapsed(repoId: string, isCollapsed: boolean) {
    const next = new Set(collapsed);
    if (isCollapsed) {
      next.add(repoId);
    } else {
      next.delete(repoId);
    }
    persistCollapsed(next);
  }

  function enterScope(repoId: string) {
    const repo = all.find((w) => w.repoId === repoId);
    if (!repo) return;
    setScope({ repoId, repoName: repo.repoName });
    setQuery("");
    setSel(0);
    inputRef.current?.focus();
  }

  function exitScope() {
    const left = scope;
    setScope(null);
    setQuery("");
    const header = left ? itemsFor(null).findIndex((it) => it.kind === "repo" && it.repoId === left.repoId) : -1;
    setSel(Math.max(0, header));
    inputRef.current?.focus();
  }

  const rows: Row[] = items.map((item): Row => {
    const repoId = itemRepoId(item);
    const base = { height: rowHeight(item), repoId, onScope: () => enterScope(repoId) };
    if (item.kind === "repo") {
      return {
        ...base,
        key: `repo-${repoId}`,
        node: repoNode(item),
        onActivate: () => setRepoCollapsed(repoId, !item.collapsed),
        onPress: canDrag && repoId !== currentRepoId ? (event) => pressRepo(event, repoId) : undefined,
      };
    }
    if (item.kind === "more") {
      return { ...base, key: `more-${repoId}`, node: moreNode(item.hidden), onActivate: () => setExpanded((prev) => new Set(prev).add(repoId)) };
    }
    const w = item.w;
    return {
      ...base,
      key: `wt-${w.path}`,
      node: worktreeNode(w, item.nested),
      onActivate: () => onOpenWorktree(w),
      onDelete: w.review ? () => void deleteReviewOf(w) : undefined,
    };
  });

  const clampedSel = rows.length === 0 ? 0 : Math.min(sel, rows.length - 1);

  // Measure the scroll viewport so we only render the rows inside it (+ overscan).
  useLayoutEffect(() => {
    const h = listRef.current?.clientHeight ?? 0;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect
    if (h > 0) setViewportH(h);
  }, [data]);

  const cells: Cell[] = [];
  let y = PAD;
  for (let i = 0; i < rows.length; i++) {
    cells.push({ i, top: y, height: rows[i].height, key: rows[i].key });
    y += rows[i].height;
  }
  const totalHeight = y + PAD;
  const visibleCells = cells.filter((c) => c.top + c.height >= scrollTop - OVERSCAN && c.top <= scrollTop + viewportH + OVERSCAN);

  const repoBoxes: RepoBox[] = [];
  cells.forEach((cell, i) => {
    if (items[i].kind === "repo") {
      repoBoxes.push({ repoId: items[i].repoId, top: cell.top, height: cell.height });
    } else if (repoBoxes.length > 0) {
      repoBoxes[repoBoxes.length - 1].height += cell.height;
    }
  });
  const slideOf = new Map<string, number>();
  let slotTop = PAD;
  let activeDrag: { repoId: string; height: number; header: Extract<PickerItem, { kind: "repo" }> } | null = null;
  if (repoDrag) {
    const box = repoBoxes.find((candidate) => candidate.repoId === repoDrag.repoId);
    const header = items.find((it): it is Extract<PickerItem, { kind: "repo" }> => it.kind === "repo" && it.repoId === repoDrag.repoId);
    if (box && header) {
      const others = repoBoxes.filter((candidate) => candidate !== box);
      slides(others, repoDrag.from, repoDrag.slot, box.height).forEach((px, j) => slideOf.set(others[j].repoId, px));
      slotTop = PAD + others.slice(0, repoDrag.slot).reduce((sum, other) => sum + other.height, 0);
      activeDrag = { repoId: repoDrag.repoId, height: box.height, header };
    }
  }

  // Keep the keyboard-selected row in view — its cell may not be rendered, so scroll
  // by computed offset rather than scrollIntoView.
  useEffect(() => {
    const el = listRef.current;
    const cell = cells[clampedSel];
    if (!el || !cell) return;
    if (cell.top < el.scrollTop) el.scrollTop = cell.top - PAD;
    else if (cell.top + cell.height > el.scrollTop + el.clientHeight) el.scrollTop = cell.top + cell.height - el.clientHeight + PAD;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clampedSel]);

  function pressRepo(event: React.PointerEvent<HTMLButtonElement>, repoId: string) {
    const list = listRef.current;
    const box = repoBoxes.find((candidate) => candidate.repoId === repoId);
    if (event.button !== 0 || !list || !box) return;
    const from = repoBoxes.indexOf(box);
    const others = repoBoxes.filter((candidate) => candidate !== box);
    const minSlot = repoBoxes[0].repoId === currentRepoId ? 1 : 0;
    const displayed = repoBoxes.map((candidate) => candidate.repoId);
    const startX = event.clientX;
    const startY = event.clientY;
    const grabOffset = startY - event.currentTarget.getBoundingClientRect().top;
    let pointerY = startY;
    let slot = from;
    let active = false;
    let frame = 0;
    let lastTick = 0;

    const slotAt = () => {
      const rect = list.getBoundingClientRect();
      if (pointerY < rect.top || pointerY > rect.bottom) return from;
      return Math.max(minSlot, dropIndex(others, pointerY - rect.top + list.scrollTop));
    };
    const track = () => {
      const next = slotAt();
      if (next === slot) return;
      slot = next;
      setRepoDrag({ repoId, from, slot });
    };
    const place = () => {
      const ghost = ghostRef.current;
      if (!ghost) return;
      const rect = list.getBoundingClientRect();
      ghost.style.left = `${rect.left + PAD}px`;
      ghost.style.width = `${list.clientWidth - PAD * 2}px`;
      ghost.style.top = `${Math.min(Math.max(pointerY - grabOffset, rect.top), rect.bottom - REPO_H)}px`;
    };
    const onMove = (moved: PointerEvent) => {
      pointerY = moved.clientY;
      if (!active) {
        if (Math.hypot(moved.clientX - startX, pointerY - startY) < DRAG_THRESHOLD) return;
        active = true;
        setRepoDrag({ repoId, from, slot });
      }
      track();
      place();
    };
    const finish = (commit: boolean) => {
      cancelDrag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onDrop);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKeydown);
      cancelAnimationFrame(frame);
      if (!active) return;
      swallowNextClick();
      setRepoDrag(null);
      if (!commit || slot === from) return;
      const order = moveRepo(displayed, repoId, slot);
      setRepoOrder(order);
      setRepoSort("manual");
      const landed = buildPickerItems({ ranked, scope, collapsed, expanded, searching, pinnedRepoId: currentRepoId, sort: "manual", repoOrder: order });
      setSel(Math.max(0, landed.findIndex((it) => it.kind === "repo" && it.repoId === repoId)));
    };
    const onDrop = () => finish(true);
    const onCancel = () => finish(false);
    const onKeydown = (pressed: KeyboardEvent) => {
      if (pressed.key !== "Escape") return;
      pressed.preventDefault();
      onCancel();
    };
    const autoscroll = (now: number) => {
      if (active) {
        const rect = list.getBoundingClientRect();
        const above = rect.top + AUTOSCROLL_EDGE - pointerY;
        const below = pointerY - (rect.bottom - AUTOSCROLL_EDGE);
        if (above > 0 || below > 0) {
          const intoEdge = Math.min(1, Math.max(above, below) / AUTOSCROLL_EDGE);
          list.scrollTop += (below > 0 ? 1 : -1) * AUTOSCROLL_SPEED * Math.min(now - lastTick, 50) * intoEdge;
        }
        track();
      }
      lastTick = now;
      frame = requestAnimationFrame(autoscroll);
    };
    cancelDrag.current = onCancel;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onDrop);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKeydown);
    frame = requestAnimationFrame(autoscroll);
  }

  function foldSelected(key: "ArrowLeft" | "ArrowRight"): boolean {
    const item = items[clampedSel];
    if (!item || scope || searching) return false;
    if (item.kind === "repo") {
      setRepoCollapsed(item.repoId, key === "ArrowLeft");
      return true;
    }
    if (key === "ArrowLeft") {
      setSel(items.findIndex((it) => it.kind === "repo" && it.repoId === itemRepoId(item)));
      return true;
    }
    return false;
  }

  function onKey(e: React.KeyboardEvent) {
    if (repoDrag) return;
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
    } else if (e.key === "Tab" && !e.shiftKey && !scope && rows[clampedSel]) {
      e.preventDefault();
      rows[clampedSel].onScope?.();
    } else if ((e.key === "Backspace" && query === "" && scope) || (e.key === "Escape" && scope)) {
      e.preventDefault();
      e.stopPropagation();
      exitScope();
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && query === "" && foldSelected(e.key)) {
      e.preventDefault();
    }
  }

  function onQueryChange(value: string) {
    const scoped = scope ? null : scopeFromQuery(value, all);
    if (scoped) {
      setScope(scoped.scope);
      setQuery(scoped.rest);
    } else {
      setQuery(value);
    }
    setSel(0);
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
        {scope && (
          <Hint tip="Back to all repos" kbd="⌫">
            <button
              type="button"
              onClick={exitScope}
              aria-label={`Leave ${scope.repoName}`}
              className="ml-3 inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-secondary pl-2 pr-1 text-[12px] font-semibold text-secondary-foreground hover:bg-secondary/80"
            >
              {scope.repoName}
              <X className="size-3 text-muted-foreground" />
            </button>
          </Hint>
        )}
        <input
          ref={inputRef}
          autoFocus
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          className={`h-11 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/70 ${scope ? "px-2" : "px-4"}`}
          placeholder={scope ? `Search ${scope.repoName}…` : "Search repos & worktrees…"}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        <RepoSortMenu onClosed={() => inputRef.current?.focus()} />
        <Hint tip="Add a repo…">
          <button
            type="button"
            onClick={onAddRepo}
            aria-label="Add a repo…"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-muted/40 pl-2.5 pr-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FolderPlus className="size-3.5" /> Add repo
            <Kbd keys="⌘O" className="bg-background/60" />
          </button>
        </Hint>
      </div>
      <div
        ref={listRef}
        data-testid="picker-list"
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
            {activeDrag && (
              <div
                className="pointer-events-none absolute rounded-md border border-dashed border-primary/40 bg-primary/5"
                style={{ top: slotTop, height: activeDrag.height, left: PAD, right: PAD }}
              />
            )}
            {visibleCells.map((c) => {
              const row = rows[c.i];
              const isSel = c.i === clampedSel;
              const item = items[c.i];
              const slide = slideOf.get(row.repoId) ?? 0;
              const isDragged = activeDrag?.repoId === row.repoId;
              return (
                <div
                  key={c.key}
                  data-index={c.i}
                  style={{ ...CELL_FRAME, top: c.top, height: c.height, transform: slide ? `translateY(${slide}px)` : undefined }}
                  className={cn(
                    "group flex items-center rounded-md",
                    isSel ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                    activeDrag && "transition-transform duration-150 ease-out",
                    isDragged && "opacity-0",
                  )}
                  onMouseMove={(e) => onItemMouseMove(e, c.i)}
                >
                  <button
                    type="button"
                    className={`flex h-full min-w-0 flex-1 items-center gap-2.5 px-3 text-left outline-none ${row.onPress ? "cursor-grab select-none" : ""}`}
                    onClick={row.onActivate}
                    onPointerDown={row.onPress}
                  >
                    {row.node}
                  </button>
                  {item.kind === "repo" && (
                    <Hint tip="Only this repo" kbd="⇥">
                      <button
                        type="button"
                        aria-label={`Only ${item.repoName}`}
                        onClick={row.onScope}
                        className={`mr-2 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${isSel ? "visible" : "invisible group-hover:visible"}`}
                      >
                        <ListFilter className="size-3.5" />
                      </button>
                    </Hint>
                  )}
                  {row.onDelete && (
                    <Hint tip="Delete review" kbd="⌘⌫">
                      <button
                        type="button"
                        aria-label="Delete review"
                        onClick={row.onDelete}
                        className={`mr-2 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus:outline-none focus-visible:ring-1 focus-visible:ring-ring ${isSel ? "visible" : "invisible group-hover:visible"}`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </Hint>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {activeDrag && (
        <>
          <div data-testid="drag-shield" className="fixed inset-0 z-40 cursor-grabbing" />
          <div
            ref={ghostRef}
            className="pointer-events-none fixed z-50 flex items-center rounded-md border border-border bg-popover px-3 text-[13px] text-popover-foreground shadow-lg ring-1 ring-foreground/10"
            style={{ height: REPO_H }}
          >
            {repoNode(activeDrag.header)}
          </div>
        </>
      )}
      <div className="flex shrink-0 items-center gap-4 border-t border-border/70 px-4 py-1.5 text-[11px] text-muted-foreground">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        {scope ? <span>⌫ all repos</span> : <span>⇥ only repo</span>}
        {!scope && <span>←→ fold</span>}
        <span>⌘⌫ delete</span>
      </div>
    </div>
  );
}
