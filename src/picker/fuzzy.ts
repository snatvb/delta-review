import { worktreeName } from "../lib/utils";
import type { PickerWorktree } from "../types";

/** Subsequence fuzzy match. Returns a score (higher is better), or null if no match. */
export function fuzzyMatch(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const consecutive = ti === prev + 1 ? 2 : 0;
      const boundary = ti === 0 || /[/\s_.-]/.test(t[ti - 1]) ? 3 : 0;
      score += 1 + consecutive + boundary;
      prev = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/** When this folder was last touched: the review you'd resume if one matches
 *  the live branch, else the branch's last commit. */
export function worktreeActivity(w: PickerWorktree): string {
  return w.review?.lastOpenedAt ?? w.lastCommitAt ?? "";
}

/** Filter + rank worktree folders against a query (branch + repo name haystack). */
export function rankWorktrees(worktrees: PickerWorktree[], query: string): PickerWorktree[] {
  const scored: { w: PickerWorktree; score: number }[] = [];
  for (const w of worktrees) {
    const score = fuzzyMatch(query, `${worktreeName(w.path)} ${w.branch} ${w.repoName}`);
    if (score !== null) scored.push({ w, score });
  }
  scored.sort((a, b) => b.score - a.score || worktreeActivity(b.w).localeCompare(worktreeActivity(a.w)));
  return scored.map((x) => x.w);
}
