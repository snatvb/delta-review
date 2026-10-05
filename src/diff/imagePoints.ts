// src/diff/imagePoints.ts
//
// Image point comments (#point): the shared vocabulary of the pins rendered on
// the binary image card, in the lightbox, and in the thread blocks below the
// card — identity, ordering, numbering, and tone — so a comment reads as the
// same numbered marker everywhere it appears.
import type { Comment } from "../types";

/** A point comment's fraction position, or null when the comment isn't one. */
export function pointOf(c: Comment): { side: "old" | "new"; x: number; y: number } | null {
  const a = c.anchor;
  if (c.scope !== "point" || !a || a.x == null || a.y == null) return null;
  return { side: a.side, x: a.x, y: a.y };
}

/** Pin block key: comments placed at the same side + point share one thread. */
export const pointKey = (side: "old" | "new", x: number, y: number) => `${side}:${x.toFixed(4)}:${y.toFixed(4)}`;

/**
 * Point comments numbered 1..N, top-to-bottom then left-to-right — the order
 * the card's thread blocks render in, so a pin's number matches its thread in
 * the card and the lightbox alike. Returns comment id → 1-based number.
 */
export function numberPointComments(comments: Comment[]): Map<string, number> {
  const pts = comments
    .map((c) => ({ c, p: pointOf(c) }))
    .filter((e): e is { c: Comment; p: { side: "old" | "new"; x: number; y: number } } => e.p != null)
    .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x || a.c.createdAt.localeCompare(b.c.createdAt));
  const m = new Map<string, number>();
  pts.forEach((e, i) => m.set(e.c.id, i + 1));
  return m;
}

/** "x30% y62%" — the compact location shown in thread headers and the index. */
export const pointSuffix = (x: number, y: number) => `x${Math.round(x * 100)}% y${Math.round(y * 100)}%`;

export type PinTone = "open" | "stale" | "resolved";

/** A pin's color state, mirroring the comment rail: resolved → emerald, stale → amber, else primary. */
export const pinToneFor = (c: Comment): PinTone => (c.resolved ? "resolved" : c.stale ? "stale" : "open");

export const PIN_TONE_CLASS: Record<PinTone, string> = {
  open: "border-primary bg-primary text-primary-foreground",
  stale: "border-amber-500 bg-amber-500 text-white",
  resolved: "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500",
};
