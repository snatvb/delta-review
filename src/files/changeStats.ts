// src/files/changeStats.ts
import type { FileEntry } from "../types";

/** The file panel header's +/− totals, summed over the reviewable files.
 *  Viewed files are skipped when `excludeViewed` is on — the "count only what's
 *  left to review" reading of the counter. Per-file numbers and the viewed chip
 *  always count everything; this is the top-line sum only. */
export function sumChangeStats(
  files: FileEntry[],
  viewedFiles: ReadonlySet<string>,
  excludeViewed: boolean,
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    if (f.ignored) continue;
    if (excludeViewed && viewedFiles.has(f.path)) continue;
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
}
