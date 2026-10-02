import { describe, it, expect } from "vitest";
import { sumChangeStats } from "./changeStats";
import type { FileEntry } from "../types";

const f = (path: string, additions: number, deletions: number, ignored = false): FileEntry => ({
  path, status: "modified", additions, deletions, binary: false, ignored,
});

describe("sumChangeStats", () => {
  it("sums additions and deletions across files", () => {
    const s = sumChangeStats([f("a.ts", 3, 1), f("b.ts", 2, 4)], new Set(), false);
    expect(s).toEqual({ additions: 5, deletions: 5 });
  });

  it("leaves ignored files out of the totals regardless of the pref", () => {
    const files = [f("a.ts", 3, 1), f("gen/api.ts", 100, 100, true)];
    expect(sumChangeStats(files, new Set(), false)).toEqual({ additions: 3, deletions: 1 });
    expect(sumChangeStats(files, new Set(), true)).toEqual({ additions: 3, deletions: 1 });
  });

  it("counts viewed files when the pref is off (today's behavior)", () => {
    const files = [f("a.ts", 3, 1), f("b.ts", 2, 4)];
    expect(sumChangeStats(files, new Set(["a.ts"]), false)).toEqual({ additions: 5, deletions: 5 });
  });

  it("skips viewed files when the pref is on", () => {
    const files = [f("a.ts", 3, 1), f("b.ts", 2, 4)];
    expect(sumChangeStats(files, new Set(["a.ts"]), true)).toEqual({ additions: 2, deletions: 4 });
  });

  it("drops to zero when everything viewed is excluded", () => {
    const files = [f("a.ts", 3, 1)];
    expect(sumChangeStats(files, new Set(["a.ts"]), true)).toEqual({ additions: 0, deletions: 0 });
  });

  it("is unaffected by viewed paths that aren't in the file list", () => {
    // viewed entries can reference files that left the diff (reconcile cleans
    // them up on refresh; until then the sums must not care).
    expect(sumChangeStats([f("a.ts", 3, 1)], new Set(["gone.ts"]), true)).toEqual({ additions: 3, deletions: 1 });
  });
});
