import { afterEach, describe, expect, it, vi } from "vitest";
import { __setInvokeForDev, __setTerminalChannelForDev } from "../api";
import type { TerminalEvent } from "../types";
import { connectSession, exitBanner, type TerminalSurface } from "./terminalSession";

type Call = { cmd: string; args?: Record<string, unknown> };

function fakeSurface() {
  const written: string[] = [];
  let dataListener: (data: string) => void = () => {};
  let resizeListener: (size: { cols: number; rows: number }) => void = () => {};
  const surface: TerminalSurface = {
    cols: 100,
    rows: 30,
    write: (data) => written.push(data),
    onData: (listener) => {
      dataListener = listener;
      return { dispose: () => { dataListener = () => {}; } };
    },
    onResize: (listener) => {
      resizeListener = listener;
      return { dispose: () => { resizeListener = () => {}; } };
    },
  };
  return {
    surface,
    written,
    type: (data: string) => dataListener(data),
    resize: (cols: number, rows: number) => resizeListener({ cols, rows }),
  };
}

function fakeBackend(openResult: () => Promise<number>) {
  const calls: Call[] = [];
  let emit: (event: TerminalEvent) => void = () => {};
  __setTerminalChannelForDev((onEvent) => {
    emit = onEvent;
    return "channel";
  });
  __setInvokeForDev(async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    if (cmd === "terminal_open") {
      return (await openResult()) as T;
    }
    return undefined as T;
  });
  return { calls, emit: (event: TerminalEvent) => emit(event) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connectSession", () => {
  it("opens in the worktree with the surface size and the chosen shell", async () => {
    const backend = fakeBackend(async () => 7);
    const { surface } = fakeSurface();
    connectSession(surface, "/repo/wt", "nu", () => {});
    await flush();
    expect(backend.calls[0]).toEqual({
      cmd: "terminal_open",
      args: { cwd: "/repo/wt", shell: "nu", cols: 100, rows: 30, events: "channel" },
    });
  });

  it("sends a blank shell as null so the backend picks the default", async () => {
    const backend = fakeBackend(async () => 1);
    connectSession(fakeSurface().surface, "/r", "", () => {});
    await flush();
    expect(backend.calls[0].args?.shell).toBeNull();
  });

  it("queues keystrokes typed before the session id arrives", async () => {
    let release: (id: number) => void = () => {};
    const backend = fakeBackend(() => new Promise((resolve) => { release = resolve; }));
    const term = fakeSurface();
    connectSession(term.surface, "/r", "", () => {});
    term.type("ls");
    term.type("\r");
    release(3);
    await flush();
    const writes = backend.calls.filter((c) => c.cmd === "terminal_write").map((c) => c.args);
    expect(writes).toEqual([{ id: 3, data: "ls" }, { id: 3, data: "\r" }]);
  });

  it("writes output and reports exit", async () => {
    const backend = fakeBackend(async () => 1);
    const term = fakeSurface();
    const onExit = vi.fn();
    connectSession(term.surface, "/r", "", onExit);
    await flush();
    backend.emit({ kind: "data", data: "hello" });
    backend.emit({ kind: "exit", code: 2 });
    expect(term.written).toEqual(["hello", exitBanner(2)]);
    expect(onExit).toHaveBeenCalledWith(2);
  });

  it("forwards resizes once open", async () => {
    const backend = fakeBackend(async () => 4);
    const term = fakeSurface();
    connectSession(term.surface, "/r", "", () => {});
    await flush();
    term.resize(80, 20);
    const resizes = backend.calls.filter((c) => c.cmd === "terminal_resize").map((c) => c.args);
    expect(resizes).toContainEqual({ id: 4, cols: 80, rows: 20 });
  });

  it("closes the session on dispose and ignores late output", async () => {
    const backend = fakeBackend(async () => 5);
    const term = fakeSurface();
    const session = connectSession(term.surface, "/r", "", () => {});
    await flush();
    session.dispose();
    backend.emit({ kind: "data", data: "late" });
    expect(backend.calls[backend.calls.length - 1]).toEqual({ cmd: "terminal_close", args: { id: 5 } });
    expect(term.written).toEqual([]);
  });

  it("closes a session that finishes opening after dispose", async () => {
    let release: (id: number) => void = () => {};
    const backend = fakeBackend(() => new Promise((resolve) => { release = resolve; }));
    const session = connectSession(fakeSurface().surface, "/r", "", () => {});
    session.dispose();
    release(9);
    await flush();
    expect(backend.calls[backend.calls.length - 1]).toEqual({ cmd: "terminal_close", args: { id: 9 } });
  });

  it("shows an open failure in the terminal", async () => {
    fakeBackend(async () => { throw new Error("Couldn't find the shell 'nu'"); });
    const term = fakeSurface();
    const onExit = vi.fn();
    connectSession(term.surface, "/r", "nu", onExit);
    await flush();
    expect(term.written.join("")).toContain("Couldn't find the shell 'nu'");
    expect(onExit).toHaveBeenCalledWith(null);
  });
});
