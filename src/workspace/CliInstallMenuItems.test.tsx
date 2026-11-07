import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DropdownMenu, DropdownMenuContent } from "@/components/ui/dropdown-menu";
import { CliInstallMenuItems } from "./CliInstallMenuItems";
import { useCliInstall } from "./useCliInstall";

const cliStatus = vi.fn();
const installCli = vi.fn();
vi.mock("../api", () => ({ api: {
  cliStatus: (...args: unknown[]) => cliStatus(...args),
  installCli: (...args: unknown[]) => installCli(...args),
} }));

function Harness() {
  const state = useCliInstall();
  return <DropdownMenu open><DropdownMenuContent><CliInstallMenuItems state={state} /></DropdownMenuContent></DropdownMenu>;
}

describe("CliInstallMenuItems", () => {
  beforeEach(() => {
    cliStatus.mockReset();
    installCli.mockReset();
    localStorage.clear();
  });

  it("offers install when the CLI isn't installed", async () => {
    cliStatus.mockResolvedValue({ supported: true, installed: false, path: null });
    render(<Harness />);
    expect(await screen.findByRole("menuitem", { name: "Install CLI" })).toBeInTheDocument();
  });

  it.each([
    { supported: true, installed: true, path: "/usr/local/bin/delta" },
    { supported: false, installed: false, path: null },
  ])("stays hidden for an installed or unsupported CLI: %j", async (status) => {
    cliStatus.mockResolvedValue(status);
    render(<Harness />);
    await waitFor(() => expect(cliStatus).toHaveBeenCalledOnce());
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  it("skips the status check once dismissed", () => {
    localStorage.setItem("delta.cliPromptDismissed", "1");
    render(<Harness />);
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(cliStatus).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "linked", path: "/usr/local/bin/delta" }, "delta CLI installed"],
    [{ kind: "linkedPathUpdated", path: "/Users/me/.local/bin/delta", shells: ["zsh"] }, "Installed — open a new terminal"],
  ])("confirms an install outcome: %j", async (outcome, label) => {
    cliStatus.mockResolvedValue({ supported: true, installed: false, path: null });
    installCli.mockResolvedValue(outcome);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Install CLI" }));
    expect(await screen.findByRole("menuitem", { name: label as string })).toHaveAttribute("aria-disabled", "true");
  });

  it("copies the fallback command without closing the menu", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    cliStatus.mockResolvedValue({ supported: true, installed: false, path: null });
    installCli.mockResolvedValue({ kind: "manualNeeded", command: "sudo ln -sf x /usr/local/bin/delta", reason: "No writable dir." });
    render(<Harness />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Install CLI" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy install command" }));
    expect(await screen.findByRole("menuitem", { name: "Copied — paste in a terminal" })).toBeInTheDocument();
    expect(write).toHaveBeenCalledWith("sudo ln -sf x /usr/local/bin/delta");
    write.mockRestore();
  });

  it("offers a retry after an install error", async () => {
    cliStatus.mockResolvedValue({ supported: true, installed: false, path: null });
    installCli.mockRejectedValueOnce(new Error("Install failed"));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Install CLI" }));
    const retry = await screen.findByRole("menuitem", { name: "Retry CLI install" });
    installCli.mockResolvedValue({ kind: "linked", path: "/usr/local/bin/delta" });
    fireEvent.click(retry);
    expect(await screen.findByRole("menuitem", { name: "delta CLI installed" })).toBeInTheDocument();
  });

  it("dismiss hides the prompt and remembers the choice", async () => {
    cliStatus.mockResolvedValue({ supported: true, installed: false, path: null });
    render(<Harness />);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Dismiss CLI prompt" }));
    expect(screen.queryByRole("menuitem")).toBeNull();
    expect(localStorage.getItem("delta.cliPromptDismissed")).toBe("1");
  });
});
