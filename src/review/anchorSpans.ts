import type { Anchor, AnchorSpan, CommentScope, Side } from "../types";

export type LineRef = { side: Side; line: number };
export type LineText = (side: Side, line: number) => string;

const SIDE_ORDER: Record<Side, number> = { new: 0, old: 1 };
const bySideThenLine = (a: LineRef, b: LineRef) => SIDE_ORDER[a.side] - SIDE_ORDER[b.side] || a.line - b.line;
const lineKey = (side: Side, line: number) => `${side}:${line}`;

export function spansOf(a: Anchor): AnchorSpan[] {
  if (a.spans) return a.spans;
  if (a.startLine == null) return [];
  return [{ side: a.side, start: a.startLine, end: Math.max(a.startLine, a.endLine ?? a.startLine), text: a.snippet ?? "" }];
}

export function anchorFromSpans(file: string, spans: AnchorSpan[]): Anchor {
  return { file, side: spans[0].side, spans };
}

export function scopeForAnchor(a: Anchor): Extract<CommentScope, "point" | "range" | "line"> {
  if (a.x != null) return "point";
  return spansOf(a).reduce((n, s) => n + s.end - s.start + 1, 0) > 1 ? "range" : "line";
}

export const isLineSelected = (spans: AnchorSpan[], ref: LineRef) =>
  spans.some((s) => s.side === ref.side && ref.line >= s.start && ref.line <= s.end);

export function spansFromLines(lines: LineRef[], lineText: LineText): AnchorSpan[] {
  const spans: AnchorSpan[] = [];
  for (const { side, line } of [...lines].sort(bySideThenLine)) {
    const last = spans[spans.length - 1];
    if (last && last.side === side && last.end === line - 1) last.end = line;
    else if (!last || last.side !== side || last.end < line) spans.push({ side, start: line, end: line, text: "" });
  }
  for (const s of spans) {
    const rows: string[] = [];
    for (let line = s.start; line <= s.end; line++) rows.push(lineText(s.side, line));
    s.text = rows.join("\n");
  }
  return spans;
}

export function withLines(spans: AnchorSpan[], refs: LineRef[], selected: boolean, lineText: LineText): AnchorSpan[] {
  const kept = new Map<string, LineRef & { text: string }>();
  for (const s of spans) {
    const rows = s.text.split("\n");
    const oneRowPerLine = rows.length === s.end - s.start + 1;
    for (let line = s.start; line <= s.end; line++) {
      kept.set(lineKey(s.side, line), { side: s.side, line, text: oneRowPerLine ? rows[line - s.start] : lineText(s.side, line) });
    }
  }
  for (const ref of refs) {
    if (selected) kept.set(lineKey(ref.side, ref.line), { ...ref, text: lineText(ref.side, ref.line) });
    else kept.delete(lineKey(ref.side, ref.line));
  }
  return spansFromLines([...kept.values()], (side, line) => kept.get(lineKey(side, line))?.text ?? "");
}

export function fillGaps(refs: LineRef[]): LineRef[] {
  const bounds = new Map<Side, [number, number]>();
  for (const { side, line } of refs) {
    const b = bounds.get(side);
    bounds.set(side, b ? [Math.min(b[0], line), Math.max(b[1], line)] : [line, line]);
  }
  return [...bounds].flatMap(([side, [from, to]]) => Array.from({ length: to - from + 1 }, (_, i) => ({ side, line: from + i })));
}

export function runsLabel(spans: AnchorSpan[], dash = "-", separator = ", "): string {
  return spans.map((s) => (s.start === s.end ? `${s.start}` : `${s.start}${dash}${s.end}`)).join(separator);
}

export function firstLineOf(a: Anchor): number {
  const spans = spansOf(a);
  const lead = spans.find((s) => s.side === "new") ?? spans[0];
  return lead ? spans.filter((s) => s.side === lead.side).reduce((n, s) => Math.min(n, s.start), lead.start) : 0;
}
