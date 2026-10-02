import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  Target,
  DiffSummary,
  FileDiff,
  BinaryFileDiff,
  BlobSide,
  Review,
  ReviewSession,
  Registry,
  PickerData,
  WorktreeEntry,
  RepoEntry,
  InstallOutcome,
  CliStatus,
  DiffMode,
  CommitPage,
  FileTextResult,
  AppSettings,
  LocalDeltaIgnore,
  BaseStrategy,
  BranchList,
  UpdaterSnapshot,
} from "./types";

// Transport indirection: a dev-only fixture backend (VITE_MOCK_IPC) can replace
// the Tauri IPC so the frontend runs in a plain browser for behavioral checks.
// Production / `tauri dev` builds keep the real `invoke`; the dev path is gated
// by an env flag in main.tsx and tree-shaken out otherwise.
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

let invokeImpl: InvokeFn = invoke as InvokeFn;

/** Dev-only: swap the IPC transport. Used by src/dev/mockBackend.ts. */
export function __setInvokeForDev(fn: InvokeFn): void {
  invokeImpl = fn;
}

export type BlobUrlFn = (target: Target, path: string, side: BlobSide, mime: string, rev: number) => string;

let blobUrlImpl: BlobUrlFn = (target, path, side, mime, rev) => {
  const query = new URLSearchParams({ target: JSON.stringify(target), path, side, mime, rev: String(rev) });
  return `${convertFileSrc("", "delta-blob")}?${query}`;
};

/** Dev-only: swap how binary blob URLs are built (no URI scheme outside Tauri). */
export function __setBlobUrlForDev(fn: BlobUrlFn): void {
  blobUrlImpl = fn;
}

export const api = {
  computeDiff: (target: Target): Promise<DiffSummary> =>
    invokeImpl("compute_diff", { target }),
  getFileDiff: (target: Target, path: string): Promise<FileDiff> =>
    invokeImpl("get_file_diff", { target, path }),
  getBinaryFileDiff: (target: Target, path: string): Promise<BinaryFileDiff> =>
    invokeImpl("get_binary_file_diff", { target, path }),
  // Image bytes load straight into <img> over the `delta-blob` URI scheme; `rev`
  // changes only when the file's sizes change, so an unchanged image keeps its
  // URL and stays in the webview cache across refresh cycles.
  binaryBlobUrl: (target: Target, path: string, side: BlobSide, mime: string, rev: number): string =>
    blobUrlImpl(target, path, side, mime, rev),
  listCommits: (target: Target, skip: number, limit: number): Promise<CommitPage> =>
    invokeImpl("list_commits", { target, skip, limit }),
  openReview: (target: Target): Promise<ReviewSession> =>
    invokeImpl("open_review", { target }),
  refreshReview: (review: Review): Promise<ReviewSession> =>
    invokeImpl("refresh_review", { review }),
  saveReview: (review: Review): Promise<void> =>
    invokeImpl("save_review", { review }),
  exportReview: (review: Review): Promise<string> =>
    invokeImpl("export_review", { review }),
  listRegistry: (): Promise<Registry> => invokeImpl("list_registry"),
  listPicker: (): Promise<PickerData> => invokeImpl("list_picker"),
  listWorktrees: (repoPath: string): Promise<WorktreeEntry[]> =>
    invokeImpl("list_worktrees", { repoPath }),
  // Base-branch picker (#base): all branches + the fork-point suggestion, and the
  // repo-wide base strategy (auto = detect the fork; branch = always this one).
  listBranches: (repoPath: string): Promise<BranchList> =>
    invokeImpl("list_branches", { repoPath }),
  getBaseStrategy: (repoPath: string): Promise<BaseStrategy | null> =>
    invokeImpl("get_base_strategy", { repoPath }),
  setBaseStrategy: (repoPath: string, strategy: BaseStrategy | null): Promise<void> =>
    invokeImpl("set_base_strategy", { repoPath, strategy }),
  importRepo: (): Promise<RepoEntry | null> => invokeImpl("import_repo"),
  openTarget: (repoPath: string, mode: DiffMode, base?: string): Promise<void> =>
    invokeImpl("open_target", { repoPath, mode, base }),
  // Re-point THIS window's fs watcher at a new target's worktree — used when a
  // review window navigates in place ("replace current" picker mode) so
  // auto-refresh follows the new repo. (#replace)
  rewatchWindow: (repoPath: string): Promise<void> =>
    invokeImpl("rewatch_window", { repoPath }),
  getSettings: (): Promise<AppSettings> => invokeImpl("get_settings"),
  setSettings: (settings: AppSettings): Promise<void> => invokeImpl("set_settings", { settings }),
  // Delta Ignore sources (Settings): global rules apply to every repo on this
  // machine; local rules never get committed (git: <git>/info/deltaignore, SVN:
  // the app data dir).
  // Saving invalidates diff snapshots and offers Refresh in open reviews.
  getGlobalDeltaIgnore: (): Promise<string> => invokeImpl("get_global_delta_ignore"),
  setGlobalDeltaIgnore: (rules: string): Promise<void> => invokeImpl("set_global_delta_ignore", { rules }),
  getLocalDeltaIgnore: (repoPath: string): Promise<LocalDeltaIgnore> =>
    invokeImpl("get_local_delta_ignore", { repoPath }),
  setLocalDeltaIgnore: (repoPath: string, rules: string): Promise<void> =>
    invokeImpl("set_local_delta_ignore", { repoPath, rules }),
  deleteReview: (id: string): Promise<void> => invokeImpl("delete_review", { id }),
  installCli: (): Promise<InstallOutcome> => invokeImpl("install_cli"),
  cliStatus: (): Promise<CliStatus> => invokeImpl("cli_status"),
  // Open a file (or the repo root, when `file` is omitted) in the user's editor;
  // `line` jumps there where the editor's CLI supports it. (#editor)
  openInEditor: (editor: string, repoPath: string, file?: string, line?: number): Promise<void> =>
    invokeImpl("open_in_editor", { editor, repoPath, file, line }),
  // `expected` must match the line's on-disk text or the backend refuses the write.
  editFileLine: (target: Target, path: string, line: number, expected: string, replacement: string): Promise<void> =>
    invokeImpl("edit_file_line", { target, path, line, expected, replacement }),
  // Full-file editor (Phase 2): content is LF-normalized regardless of the
  // file's actual line endings; `hash` fingerprints the on-disk bytes so a
  // later write can detect an external change.
  readFileText: (target: Target, path: string): Promise<FileTextResult> =>
    invokeImpl("read_file_text", { target, path }),
  // `expectedHash` must match the file's current on-disk hash or the backend
  // refuses the write (and leaves the file untouched).
  writeFileText: (target: Target, path: string, expectedHash: string, content: string): Promise<FileTextResult> =>
    invokeImpl("write_file_text", { target, path, expectedHash, content }),
  // Self-updater lifecycle. The backend owns the check and the download
  // (src-tauri/src/updater.rs) so a transfer survives the launcher window
  // closing and every window sees the same state via `updater:state` events;
  // `manual` marks checks that may re-run (Settings button, periodic timer) —
  // the mount-time auto check runs at most once per process.
  updaterStatus: (): Promise<UpdaterSnapshot> => invokeImpl("updater_status"),
  updaterCheck: (manual: boolean): Promise<UpdaterSnapshot> => invokeImpl("updater_check", { manual }),
  updaterDownload: (): Promise<UpdaterSnapshot> => invokeImpl("updater_download"),
  // True unless telemetry is disabled by build/env (debug build, DO_NOT_TRACK,
  // or DELTA_TELEMETRY=0). The user's Settings toggle is checked separately in
  // src/analytics.ts. SLEEPING TELEMETRY: dormant in this fork — unused at
  // runtime while TELEMETRY_DORMANT is set there; kept for revival. (#analytics)
  telemetryAllowed: (): Promise<boolean> => invokeImpl("telemetry_allowed"),
};
