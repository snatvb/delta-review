import { beforeEach, describe, expect, it } from "vitest";
import { buildPickerItems, loadCollapsedRepos, scopeFromQuery, type PickerItem } from "./pickerGroups";
import type { PickerWorktree } from "../types";

const repo = (repoName: string): PickerWorktree => ({
  path: `/r/${repoName}`,
  branch: "main",
  isMain: true,
  repoName,
  repoId: `id-${repoName}`,
});

describe("scopeFromQuery", () => {
  const repos = [repo("delta"), repo("delta-review"), repo("wotdev")];

  it("scopes to the only repo starting with the prefix", () => {
    expect(scopeFromQuery("wot/menu", repos)).toEqual({ scope: { repoId: "id-wotdev", repoName: "wotdev" }, rest: "menu" });
  });

  it("prefers an exact name over longer names sharing the prefix", () => {
    expect(scopeFromQuery("delta/", repos)?.scope.repoName).toBe("delta");
  });

  it("leaves an ambiguous or unknown prefix as a plain query", () => {
    expect(scopeFromQuery("del/x", repos)).toBeNull();
    expect(scopeFromQuery("feat/context", repos)).toBeNull();
    expect(scopeFromQuery("wotdev", repos)).toBeNull();
  });
});

describe("buildPickerItems", () => {
  const main = { ...repo("wotdev"), lastCommitAt: "2026-11-01T00:00:00Z" };
  const fresh = (name: string, day: string): PickerWorktree => ({
    ...repo("wotdev"),
    path: `/wt/${name}`,
    branch: name,
    isMain: false,
    lastCommitAt: `2026-11-${day}T00:00:00Z`,
  });
  const ranked = [fresh("a", "18"), fresh("b", "17"), fresh("c", "16"), main];
  const base = { collapsed: new Set<string>(), expanded: new Set<string>(), searching: false };
  const paths = (items: PickerItem[]) => items.flatMap((i) => (i.kind === "worktree" ? [i.w.path] : []));

  it("keeps the main worktree on top of its repo group, inside the preview", () => {
    expect(paths(buildPickerItems({ ...base, ranked, scope: null }))).toEqual(["/r/wotdev", "/wt/a", "/wt/b"]);
  });

  it("keeps the main worktree on top in a repo scope", () => {
    const scope = { repoId: main.repoId, repoName: main.repoName };
    expect(paths(buildPickerItems({ ...base, ranked, scope }))[0]).toBe("/r/wotdev");
  });

  it("keeps the match ranking while searching", () => {
    expect(paths(buildPickerItems({ ...base, ranked, scope: null, searching: true }))).toEqual(["/wt/a", "/wt/b", "/wt/c", "/r/wotdev"]);
  });
});

describe("loadCollapsedRepos", () => {
  beforeEach(() => localStorage.clear());

  it("ignores a corrupted value", () => {
    localStorage.setItem("delta.picker.collapsedRepos", "{not json");
    expect(loadCollapsedRepos().size).toBe(0);
    localStorage.setItem("delta.picker.collapsedRepos", JSON.stringify(["a", 3, null]));
    expect([...loadCollapsedRepos()]).toEqual(["a"]);
  });
});
