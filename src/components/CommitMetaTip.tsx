import type * as React from "react";
import { Hint } from "@/components/Hint";
import type { CommitMeta } from "@/types";

/** The body of a commit hover: subject, author · date, full oid. Shown wherever
 *  the UI abbreviates a commit to its short oid — the diff-mode trigger and the
 *  comment index's handed-off chip — so the full context is one hover away
 *  instead of a native `title` the user has to wait a second for. */
export function CommitMetaBody({ meta, oid, note }: {
  meta?: CommitMeta;
  oid: string;
  /** Extra line under the metadata (e.g. what clicking the chip does). */
  note?: React.ReactNode;
}) {
  if (!meta) {
    return (
      <span className="flex max-w-[280px] flex-col items-start gap-1 text-left">
        {note && <span>{note}</span>}
        <span className="font-mono text-[11px] text-background/60">{oid}</span>
      </span>
    );
  }
  return (
    <span className="flex max-w-[280px] flex-col items-start gap-0.5 text-left">
      <span className="w-full truncate font-medium">{meta.subject || "(no subject)"}</span>
      <span className="text-background/60">
        {meta.author || "unknown"} · {new Date(meta.time * 1000).toLocaleString()}
      </span>
      <span className="font-mono text-[11px] text-background/60">{oid}</span>
      {note && <span className="text-background/60">{note}</span>}
    </span>
  );
}

/** Hover wrapper for a commit reference: rich body when the commit's metadata
 *  is loaded, oid-only fallback otherwise. */
export function CommitMetaTip({ meta, oid, note, children, ...hint }: {
  meta?: CommitMeta;
  oid: string;
  note?: React.ReactNode;
  children: React.ReactElement;
} & Omit<React.ComponentProps<typeof Hint>, "tip" | "children">) {
  return (
    <Hint tip={<CommitMetaBody meta={meta} oid={oid} note={note} />} {...hint}>
      {children}
    </Hint>
  );
}
