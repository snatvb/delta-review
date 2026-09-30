import { describe, it, expect } from "vitest";
import { occurrenceQueryFromSelection } from "./occurrenceSelection";

describe("occurrenceQueryFromSelection", () => {
  it("returns a partial-word selection", () => {
    expect(occurrenceQueryFromSelection("User")).toBe("User");
  });

  it("trims surrounding whitespace", () => {
    expect(occurrenceQueryFromSelection("  User  ")).toBe("User");
  });

  it("returns null for a single character (too noisy to light the file up)", () => {
    expect(occurrenceQueryFromSelection("a")).toBeNull();
  });

  it("returns null for an empty selection", () => {
    expect(occurrenceQueryFromSelection("")).toBeNull();
  });

  it("returns null for a whitespace-only selection", () => {
    expect(occurrenceQueryFromSelection("   ")).toBeNull();
  });

  it("returns null for a multi-line selection (per-line matching can't match it)", () => {
    expect(occurrenceQueryFromSelection("const a = 1\nconst b = 2")).toBeNull();
  });
});
