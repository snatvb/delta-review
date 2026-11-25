import { worktreeActivity } from "./fuzzy";
import type { PickerWorktree } from "../types";
import type { RepoSort } from "../repoSortPref";

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
  sort: RepoSort;
  repoOrder: readonly string[];
}

const byRepoName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function arrangeRepoIds(incoming: readonly string[], saved: readonly string[]): string[] {
  const rank = new Map(saved.map((id, at) => [id, at] as const));
  const placed = incoming.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...incoming.filter((id) => !rank.has(id)), ...placed];
}

export function moveRepo(ids: readonly string[], repo: string, slot: number): string[] {
  const rest = ids.filter((id) => id !== repo);
  rest.splice(slot, 0, repo);
  return rest;
}

function arrangeRepos(rest: PickerWorktree[][], sort: RepoSort, savedOrder: readonly string[]): PickerWorktree[][] {
  if (sort === "name") {
    return [...rest].sort((a, b) => byRepoName.compare(a[0].repoName, b[0].repoName));
  }
  if (sort === "manual") {
    const byId = new Map(rest.map((group) => [group[0].repoId, group] as const));
    return arrangeRepoIds([...byId.keys()], savedOrder).map((id) => byId.get(id)!);
  }
  return rest;
}

function groupByRepo(ranked: PickerWorktree[], pinnedRepoId: string | undefined, sort: RepoSort, savedOrder: readonly string[]): PickerWorktree[][] {
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
  const pinned = ordered.find((g) => g[0].repoId === pinnedRepoId);
  const rest = ordered.filter((g) => g !== pinned);
  return pinned ? [pinned, ...arrangeRepos(rest, sort, savedOrder)] : arrangeRepos(rest, sort, savedOrder);
}

function mainWorktreeFirst(group: PickerWorktree[]): PickerWorktree[] {
  return [...group.filter((w) => w.isMain), ...group.filter((w) => !w.isMain)];
}

export function buildPickerItems({ ranked, scope, collapsed, expanded, searching, pinnedRepoId, sort, repoOrder }: PickerItemsInput): PickerItem[] {
  const arrange = searching ? (group: PickerWorktree[]) => group : mainWorktreeFirst;
  if (scope) {
    return arrange(ranked.filter((w) => w.repoId === scope.repoId)).map((w) => ({ kind: "worktree", w, nested: false }));
  }
  const items: PickerItem[] = [];
  for (const group of groupByRepo(ranked, pinnedRepoId, searching ? "recent" : sort, repoOrder).map(arrange)) {
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
