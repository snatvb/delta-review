// Geometry from the last committed layout survives even when a viewed file has
// already been filtered out of the pane. No DOM lookup for that file is needed.
export type FileScrollGeometry = {
  path: string;
  top: number;
  bodyHeight: number;
  collapsed: boolean;
};

// `scrollTop` must be captured BEFORE the DOM shrinks: afterwards the browser
// may already have clamped it to the new scroll range. The caller clamps the
// result to that range and syncs virtualization, even if no DOM scroll is needed.
export function anchorScrollTopAfterReview(
  scrollTop: number,
  previous: readonly FileScrollGeometry[],
  current: readonly FileScrollGeometry[],
  viewedFiles: ReadonlySet<string>,
  headerH: number,
  gap: number,
  pad: number,
): number | null {
  const byPath = new Map(current.map((file) => [file.path, file]));
  let removedAbove = 0;
  let changed = false;

  for (let i = 0; i < previous.length; i++) {
    const file = previous[i];
    const next = byPath.get(file.path);
    const hidden = !next && viewedFiles.has(file.path);
    const collapsed = next?.collapsed && !file.collapsed;
    if (!hidden && !collapsed) {
      continue;
    }
    changed = true;
    if (scrollTop <= file.top) {
      continue; // The changed card is below the viewport top.
    }
    if (scrollTop <= file.top + headerH + file.bodyHeight) {
      if (next) {
        return Math.max(0, next.top - pad); // Keep the collapsed header on top.
      }
      // The current card disappeared. Find the next surviving card in the OLD
      // order, including when a folder checkbox hides several files at once.
      for (let j = i + 1; j < previous.length; j++) {
        const following = byPath.get(previous[j].path);
        if (following) {
          return Math.max(0, following.top - pad);
        }
      }
      // No following card: let the caller clamp to the end of the remaining pane.
      return Math.max(0, file.top - removedAbove - pad);
    }
    // The changed file is above what we're reading. Hidden cards lose their
    // header and gap too; collapsed cards lose only their body.
    removedAbove += file.bodyHeight + (hidden ? headerH + gap : 0);
  }

  if (!changed) {
    return null;
  }
  // Preserve the offset within a surviving reader card, not just the sum of
  // removed heights: async measurements can also move that card in this commit.
  for (let i = previous.length - 1; i >= 0; i--) {
    const file = previous[i];
    if (file.top > scrollTop + pad) {
      continue;
    }
    const reader = byPath.get(file.path);
    if (reader && reader.collapsed === file.collapsed) {
      return Math.max(0, reader.top + scrollTop - file.top);
    }
    break;
  }
  return Math.max(0, scrollTop - removedAbove);
}
