import { describe, it, expect } from "vitest";
import { isWorkingTreeTarget, unifiedRowEdit, splitRowEdit } from "./lineEdit";
import type { DiffMode } from "../types";

describe("isWorkingTreeTarget", () => {
  it("is true for all-changes and uncommitted", () => {
    expect(isWorkingTreeTarget("all-changes")).toBe(true);
    expect(isWorkingTreeTarget("uncommitted")).toBe(true);
  });

  it("is false for commit-pinned modes", () => {
    expect(isWorkingTreeTarget("last-commit")).toBe(false);
    expect(isWorkingTreeTarget("branch-vs-base")).toBe(false);
    expect(isWorkingTreeTarget("commit")).toBe(false);
  });
});

describe("unifiedRowEdit", () => {
  const workingTree: DiffMode = "uncommitted";

  it("is editable for an added/context row carrying a new-side line", () => {
    expect(unifiedRowEdit(workingTree, { newLineNumber: 12, value: "const x = 1;" }))
      .toEqual({ side: "new", line: 12, text: "const x = 1;" });
  });

  it("strips the line terminator the diff model carries in the value", () => {
    expect(unifiedRowEdit(workingTree, { newLineNumber: 12, value: "const x = 1;\n" }))
      .toEqual({ side: "new", line: 12, text: "const x = 1;" });
    expect(unifiedRowEdit(workingTree, { newLineNumber: 12, value: "const x = 1;\r\n" }))
      .toEqual({ side: "new", line: 12, text: "const x = 1;" });
  });

  it("is not editable for a deleted (old-side-only) row", () => {
    expect(unifiedRowEdit(workingTree, { newLineNumber: null, value: null })).toBeNull();
  });

  it("is not editable outside a working-tree target", () => {
    expect(unifiedRowEdit("last-commit", { newLineNumber: 3, value: "x" })).toBeNull();
    expect(unifiedRowEdit("branch-vs-base", { newLineNumber: 3, value: "x" })).toBeNull();
    expect(unifiedRowEdit("commit", { newLineNumber: 3, value: "x" })).toBeNull();
  });

  it("is not editable when the row's text is unknown", () => {
    expect(unifiedRowEdit(workingTree, { newLineNumber: 3, value: null })).toBeNull();
  });
});

describe("splitRowEdit", () => {
  const workingTree: DiffMode = "all-changes";

  it("is editable on the right (new) column only", () => {
    expect(splitRowEdit(workingTree, "new", { lineNumber: 5, value: "return 1;" }))
      .toEqual({ side: "new", line: 5, text: "return 1;" });
    expect(splitRowEdit(workingTree, "old", { lineNumber: 5, value: "return 1;" })).toBeNull();
  });

  it("strips the line terminator on the new side", () => {
    expect(splitRowEdit(workingTree, "new", { lineNumber: 4, value: "let y = 2;\r\n" }))
      .toEqual({ side: "new", line: 4, text: "let y = 2;" });
  });

  it("is not editable when the column has no line here", () => {
    expect(splitRowEdit(workingTree, "new", { lineNumber: null, value: null })).toBeNull();
  });

  it("is not editable outside a working-tree target", () => {
    expect(splitRowEdit("commit", "new", { lineNumber: 5, value: "x" })).toBeNull();
  });
});
