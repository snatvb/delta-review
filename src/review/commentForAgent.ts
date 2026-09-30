import { useCallback, useEffect, useRef, useState } from "react";
import type { Comment } from "../types";
import { track } from "../analytics";

// The per-comment counterpart of the backend's agent export (export/mod.rs):
// one comment, as compact as an agent can use it. The location leads in
// `path:line[-end]` form — the file:line convention agents parse natively —
// followed by the anchored snippet as a code fence, then the body verbatim.
// No review title, no section headers: this is a one-off note about a specific
// spot, meant to be pasted into a chat as-is.
export function commentForAgent(c: Comment): string {
  const a = c.anchor;
  if (!a) return c.body.trim();
  let loc = a.file;
  if (a.startLine != null) {
    loc += `:${a.startLine}`;
    if (a.endLine != null && a.endLine > a.startLine) loc += `-${a.endLine}`;
  }
  // Old-side line numbers refer to the pre-change content, and a stale anchor
  // no longer resolves in the current diff — both change how the agent should
  // read the location, so they ride along on the same line.
  const notes: string[] = [];
  if (a.side === "old") notes.push("old side");
  if (c.stale && !c.resolved) notes.push("⚠ stale");
  if (c.commit) notes.push(`commit ${c.commit.slice(0, 7)}`);
  if (notes.length) loc += ` (${notes.join(" · ")})`;

  const out = [loc];
  if (a.snippet && a.snippet.trim()) out.push("```" + langFor(a.file), a.snippet.trimEnd(), "```");
  const body = c.body.trim();
  if (body) out.push(body);
  return out.join("\n");
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
