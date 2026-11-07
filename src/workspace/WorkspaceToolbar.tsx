import { useRef, type ReactNode } from "react";
import { Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, Copy, ExternalLink, ListFilter, MessageSquare, MoreHorizontal, RefreshCw, Search, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/Hint";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { FILE_TYPE_FILTERS, useFileTypeFilter, type FileTypeFilter } from "../fileTypeFilterPref";
import { useHideViewedFiles } from "../hideViewedFilesPref";
import { isMac } from "../lib/platform";
import { worktreeName } from "../lib/utils";
import { CliInstallMenuItems } from "./CliInstallMenuItems";
import { useCliInstall } from "./useCliInstall";
import "./WorkspaceToolbar.css";

interface CommitNavigation {
  position: string;
  previousDisabled: boolean;
  nextDisabled: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

interface WorkspaceToolbarProps {
  repoPath: string;
  repoName: string;
  worktree?: string | null;
  onOpenPalette?: () => void;
  loaded: boolean;
  busy: boolean;
  comparison: ReactNode;
  commitNavigation?: CommitNavigation;
  fileCount: number;
  viewedCount: number;
  layout: "unified" | "split";
  onLayoutChange: (layout: "unified" | "split") => void;
  pendingRefresh: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  commentCount: number;
  indexOpen: boolean;
  onToggleComments: () => void;
  copyCount: number;
  copyState: "idle" | "ok" | "err";
  onCopy: () => void;
  onOpenEditor: () => void;
  onOpenSettings?: () => void;
}

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 dark:bg-transparent dark:hover:bg-input/60";

function FileFilters({ fileCount, viewedCount }: { fileCount: number; viewedCount: number }) {
  const [filter, setFilter] = useFileTypeFilter();
  const [hideViewed, setHideViewed] = useHideViewedFiles();
  const label = FILE_TYPE_FILTERS.find((item) => item.value === filter)!.shortLabel;
  const active = filter !== "all" || hideViewed === "on";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`File filters: ${label}${hideViewed === "on" ? "; viewed hidden" : ""}`}
        data-active={active}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-input bg-muted/40 px-2 text-[12px] font-medium outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring data-[active=true]:border-primary/40 data-[active=true]:bg-primary/10 data-[active=true]:text-primary"
      >
        <ListFilter className="toolbar-filter-icon size-3.5" />
        <span>{label}</span>
        {hideViewed === "on" && <CheckCheck aria-hidden className="size-3.5" />}
        <span className="toolbar-file-count text-muted-foreground" aria-hidden>· {fileCount}</span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuRadioGroup aria-label="File types" value={filter} onValueChange={(value) => setFilter(value as FileTypeFilter)}>
          {FILE_TYPE_FILTERS.map((item) => <DropdownMenuRadioItem key={item.value} value={item.value}>{item.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={hideViewed === "on"} onCheckedChange={(checked) => setHideViewed(checked ? "on" : "off")}>
          Hide viewed files ({viewedCount})
        </DropdownMenuCheckboxItem>
        <p className="max-w-[15rem] px-2 py-1 text-[11px] text-muted-foreground">Viewed files stay in the file tree.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceToolbar(props: WorkspaceToolbarProps) {
  const openingSettings = useRef(false);
  const cliInstall = useCliInstall();
  const wt = worktreeName(props.repoPath);
  const name = props.repoName && wt === props.repoName ? props.repoName : wt;
  const navigation = props.commitNavigation;
  const copyLabel = props.copyState === "ok" ? "Copied" : props.copyState === "err" ? "Copy failed" : "Copy for agents";
  return (
    <header data-tauri-drag-region className={`workspace-toolbar flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card pr-3 ${isMac ? "pl-24" : "pl-3"}`}>
      <Hint tip={`${props.repoName && props.repoName !== name ? `${props.repoName} / ` : ""}${name}${props.worktree ? ` · ${props.worktree}` : ""} — Open command palette`} kbd="⌘P">
        <button type="button" aria-label="Open command palette" onClick={props.onOpenPalette} className="toolbar-repo inline-flex h-7 items-center gap-1.5 rounded-md border border-input bg-muted/40 px-2 text-[13px] font-medium outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            {props.repoName && props.repoName !== name && <span className="toolbar-repo-parent font-normal text-muted-foreground">{props.repoName} / </span>}{name}
          </span>
          {props.worktree && <span className="toolbar-worktree min-w-0 truncate border-l border-border/70 pl-2 font-normal text-muted-foreground">{props.worktree}</span>}
          <Kbd keys="⌘P" className="toolbar-palette-shortcut ml-auto shrink-0" />
        </button>
      </Hint>
      {props.loaded && (
        <>
          <div className="toolbar-comparison min-w-0">{props.comparison}</div>
          {navigation && (
            <div className="toolbar-commit-stepper shrink-0 items-center gap-1" data-testid="commit-stepper">
              <Hint tip="Previous commit" kbd="["><button type="button" aria-label="Previous commit" className={ICON_BUTTON} disabled={navigation.previousDisabled} onClick={navigation.onPrevious}><ChevronLeft className="size-3.5" /></button></Hint>
              <Hint tip="Next commit" kbd="]"><button type="button" aria-label="Next commit" className={ICON_BUTTON} disabled={navigation.nextDisabled} onClick={navigation.onNext}><ChevronRight className="size-3.5" /></button></Hint>
              <span className="ml-1 font-mono text-[11px] tabular-nums text-muted-foreground">{navigation.position}</span>
            </div>
          )}
          <FileFilters fileCount={props.fileCount} viewedCount={props.viewedCount} />
        </>
      )}
      {props.busy && <span role="status" className="sr-only">Computing delta…</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {props.loaded && (
          <>
            <Hint tip={props.pendingRefresh ? "The diff changed on disk — click to update" : props.refreshing ? "Re-diffing…" : "Re-diff now"} kbd={props.refreshing ? undefined : "⌘R"}>
              <button type="button" aria-label={props.pendingRefresh ? "Refresh" : "Re-diff now"} disabled={props.refreshing} onClick={props.onRefresh} className={`${ICON_BUTTON} ${props.pendingRefresh ? "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-400" : ""}`}>
                <RefreshCw className={`size-4 ${props.refreshing ? "animate-spin will-change-transform" : ""}`} />
              </button>
            </Hint>
            <Button size="sm" variant="outline" aria-label={`Comments (${props.commentCount})`} aria-pressed={props.indexOpen} className="toolbar-comments h-7 gap-1.5 px-2 text-[13px] text-muted-foreground aria-pressed:border-primary/40 aria-pressed:bg-primary/10 aria-pressed:text-primary" onClick={props.onToggleComments}>
              <MessageSquare className="size-4" /> {props.commentCount}
            </Button>
            <Hint tip={props.copyCount === 0 ? "No open comments in this view to copy" : copyLabel} kbd={props.copyCount > 0 ? "⌘⇧C" : undefined}>
              <span className="inline-flex shrink-0">
                <Button size="sm" aria-label={copyLabel} disabled={props.copyCount === 0} onClick={props.onCopy} className="toolbar-copy h-7 justify-center gap-1.5 px-2 text-[13px] transition-colors" style={props.copyState === "ok" ? { backgroundColor: "#059669", color: "#fff" } : props.copyState === "err" ? { backgroundColor: "var(--destructive)", color: "#fff" } : undefined}>
                  {props.copyState === "ok" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  <span className="toolbar-copy-label">{props.copyState === "idle" ? <>Copy<span className="toolbar-copy-full"> for agents</span></> : props.copyState === "ok" ? "Copied" : "Failed"}</span>
                  <Kbd keys="⌘⇧C" className="toolbar-copy-shortcut border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground/90" />
                </Button>
              </span>
            </Hint>
          </>
        )}
        <DropdownMenu>
          <Hint tip="More actions"><DropdownMenuTrigger aria-label="More actions" className={ICON_BUTTON}><MoreHorizontal className="size-4" /></DropdownMenuTrigger></Hint>
          <DropdownMenuContent align="end" className="min-w-[13rem]" onCloseAutoFocus={(event) => {
            if (openingSettings.current) {
              event.preventDefault();
              openingSettings.current = false;
              // The menu's focus trap is gone; the dialog can now take focus.
              props.onOpenSettings?.();
            }
          }}>
            {props.loaded && (
              <>
                <DropdownMenuItem className="toolbar-comments-overflow" onSelect={props.onToggleComments}><MessageSquare className="size-3.5" /> Comments ({props.commentCount})</DropdownMenuItem>
                {navigation && (
                  <div className="toolbar-commit-overflow">
                    <DropdownMenuItem disabled={navigation.previousDisabled} onSelect={navigation.onPrevious}>Previous commit <Kbd keys="[" className="ml-auto" /></DropdownMenuItem>
                    <DropdownMenuItem disabled={navigation.nextDisabled} onSelect={navigation.onNext}>Next commit <Kbd keys="]" className="ml-auto" /></DropdownMenuItem>
                    <span className="px-2 text-[11px] text-muted-foreground">Commit {navigation.position}</span>
                  </div>
                )}
                <DropdownMenuRadioGroup aria-label="Diff layout" value={props.layout} onValueChange={(value) => props.onLayoutChange(value as "unified" | "split")}>
                  <DropdownMenuRadioItem value="unified">Unified</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={props.onOpenEditor}><ExternalLink className="size-3.5" /> Open repository in editor</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => {
              // Open after the menu releases its focus trap, not during selection.
              openingSettings.current = props.onOpenSettings !== undefined;
            }}><Settings className="size-3.5" /> Settings <Kbd keys="⌘," className="ml-auto" /></DropdownMenuItem>
            {props.loaded && <CliInstallMenuItems state={cliInstall} />}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
