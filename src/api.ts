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
  CommitMeta,
  FileTextResult,
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
  // changes on every sizes refetch so a refreshed file never hits a cached image.
  binaryBlobUrl: (target: Target, path: string, side: BlobSide, mime: string, rev: number): string =>
    blobUrlImpl(target, path, side, mime, rev),
  listCommits: (target: Target): Promise<CommitMeta[]> =>
    invokeImpl("list_commits", { target }),
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
  importRepo: (): Promise<RepoEntry | null> => invokeImpl("import_repo"),
  openTarget: (repoPath: string, mode: DiffMode, base?: string): Promise<void> =>
    invokeImpl("open_target", { repoPath, mode, base }),
  // Re-point THIS window's fs watcher at a new target's worktree — used when a
  // review window navigates in place ("replace current" picker mode) so
  // auto-refresh follows the new repo. (#replace)
  rewatchWindow: (repoPath: string): Promise<void> =>
    invokeImpl("rewatch_window", { repoPath }),
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
  // Process-wide updater leader election: the first window to call this gets
  // `true` and runs the check/download; other windows get `false` and stay idle,
  // so we never run concurrent downloads or .app replacements. (#updater-race)
  acquireUpdaterGate: (): Promise<boolean> => invokeImpl("updater_try_acquire"),
  // True unless telemetry is disabled by build/env (debug build, DO_NOT_TRACK,
  // or DELTA_TELEMETRY=0). The user's Settings toggle is checked separately in
  // src/analytics.ts. (#analytics)
  telemetryAllowed: (): Promise<boolean> => invokeImpl("telemetry_allowed"),
};
