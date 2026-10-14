import { describe, it, expect } from "vitest";
import { sameFolder } from "./sameFolder";

describe("sameFolder", () => {
  it("ignores trailing separators", () => {
    // libgit2's workdir() form vs a normalized row path.
    expect(sameFolder("/r/demo/", "/r/demo")).toBe(true);
    expect(sameFolder("/r/demo", "/r/demo/")).toBe(true);
    expect(sameFolder("/r/demo//", "/r/demo")).toBe(true);
  });

  it("ignores slash direction and drive-letter case", () => {
    // Windows: libgit2 hands out POSIX slashes, dunce native ones.
    expect(sameFolder("C:/Users/me/proj", "C:\\Users\\me\\proj")).toBe(true);
    expect(sameFolder("c:\\users\\me\\proj\\", "C:/Users/me/proj")).toBe(true);
  });

  it("still tells different folders apart", () => {
    expect(sameFolder("/r/demo", "/r/demo-spike")).toBe(false);
    expect(sameFolder("/r/demo", "/r/other")).toBe(false);
    // A path and its sibling sharing a prefix must not fold together.
    expect(sameFolder("C:/a/b", "C:/a/bc")).toBe(false);
  });
});
