import type { DiffMode, Side } from "../types";

export function isWorkingTreeTarget(mode: DiffMode): boolean {
  return mode === "all-changes" || mode === "uncommitted";
}

// @git-diff-view keeps each line's terminator inside `value`; the backend compares
// and writes the line without one.
function withoutTerminator(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export interface EditableLine {
  side: "new";
  line: number;
  text: string;
}

interface UnifiedLineShape {
  newLineNumber?: number | null;
  value?: string | null;
}

export function unifiedRowEdit(mode: DiffMode, line: UnifiedLineShape): EditableLine | null {
  if (!isWorkingTreeTarget(mode) || line.newLineNumber == null || line.value == null) {
    return null;
  }
  return { side: "new", line: line.newLineNumber, text: withoutTerminator(line.value) };
}

interface SplitLineShape {
  lineNumber?: number | null;
  value?: string | null;
}

export function splitRowEdit(mode: DiffMode, side: Side, line: SplitLineShape): EditableLine | null {
  if (!isWorkingTreeTarget(mode) || side !== "new" || line.lineNumber == null || line.value == null) {
    return null;
  }
  return { side: "new", line: line.lineNumber, text: withoutTerminator(line.value) };
}
