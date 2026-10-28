import type * as React from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";

/** One-line replacement for native `title=` tooltips:
 *
 *   <Hint tip="Delete" kbd="⌘⌫"><Button/></Hint>
 *
 * The provider at the app root sets the shared 200ms delay (instant-feeling,
 * but no flicker when the pointer sweeps across the toolbar). `kbd` renders a
 * shortcut badge via the shared Kbd component.
 *
 * `disabled` drops the wrapper entirely (rendering just the child) for dynamic
 * cases like "Copied ✓" states handled elsewhere. */
export function Hint({
  tip,
  kbd,
  side,
  align,
  contentClassName,
  disabled,
  children,
}: {
  tip: React.ReactNode;
  /** Shortcut badge, e.g. "⏎" or "⇧⏎" — tokenized like every other Kbd. */
  kbd?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  contentClassName?: string;
  disabled?: boolean;
  children: React.ReactElement;
}) {
  if (disabled) return children;
  return (
    // Self-contained provider: components render in tests without the app root,
    // and a nested provider is legal (inner one wins). 200ms feels instant next
    // to the ~1s native `title` delay but doesn't flicker on a toolbar sweep.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} align={align} className={contentClassName}>
          {tip}
          {kbd && (
            <span data-slot="kbd" className="inline-flex">
              <Kbd keys={kbd} />
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
