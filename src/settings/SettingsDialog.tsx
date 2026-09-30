import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Monitor, Moon, Sun, X } from "lucide-react";
import { useThemePref, type ThemePref } from "../theme";
import { useEditorPref, EDITORS, type EditorId } from "../editor";
import { useCodeFont, setCodeFontFamily, setCodeFontSize, installedMonoFonts, SIZE_OPTIONS } from "../codeFont";
import { usePickerOpenMode, type PickerOpenMode } from "../windowMode";
import { reloadWindowPerBranch, useWindowPerBranch } from "../windowPerBranch";
import { useChangeDetection } from "../changeDetection";
import { useUpdateCheck } from "../updater/updateCheckPref";
import { api } from "../api";
import type { Target } from "../types";
import type { OnOff } from "../lib/onOffPref";

const THEMES: { value: ThemePref; label: string; Icon: typeof Monitor }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

function Row({ label, hint, control }: { label: string; hint?: string; control: ReactNode }) {
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

const selectClass =
  "h-8 appearance-none rounded-md border border-input bg-muted/40 pl-2.5 pr-7 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted focus:bg-background";

// Lightweight overlay rather than the Radix Dialog: Radix's open path (focus
// scope, scroll-lock, and especially the `aria-hidden` sweep over every sibling)
// scales with total DOM size — on a big diff it cost 100–340 ms per open (the
// "settings takes ~1s" report). This hand-rolled overlay — the same shape the
// command palette uses — opens in a single frame regardless of the diff behind
// it. Escape and click-outside close; the card grabs focus so Escape works.
export function SettingsDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The review this window shows — enables the per-repo local ignore editor. */
  target?: Target;
}) {
  const [theme, setTheme] = useThemePref();
  const [editor, setEditor] = useEditorPref();
  const [openMode, setOpenMode] = usePickerOpenMode();
  const [windowPerBranch, setWindowPerBranch] = useWindowPerBranch();
  const [changeDetection, setChangeDetection] = useChangeDetection();
  const [updateCheck, setUpdateCheck] = useUpdateCheck();
  const { family: fontFamily, size: fontSize } = useCodeFont();
  // Installed mono families (probed once) → "System Mono" default + whatever the
  // machine actually has. Keep the current pick listed even if it's not detected.
  const families = useMemo(() => {
    const found = installedMonoFonts();
    return fontFamily && !found.includes(fontFamily) ? [fontFamily, ...found] : found;
  }, [fontFamily]);
  const cardRef = useRef<HTMLDivElement>(null);

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
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/5 outline-none duration-100 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 dark:ring-foreground/10"
        data-open
      >
        <div className="flex items-start justify-between border-b border-border/70 px-5 py-4">
          <div>
            <h2 id="settings-title" className="font-heading text-[15px] font-medium leading-none">Settings</h2>
            <p className="mt-1.5 text-[12px] text-muted-foreground">Appearance, windows, editor, and privacy preferences.</p>
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

        <div className="max-h-[70vh] overflow-y-auto px-5 pb-4 pt-2">
          <Row
            label="Theme"
            hint="Match the system, or force light/dark."
            control={
              <ToggleGroup
                type="single"
                size="sm"
                value={theme}
                onValueChange={(v) => v && setTheme(v as ThemePref)}
                className="gap-0.5 rounded-lg bg-muted/70 p-0.5"
              >
                {THEMES.map(({ value, label, Icon }) => (
                  <ToggleGroupItem
                    key={value}
                    value={value}
                    aria-label={label}
                    title={label}
                    className="h-7 gap-1.5 rounded-md border-0 px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm"
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="External editor"
            hint="Used by the “open in editor” buttons."
            control={
              <div className="relative">
                <select
                  aria-label="External editor"
                  value={editor}
                  onChange={(e) => setEditor(e.target.value as EditorId)}
                  className={selectClass}
                >
                  {EDITORS.map((ed) => (
                    <option key={ed.id} value={ed.id}>{ed.label}</option>
                  ))}
                </select>
                <Chevron />
              </div>
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="Open reviews in"
            hint="Where ⌘K opens a picked review."
            control={
              <div className="relative">
                <select
                  aria-label="Open reviews in"
                  value={openMode}
                  onChange={(e) => setOpenMode(e.target.value as PickerOpenMode)}
                  className={selectClass}
                >
                  <option value="new-window">New window</option>
                  <option value="replace">Current window</option>
                </select>
                <Chevron />
              </div>
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="New window per branch"
            hint="Off: another branch of the same folder reuses its window."
            control={
              <OnOffToggle
                label="New window per branch"
                value={windowPerBranch ? "on" : "off"}
                onChange={(v) => setWindowPerBranch(v === "on")}
                onTitle="Each branch gets its own window"
                offTitle="One window per folder"
              />
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="Detect changes"
            hint="Re-diff in the background when files change."
            control={
              <OnOffToggle
                label="Detect changes"
                value={changeDetection}
                onChange={setChangeDetection}
                onTitle="Offer Refresh when files change"
                offTitle="Refresh manually only"
              />
            }
          />

          <div className="h-px bg-border/50" />

          {/* key: a target switch remounts the section, so its loaded state
              resets by remount instead of prop-syncing inside an effect. */}
          <DeltaIgnoreSection key={target?.repoPath ?? ""} target={target} />

          <div className="h-px bg-border/50" />

          <Row
            label="Code font"
            hint="Font family for diffs and code."
            control={
              <div className="relative">
                <select
                  aria-label="Code font family"
                  value={fontFamily}
                  onChange={(e) => setCodeFontFamily(e.target.value)}
                  className={selectClass}
                >
                  <option value="">System Mono</option>
                  {families.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <Chevron />
              </div>
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="Code font size"
            hint="Size of code in the diff view."
            control={
              <div className="relative">
                <select
                  aria-label="Code font size"
                  value={fontSize}
                  onChange={(e) => setCodeFontSize(Number(e.target.value))}
                  className={selectClass}
                >
                  {SIZE_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}px</option>
                  ))}
                </select>
                <Chevron />
              </div>
            }
          />

          <div className="h-px bg-border/50" />

          <Row
            label="Check for updates"
            hint="Look for a new version on launch."
            control={
              <OnOffToggle
                label="Check for updates"
                value={updateCheck}
                onChange={setUpdateCheck}
                onTitle="Check for updates on launch"
                offTitle="Never check for updates"
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

const toggleItemClass =
  "h-7 gap-1.5 rounded-md border-0 px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm";

const rulesTextareaClass =
  "min-h-[76px] w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring";

const saveBtnClass =
  "h-7 shrink-0 rounded-md border border-border px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40";

// Delta Ignore editors: machine-wide rules and, when a review window has a
// target, this checkout's never-committed local rules. Saving tells the
// backend, which invalidates diff snapshots and offers Refresh in open
// reviews — the window does not swap its diff under the user.
function DeltaIgnoreSection({ target }: { target?: Target }) {
  const [globalRules, setGlobalRules] = useState("");
  const [globalSaved, setGlobalSaved] = useState<string | null>(null);
  const [localRules, setLocalRules] = useState("");
  const [localSaved, setLocalSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<"global" | "local" | null>(null);

  useEffect(() => {
    if (flash == null) return;
    const t = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [flash]);

  // Load both sources on mount (the dialog unmounts us when closed, and the
  // parent keys us by repoPath, so target never changes under a live instance).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const g = await api.getGlobalDeltaIgnore();
        if (!cancelled) {
          setGlobalRules(g);
          setGlobalSaved(g);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
      if (!target) return;
      try {
        const l = await api.getLocalDeltaIgnore(target.repoPath);
        if (!cancelled) {
          setLocalRules(l);
          setLocalSaved(l);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  const save = async (which: "global" | "local") => {
    try {
      if (which === "global") {
        await api.setGlobalDeltaIgnore(globalRules);
        setGlobalSaved(globalRules);
      } else if (target) {
        await api.setLocalDeltaIgnore(target.repoPath, localRules);
        setLocalSaved(localRules);
      }
      setError(null);
      setFlash(which);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="py-2.5">
      <div className="text-[13px] font-medium text-foreground">Delta Ignore</div>
      <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">
        Gitignore-style rules that mute files from reviews. Precedence: global &lt; project{" "}
        <code>.deltaignore</code> &lt; local.
      </div>
      {error && <div className="mt-1 text-[12px] text-destructive">{error}</div>}

      <div className="mt-2.5">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="text-[12px] font-medium text-muted-foreground">Global — every repository</span>
          <button
            type="button"
            className={saveBtnClass}
            disabled={globalSaved == null || globalRules === globalSaved}
            onClick={() => void save("global")}
          >
            {flash === "global" ? "Saved ✓" : "Save"}
          </button>
        </div>
        <textarea
          aria-label="Global Delta Ignore rules"
          className={rulesTextareaClass}
          spellCheck={false}
          value={globalRules}
          onChange={(e) => setGlobalRules(e.target.value)}
          placeholder={"*.gen.ts\ndist/\nvendor/"}
        />
      </div>

      {target ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="text-[12px] font-medium text-muted-foreground">This repository — local</span>
            <button
              type="button"
              className={saveBtnClass}
              disabled={localSaved == null || localRules === localSaved}
              onClick={() => void save("local")}
            >
              {flash === "local" ? "Saved ✓" : "Save"}
            </button>
          </div>
          <textarea
            aria-label="Local Delta Ignore rules"
            className={rulesTextareaClass}
            spellCheck={false}
            value={localRules}
            onChange={(e) => setLocalRules(e.target.value)}
            placeholder={"huge-monorepo/\ncodegen-output/"}
          />
          <div className="mt-1 text-[12px] leading-snug text-muted-foreground">
            Stored in <code>.git/info/deltaignore</code> — this checkout only, never committed or shared.
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-muted-foreground">
          Open a review to edit that repository's local rules.
        </div>
      )}
    </div>
  );
}

function OnOffToggle({
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

function Chevron() {
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
