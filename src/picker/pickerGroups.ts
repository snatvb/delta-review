import { worktreeActivity } from "./fuzzy";
import type { PickerWorktree } from "../types";

export interface RepoScope {
  repoId: string;
  repoName: string;
}

export type PickerItem =
  | { kind: "repo"; repoId: string; repoName: string; total: number; lastActivity: string; collapsed: boolean }
  | { kind: "worktree"; w: PickerWorktree; nested: boolean }
  | { kind: "more"; repoId: string; hidden: number };

export const PREVIEW_PER_REPO = 3;

export interface PickerItemsInput {
  ranked: PickerWorktree[];
  scope: RepoScope | null;
  collapsed: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  searching: boolean;
  pinnedRepoId?: string;
}

function groupByRepo(ranked: PickerWorktree[], pinnedRepoId?: string): PickerWorktree[][] {
  const groups = new Map<string, PickerWorktree[]>();
  for (const w of ranked) {
    const group = groups.get(w.repoId);
    if (group) {
      group.push(w);
    } else {
      groups.set(w.repoId, [w]);
    }
  }
  const ordered = [...groups.values()];
  const pinned = ordered.findIndex((g) => g[0].repoId === pinnedRepoId);
  if (pinned > 0) {
    ordered.unshift(...ordered.splice(pinned, 1));
  }
  return ordered;
}

function mainWorktreeFirst(group: PickerWorktree[]): PickerWorktree[] {
  return [...group.filter((w) => w.isMain), ...group.filter((w) => !w.isMain)];
}

export function buildPickerItems({ ranked, scope, collapsed, expanded, searching, pinnedRepoId }: PickerItemsInput): PickerItem[] {
  const arrange = searching ? (group: PickerWorktree[]) => group : mainWorktreeFirst;
  if (scope) {
    return arrange(ranked.filter((w) => w.repoId === scope.repoId)).map((w) => ({ kind: "worktree", w, nested: false }));
  }
  const items: PickerItem[] = [];
  for (const group of groupByRepo(ranked, pinnedRepoId).map(arrange)) {
    const { repoId, repoName } = group[0];
    const isCollapsed = !searching && collapsed.has(repoId);
    const lastActivity = group.map(worktreeActivity).reduce((a, b) => (b > a ? b : a), "");
    items.push({ kind: "repo", repoId, repoName, total: group.length, lastActivity, collapsed: isCollapsed });
    if (isCollapsed) {
      continue;
    }
    const showAll = searching || expanded.has(repoId);
    const shown = showAll ? group : group.slice(0, PREVIEW_PER_REPO);
    items.push(...shown.map((w): PickerItem => ({ kind: "worktree", w, nested: true })));
    if (shown.length < group.length) {
      items.push({ kind: "more", repoId, hidden: group.length - shown.length });
    }
  }
  return items;
}

export function itemRepoId(item: PickerItem): string {
  return item.kind === "worktree" ? item.w.repoId : item.repoId;
}

/** "wot/ctx" → scope to the one repo whose name starts with "wot", query "ctx". */
export function scopeFromQuery(query: string, worktrees: PickerWorktree[]): { scope: RepoScope; rest: string } | null {
  const match = /^([^\s/]+)\/(.*)$/s.exec(query);
  if (!match) {
    return null;
  }
  const prefix = match[1].toLowerCase();
  const repos = new Map<string, RepoScope>();
  for (const w of worktrees) {
    if (w.repoName.toLowerCase().startsWith(prefix)) {
      repos.set(w.repoId, { repoId: w.repoId, repoName: w.repoName });
    }
  }
  const candidates = [...repos.values()];
  const exact = candidates.find((r) => r.repoName.toLowerCase() === prefix);
  const scope = exact ?? (candidates.length === 1 ? candidates[0] : null);
  return scope ? { scope, rest: match[2] } : null;
}

const COLLAPSED_KEY = "delta.picker.collapsedRepos";

export function loadCollapsedRepos(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedRepos(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
  } catch {
    return;
  }
}
