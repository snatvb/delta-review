// Pure decision logic for the full-file editor overlay (Phase 2 of in-app
// editing). Kept separate from FileEditorOverlay.tsx so it's unit-testable
// without mounting CodeMirror or the 1600-line diff pane.

/** Character offset of the start of a 1-based `line` within LF-normalized
 *  `content`. Clamps to the end of the content when `line` is out of range,
 *  so a stale escalation target still lands somewhere sane. */
export function offsetForLine(content: string, line: number): number {
  if (line <= 1) return 0;
  let idx = -1;
  for (let n = 1; n < line; n++) {
    const next = content.indexOf("\n", idx + 1);
    if (next === -1) return content.length;
    idx = next;
  }
  return idx + 1;
}

/** The backend's exact wording for a conflicting write (edit_file_line and
 *  write_file_text both use it) — lets the overlay tell a stale-write refusal
 *  apart from any other save failure. */
export function isStaleWriteError(message: string): boolean {
  return message.includes("changed on disk");
}
