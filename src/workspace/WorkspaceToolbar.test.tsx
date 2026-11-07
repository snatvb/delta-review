import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { WorkspaceToolbar } from "./WorkspaceToolbar";

import { getFileTypeFilter, setFileTypeFilter } from "../fileTypeFilterPref";
import { setHideViewedFiles } from "../hideViewedFilesPref";
import { api } from "../api";
import { SettingsDialog } from "../settings/SettingsDialog";


vi.mock("../api", () => ({ api: {
  cliStatus: vi.fn().mockResolvedValue({ supported: true, installed: true, path: "/usr/local/bin/delta" }),
  installCli: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({ windowPerBranch: true }),
} }));

function openMenu(label: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: label }), { button: 0, pointerType: "mouse" });
}

const defaults = {
  repoPath: "/work/repo",
  repoName: "repo",
  worktree: "feature/long-branch-name",
  loaded: true,
  busy: false,
  comparison: <button aria-label="Diff mode">Branch → dev</button>,
  fileCount: 3,
  viewedCount: 1,
  layout: "unified" as const,
  onLayoutChange: vi.fn(),
  pendingRefresh: false,
  refreshing: false,
  onRefresh: vi.fn(),
  commentCount: 2,
  indexOpen: false,
  onToggleComments: vi.fn(),
  copyCount: 2,
  copyState: "idle" as const,
  onCopy: vi.fn(),
  onOpenEditor: vi.fn(),
  onOpenSettings: vi.fn(),
};

describe("WorkspaceToolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFileTypeFilter("all");
    setHideViewedFiles("off");
    localStorage.removeItem("delta.cliPromptDismissed");
    vi.mocked(api.cliStatus).mockResolvedValue({ supported: true, installed: true, path: "/usr/local/bin/delta" });
  });


  it("shows the active file mode and offers mutually exclusive choices", () => {
    render(<WorkspaceToolbar {...defaults} />);
    expect(screen.getByRole("button", { name: /File filters: All files/ })).toHaveTextContent("All files");
    openMenu("File filters: All files");
    expect(screen.getByRole("menuitemradio", { name: "All files" })).toBeChecked();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Only tests" }));
    expect(getFileTypeFilter()).toBe("only-tests");
    expect(screen.getByRole("button", { name: /File filters: Only tests/ })).toHaveTextContent("Only tests");
    openMenu("File filters: Only tests");
    expect(screen.getByRole("menuitemradio", { name: "Only tests" })).toBeChecked();
    expect(screen.getByRole("menuitemradio", { name: "Exclude tests" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Hide viewed files (1)" }));
    expect(screen.getByRole("button", { name: "File filters: Only tests; viewed hidden" })).toBeInTheDocument();
    expect(getFileTypeFilter()).toBe("only-tests");
  });

  it("keeps secondary controls in overflow and preserves callbacks", async () => {
    render(<WorkspaceToolbar {...defaults} />);
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    openMenu("More actions");
    fireEvent.click(screen.getByRole("menuitem", { name: /Settings/ }));
    await waitFor(() => expect(defaults.onOpenSettings).toHaveBeenCalledOnce());
    openMenu("More actions");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Split" }));
    expect(defaults.onLayoutChange).toHaveBeenCalledWith("split");
    openMenu("More actions");
    fireEvent.click(screen.getByRole("menuitem", { name: /Comments \(2\)/ }));
    expect(defaults.onToggleComments).toHaveBeenCalledOnce();
    openMenu("More actions");
    fireEvent.click(screen.getByRole("menuitem", { name: "Open repository in editor" }));
    expect(defaults.onOpenEditor).toHaveBeenCalledOnce();
  });

  it("keeps pending refresh icon-sized and copy feedback accessible", () => {
    render(<WorkspaceToolbar {...defaults} pendingRefresh copyState="ok" />);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toHaveTextContent("");
    fireEvent.click(refresh);
    expect(defaults.onRefresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    expect(defaults.onCopy).toHaveBeenCalledOnce();
  });

  it("keeps settings and editor reachable before the review loads", () => {
    render(<WorkspaceToolbar {...defaults} loaded={false} />);
    expect(screen.queryByRole("button", { name: /File filters/ })).not.toBeInTheDocument();
    openMenu("More actions");
    expect(screen.getByRole("menuitem", { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Open repository in editor" })).toBeInTheDocument();
  });

  it("keeps CLI actions in menu keyboard navigation and preserves fallback on reopen", async () => {
    vi.mocked(api.cliStatus).mockResolvedValue({ supported: true, installed: false, path: null });
    vi.mocked(api.installCli).mockResolvedValue({ kind: "manualNeeded", command: "sudo ln -sf delta /usr/local/bin/delta", reason: "No writable dir." });
    render(<WorkspaceToolbar {...defaults} />);
    openMenu("More actions");
    const install = await screen.findByRole("menuitem", { name: "Install CLI" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Dismiss CLI prompt" })).toHaveFocus());
    fireEvent.click(install);
    expect(await screen.findByRole("menuitem", { name: "Copy install command" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    openMenu("More actions");
    expect(screen.getByRole("menuitem", { name: "Copy install command" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Dismiss CLI prompt" })).toBeInTheDocument();
    expect(api.installCli).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight CLI result when overflow is closed", async () => {
    vi.mocked(api.cliStatus).mockResolvedValue({ supported: true, installed: false, path: null });
    let finish!: (outcome: Awaited<ReturnType<typeof api.installCli>>) => void;
    vi.mocked(api.installCli).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<WorkspaceToolbar {...defaults} />);
    openMenu("More actions");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Install CLI" }));
    expect(screen.getByRole("menuitem", { name: "Installing CLI…" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await act(async () => { finish({ kind: "manualNeeded", command: "install command", reason: "No writable dir." }); });
    openMenu("More actions");
    expect(screen.getByRole("menuitem", { name: "Copy install command" })).toBeInTheDocument();
    expect(api.installCli).toHaveBeenCalledOnce();
  });

  it("keeps Settings focus after overflow closes", async () => {
    const updater = { status: "idle" as const, version: null, progress: null, lastCheckedAt: null, check: vi.fn(), download: vi.fn(), restart: vi.fn() };
    function Harness() {
      const [open, setOpen] = useState(false);
      return <><WorkspaceToolbar {...defaults} onOpenSettings={() => setOpen(true)} /><SettingsDialog open={open} onOpenChange={setOpen} updater={updater} /></>;
    }
    render(<Harness />);
    openMenu("More actions");
    fireEvent.click(screen.getByRole("menuitem", { name: /Settings/ }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    // Radix restores focus after unmount; flush that task before checking the dialog.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole("dialog")).toHaveFocus();
  });
});
