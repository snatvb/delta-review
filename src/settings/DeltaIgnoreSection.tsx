import { useEffect, useState } from "react";
import { api } from "../api";
import type { Target } from "../types";

const rulesTextareaClass =
  "min-h-[76px] w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus-visible:ring-1 focus-visible:ring-ring";

const saveBtnClass =
  "h-7 shrink-0 rounded-md border border-border px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40";

// Delta Ignore editors: machine-wide rules and, when a review window has a
// target, this checkout's never-committed local rules. Saving tells the
// backend, which invalidates diff snapshots and offers Refresh in open
// reviews — the window does not swap its diff under the user.
export function DeltaIgnoreSection({ target }: { target?: Target }) {
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

  // Load both sources on mount (switching to another section unmounts us, and
  // the shell keys us by repoPath, so target never changes under a live
  // instance). Loading happens only when this page is opened, not on every
  // dialog open.
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
    <div>
      <div className="py-2.5 text-[12px] leading-snug text-muted-foreground">
        Rules apply in order of precedence: global &lt; project <code>.deltaignore</code> &lt; local.
        A muted file stays out of the diff but is never deleted or modified.
      </div>
      {error && <div className="mb-1 text-[12px] text-destructive">{error}</div>}

      <div>
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
        <div className="mt-4">
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
            className={`${rulesTextareaClass} min-h-[120px]`}
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
