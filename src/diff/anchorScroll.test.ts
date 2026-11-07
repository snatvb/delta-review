import { describe, expect, it } from "vitest";
import { anchorScrollTopAfterReview, type FileScrollGeometry } from "./anchorScroll";

const HEADER_H = 40;
const GAP = 10;
const PAD = 14;
const previous: FileScrollGeometry[] = [
  { path: "before.ts", top: PAD, bodyHeight: 900, collapsed: false },
  { path: "large.ts", top: 964, bodyHeight: 5000, collapsed: false },
  { path: "next.ts", top: 6014, bodyHeight: 3000, collapsed: false },
];
const collapsed = [
  previous[0],
  { ...previous[1], bodyHeight: 0, collapsed: true },
  { ...previous[2], top: 1014 },
];
const hidden = [previous[0], { ...previous[2], top: 964 }];
const anchor = (top: number, current: FileScrollGeometry[], viewed = ["large.ts"]) =>
  anchorScrollTopAfterReview(top, previous, current, new Set(viewed), HEADER_H, GAP, PAD);

describe("anchorScrollTopAfterReview", () => {
  it("leaves scroll alone for loading, expansion, and unrelated removals", () => {
    expect(anchor(2000, previous)).toBeNull();
    expect(anchor(2000, [{ ...previous[0], bodyHeight: 1000 }, ...previous.slice(1)])).toBeNull();
    expect(anchor(2000, hidden, [])).toBeNull();
    expect(anchorScrollTopAfterReview(950, collapsed, previous, new Set(), HEADER_H, GAP, PAD)).toBeNull();
  });

  it("keeps the original position when the changed file is below the viewport top", () => {
    expect(anchor(200, collapsed)).toBe(200);
    expect(anchor(previous[1].top, collapsed)).toBe(previous[1].top);
    expect(anchor(200, hidden)).toBe(200);
  });

  it("snaps a collapsed file's header to the top while reviewing it", () => {
    expect(anchor(3000, collapsed)).toBe(950);
    expect(anchor(6004, collapsed)).toBe(950); // Body's bottom edge still belongs to it.
  });

  it("shows the next surviving file from its start when the current file disappears", () => {
    expect(anchor(3000, hidden)).toBe(950);
    expect(anchor(6004, hidden)).toBe(950);
  });

  it("preserves later content when a file above it collapses or disappears", () => {
    expect(anchor(6500, collapsed)).toBe(1500);
    expect(anchor(6500, hidden)).toBe(1450); // Hidden header + gap also leave.
    expect(anchor(6005, collapsed)).toBe(1005); // Just past the old body's bottom.
  });

  it("preserves the reader's offset when an earlier measurement changes in the same commit", () => {
    const measuredBefore = { ...previous[0], bodyHeight: 100 };
    const currentCollapsed = [
      measuredBefore,
      { ...collapsed[1], top: 164 },
      { ...collapsed[2], top: 214 },
    ];
    const currentHidden = [measuredBefore, { ...hidden[1], top: 164 }];
    expect(anchor(6500, currentCollapsed)).toBe(700);
    expect(anchor(6500, currentHidden)).toBe(650);
  });

  it("handles several hidden files, using the old order to find the next survivor", () => {
    const current = [{ ...previous[2], top: PAD }];
    expect(anchor(3000, current, ["before.ts", "large.ts"])).toBe(0);
    expect(anchor(6500, current, ["before.ts", "large.ts"])).toBe(500);
  });

  it("handles several collapsed files without skipping the next file", () => {
    const current = [
      { ...previous[0], bodyHeight: 0, collapsed: true },
      { ...previous[1], top: 64, bodyHeight: 0, collapsed: true },
      { ...previous[2], top: 114 },
    ];
    expect(anchor(3000, current)).toBe(50);
    expect(anchor(6500, current)).toBe(600);
  });

  it("anchors manual collapse too, without requiring a viewed mark", () => {
    expect(anchor(3000, collapsed, [])).toBe(950);
  });

  it("ignores newly added collapsed files", () => {
    const current = [...previous, { path: "new.ts", top: 9064, bodyHeight: 0, collapsed: true }];
    expect(anchor(3000, current)).toBeNull();
  });

  it("falls back to the end when the last file disappears, without negative positions", () => {
    const current = [previous[0]];
    expect(anchor(6500, current, ["large.ts", "next.ts"])).toBe(950);
    expect(anchor(500, [{ ...previous[1], top: PAD }, { ...previous[2], top: 5064 }], ["before.ts"])).toBe(0);
    expect(anchor(3000, [], ["before.ts", "large.ts", "next.ts"])).toBe(0);
  });
});
