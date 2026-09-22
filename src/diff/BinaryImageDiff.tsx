// src/diff/BinaryImageDiff.tsx
//
// GitHub-style compare for binary images (#binary): old left, new right — a single
// pane when the change has only one side (added/deleted). Each side sits on a
// checkerboard so transparency reads, captioned with its natural dimensions and
// byte size, scaled to fit. The card body is a FIXED height (the pane's offset
// math needs it known before anything loads), so images never size the card.
//
// Data comes from get_binary_file_diff as base64 (server-capped); a side over the
// cap reports its size but no data — the pane says "too large to preview" instead.
import { useState } from "react";
import { ImageOff } from "lucide-react";
import { formatBytes, imageDataUrl } from "./binaryFile";
import type { BinaryFileDiff, FileStatus } from "../types";

interface Side {
  label: string;
  base64: string | null;
  mime: string | null;
  size: number | null;
}

function ImagePane({ side }: { side: Side }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  return (
    <div data-side={side.label.toLowerCase()} className="flex min-w-0 flex-1 flex-col">
      <div className="delta-ui-font flex h-7 shrink-0 items-center justify-center gap-2 text-[11px] text-muted-foreground">
        <span>{side.label}</span>
        {dims && (
          <span className="tabular-nums">
            {dims.w} × {dims.h}
          </span>
        )}
        {side.size != null && <span className="tabular-nums">{formatBytes(side.size)}</span>}
      </div>
      <div className="delta-checker flex min-h-0 flex-1 items-center justify-center overflow-hidden border-t border-border/40 p-3">
        {side.base64 && side.mime ? (
          <img
            src={imageDataUrl(side.mime, side.base64)}
            alt={`${side.label} version`}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            onLoad={(e) => {
              const t = e.currentTarget;
              setDims({ w: t.naturalWidth, h: t.naturalHeight });
            }}
          />
        ) : (
          <span className="delta-ui-font flex items-center gap-2 px-3 text-center text-[12px] text-muted-foreground">
            <ImageOff className="size-4 shrink-0 opacity-70" />
            {side.size != null ? `Too large to preview — ${formatBytes(side.size)}` : "No preview available"}
          </span>
        )}
      </div>
    </div>
  );
}

export function BinaryImageDiff({
  binary,
  status,
  mime,
  oldMime,
}: {
  binary: BinaryFileDiff | undefined; // undefined while the fetch is in flight
  status: FileStatus;
  mime: string | null; // MIME for the new side, from the file's extension
  oldMime?: string | null; // old side may be a renamed extension change
}) {
  if (!binary) {
    return (
      <div className="delta-ui-font flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <span>Loading image…</span>
      </div>
    );
  }
  const sides: Side[] = [];
  if (status !== "added") sides.push({ label: "Old", base64: binary.oldData, mime: oldMime ?? mime, size: binary.oldSize });
  if (status !== "deleted") sides.push({ label: "New", base64: binary.newData, mime, size: binary.newSize });
  return (
    <div className="flex h-full items-stretch">
      {sides.map((side, i) => (
        <div key={side.label} className={`flex min-w-0 flex-1 ${i > 0 ? "border-l border-border/40" : ""}`}>
          <ImagePane side={side} />
        </div>
      ))}
    </div>
  );
}
