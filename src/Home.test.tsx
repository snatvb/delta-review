import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Home } from "./Home";
import { __resetPickerCacheForTest } from "./picker/pickerData";
import { __setInvokeForDev } from "./api";
import type { PickerData } from "./types";

const WITH_REPOS: PickerData = {
  home: "/Users/me",
  worktrees: [
    { path: "/r/demo", branch: "main", isMain: true, repoName: "demo", repoId: "r1" },
  ],
};

const EMPTY: PickerData = { home: "/Users/me", worktrees: [] };

function mock(picker: PickerData) {
  __setInvokeForDev(async (cmd: string) => {
    if (cmd === "list_picker") return structuredClone(picker) as never;
    if (cmd === "cli_status") return { installed: true, path: "/usr/local/bin/delta" } as never;
    throw new Error(`unexpected ${cmd}`);
  });
}

describe("Home", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetPickerCacheForTest();
  });

  it("shows the FirstRun empty state when there are no repos", async () => {
    mock(EMPTY);
    render(<Home />);
    expect(await screen.findByText("Open a repository")).toBeInTheDocument();
    // The picker (with its search box) should not be mounted.
    expect(screen.queryByPlaceholderText(/search repos/i)).toBeNull();
  });

  it("shows the picker when there are repos to list", async () => {
    mock(WITH_REPOS);
    render(<Home />);
    expect(await screen.findByPlaceholderText(/search repos/i)).toBeInTheDocument();
    expect(screen.queryByText("Open a repository")).toBeNull();
  });
});
