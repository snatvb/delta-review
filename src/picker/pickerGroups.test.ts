import { beforeEach, describe, expect, it } from "vitest";
import {
  arrangeRepoIds,
  buildPickerItems,
  loadCollapsedRepos,
  moveRepo,
  scopeFromQuery,
  type PickerItem,
  type PickerItemsInput,
} from "./pickerGroups";
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
  const base: Omit<PickerItemsInput, "ranked" | "scope"> = {
    collapsed: new Set<string>(),
    expanded: new Set<string>(),
    searching: false,
    sort: "recent",
    repoOrder: [],
  };
  const paths = (items: PickerItem[]) => items.flatMap((i) => (i.kind === "worktree" ? [i.w.path] : []));
  const repoNames = (items: PickerItem[]) => items.flatMap((i) => (i.kind === "repo" ? [i.repoName] : []));

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

  describe("repo order", () => {
    const touched = (repoName: string, day: string) => ({ ...repo(repoName), lastCommitAt: `2026-11-${day}T00:00:00Z` });
    const zeta = touched("zeta", "20");
    const alpha = touched("alpha", "02");
    const mixed = [zeta, ...ranked, alpha];

    it("follows the freshest activity by default, else the repo name", () => {
      expect(repoNames(buildPickerItems({ ...base, ranked: mixed, scope: null }))).toEqual(["zeta", "wotdev", "alpha"]);
      expect(repoNames(buildPickerItems({ ...base, ranked: mixed, scope: null, sort: "name" }))).toEqual(["alpha", "wotdev", "zeta"]);
    });

    it("ignores case and compares digits as numbers", () => {
      const tools = [touched("tool-10", "01"), touched("Zeta", "01"), touched("tool-2", "01")];
      expect(repoNames(buildPickerItems({ ...base, ranked: tools, scope: null, sort: "name" }))).toEqual(["tool-2", "tool-10", "Zeta"]);
    });

    it("sorts by repo name, not by the id behind it", () => {
      const zulu = { ...touched("zulu", "20"), repoId: "id-a" };
      const alpha = { ...touched("alpha", "01"), repoId: "id-z" };
      expect(repoNames(buildPickerItems({ ...base, ranked: [zulu, alpha], scope: null, sort: "name" }))).toEqual(["alpha", "zulu"]);
      expect(repoNames(buildPickerItems({ ...base, ranked: [zulu, alpha], scope: null, sort: "manual", repoOrder: ["id-z"] }))).toEqual(["zulu", "alpha"]);
    });

    it("keeps the match ranking while searching, whatever the sort", () => {
      expect(repoNames(buildPickerItems({ ...base, ranked: mixed, scope: null, sort: "name", searching: true }))).toEqual(["zeta", "wotdev", "alpha"]);
      expect(repoNames(buildPickerItems({ ...base, ranked: mixed, scope: null, sort: "manual", repoOrder: ["alpha"], searching: true }))).toEqual([
        "zeta",
        "wotdev",
        "alpha",
      ]);
    });

    it("keeps the current review's repo first", () => {
      expect(repoNames(buildPickerItems({ ...base, ranked: mixed, scope: null, sort: "name", pinnedRepoId: zeta.repoId }))).toEqual(["zeta", "alpha", "wotdev"]);
      expect(repoNames(buildPickerItems({ ...base, ranked: mixed, scope: null, sort: "manual", repoOrder: ["alpha"], pinnedRepoId: zeta.repoId }))).toEqual([
        "zeta",
        "wotdev",
        "alpha",
      ]);
    });

    it("shows a manual arrangement, with repos never placed leading", () => {
      const repoOrder = [main.repoId, alpha.repoId, zeta.repoId];
      const placed = buildPickerItems({ ...base, ranked: mixed, scope: null, sort: "manual", repoOrder });
      expect(repoNames(placed)).toEqual(["wotdev", "alpha", "zeta"]);
      const fresh = touched("new", "21");
      expect(repoNames(buildPickerItems({ ...base, ranked: [fresh, ...mixed], scope: null, sort: "manual", repoOrder }))).toEqual(["new", "wotdev", "alpha", "zeta"]);
    });

    it("leaves the rows inside a repo alone", () => {
      const mainBetween = [fresh("zulu", "18"), main, fresh("bravo", "17")];
      expect(paths(buildPickerItems({ ...base, ranked: [alpha, ...mainBetween], scope: null, sort: "name" }))).toEqual([
        "/r/alpha",
        "/r/wotdev",
        "/wt/zulu",
        "/wt/bravo",
      ]);
    });
  });
});

describe("manual order", () => {
  it("puts repos never placed first, then follows the saved positions", () => {
    expect(arrangeRepoIds(["c", "a", "d", "b"], ["b", "a"])).toEqual(["c", "d", "b", "a"]);
    expect(arrangeRepoIds(["a"], ["gone", "a"])).toEqual(["a"]);
  });

  it("moves a repo to the slot counted over the other repos", () => {
    expect(moveRepo(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveRepo(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveRepo(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
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
