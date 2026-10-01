// src/diff/ImageLightbox.tsx
//
// Full-window viewer for binary image diffs (#binary): the card's thumbnails are
// small and fixed-height, so judging a visual change needs a lightbox where the
// image can be inspected at real pixels. One zoom/pan state drives every compare
// mode — 2-up keeps both panes on the SAME scale and pan so the comparison stays
// honest, while swipe/onion/difference stack both sides in one box sized to the
// largest natural dimensions (differently-sized sides center-align inside it).
// Every size derivation guards against zero — headless DOMs report 0×0 stages
// and images that never load — falling back to scale 1 instead of dividing by it.
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronsLeftRight, ImageOff, ZoomIn, ZoomOut } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isMac } from "../lib/platform";
import { formatBytes } from "./binaryFile";
import type { BlobSide } from "../types";

export type ImageCompareMode = "2-up" | "swipe" | "onion" | "difference";

export interface ImageLightboxSide {
  side: BlobSide;
  label: string;
  /** Blob/data URL; null when the side is not previewable. */
  src: string | null;
  mime: string | null;
  /** Bytes; null when unknown. */
  size: number | null;
}

type Dims = { w: number; h: number };
type Point = { x: number; y: number };
type Backdrop = "checker" | "dark" | "light";

const MODES: { value: ImageCompareMode; label: string; title: string }[] = [
  { value: "2-up", label: "2-up", title: "Side by side" },
  { value: "swipe", label: "Swipe", title: "Swipe compare" },
  { value: "onion", label: "Onion", title: "Onion skin" },
  { value: "difference", label: "Diff", title: "Pixel difference" },
];

const BACKDROPS: { value: Backdrop; title: string }[] = [
  { value: "checker", title: "Checker backdrop" },
  { value: "dark", title: "Dark backdrop" },
  { value: "light", title: "Light backdrop" },
];

// Photographic backdrops, not theme colors — fixed so a backdrop reads the same
// in light and dark mode.
const BACKDROP_BG: Record<Exclude<Backdrop, "checker">, string> = {
  dark: "rgb(24 24 27)",
  light: "rgb(250 250 250)",
};

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const clamp01to100 = (n: number): number => Math.min(100, Math.max(0, n));

type Transform = { scale: number; pan: Point };
// Pan bounds need the content extent (box) and the stage, in px.
type Geo = { boxW: number; boxH: number; stW: number; stH: number };

// Module-level and pure so listeners depend on their NUMERIC inputs only —
// per-render closures in effect deps would rebind the listeners every tick.
const clampPan = (p: Point, s: number, g: Geo): Point => {
  // Content smaller than the stage locks centered; larger can't fully leave.
  const maxX = Math.max(0, (g.boxW * s - g.stW) / 2);
  const maxY = Math.max(0, (g.boxH * s - g.stH) / 2);
  return { x: Math.min(maxX, Math.max(-maxX, p.x)), y: Math.min(maxY, Math.max(-maxY, p.y)) };
};

// Zoom anchored at (fx, fy): the content point under that point stays under it.
// fx/fy are offsets from the anchor the transform's pan is measured against.
const zoomAt = (t: Transform, factor: number, fx: number, fy: number, g: Geo): Transform => {
  const scale = clampScale(t.scale * factor);
  if (scale === t.scale) return t; // same object → React skips the re-render
  const k = scale / t.scale;
  return { scale, pan: clampPan({ x: fx - (fx - t.pan.x) * k, y: fy - (fy - t.pan.y) * k }, scale, g) };
};

// Button/key zoom anchors on the content's own center (0, 0 in pan coords).
const stepZoom = (t: Transform, factor: number, g: Geo): Transform => zoomAt(t, factor, 0, 0, g);

const panByStep = (t: Transform, dx: number, dy: number, g: Geo): Transform => ({
  ...t,
  pan: clampPan({ x: t.pan.x + dx, y: t.pan.y + dy }, t.scale, g),
});

// Shared chrome for the small header buttons (backdrop, zoom).
const iconBtn =
  "inline-flex h-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

// BinaryImageDiff's "can't show this side" treatment, reused per pane.
function SideNote({ text }: { text: string }) {
  return (
    <span className="delta-ui-font flex items-center gap-2 px-3 text-center text-[12px] text-muted-foreground">
      <ImageOff className="size-4 shrink-0 opacity-70" />
      {text}
    </span>
  );
}

export function ImageLightbox({ path, sides, onClose }: {
  path: string;
  /** 1 or 2 entries, order [old?, new] — used as given. */
  sides: ImageLightboxSide[];
  onClose: () => void;
}): ReactNode {
  const [mode, setMode] = useState<ImageCompareMode>("2-up");
  const [backdrop, setBackdrop] = useState<Backdrop>("checker");
  // One transform state, always updated FUNCTIONALLY: handlers never read the
  // current value, so they can't go stale and need no mirror refs.
  const [transform, setTransform] = useState<Transform>({ scale: 1, pan: { x: 0, y: 0 } });
  const [swipePos, setSwipePos] = useState(50);
  const [onionOpacity, setOnionOpacity] = useState(50);
  const [dims, setDims] = useState<Partial<Record<BlobSide, Dims>>>({});
  const [failed, setFailed] = useState<Partial<Record<BlobSide, boolean>>>({});
  const [stageSize, setStageSize] = useState<Point>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; startPan: Point } | null>(null);
  const downRef = useRef<{ x: number; y: number; target: EventTarget; moved: boolean } | null>(null);
  const gripDragRef = useRef<number | null>(null);

  const base = path.slice(path.lastIndexOf("/") + 1);
  const dir = path.slice(0, path.length - base.length);

  const twoUp = sides.length === 2 && mode === "2-up";
  const usable = sides.filter((s) => s.src != null && !failed[s.side]);
  const anyUsable = usable.length > 0;

  const knownDims = sides
    .map((s) => dims[s.side])
    .filter((d): d is Dims => !!d && d.w > 0 && d.h > 0);
  // Content extent for clamping and the shared compare box: the largest known
  // natural size across sides (0 while nothing has loaded → all math no-ops).
  const boxW = knownDims.reduce((m, d) => Math.max(m, d.w), 0);
  const boxH = knownDims.reduce((m, d) => Math.max(m, d.h), 0);

  // Pan/zoom bounds as plain numbers — stable effect deps.
  const geo: Geo = { boxW, boxH, stW: stageSize.x, stH: stageSize.y };

  let fitScale = 1;
  if (stageSize.x > 0 && stageSize.y > 0 && knownDims.length > 0) {
    if (twoUp) {
      const paneW = stageSize.x / 2 - 16;
      const paneH = stageSize.y - 16;
      if (paneW > 0 && paneH > 0) {
        fitScale = Math.min(...knownDims.map((d) => Math.min(paneW / d.w, paneH / d.h)));
      }
    } else if (boxW > 0 && boxH > 0) {
      fitScale = Math.min(stageSize.x / boxW, stageSize.y / boxH);
    }
  }

  // Opening, mode switches, stage resizes and dim arrivals all re-fit — the
  // zoom level is only meaningful once the stage and content sizes are known.
  // Adjusting DURING render (not in an effect) per React's adjust-state-when-
  // props-change pattern: a setState-in-effect cascades an extra render.
  const [fitAnchor, setFitAnchor] = useState<{ mode: ImageCompareMode; fit: number } | null>(null);
  if (!fitAnchor || fitAnchor.mode !== mode || fitAnchor.fit !== fitScale) {
    setFitAnchor({ mode, fit: fitScale });
    setTransform({ scale: fitScale, pan: { x: 0, y: 0 } });
  }

  // Track the stage's size for fit math; ResizeObserver plus a window resize
  // listener (the observer alone misses window-level resizes in some embedders).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const r = stage.getBoundingClientRect();
      setStageSize({ x: r.width, y: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Native wheel listener — React's synthetic onWheel is passive, and this must
  // preventDefault to stop the app behind the overlay from scrolling.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !anyUsable) return;
    const onWheel = (e: WheelEvent) => {
      // The onion slider handles its own wheel target — zooming behind it as well
      // feels broken, and React's synthetic stopPropagation runs too late to help.
      if ((e.target as HTMLElement).closest('input[type="range"]')) return;
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      // Zoom-to-cursor: keep the content point under the cursor under the cursor.
      // In 2-up the images center on their PANES' centers, so the x anchor is the
      // half-pane the cursor is in — anchoring on the stage center would yank both
      // images sideways by up to a quarter of the window per notch.
      const fx = e.clientX - rect.left - (twoUp ? (e.clientX - rect.left < rect.width / 2 ? rect.width / 4 : (rect.width * 3) / 4) : rect.width / 2);
      const fy = e.clientY - rect.top - rect.height / 2;
      setTransform((t) => zoomAt(t, Math.exp(-e.deltaY * (e.ctrlKey ? 0.008 : 0.0015)), fx, fy, geo));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
    // Numeric deps only: the handlers close over `geo`'s inputs, so a geometry
    // change rebinds once and every wheel tick between changes hits fresh math.
  }, [anyUsable, twoUp, boxW, boxH, stageSize.x, stageSize.y]);

  // One window listener for the whole overlay, like FileEditorOverlay's Esc.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "+":
        case "=":
          if (anyUsable) setTransform((t) => stepZoom(t, 1.25, geo));
          break;
        case "-":
          if (anyUsable) setTransform((t) => stepZoom(t, 1 / 1.25, geo));
          break;
        case "0":
          if (anyUsable) setTransform({ scale: fitScale, pan: { x: 0, y: 0 } });
          break;
        case "1":
          if (anyUsable) setTransform({ scale: 1, pan: { x: 0, y: 0 } });
          break;
        case "ArrowLeft":
          e.preventDefault();
          setTransform((t) => panByStep(t, -80, 0, geo));
          break;
        case "ArrowRight":
          e.preventDefault();
          setTransform((t) => panByStep(t, 80, 0, geo));
          break;
        case "ArrowUp":
          e.preventDefault();
          setTransform((t) => panByStep(t, 0, -80, geo));
          break;
        case "ArrowDown":
          e.preventDefault();
          setTransform((t) => panByStep(t, 0, 80, geo));
          break;
        case "[":
          if (mode === "swipe") setSwipePos((p) => clamp01to100(p - 2));
          break;
        case "]":
          if (mode === "swipe") setSwipePos((p) => clamp01to100(p + 2));
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, anyUsable, fitScale, onClose, boxW, boxH, stageSize.x, stageSize.y]);

  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, startPan: { ...transform.pan } };
    // The down target decides click-to-close: with pointer capture active the
    // up event's target is always the stage, so it can't be consulted then.
    downRef.current = { x: e.clientX, y: e.clientY, target: e.target, moved: false };
    setDragging(true);
    try {
      stageRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Headless DOMs without capture still pan fine within the stage.
    }
  };

  const onStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (downRef.current && Math.hypot(dx, dy) > 3) downRef.current.moved = true;
    setTransform((t) => ({ ...t, pan: clampPan({ x: drag.startPan.x + dx, y: drag.startPan.y + dy }, t.scale, geo) }));
  };

  const onStagePointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const down = downRef.current;
    dragRef.current = null;
    downRef.current = null;
    if (drag?.pointerId !== e.pointerId) return;
    setDragging(false);
    // Bare-stage click (no drag, down landed on the stage itself) closes —
    // clicks that landed on the image or a control never do. Cancel events
    // (e.g. an interrupted gesture) must not close.
    if (
      e.type === "pointerup" &&
      down &&
      !down.moved &&
      Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4 &&
      down.target === stageRef.current
    ) {
      onClose();
    }
  };

  const onStageDoubleClick = () => {
    if (!anyUsable) return;
    setTransform((t) => (Math.abs(t.scale - fitScale) < 0.01 ? { scale: 1, pan: { x: 0, y: 0 } } : { scale: fitScale, pan: { x: 0, y: 0 } }));
  };

  const handleLoad = (side: BlobSide) => (e: SyntheticEvent<HTMLImageElement>) => {
    const t = e.currentTarget;
    if (t.naturalWidth > 0 && t.naturalHeight > 0) {
      setDims((d) => ({ ...d, [side]: { w: t.naturalWidth, h: t.naturalHeight } }));
    }
  };
  const handleError = (side: BlobSide) => () => setFailed((f) => ({ ...f, [side]: true }));

  const stageBackdropClass = backdrop === "checker" ? "delta-checker" : "";
  const stageBackdropStyle: CSSProperties | undefined =
    backdrop === "checker" ? undefined : { backgroundColor: BACKDROP_BG[backdrop] };

  // Screen-space geometry of the shared box (stage coords) — the swipe divider
  // lives here, not in the transformed box, so it never scales with zoom.
  const dispW = boxW * transform.scale;
  const dispH = boxH * transform.scale;
  const boxLeft = stageSize.x / 2 + transform.pan.x - dispW / 2;
  const boxTop = stageSize.y / 2 + transform.pan.y - dispH / 2;

  const stopPointer = (e: ReactPointerEvent) => e.stopPropagation();

  const posFromClientX = (clientX: number): number => {
    const stage = stageRef.current;
    if (!stage || dispW <= 0) return swipePos;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0) return swipePos;
    const rel = (clientX - rect.left - rect.width / 2 - transform.pan.x) / dispW;
    return clamp01to100((rel + 0.5) * 100);
  };

  // In stacked modes the second entry is the side that sits on top.
  const topSide = sides.length === 2 ? sides[1].side : null;

  // Difference blending needs its own stacking context on black: identical
  // pixels subtract to black, changes light up.
  const diffStyle: CSSProperties = { isolation: "isolate", backgroundColor: "rgb(0 0 0)" };

  const stackedImgStyle = (side: BlobSide): CSSProperties => {
    if (side !== topSide) return {};
    if (mode === "swipe") return { clipPath: `inset(0 0 0 ${swipePos}%)` };
    if (mode === "onion") return { opacity: onionOpacity / 100 };
    if (mode === "difference") return { mixBlendMode: "difference" };
    return {};
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`View image ${path}`}
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      {/* macOS traffic lights float over the top-left — pad the header past them
          like the workspace toolbar does (pl-24), so Back stays clickable. */}
      <header className={`flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card pr-4 ${isMac ? "pl-24" : "pl-4"}`}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to the diff"
          title="Back to the diff (Esc)"
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background pl-1.5 pr-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ArrowLeft className="size-4" /> Back
          <Kbd keys="esc" className="border-border/60 bg-muted/50" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
          {dir && <span className="text-muted-foreground">{dir}</span>}
          <span className="font-medium text-foreground">{base}</span>
        </span>
        {sides.length === 2 && (
          <ToggleGroup
            type="single"
            size="sm"
            value={mode}
            onValueChange={(v) => v && setMode(v as ImageCompareMode)}
            className="gap-0.5 rounded-lg bg-muted/70 p-0.5"
          >
            {MODES.map((m) => (
              <ToggleGroupItem
                key={m.value}
                value={m.value}
                aria-label={m.title}
                title={m.title}
                className="h-7 gap-1.5 rounded-md border-0 px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"
              >
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Backdrop">
          {BACKDROPS.map((b) => (
            <button
              key={b.value}
              type="button"
              title={b.title}
              aria-label={b.title}
              aria-pressed={backdrop === b.value}
              onClick={() => setBackdrop(b.value)}
              className={`${iconBtn} w-7 ${backdrop === b.value ? "ring-1 ring-border" : ""}`}
            >
              <span
                className={`size-3.5 rounded-sm ${b.value === "checker" ? "delta-checker" : ""}`}
                style={b.value === "checker" ? undefined : { backgroundColor: BACKDROP_BG[b.value] }}
              />
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Zoom">
          <button type="button" title="Zoom out" aria-label="Zoom out" disabled={!anyUsable} onClick={() => setTransform((t) => stepZoom(t, 1 / 1.25, geo))} className={`${iconBtn} w-7`}>
            <ZoomOut className="size-4" />
          </button>
          <span className="w-12 text-center text-[12px] tabular-nums text-muted-foreground" title="Zoom level">
            {Math.round(transform.scale * 100)}%
          </span>
          <button type="button" title="Zoom in" aria-label="Zoom in" disabled={!anyUsable} onClick={() => setTransform((t) => stepZoom(t, 1.25, geo))} className={`${iconBtn} w-7`}>
            <ZoomIn className="size-4" />
          </button>
          <button
            type="button"
            title="Fit to window"
            disabled={!anyUsable}
            onClick={() => setTransform({ scale: fitScale, pan: { x: 0, y: 0 } })}
            className={`${iconBtn} px-2 text-[12px]`}
          >
            Fit
          </button>
          <button type="button" title="Actual size" disabled={!anyUsable} onClick={() => setTransform({ scale: 1, pan: { x: 0, y: 0 } })} className={`${iconBtn} px-2 text-[12px]`}>
            1:1
          </button>
        </div>
      </header>

      <div
        ref={stageRef}
        className={`relative min-h-0 flex-1 touch-none select-none overflow-hidden ${stageBackdropClass} ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={stageBackdropStyle}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerEnd}
        onPointerCancel={onStagePointerEnd}
        onDoubleClick={onStageDoubleClick}
      >
        {twoUp ? (
          <div className="flex h-full w-full">
            {sides.map((s, i) => {
              // A pane explains itself only while the other pane still shows an
              // image; when nothing is previewable the centered note takes over.
              const note = !anyUsable
                ? null
                : s.src == null
                  ? "No preview available"
                  : failed[s.side]
                    ? "Preview failed to load"
                    : null;
              return (
                <div key={s.side} data-side={s.side} className={`relative min-w-0 flex-1 overflow-hidden ${i > 0 ? "border-l border-border/40" : ""}`}>
                  {s.src && !failed[s.side] ? (
                    <img
                      src={s.src}
                      alt={`${s.label} version`}
                      draggable={false}
                      decoding="async"
                      className="absolute left-1/2 top-1/2 max-w-none object-contain"
                      style={{
                        transform: `translate(calc(-50% + ${transform.pan.x}px), calc(-50% + ${transform.pan.y}px)) scale(${transform.scale})`,
                        transformOrigin: "center",
                      }}
                      onLoad={handleLoad(s.side)}
                      onError={handleError(s.side)}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center">
                      <SideNote text={note!} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div
            className="absolute left-1/2 top-1/2"
            style={{
              width: boxW,
              height: boxH,
              transform: `translate(calc(-50% + ${transform.pan.x}px), calc(-50% + ${transform.pan.y}px)) scale(${transform.scale})`,
              transformOrigin: "center",
              // Difference blending needs its own stacking context on black:
              // identical pixels subtract to black, changes light up.
              ...(mode === "difference" ? diffStyle : {}),
            }}
          >
            {sides.map((s) =>
              s.src && !failed[s.side] ? (
                <img
                  key={s.side}
                  src={s.src}
                  alt={`${s.label} version`}
                  draggable={false}
                  decoding="async"
                  className="absolute inset-0 h-full w-full max-w-none object-contain"
                  style={stackedImgStyle(s.side)}
                  onLoad={handleLoad(s.side)}
                  onError={handleError(s.side)}
                />
              ) : null,
            )}
          </div>
        )}

        {!twoUp && sides.length === 2 && usable.length === 1 && (
          <div className="pointer-events-none absolute right-3 top-3 flex flex-col items-end gap-1">
            {sides
              .filter((s) => !s.src || failed[s.side])
              .map((s) => (
                <span
                  key={s.side}
                  className="delta-ui-font rounded border border-border bg-background/80 px-2 py-1 text-[11px] text-muted-foreground"
                >
                  {s.src ? "Preview failed to load" : `${s.label} preview unavailable`}
                </span>
              ))}
          </div>
        )}

        {!anyUsable && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <SideNote text={sides.some((s) => failed[s.side]) ? "Preview failed to load" : "No preview available"} />
          </div>
        )}

        {mode === "swipe" && sides.length === 2 && boxW > 0 && boxH > 0 && (
          <div className="pointer-events-none absolute" style={{ left: boxLeft + (swipePos / 100) * dispW, top: boxTop, height: dispH }}>
            <div className="absolute inset-y-0 left-0 w-px bg-foreground/70" />
            <button
              type="button"
              aria-label="Swipe divider"
              title="Drag to compare (or press [ and ])"
              className="pointer-events-auto absolute left-1/2 top-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-full border border-border bg-background shadow"
              onPointerDown={(e) => {
                stopPointer(e);
                gripDragRef.current = e.pointerId;
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  // Capture is unavailable in headless DOMs; drags then stay on the grip.
                }
              }}
              onPointerMove={(e) => {
                if (gripDragRef.current !== e.pointerId) return;
                stopPointer(e);
                setSwipePos(posFromClientX(e.clientX));
              }}
              onPointerUp={(e) => {
                if (gripDragRef.current !== e.pointerId) return;
                gripDragRef.current = null;
                stopPointer(e);
              }}
              onPointerCancel={(e) => {
                if (gripDragRef.current !== e.pointerId) return;
                gripDragRef.current = null;
                stopPointer(e);
              }}
            >
              <ChevronsLeftRight className="size-3.5 text-muted-foreground" />
            </button>
          </div>
        )}

        {mode === "onion" && sides.length === 2 && anyUsable && (
          <div
            className="absolute bottom-4 left-1/2 flex h-8 -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/90 px-3 shadow-sm"
            onPointerDown={stopPointer}
            onPointerMove={stopPointer}
            onPointerUp={stopPointer}
            onWheel={(e) => e.stopPropagation()}
          >
            <input
              type="range"
              min={0}
              max={100}
              value={onionOpacity}
              onChange={(e) => setOnionOpacity(Number(e.target.value))}
              aria-label="Onion skin opacity"
              className="w-48 cursor-pointer accent-[var(--primary)]"
            />
            <span className="delta-ui-font w-9 text-right text-[11px] tabular-nums text-muted-foreground">{onionOpacity}%</span>
          </div>
        )}
      </div>

      <footer className="delta-ui-font flex h-8 shrink-0 items-center gap-4 border-t border-border px-4 text-[11px] text-muted-foreground">
        {sides.map((s) =>
          s.size != null ? (
            <span key={s.side} className="tabular-nums">
              {s.label}
              {dims[s.side] ? ` ${dims[s.side]!.w}×${dims[s.side]!.h} ·` : ""} {formatBytes(s.size)}
            </span>
          ) : null,
        )}
      </footer>
    </div>,
    document.body,
  );
}
