import { describe, it, expect } from "vitest";
import { commentForAgent } from "./commentForAgent";
import type { Anchor, Comment } from "../types";

function c(anchor: Anchor | null, body: string, extra: Partial<Comment> = {}): Comment {
  return { id: "x", scope: anchor ? "line" : "general", anchor, body, stale: false, resolved: false, createdAt: "t", updatedAt: "t", ...extra };
}

describe("commentForAgent", () => {
  it("formats a line comment as location, fenced snippet, body", () => {
    const md = commentForAgent(c(
      { file: "src/a.ts", side: "new", startLine: 40, endLine: null, snippet: "export const TTL = 3600\n" },
      "make configurable",
    ));
    expect(md).toBe("src/a.ts:40\n```ts\nexport const TTL = 3600\n```\nmake configurable");
  });

  it("renders a range as start-end", () => {
    const md = commentForAgent(c(
      { file: "src/a.ts", side: "new", startLine: 12, endLine: 18, snippet: null },
      "extract",
    ));
    expect(md.startsWith("src/a.ts:12-18\n")).toBe(true);
  });

  it("collapses a single-line range (endLine === startLine)", () => {
    const md = commentForAgent(c(
      { file: "src/a.ts", side: "new", startLine: 40, endLine: 40, snippet: null },
      "note",
    ));
    expect(md.startsWith("src/a.ts:40\n")).toBe(true);
  });

  it("file-level comment is just the path — line comments always carry :L, so it's unambiguous", () => {
    const md = commentForAgent(c({ file: "src/a.ts", side: "new", startLine: null, endLine: null, snippet: null }, "naming"));
    expect(md).toBe("src/a.ts\nnaming");
  });

  it("marks old side and stale; a resolved comment is no longer stale", () => {
    const old = commentForAgent(c(
      { file: "src/a.ts", side: "old", startLine: 8, endLine: null, snippet: null },
      "redundant guard",
      { stale: true },
    ));
    expect(old.startsWith("src/a.ts:8 (old side · ⚠ stale)\n")).toBe(true);
    const resolved = commentForAgent(c(
      { file: "src/a.ts", side: "old", startLine: 8, endLine: null, snippet: null },
      "redundant guard",
      { stale: true, resolved: true },
    ));
    expect(resolved.startsWith("src/a.ts:8 (old side)\n")).toBe(true);
  });

  it("notes the commit a comment was handed off to", () => {
    const md = commentForAgent(c(
      { file: "src/a.ts", side: "new", startLine: 40, endLine: null, snippet: null },
      "note",
      { commit: "a1b2c3d4e5f6a7b8c9d0" },
    ));
    expect(md.startsWith("src/a.ts:40 (commit a1b2c3d)\n")).toBe(true);
  });

  it("general comment copies as just the body", () => {
    expect(commentForAgent(c(null, "standardize errors"))).toBe("standardize errors");
  });

  it("empty body still yields location + snippet — the context to ask a question against", () => {
    const md = commentForAgent(c(
      { file: "src/a.ts", side: "new", startLine: 40, endLine: null, snippet: "const x = 1" },
      "  ",
    ));
    expect(md).toBe("src/a.ts:40\n```ts\nconst x = 1\n```");
  });

  it("fence has no language for extensionless paths", () => {
    const md = commentForAgent(c(
      { file: "scripts/build", side: "new", startLine: 3, endLine: null, snippet: "set -e" },
      "note",
    ));
    expect(md).toContain("```\nset -e\n```");
  });
});
