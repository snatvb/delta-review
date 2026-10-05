// Image point comments (#point): the shared pin vocabulary — which comments are
// points, how they group into threads, and the top-to-bottom numbering that
// keeps a pin's number identical on the card, in the lightbox, and in the index.
import { describe, it, expect } from "vitest";
import { numberPointComments, pointKey, pointOf, pointSuffix } from "./imagePoints";
import type { Comment } from "../types";

function point(id: string, side: "old" | "new", x: number, y: number, createdAt = "2026-01-01T00:00:00Z"): Comment {
  return {
    id,
    scope: "point",
    anchor: { file: "assets/logo.png", side, startLine: null, endLine: null, snippet: null, x, y },
    body: `note ${id}`,
    stale: false,
    resolved: false,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("imagePoints", () => {
  it("pointOf accepts point comments with coordinates, rejects everything else", () => {
    expect(pointOf(point("p", "new", 0.5, 0.5))).toEqual({ side: "new", x: 0.5, y: 0.5 });
    const line: Comment = {
      id: "l", scope: "line", anchor: { file: "a.ts", side: "new", startLine: 3 }, body: "b",
      stale: false, resolved: false, createdAt: "t", updatedAt: "t",
    };
    expect(pointOf(line)).toBeNull();
    const fileScoped: Comment = {
      id: "f", scope: "file", anchor: { file: "a.ts", side: "new", startLine: null }, body: "b",
      stale: false, resolved: false, createdAt: "t", updatedAt: "t",
    };
    expect(pointOf(fileScoped)).toBeNull();
  });

  it("numbers pins top-to-bottom, then left-to-right", () => {
    const n = numberPointComments([
      point("a", "new", 0.9, 0.8),
      point("b", "new", 0.1, 0.8),
      point("c", "new", 0.5, 0.2),
    ]);
    expect(n.get("c")).toBe(1);
    expect(n.get("b")).toBe(2);
    expect(n.get("a")).toBe(3);
  });

  it("groups by rounded coordinates — two comments on the same spot share a key", () => {
    expect(pointKey("new", 0.3, 0.6)).toBe(pointKey("new", 0.3, 0.6));
    expect(pointKey("old", 0.3, 0.6)).not.toBe(pointKey("new", 0.3, 0.6));
    expect(pointKey("new", 0.3, 0.6)).not.toBe(pointKey("new", 0.31, 0.6));
  });

  it("formats the compact x/y suffix", () => {
    expect(pointSuffix(0.3, 0.62)).toBe("x30% y62%");
    expect(pointSuffix(0, 1)).toBe("x0% y100%");
  });
});
