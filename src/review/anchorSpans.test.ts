import { describe, it, expect } from "vitest";
import { anchorFromSpans, fillGaps, firstLineOf, runsLabel, scopeForAnchor, spansFromLines, spansOf, withLines } from "./anchorSpans";
import type { Anchor, AnchorSpan } from "../types";

const lines = ["one", "two", "three", "four", "five", "six"];
const textOf = (side: "new" | "old", line: number) => (side === "new" ? lines : lines.map((l) => `-${l}`))[line - 1] ?? "";
const span = (side: "new" | "old", start: number, end = start): AnchorSpan => ({
  side, start, end, text: Array.from({ length: end - start + 1 }, (_, i) => textOf(side, start + i)).join("\n"),
});
const anchorsEqual = (a: AnchorSpan[], b: AnchorSpan[]) => {
  expect(a.map(({ side, start, end }) => [side, start, end])).toEqual(b.map(({ side, start, end }) => [side, start, end]));
  expect(a.map((s) => s.text)).toEqual(b.map((s) => s.text));
};

describe("spansOf", () => {
  it("reads an anchor written before spans existed as a single run", () => {
    const legacy: Anchor = { file: "a.ts", side: "old", startLine: 3, endLine: 5, snippet: "x\ny\nz" };
    expect(spansOf(legacy)).toEqual([{ side: "old", start: 3, end: 5, text: "x\ny\nz" }]);
    expect(spansOf({ file: "a.ts", side: "new", startLine: 7, endLine: null, snippet: "x" })).toEqual([{ side: "new", start: 7, end: 7, text: "x" }]);
    expect(spansOf({ file: "a.ts", side: "new", startLine: null, endLine: null, snippet: null })).toEqual([]);
  });

  it("prefers the stored spans", () => {
    const a = anchorFromSpans("a.ts", [span("new", 2), span("old", 9)]);
    expect(spansOf(a)).toEqual([span("new", 2), span("old", 9)]);
    expect(a.side).toBe("new");
  });
});

describe("scopeForAnchor", () => {
  it("is a point for image anchors, a range for more than one line, else a line", () => {
    expect(scopeForAnchor({ file: "a.png", side: "new", x: 0.2, y: 0.4 })).toBe("point");
    expect(scopeForAnchor(anchorFromSpans("a.ts", [span("new", 4)]))).toBe("line");
    expect(scopeForAnchor(anchorFromSpans("a.ts", [span("new", 4, 6)]))).toBe("range");
    expect(scopeForAnchor(anchorFromSpans("a.ts", [span("new", 4), span("new", 9)]))).toBe("range");
  });
});

describe("spansFromLines", () => {
  it("merges consecutive lines into one run per side, new side first", () => {
    const spans = spansFromLines([{ side: "old", line: 9 }, { side: "new", line: 5 }, { side: "new", line: 3 }, { side: "new", line: 4 }, { side: "new", line: 4 }], textOf);
    anchorsEqual(spans, [span("new", 3, 5), span("old", 9)]);
  });
});

describe("withLines", () => {
  it("selecting a line beside a run grows it, between two runs joins them, apart starts a new run", () => {
    const base = [span("new", 3, 4)];
    anchorsEqual(withLines(base, [{ side: "new", line: 5 }], true, textOf), [span("new", 3, 5)]);
    anchorsEqual(withLines(base, [{ side: "new", line: 2 }], true, textOf), [span("new", 2, 4)]);
    anchorsEqual(withLines([...base, span("new", 6)], [{ side: "new", line: 5 }], true, textOf), [span("new", 3, 6)]);
    anchorsEqual(withLines(base, [{ side: "new", line: 9 }, { side: "old", line: 1 }], true, textOf), [span("new", 3, 4), span("new", 9), span("old", 1)]);
  });

  it("unselecting an end shrinks the run; unselecting its middle splits it; its last line empties the selection", () => {
    const base = [span("new", 3, 5)];
    anchorsEqual(withLines(base, [{ side: "new", line: 3 }], false, textOf), [span("new", 4, 5)]);
    anchorsEqual(withLines(base, [{ side: "new", line: 5 }], false, textOf), [span("new", 3, 4)]);
    anchorsEqual(withLines(base, [{ side: "new", line: 4 }], false, textOf), [span("new", 3), span("new", 5)]);
    expect(withLines([span("new", 3)], [{ side: "new", line: 3 }], false, textOf)).toEqual([]);
    expect(withLines(base, [{ side: "old", line: 3 }], false, textOf)).toEqual(base);
  });

  it("keeps the text a line was anchored with and only reads a newly selected line from the file", () => {
    const anchored = [{ ...span("new", 2), text: "OLD two" }];
    expect(withLines(anchored, [{ side: "new", line: 3 }], true, textOf)[0].text).toBe("OLD two\nthree");
  });
});

describe("fillGaps", () => {
  it("spans each side from its first to its last line", () => {
    expect(fillGaps([{ side: "new", line: 8 }, { side: "new", line: 5 }, { side: "old", line: 2 }])).toEqual([
      { side: "new", line: 5 }, { side: "new", line: 6 }, { side: "new", line: 7 }, { side: "new", line: 8 },
      { side: "old", line: 2 },
    ]);
  });
});

describe("runsLabel", () => {
  it("lists runs as start-end or a single number", () => {
    expect(runsLabel([span("new", 3, 5), span("new", 10)], "-", ",")).toBe("3-5,10");
    expect(runsLabel([span("new", 3, 5), span("new", 10)], "–", ", ")).toBe("3–5, 10");
    expect(runsLabel([])).toBe("");
  });
});

describe("firstLineOf", () => {
  it("is the lowest new-side line, falling back to the old side", () => {
    expect(firstLineOf(anchorFromSpans("a.ts", [span("new", 12), span("new", 4), span("old", 2)]))).toBe(4);
    expect(firstLineOf(anchorFromSpans("a.ts", [span("old", 8), span("old", 3)]))).toBe(3);
    expect(firstLineOf({ file: "a.ts", side: "new", startLine: null, endLine: null, snippet: null })).toBe(0);
  });
});
