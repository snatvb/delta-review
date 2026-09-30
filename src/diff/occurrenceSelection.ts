// src/diff/occurrenceSelection.ts
//
// Turns a text selection made inside one diff row into the query for
// selection-occurrence highlighting (#occ): picking part of a word highlights the
// other occurrences of that string across the SAME file's shown lines, like an
// editor's selection-match highlighting. Returns null to skip. Multi-line
// selections are rejected (occurrences match per-line, VirtualDiffPane); so is a
// single character — mirroring the full-file editor's highlightSelectionMatches
// default (minSelectionLength 2), one glyph lights the whole file up for no
// value. The result is trimmed so a stray leading/trailing space swept up in a
// drag doesn't silently zero out the matches.
export function occurrenceQueryFromSelection(selected: string): string | null {
  const trimmed = selected.trim();
  if (trimmed.length < 2) return null;
  if (/[\r\n]/.test(trimmed)) return null;
  return trimmed;
}
