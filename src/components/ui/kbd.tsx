import type { ComponentType } from "react";
import { ArrowBigUp, ArrowDown, ArrowLeft, ArrowRight, ArrowRightToLine, ArrowUp, ChevronUp, CornerDownLeft, Delete, Option } from "lucide-react";
import { cn } from "@/lib/utils";

function CommandIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" fill="currentColor" aria-hidden className={className}>
      <path
        fillRule="evenodd"
        d="M400,288a110.931,110.931,0,0,0-48,11.188V212.813A111.767,111.767,0,1,0,288,112v48H224V112a113.05,113.05,0,1,0-64,100.812v86.375A111.767,111.767,0,1,0,224,400V352h64v48A112,112,0,1,0,400,288Zm0-224a48,48,0,1,1-48,48A48,48,0,0,1,400,64ZM112,448a48,48,0,1,1,48-48A48,48,0,0,1,112,448Zm0-288a48,48,0,1,1,48-48A48,48,0,0,1,112,160ZM288,288H224V224h64ZM400,448a48,48,0,1,1,48-48A48,48,0,0,1,400,448Z"
      />
    </svg>
  );
}

// Drawing modifiers as icons rather than text: which font a webview substitutes for
// ⌘ and friends varies by platform, and an oversized substitute distorts the badge.
const GLYPH_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "⌘": CommandIcon,
  "⇧": ArrowBigUp,
  "⌥": Option,
  "⌃": ChevronUp,
  "⌫": Delete,
  "⇥": ArrowRightToLine,
  "↵": CornerDownLeft,
  "⏎": CornerDownLeft,
  "↩": CornerDownLeft,
  "↑": ArrowUp,
  "↓": ArrowDown,
  "←": ArrowLeft,
  "→": ArrowRight,
};

function tokenize(keys: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of keys) {
    if (GLYPH_ICONS[ch]) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** A keyboard-shortcut hint badge. Pass the shortcut as `keys` (e.g. "⌘⇧F",
 *  "esc"); `className` overrides the default muted styling for special placements
 *  (positioning, on-primary palettes). */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 select-none items-center gap-0.5 rounded border border-border/70 bg-muted px-1.5 text-[10px] font-medium leading-none text-muted-foreground",
        className,
      )}
    >
      {tokenize(keys).map((t, i) => {
        const Icon = GLYPH_ICONS[t];
        return Icon ? <Icon key={i} className="size-[1em] shrink-0" /> : <span key={i}>{t}</span>;
      })}
    </kbd>
  );
}
