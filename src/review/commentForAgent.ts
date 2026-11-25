import { useCallback, useEffect, useRef, useState } from "react";
import type { AnchorSpan, Comment } from "../types";
import { track } from "../analytics";
import { runsLabel, spansOf } from "./anchorSpans";

// The per-comment counterpart of the backend's agent export (export/mod.rs):
// one comment, as compact as an agent can use it. The location leads in
// `path:line[-end]` form — the file:line convention agents parse natively —
// followed by the anchored snippet as a code fence, then the body verbatim.
// No review title, no section headers: this is a one-off note about a specific
// spot, meant to be pasted into a chat as-is.
export function commentForAgent(c: Comment): string {
  const a = c.anchor;
  if (!a) return c.body.trim();
  const current = spansOf(a).filter((s) => s.side === "new");
  const deleted = spansOf(a).filter((s) => s.side === "old");
  let loc = a.file;
  if (current.length || deleted.length) loc += `:${runsLabel(current.length ? current : deleted, "-", ",")}`;
  // Old-side line numbers refer to the pre-change content, and a stale anchor
  // no longer resolves in the current diff — both change how the agent should
  // read the location, so they ride along on the same line. So does an image
  // point: fractions of the picture's natural size, the spot the pin marks.
  const notes: string[] = [];
  if (a.x != null && a.y != null) notes.push(`image x ${Math.round(a.x * 100)}% y ${Math.round(a.y * 100)}%`);
  if (current.length && deleted.length) notes.push(`deleted: old side ${runsLabel(deleted, "-", ",")}`);
  else if (a.side === "old") notes.push("old side");
  if (c.stale && !c.resolved) notes.push("⚠ stale");
  if (c.commit) notes.push(`commit ${c.commit.slice(0, 7)}`);
  if (notes.length) loc += ` (${notes.join(" · ")})`;

  const lang = langFor(a.file);
  const textOf = (spans: AnchorSpan[]) => spans.map((s) => s.text).join("\n");
  const fence = (text: string): string[] => (text.trim() ? ["```" + lang, text.trimEnd(), "```"] : []);
  const block = (label: string, spans: AnchorSpan[]): string | null => {
    const lines = fence(textOf(spans));
    return lines.length ? [label, ...lines].join("\n") : null;
  };
  const split = current.length > 0 && deleted.length > 0;
  const sections = [
    loc,
    split
      ? [
          block(`deleted (old side ${runsLabel(deleted, "-", ", ")}):`, deleted),
          block(`current (${runsLabel(current, "-", ", ")}):`, current),
        ].filter((b): b is string => b != null).join("\n\n")
      : fence(textOf(current.length ? current : deleted)).join("\n"),
    c.body.trim(),
  ].filter((section) => section !== "");
  return sections.join(split ? "\n\n" : "\n");
}

function langFor(file: string): string {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = file.slice(dot + 1);
  return ext.includes("/") ? "" : ext;
}

/** Copy one comment for an agent, flashing ✓ on that comment's button for
 *  1.2s. Shared by the diff's inline threads and the comments index, so the
 *  clipboard/feedback behavior stays identical in both. */
export function useCopyCommentForAgent() {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback((c: Comment) => {
    void navigator.clipboard.writeText(commentForAgent(c)).then(() => {
      track("copy_comment_for_agents", { scope: c.scope });
      setCopiedId(c.id);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopiedId(null), 1200);
    }).catch((e) => console.error("copy comment for agent:", e));
  }, []);
  return { copiedId, copy };
}
