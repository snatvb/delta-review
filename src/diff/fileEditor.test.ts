import { describe, it, expect } from "vitest";
import { offsetForLine, isStaleWriteError } from "./fileEditor";

describe("offsetForLine", () => {
  const content = "a\nbb\nccc\ndddd";

  it("is 0 for line 1 (and anything ≤ 1)", () => {
    expect(offsetForLine(content, 1)).toBe(0);
    expect(offsetForLine(content, 0)).toBe(0);
    expect(offsetForLine(content, -3)).toBe(0);
  });

  it("finds the start offset of a middle line", () => {
    expect(offsetForLine(content, 2)).toBe(2); // "bb"
    expect(offsetForLine(content, 3)).toBe(5); // "ccc"
    expect(offsetForLine(content, 4)).toBe(9); // "dddd"
  });

  it("clamps to the content length when the line is out of range", () => {
    expect(offsetForLine(content, 99)).toBe(content.length);
  });

  it("handles empty content", () => {
    expect(offsetForLine("", 1)).toBe(0);
    expect(offsetForLine("", 5)).toBe(0);
  });
});

describe("isStaleWriteError", () => {
  it("recognizes the backend's stale-write message", () => {
    expect(isStaleWriteError("file changed on disk — refusing to overwrite")).toBe(true);
  });

  it("is false for an unrelated error", () => {
    expect(isStaleWriteError("binary file — editing isn't supported")).toBe(false);
    expect(isStaleWriteError("network error")).toBe(false);
  });
});
