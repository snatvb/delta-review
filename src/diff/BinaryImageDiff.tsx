// src/diff/BinaryImageDiff.tsx
//
// GitHub-style compare for binary images (#binary): old left, new right — a single
// pane when the change has only one side (added/deleted). Each side sits on a
// checkerboard so transparency reads, captioned with its natural dimensions and
// byte size, scaled to fit. The card body is a FIXED height (the pane's offset
// math needs it known before anything loads), so images never size the card.
//
// Sizes come from get_binary_file_diff; the pixels load straight into <img> from
// `srcOf` (the `delta-blob` URI scheme), never as base64 over IPC. Clicking an
// image (or its expand button) opens the full-window viewer (#lightbox) — the
// tiny fitted preview is for orientation, not inspection.
//
// Point comments (#point) render as numbered pins over the pixels: the img's
// offset box is measured (not derived via CSS, where a % of an auto-height
// wrapper doesn't resolve), and each pin sits at its anchor's fraction of that
// box — so pins track the fit-scaling exactly. A pin click opens the lightbox
// with that comment's bubble; its number matches the thread blocks under the
// card and the lightbox pins (same order — see imagePoints.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOff, Maximize2 } from "lucide-react";
import { Hint } from "@/components/Hint";
import { binarySidesFor, formatBytes, previewableImageSide } from "./binaryFile";
import { PIN_TONE_CLASS } from "./imagePoints";
import type { BinaryFileDiff, BlobSide, FileStatus } from "../types";

interface Side {
  side: BlobSide;
  label: string;
  mime: string | null;
  size: number | null;
}

/** One pin on the preview: the comment it opens, its number, and its fraction position. */
export interface ImagePin {
  commentId: string;
  n: number;
  side: BlobSide;
  x: number;
  y: number;
  tone: "open" | "stale" | "resolved";
  title: string;
}

function ImagePane({
  side,
  src,
  pins,
  onOpenPin,
  onExpand,
}: {
  side: Side;
  src: string | null;
  pins: ImagePin[];
  onOpenPin?: (commentId: string) => void;
  onExpand?: () => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // The img's offset box inside the (position:relative) preview area — pins
  // position at fractions of it. Re-measured on load and on any resize (pane
  // or img both observed) so pins stay glued through card resizes.
  const [box, setBox] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const measure = useCallback(() => {
    const img = imgRef.current;
    if (!img || img.offsetWidth === 0) return;
    const next = { l: img.offsetLeft, t: img.offsetTop, w: img.offsetWidth, h: img.offsetHeight };
    setBox((prev) =>
      prev && Math.abs(prev.l - next.l) < 0.5 && Math.abs(prev.t - next.t) < 0.5
        && Math.abs(prev.w - next.w) < 0.5 && Math.abs(prev.h - next.h) < 0.5 ? prev : next,
    );
  }, []);
  useEffect(() => {
    const host = hostRef.current;
    const img = imgRef.current;
    if (!host || !img) return;
    measure(); // measure once up front — the observer only fires on CHANGE
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    ro.observe(img);
    return () => ro.disconnect();
  }, [measure]);
  const note =
    side.size == null ? "No preview available"
    : !previewableImageSide(side.size, side.mime) ? `Too large to preview — ${formatBytes(side.size)}`
    : failed ? "Preview failed to load"
    : null;
  return (
    <div data-side={side.side} className="flex min-w-0 flex-1 flex-col">
      <div className="delta-ui-font relative flex h-7 shrink-0 items-center justify-center gap-2 text-[11px] text-muted-foreground">
        <span>{side.label}</span>
        {dims && (
          <span className="tabular-nums">
            {dims.w} × {dims.h}
          </span>
        )}
        {side.size != null && <span className="tabular-nums">{formatBytes(side.size)}</span>}
        {onExpand && (
          <Hint tip="Open full view — zoom and compare">
            <button
              type="button"
              onClick={onExpand}
              aria-label={`Open full-size ${side.label.toLowerCase()} image`}
              className="absolute right-1 inline-flex size-6 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <Maximize2 className="size-3.5" />
            </button>
          </Hint>
        )}
      </div>
      <div ref={hostRef} className="delta-checker relative flex min-h-0 flex-1 items-center justify-center overflow-hidden border-t border-border/40 p-3">
        {src && !failed ? (
          <img
            ref={imgRef}
            src={src}
            alt={`${side.label} version`}
            draggable={false}
            decoding="async"
            onClick={onExpand}
            onLoad={(e) => {
              const t = e.currentTarget;
              setDims({ w: t.naturalWidth, h: t.naturalHeight });
              measure();
            }}
            onError={() => setFailed(true)}
            className={`max-h-full max-w-full object-contain${onExpand ? " cursor-zoom-in" : ""}`}
          />
        ) : note && (
          <span className="delta-ui-font flex items-center gap-2 px-3 text-center text-[12px] text-muted-foreground">
            <ImageOff className="size-4 shrink-0 opacity-70" />
            {note}
          </span>
        )}
        {box && pins.map((p) => (
          <Hint key={p.commentId} tip={p.title}>
            <button
              type="button"
              data-image-pin={p.n}
              aria-label={`Comment ${p.n} — ${side.label.toLowerCase()} image, x ${Math.round(p.x * 100)}% y ${Math.round(p.y * 100)}%`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onOpenPin?.(p.commentId);
              }}
              className={`absolute z-10 flex size-[18px] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border text-[10px] font-semibold leading-none tabular-nums shadow-sm transition-transform hover:scale-110 ${PIN_TONE_CLASS[p.tone]}`}
              style={{ left: box.l + p.x * box.w, top: box.t + p.y * box.h }}
            >
              {p.n}
            </button>
          </Hint>
        ))}
      </div>
    </div>
  );
}

export function BinaryImageDiff({
  binary,
  status,
  mime,
  oldMime,
  load,
  srcOf,
  pins,
  onOpenPin,
  onExpand,
}: {
  binary: BinaryFileDiff | undefined; // undefined while the fetch is in flight
  status: FileStatus;
  mime: string | null; // MIME for the new side, from the file's extension
  oldMime?: string | null; // old side may be a renamed extension change
  load: boolean; // near the viewport — off-screen cards keep their frame but fetch no pixels
  srcOf: (side: BlobSide, mime: string) => string;
  pins?: ImagePin[]; // point-comment pins, positioned over the pixels (#point)
  onOpenPin?: (commentId: string) => void; // open the lightbox with this pin's comment focused
  onExpand?: () => void; // open the full-window viewer (#lightbox); the pane knows the path + rev
}) {
  if (!binary) {
    return (
      <div className="delta-ui-font flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <span>Loading image…</span>
      </div>
    );
  }
  const sides: Side[] = binarySidesFor(status).map((side) => ({
    side,
    label: side === "old" ? "Old" : "New",
    mime: side === "old" ? oldMime ?? mime : mime,
    size: side === "old" ? binary.oldSize : binary.newSize,
  }));
  return (
    <div className="flex h-full items-stretch">
      {sides.map((s, i) => {
        const src = load && previewableImageSide(s.size, s.mime) ? srcOf(s.side, s.mime!) : null;
        return (
          <div key={s.side} className={`flex min-w-0 flex-1 ${i > 0 ? "border-l border-border/40" : ""}`}>
            <ImagePane key={src} side={s} src={src} pins={(pins ?? []).filter((p) => p.side === s.side)} onOpenPin={onOpenPin} onExpand={onExpand} />
          </div>
        );
      })}
    </div>
  );
}
