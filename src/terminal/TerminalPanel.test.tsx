import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
const sessions = vi.hoisted(() => ({ opened: 0, onExit: [] as Array<() => void> }));
vi.mock("./terminalSession", () => ({
  connectSession: (_term: unknown, _cwd: string, _shell: string, onExit: () => void) => {
    sessions.opened += 1;
    sessions.onExit.push(onExit);
    return { dispose() {} };
  },
}));

import { TerminalPanel } from "./TerminalPanel";

function renderPanel() {
  const onClose = vi.fn();
  render(<TerminalPanel cwd="/repo" visible onHide={() => {}} onClose={onClose} />);
  return { onClose };
}

describe("TerminalPanel kill", () => {
  it("asks before killing and keeps the shell on cancel", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
    expect(screen.getByRole("alertdialog", { name: "Kill terminal?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("kills once confirmed", () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("TerminalPanel restart", () => {
  beforeEach(() => {
    sessions.opened = 0;
    sessions.onExit = [];
  });

  it("asks before restarting a running shell", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    expect(screen.getByRole("alertdialog", { name: "Restart terminal?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sessions.opened).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(sessions.opened).toBe(2);
  });

  it("restarts an exited shell without asking", () => {
    renderPanel();
    act(() => sessions.onExit[0]());
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sessions.opened).toBe(2);
  });
});
