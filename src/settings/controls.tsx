import type { ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { OnOff } from "../lib/onOffPref";

// Shared pieces of the Settings section pages: the label/control row, the
// On/Off pill, and the chevron for native selects. One place so every section
// page renders identically.

export function Row({ label, hint, control }: { label: string; hint?: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground">{label}</div>
        {hint && <div className="text-[12px] text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export function Divider() {
  return <div className="h-px bg-border/50" />;
}

export const selectClass =
  "h-8 appearance-none rounded-md border border-input bg-muted/40 pl-2.5 pr-7 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus:bg-background";

const toggleItemClass =
  "h-7 gap-1.5 rounded-md border-0 px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm";

export function OnOffToggle({
  label,
  value,
  onChange,
  onTitle,
  offTitle,
}: {
  label: string;
  value: OnOff;
  onChange: (v: OnOff) => void;
  onTitle: string;
  offTitle: string;
}) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      aria-label={label}
      value={value}
      onValueChange={(v) => v && onChange(v as OnOff)}
      className="gap-0.5 rounded-lg bg-muted/70 p-0.5"
    >
      <ToggleGroupItem value="on" aria-label="On" title={onTitle} className={toggleItemClass}>
        On
      </ToggleGroupItem>
      <ToggleGroupItem value="off" aria-label="Off" title={offTitle} className={toggleItemClass}>
        Off
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

export function Chevron() {
  return (
    <svg
      className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
