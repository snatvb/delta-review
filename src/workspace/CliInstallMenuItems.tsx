import { CheckCircle2, Copy, Loader2, Terminal, TriangleAlert, X } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Hint } from "@/components/Hint";
import type { CliInstall } from "./useCliInstall";

/** The state lives in the toolbar so closing this disposable menu never loses
 * an in-flight install or the manual command returned by the backend. */
export function CliInstallMenuItems({ state }: { state: CliInstall }) {
  const { phase, detail, copied, install, dismiss, copyCommand } = state;
  if (phase === "checking" || phase === "hidden" || phase === "installed") {
    return null;
  }

  return (
    <>
      <DropdownMenuSeparator />
      {phase === "working" ? (
        <DropdownMenuItem disabled><Loader2 className="size-3.5 animate-spin" /> Installing CLI…</DropdownMenuItem>
      ) : phase === "linked" || phase === "pathUpdated" ? (
        <DropdownMenuItem disabled><CheckCircle2 className="size-3.5" /> {phase === "pathUpdated" ? "Installed — open a new terminal" : "delta CLI installed"}</DropdownMenuItem>
      ) : phase === "manual" ? (
        <Hint tip={detail}>
          <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void copyCommand(); }}><Copy className="size-3.5" /> {copied ? "Copied — paste in a terminal" : "Copy install command"}</DropdownMenuItem>
        </Hint>
      ) : (
        <Hint tip={phase === "error" ? detail : "Run delta from any terminal"}>
          <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void install(); }}>
            {phase === "error" ? <TriangleAlert className="size-3.5" /> : <Terminal className="size-3.5" />}
            {phase === "error" ? "Retry CLI install" : "Install CLI"}
          </DropdownMenuItem>
        </Hint>
      )}
      {phase !== "working" && phase !== "linked" && phase !== "pathUpdated" && (
        <DropdownMenuItem onSelect={dismiss}><X className="size-3.5" /> Dismiss CLI prompt</DropdownMenuItem>
      )}
    </>
  );
}
