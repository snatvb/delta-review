import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";
import { __resetPickerCacheForTest } from "./pickerData";
import { __setInvokeForDev } from "../api";
import type { PickerData } from "../types";

const DATA: PickerData = {
  home: "/Users/me",
  worktrees: [
    {
      path: "/r/demo",
      branch: "main",
      isMain: true,
      lastCommitAt: "2026-06-26T09:00:00Z",
      repoName: "demo",
      repoId: "r1",
      review: {
        id: "abc",
        repoName: "demo",
        target: { repoPath: "/r/demo", worktree: "main", mode: "all-changes", base: "dev" },
        lastOpenedAt: "2026-06-26T10:00:00Z",
        commentCount: 3,
        staleCount: 1,
        resolvedCount: 1,
        viewedCount: 0,
        fileCount: 7,
      },
    },
    { path: "/r/demo-spike", branch: "spike/idea", isMain: false, lastCommitAt: "2026-06-26T15:45:00Z", dirty: false, repoName: "demo", repoId: "r1" },
  ],
};

describe("CommandPalette", () => {
  let calls: { cmd: string; args?: Record<string, unknown> }[];
  beforeEach(() => {
    __resetPickerCacheForTest();
    calls = [];
    __setInvokeForDev(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "list_picker") return structuredClone(DATA) as never;
      return undefined as never;
    });
  });

  it("opens a folder resuming its joined review's mode and base", async () => {
    let closed = false;
    render(<CommandPalette onClose={() => { closed = true; }} />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    fireEvent.click(screen.getByText("main"));
    await waitFor(() => {
      const call = calls.find((c) => c.cmd === "open_target");
      expect(call?.args).toMatchObject({ repoPath: "/r/demo", mode: "all-changes", base: "dev" });
    });
    expect(closed).toBe(true);
  });

  it("opens a folder without a matching review on uncommitted", async () => {
    render(<CommandPalette onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("spike/idea")).toBeInTheDocument());
    fireEvent.click(screen.getByText("spike/idea"));
    await waitFor(() => {
      const call = calls.find((c) => c.cmd === "open_target");
      expect(call?.args).toMatchObject({ repoPath: "/r/demo-spike", mode: "uncommitted" });
    });
  });

  it("escape closes", async () => {
    let closed = false;
    render(<CommandPalette onClose={() => { closed = true; }} />);
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: "Escape" });
    expect(closed).toBe(true);
  });
});
