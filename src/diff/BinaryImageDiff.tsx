// src/diff/BinaryImageDiff.tsx
//
// GitHub-style compare for binary images (#binary): old left, new right — a single
// pane when the change has only one side (added/deleted). Each side sits on a
// checkerboard so transparency reads, captioned with its natural dimensions and
// byte size, scaled to fit. The card body is a FIXED height (the pane's offset
// math needs it known before anything loads), so images never size the card.
//
// Sizes come from get_binary_file_diff; the pixels load straight into <img> from
// `srcOf` (the `delta-blob` URI scheme), never as base64 over IPC.
import { useState } from "react";
import { ImageOff } from "lucide-react";
import { formatBytes, MAX_IMAGE_PREVIEW_BYTES } from "./binaryFile";
import type { BinaryFileDiff, BlobSide, FileStatus } from "../types";

interface Side {
  side: BlobSide;
  label: string;
  mime: string | null;
  size: number | null;
}

function ImagePane({ side, src }: { side: Side; src: string | null }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const note =
    side.size == null ? "No preview available"
    : side.size > MAX_IMAGE_PREVIEW_BYTES ? `Too large to preview — ${formatBytes(side.size)}`
    : "Preview failed to load";
  return (
    <div data-side={side.side} className="flex min-w-0 flex-1 flex-col">
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
        {src && !failed ? (
          <img
            src={src}
            alt={`${side.label} version`}
            draggable={false}
            decoding="async"
            className="max-h-full max-w-full object-contain"
            onLoad={(e) => {
              const t = e.currentTarget;
              setDims({ w: t.naturalWidth, h: t.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="delta-ui-font flex items-center gap-2 px-3 text-center text-[12px] text-muted-foreground">
            <ImageOff className="size-4 shrink-0 opacity-70" />
            {note}
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
  srcOf,
}: {
  binary: BinaryFileDiff | undefined; // undefined while the fetch is in flight
  status: FileStatus;
  mime: string | null; // MIME for the new side, from the file's extension
  oldMime?: string | null; // old side may be a renamed extension change
  srcOf: (side: BlobSide, mime: string) => string;
}) {
  if (!binary) {
    return (
      <div className="delta-ui-font flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <span>Loading image…</span>
      </div>
    );
  }
  const sides: Side[] = [];
  if (status !== "added") sides.push({ side: "old", label: "Old", mime: oldMime ?? mime, size: binary.oldSize });
  if (status !== "deleted") sides.push({ side: "new", label: "New", mime, size: binary.newSize });
  return (
    <div className="flex h-full items-stretch">
      {sides.map((s, i) => {
        const previewable = s.size != null && s.size <= MAX_IMAGE_PREVIEW_BYTES && s.mime;
        const src = previewable ? srcOf(s.side, s.mime!) : null;
        return (
          <div key={s.side} className={`flex min-w-0 flex-1 ${i > 0 ? "border-l border-border/40" : ""}`}>
            <ImagePane key={src} side={s} src={src} />
          </div>
        );
      })}
    </div>
  );
}
