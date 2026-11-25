import { describe, expect, it } from "vitest";
import { dropIndex, slides, type RepoBox } from "./repoDrag";

const box = (repoId: string, top: number): RepoBox => ({ repoId, top, height: 100 });

describe("dropIndex", () => {
  const others = [box("b", 100), box("c", 200)];

  it("lands before the first repo whose midpoint is below the pointer", () => {
    expect(dropIndex(others, 0)).toBe(0);
    expect(dropIndex(others, 149)).toBe(0);
    expect(dropIndex(others, 151)).toBe(1);
    expect(dropIndex(others, 500)).toBe(2);
  });
});

describe("slides", () => {
  const others = [box("b", 100), box("c", 200), box("d", 300)];

  it("leaves every repo in place when the slot is where the dragged one came from", () => {
    expect(slides(others, 1, 1, 100)).toEqual([0, 0, 0]);
  });

  it("slides up the repos a dragged repo passes on its way down", () => {
    expect(slides(others, 0, 2, 100)).toEqual([-100, -100, 0]);
  });

  it("slides down the repos a dragged repo passes on its way up", () => {
    expect(slides(others, 3, 1, 100)).toEqual([0, 100, 100]);
  });
});
