import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { isGiant, isGiantBySize } from "./giant";

const entry = (over: Partial<FileEntry>): FileEntry => ({ path: "a.xml", status: "modified", additions: 1, deletions: 1, binary: false, ...over });

describe("isGiant", () => {
  it("flags a file with many changed lines", () => {
    expect(isGiant(entry({ additions: 400, deletions: 100 }))).toBe(true);
  });

  it("flags a file of 2 MB or more even with few changed lines", () => {
    const big = entry({ bytes: 2 * 1024 * 1024 });
    expect(isGiantBySize(big)).toBe(true);
    expect(isGiant(big)).toBe(true);
  });

  it("leaves small files with few changes alone", () => {
    const small = entry({ bytes: 2 * 1024 * 1024 - 1 });
    expect(isGiantBySize(small)).toBe(false);
    expect(isGiant(small)).toBe(false);
    expect(isGiant(entry({}))).toBe(false);
  });
});
