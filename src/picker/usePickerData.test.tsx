// The registry:changed listener — the backend's "your list is stale" signal.
// Windows' WebView2 doesn't reliably emit DOM focus on native window
// activation, so a running app's picker needs an app-driven refetch trigger.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { usePickerData } from "./usePickerData";
import { __resetPickerCacheForTest } from "./pickerData";
import { __setInvokeForDev } from "../api";
import type { PickerData } from "../types";

// Capture the backend-event handlers usePickerData registers.
const handlers = vi.hoisted(() => new Map<string, Array<() => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: () => void) => {
    const list = handlers.get(name) ?? [];
    list.push(cb);
    handlers.set(name, list);
    return () => {
      const cur = handlers.get(name) ?? [];
      handlers.set(name, cur.filter((h) => h !== cb));
    };
  }),
}));

function emit(name: string) {
  for (const cb of [...(handlers.get(name) ?? [])]) cb();
}

const FIRST: PickerData = {
  home: "/Users/me",
  worktrees: [
    { path: "/r/demo", branch: "main", isMain: true, repoName: "demo", repoId: "r1" },
  ],
};

const WITH_NEW: PickerData = {
  ...FIRST,
  worktrees: [
    ...FIRST.worktrees,
    { path: "/r/demo-fresh", branch: "fresh/wt", isMain: false, repoName: "demo", repoId: "r1" },
  ],
};

function Harness() {
  const data = usePickerData();
  return <div>{data?.worktrees.map((w) => w.branch).join(" ")}</div>;
}

describe("usePickerData", () => {
  beforeEach(() => {
    __resetPickerCacheForTest();
    handlers.clear();
  });

  it("refetches when the backend reports the registry changed", async () => {
    let calls = 0;
    __setInvokeForDev(async (cmd: string) => {
      if (cmd !== "list_picker") throw new Error(`unexpected ${cmd}`);
      calls += 1;
      return structuredClone(calls === 1 ? FIRST : WITH_NEW) as never;
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    expect(screen.queryByText(/fresh\/wt/)).not.toBeInTheDocument();

    // The app imported a repo / opened a review somewhere else in the process.
    emit("registry:changed");

    await waitFor(() => expect(screen.getByText(/fresh\/wt/)).toBeInTheDocument());
  });

  it("stops listening on unmount", async () => {
    __setInvokeForDev(async (cmd: string) => {
      if (cmd !== "list_picker") throw new Error(`unexpected ${cmd}`);
      return structuredClone(FIRST) as never;
    });
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    const registered = (handlers.get("registry:changed") ?? []).length;
    expect(registered).toBe(1);

    unmount();
    expect((handlers.get("registry:changed") ?? []).length).toBe(0);
  });

  it("keeps the focus-based revalidation alongside the event", async () => {
    let calls = 0;
    __setInvokeForDev(async (cmd: string) => {
      if (cmd !== "list_picker") throw new Error(`unexpected ${cmd}`);
      calls += 1;
      return structuredClone(calls === 1 ? FIRST : WITH_NEW) as never;
    });
    render(<Harness />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());

    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(screen.getByText(/fresh\/wt/)).toBeInTheDocument());
  });
});
