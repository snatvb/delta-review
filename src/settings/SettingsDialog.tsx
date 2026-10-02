import { useEffect, useRef, useState } from "react";
import { EyeOff, Info, Palette, SlidersHorizontal, X } from "lucide-react";
import { APP_VERSION } from "../appVersion";
import { reloadWindowPerBranch } from "../windowPerBranch";
import type { Target } from "../types";
import type { UpdaterState } from "../updater/useUpdater";
import { GeneralSection } from "./GeneralSection";
import { AppearanceSection } from "./AppearanceSection";
import { DeltaIgnoreSection } from "./DeltaIgnoreSection";
import { AboutSection } from "./AboutSection";

type SectionId = "general" | "appearance" | "ignore" | "about";

const SECTIONS: { id: SectionId; label: string; Icon: typeof Info; subtitle: string }[] = [
  { id: "general", label: "General", Icon: SlidersHorizontal, subtitle: "Editors, windows, and change detection." },
  { id: "appearance", label: "Appearance", Icon: Palette, subtitle: "Theme and code typography." },
  { id: "ignore", label: "Delta Ignore", Icon: EyeOff, subtitle: "Gitignore-style rules that mute files from reviews." },
  { id: "about", label: "About", Icon: Info, subtitle: "Version, links, and credits." },
];

const SECTION_STORAGE_KEY = "delta:settingsSection";

function readStoredSection(): SectionId {
  try {
    const v = localStorage.getItem(SECTION_STORAGE_KEY);
    if (SECTIONS.some((s) => s.id === v)) return v as SectionId;
  } catch {
    /* ignore */
  }
  return "general";
}

// Lightweight overlay rather than the Radix Dialog: Radix's open path (focus
// scope, scroll-lock, and especially the `aria-hidden` sweep over every sibling)
// scales with total DOM size — on a big diff it cost 100–340 ms per open (the
// "settings takes ~1s" report). This hand-rolled overlay — the same shape the
// command palette uses — opens in a single frame regardless of the diff behind
// it. Escape and click-outside close; the card grabs focus so Escape works.
//
// Layout: a wide (up to 1280px) card with a section sidebar on the left, like
// the platform settings apps; only the content pane scrolls, so the sidebar
// stays put. The chosen section is remembered across opens (and windows).
export function SettingsDialog({
  open,
  onOpenChange,
  target,
  updater,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The review this window shows — enables the per-repo local ignore editor. */
  target?: Target;
  /** The app-wide update state — drives the About section's check UI. */
  updater: UpdaterState;
}) {
  const [section, setSection] = useState<SectionId>(readStoredSection);
  const cardRef = useRef<HTMLDivElement>(null);

  const selectSection = (id: SectionId) => {
    setSection(id);
    try {
      localStorage.setItem(SECTION_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!open) return;
    reloadWindowPerBranch();
    cardRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];

  return (
    <div
      data-testid="settings-dialog"
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4 duration-100 data-[open]:animate-in data-[open]:fade-in-0"
      data-open
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        className="flex h-[85vh] max-h-[820px] w-[min(90vw,1280px)] overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5 outline-none duration-100 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 dark:ring-foreground/10"
        data-open
      >
        <nav
          aria-label="Settings sections"
          className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-border/70 bg-muted/30 p-2.5"
        >
          <div className="px-2.5 pb-2 pt-1.5 font-heading text-[13px] font-medium text-foreground">Settings</div>
          {SECTIONS.map(({ id, label, Icon }) => {
            const isActive = id === section;
            return (
              <button
                key={id}
                type="button"
                onClick={() => selectSection(id)}
                aria-current={isActive ? "page" : undefined}
                className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring ${
                  isActive
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                }`}
              >
                <Icon className="size-4 shrink-0" />
                {label}
              </button>
            );
          })}
          <div className="mt-auto px-2.5 pb-1 pt-3 font-mono text-[11px] text-muted-foreground/70">
            v{APP_VERSION}
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border/70 px-6 py-4">
            <div className="min-w-0">
              <h2 id="settings-title" className="font-heading text-[15px] font-medium leading-none">
                {active.label}
              </h2>
              <p className="mt-1.5 text-[12px] text-muted-foreground">{active.subtitle}</p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close settings"
              className="-mr-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-1">
            {section === "general" && <GeneralSection />}
            {section === "appearance" && <AppearanceSection />}
            {/* key: a target switch remounts the section, so its loaded state
                resets by remount instead of prop-syncing inside an effect. */}
            {section === "ignore" && <DeltaIgnoreSection key={target?.repoPath ?? ""} target={target} />}
            {section === "about" && <AboutSection updater={updater} />}
          </div>
        </div>
      </div>
    </div>
  );
}
