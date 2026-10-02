import { Download, ExternalLink, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { APP_VERSION } from "../appVersion";
import { openExternal } from "../lib/markdownLink";
import type { UpdaterState } from "../updater/useUpdater";
import { Divider, Row } from "./controls";

const REPO_URL = "https://github.com/snatvb/delta-review";

const linkBtnClass =
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";

// Button idioms mirror components/ui/button.tsx (like UpdateBanner) so the
// update actions get the same hover + keyboard-focus affordances.
const primaryBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors outline-none hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/30";
const ghostBtn =
  "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/30";

function LinkButton({ label, href }: { label: string; href: string }) {
  return (
    <button type="button" className={linkBtnClass} onClick={() => openExternal(href)}>
      {label}
      <ExternalLink className="size-3 text-muted-foreground" />
    </button>
  );
}

function checkedHint(at: number | null): string {
  if (at == null) return "Look for a new version right now.";
  const t = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Last checked at ${t}.`;
}

// The deliberate update surface (the banner is the ambient one). Both render
// the same backend-owned state, so actions here and the banner never disagree —
// starting a download here makes the banner switch to its progress state too.
function UpdatesRow({ updater }: { updater: UpdaterState }) {
  const { status, version, progress, lastCheckedAt } = updater;

  let hint: ReactNode;
  let control: ReactNode;

  switch (status) {
    case "checking":
      hint = "Checking for updates…";
      control = (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Checking…
        </span>
      );
      break;
    case "available":
      hint = `Version ${version} is available.`;
      control = (
        <button type="button" className={primaryBtn} onClick={updater.download}>
          <Download className="size-3.5" />
          Download
        </button>
      );
      break;
    case "downloading": {
      const pct = progress != null ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null;
      hint = "Downloading update…";
      control = (
        <span className="inline-flex items-center gap-2 text-[12px] tabular-nums text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {pct != null ? `${pct}%` : ""}
        </span>
      );
      return (
        <div className="py-2.5" data-testid="about-updates">
          <div className="flex items-center justify-between gap-6">
            <div className="text-[13px] font-medium text-foreground">Updates</div>
            {control}
          </div>
          <div className="mt-1 text-[12px] text-muted-foreground">{hint}</div>
          {/* Same track/fill visual as the UpdateBanner's progress state. */}
          <div className="relative mt-2.5 h-1 w-full overflow-hidden rounded-full bg-primary/15">
            {pct != null ? (
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            ) : (
              <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary/70 delta-indeterminate" />
            )}
          </div>
        </div>
      );
    }
    case "ready":
      hint = (
        <>
          Version {version} is ready.
          <span className="text-muted-foreground/70"> Restart to apply.</span>
        </>
      );
      control = (
        <button type="button" className={primaryBtn} onClick={() => void updater.restart()}>
          <RotateCcw className="size-3.5" />
          Restart now
        </button>
      );
      break;
    case "error":
      hint = <span className="text-amber-600 dark:text-amber-400">Update failed.</span>;
      control = (
        <button type="button" className={ghostBtn} onClick={updater.check}>
          <RefreshCw className="size-3.5" />
          Try again
        </button>
      );
      break;
    default:
      hint = checkedHint(lastCheckedAt);
      control = (
        <button type="button" className={primaryBtn} onClick={updater.check}>
          <RefreshCw className="size-3.5" />
          Check for Updates
        </button>
      );
  }

  return (
    <Row label="Updates" hint={hint} control={control} />
  );
}

export function AboutSection({ updater }: { updater: UpdaterState }) {
  return (
    <div>
      <Row
        label="Version"
        hint="Automatic checks can be tuned in General."
        control={<span className="font-mono text-[12px] font-medium text-muted-foreground">v{APP_VERSION}</span>}
      />

      <Divider />

      <UpdatesRow updater={updater} />

      <Divider />

      <Row
        label="GitHub repository"
        hint="Source code, docs, and release notes."
        control={<LinkButton label="snatvb/delta-review" href={REPO_URL} />}
      />

      <Divider />

      <Row
        label="Report an issue"
        hint="Bugs, feature ideas, and pull requests."
        control={<LinkButton label="Issues" href={`${REPO_URL}/issues`} />}
      />

      <div className="mt-6 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
        Delta Review is a fork of{" "}
        <a
          href="https://github.com/darioielardi/delta"
          className="text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          onClick={(e) => {
            e.preventDefault();
            openExternal("https://github.com/darioielardi/delta");
          }}
        >
          Delta
        </a>{" "}
        by Dario Ielardi, created and maintained by Andrei Avsenin. Released under the MIT License.
      </div>
    </div>
  );
}
