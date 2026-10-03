// Shared visual helpers for worktree/review rows, used by both the launcher's
// ReviewPicker and the review window's "Nothing to review" empty state so the two
// stay visually identical.
import { Folder, GitBranch, MessageSquare, TriangleAlert, Check } from "lucide-react";
import type { ReactNode } from "react";
import { worktreeName } from "../lib/utils";
import type { ReviewEntry } from "../types";

/** Relative "time ago" label for an ISO timestamp — "just now", "5m ago", "3h ago",
 *  "2d ago". Empty string for an unparseable input. */
export function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Leading icon + a hierarchical "repo / worktree" line over the branch — the identity
 *  shown for every row. The worktree name (what you usually know) is emphasized; the repo
 *  is a muted breadcrumb prefix, dropped when it equals the worktree (the main worktree). */
export function worktreeIdentity(repoName: string, path: string, branch: string): ReactNode {
  const wt = worktreeName(path);
  const isMain = wt === repoName;
  return (
    // items-start so the folder icon tracks the title line (its top), not the vertical
    // center of the whole two-line block — the icon's height matches the title line, so
    // its center lands on the title regardless of the row's height.
    <div className="flex min-w-0 flex-1 items-start gap-2.5">
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline text-[13px] leading-tight">
          {!isMain && <span className="shrink-0 text-muted-foreground">{repoName}&nbsp;/&nbsp;</span>}
          <span className="truncate font-medium">{isMain ? repoName : wt}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] leading-tight text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </div>
      </div>
    </div>
  );
}

/** Trailing metadata for a worktree row: the joined review's comment badges
 *  (when the folder's current branch has one), a dirty indicator, and the
 *  relative time — last opened when a review matches, else the branch's last
 *  commit. Shared so the launcher and the empty-state rows render identical
 *  trailers. */
export function worktreeMeta(w: {
  dirty?: boolean | null;
  lastCommitAt?: string | null;
  review?: ReviewEntry | null;
}): ReactNode {
  const r = w.review;
  const at = r?.lastOpenedAt ?? w.lastCommitAt;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-2.5 self-center whitespace-nowrap text-[11px] text-muted-foreground">
      {r && r.commentCount > 0 && (
        <span className="inline-flex items-center gap-1 tabular-nums"><MessageSquare className="size-3.5" />{r.commentCount}</span>
      )}
      {r && r.staleCount > 0 && (
        <span className="inline-flex items-center gap-1 tabular-nums text-amber-500"><TriangleAlert className="size-3.5" />{r.staleCount}</span>
      )}
      {r && r.resolvedCount > 0 && (
        <span className="inline-flex items-center gap-1 tabular-nums text-emerald-500"><Check className="size-3.5" />{r.resolvedCount}</span>
      )}
      {w.dirty && (
        <span className="inline-flex items-center gap-1 text-amber-500" title="Uncommitted changes">
          <span className="size-1.5 rounded-full bg-amber-500" /> uncommitted
        </span>
      )}
      {at && <span>{relTime(at)}</span>}
    </span>
  );
}
