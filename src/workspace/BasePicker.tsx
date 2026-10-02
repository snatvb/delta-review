// src/workspace/BasePicker.tsx
// The "vs <base>" chip next to the diff-mode switcher. Picks which branch the
// diff is taken against: any branch ad-hoc (per window), the repo-wide strategy
// footer (auto fork detection / always-this-branch), and shows where the branch
// was cut from. (#base)
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { BaseStrategy, BranchInfo, BranchList } from "../types";
import { relTime } from "../picker/pickerUi";
import { ChevronDown, GitBranch, Pin } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuCheck,
} from "@/components/ui/dropdown-menu";

interface BasePickerProps {
  repoPath: string;
  /** Refetch key — new commits move the fork point. */
  headOid?: string | null;
  /** Explicit per-window base (URL `?base=`), highest priority. */
  override?: string;
  /** Repo-wide strategy; `undefined` = still loading, `null` = auto. */
  strategy: BaseStrategy | null | undefined;
  /** What the backend actually resolved (summary.baseLabel). */
  resolvedLabel?: string;
  onPick: (name: string) => void;
  onAuto: () => void;
  onPin: (name: string) => void;
}

/** "3d ago"-style label for unix-seconds timestamps. */
function ago(seconds: number | null | undefined): string {
  return seconds ? relTime(new Date(seconds * 1000).toISOString()) : "";
}

const CHIP =
  "ml-1 inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-input bg-muted/40 pl-2 pr-2 text-[12px] font-medium text-foreground outline-none transition-colors hover:bg-muted data-[state=open]:bg-muted";

function BranchRow({
  branch,
  checked,
  suggested,
}: {
  branch: BranchInfo;
  checked: boolean;
  suggested: boolean;
}) {
  return (
    <>
      <DropdownMenuCheck checked={checked} />
      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{branch.name}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[11px] text-muted-foreground">
        {branch.isDefault && <span className="rounded bg-muted px-1">default</span>}
        {branch.isCurrent && <span className="rounded bg-muted px-1">current</span>}
        <span title={`${branch.ahead} ahead / ${branch.behind} behind`}>
          {suggested ? "cut here" : ago(branch.lastCommitAt)}
        </span>
      </span>
    </>
  );
}

export function BasePicker({ repoPath, headOid, override, strategy, resolvedLabel, onPick, onAuto, onPin }: BasePickerProps) {
  const [data, setData] = useState<BranchList | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  // Fetch on every open — branch state moves with every commit/push, and the
  // dropdown opening is the one moment the user is looking at it.
  useEffect(() => {
    // Reset synchronously so a repo switch never lists the prior repo's branches.
    // react-doctor-disable-next-line react-doctor/set-state-in-effect, react-hooks-js/set-state-in-effect, react-doctor/no-adjust-state-on-prop-change
    setData(null); setFailed(false);
    let cancelled = false;
    api.listBranches(repoPath).then(
      (list) => { if (!cancelled) setData(list); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [repoPath, headOid]);

  const explicit = override != null;
  const pinned = !explicit && strategy?.kind === "branch";
  const auto = !explicit && !pinned;
  const label = override ?? resolvedLabel ?? "…";
  const effectiveBase = override ?? resolvedLabel;
  const suggestedName = data?.suggested?.name;

  const title = explicit
    ? `Comparing against ${override}`
    : data?.suggested
      ? `Auto: cut from ${data.suggested.name} @ ${data.suggested.mergeBaseShortOid} · ${ago(data.suggested.mergeBaseAt)}`
      : pinned
        ? `Pinned base for this repo: ${strategy?.kind === "branch" ? strategy.name : ""}`
        : "Base auto-detected";

  const { locals, remotes } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (b: BranchInfo) => !q || b.name.toLowerCase().includes(q);
    const all = data?.branches ?? [];
    return {
      locals: all.filter((b) => !b.remote && match(b)),
      remotes: all.filter((b) => b.remote && match(b)),
    };
  }, [data, query]);

  const row = (b: BranchInfo) => (
    <DropdownMenuItem
      key={b.name}
      onSelect={() => onPick(b.name)}
      className="gap-2"
    >
      <BranchRow branch={b} checked={b.name === effectiveBase} suggested={b.name === suggestedName} />
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Base branch" title={title} className={CHIP}>
        <GitBranch className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-muted-foreground">vs</span>
        <span className="max-w-[16ch] truncate">{label}</span>
        {strategy !== undefined && !explicit && (
          <span className="text-[11px] font-normal text-muted-foreground">
            ({pinned ? "pinned" : "auto"})
          </span>
        )}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[18rem]">
        {/* Radix menu owns arrow keys for item navigation; the filter input must
            keep its keystrokes to itself. */}
        <div className="flex items-center gap-1.5 border-b border-border/60 px-2 py-1">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Filter branches…"
            className="h-6 w-full bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {!data && !failed && (
            <DropdownMenuItem disabled className="justify-center text-muted-foreground">Loading…</DropdownMenuItem>
          )}
          {failed && (
            <DropdownMenuItem disabled className="justify-center text-muted-foreground">Couldn't list branches</DropdownMenuItem>
          )}
          {locals.length > 0 && <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Local</div>}
          {locals.map(row)}
          {remotes.length > 0 && <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Remote</div>}
          {remotes.map(row)}
          {data && locals.length === 0 && remotes.length === 0 && (
            <DropdownMenuItem disabled className="justify-center text-muted-foreground">No matching branches</DropdownMenuItem>
          )}
        </div>
        <DropdownMenuSeparator />
        {/* Repo-wide strategy: what new windows and every future review use. */}
        <DropdownMenuItem onSelect={onAuto} className="gap-2">
          <DropdownMenuCheck checked={auto} />
          <span className="flex-1">Auto-detect base</span>
          <span className="text-[11px] text-muted-foreground">where this branch was cut from</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!effectiveBase}
          onSelect={() => effectiveBase && onPin(effectiveBase)}
          className="gap-2"
        >
          {pinned ? <DropdownMenuCheck checked /> : <Pin className="size-3.5 shrink-0" />}
          <span className="flex-1 truncate">Always use “{effectiveBase ?? "…"}” in this repo</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
