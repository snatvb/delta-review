// src/files/buildTree.test.ts
import { describe, it, expect } from "vitest";
import { buildTree, flattenTreeFiles, reviewOrder } from "./buildTree";
import type { FileEntry } from "../types";

const f = (path: string): FileEntry => ({ path, status: "modified", additions: 1, deletions: 0, binary: false });

describe("buildTree", () => {
  it("nests files under directory nodes", () => {
    const tree = buildTree([f("src/a.ts"), f("src/b/c.ts"), f("readme.md")]);
    const names = tree.map((n) => n.name).sort();
    expect(names).toEqual(["readme.md", "src"]);
    const src = tree.find((n) => n.name === "src")!;
    expect(src.kind).toBe("dir");
    expect(src.children.find((n) => n.name === "b")!.children[0].name).toBe("c.ts");
  });
});

describe("flattenTreeFiles", () => {
  it("returns files in tree display order (dirs-first, alphabetical), not input order", () => {
    const ordered = flattenTreeFiles([f("src/z.ts"), f("readme.md"), f("src/a.ts"), f("src/b/c.ts")]);
    expect(ordered.map((e) => e.path)).toEqual(["src/b/c.ts", "src/a.ts", "src/z.ts", "readme.md"]);
  });
});

describe("reviewOrder", () => {
  it("moves binaries and giant diffs to the end, each group in tree order", () => {
    const bin = (path: string): FileEntry => ({ ...f(path), binary: true });
    const giant = (path: string): FileEntry => ({ ...f(path), additions: 900 });
    const ordered = reviewOrder([bin("a/logo.png"), f("z.ts"), giant("a/gen.ts"), f("a/b.ts"), bin("readme.pdf")]);
    expect(ordered.map((e) => e.path)).toEqual(["a/b.ts", "z.ts", "a/gen.ts", "a/logo.png", "readme.pdf"]);
  });

  it("puts ignored files last, after binaries and giants", () => {
    const ignored = (path: string): FileEntry => ({ ...f(path), ignored: true });
    const bin = (path: string): FileEntry => ({ ...f(path), binary: true });
    const ordered = reviewOrder([ignored("a/gen/api.ts"), bin("logo.png"), f("z.ts"), ignored("b.gen.ts")]);
    expect(ordered.map((e) => e.path)).toEqual(["z.ts", "logo.png", "a/gen/api.ts", "b.gen.ts"]);
  });
});
