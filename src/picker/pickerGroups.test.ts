import { beforeEach, describe, expect, it } from "vitest";
import { loadCollapsedRepos, scopeFromQuery } from "./pickerGroups";
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

describe("loadCollapsedRepos", () => {
  beforeEach(() => localStorage.clear());

  it("ignores a corrupted value", () => {
    localStorage.setItem("delta.picker.collapsedRepos", "{not json");
    expect(loadCollapsedRepos().size).toBe(0);
    localStorage.setItem("delta.picker.collapsedRepos", JSON.stringify(["a", 3, null]));
    expect([...loadCollapsedRepos()]).toEqual(["a"]);
  });
});
