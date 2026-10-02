// src/workspace/BasePicker.test.tsx — the "vs <base>" chip: provenance badges,
// branch list with fork suggestion, and the repo-strategy footer. (#base)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listBranches = vi.fn();
vi.mock("../api", () => ({
  api: {
    listBranches: (...a: unknown[]) => listBranches(...a),
  },
}));

import { BasePicker } from "./BasePicker";
import type { BranchList } from "../types";

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

const LIST: BranchList = {
  branches: [
    { name: "feat/auth", remote: false, isCurrent: true, isDefault: false, shortOid: "a1b2c3d", lastCommitAt: now - 3600, lastSubject: "wip", ahead: 0, behind: 0 },
    { name: "dev", remote: false, isCurrent: false, isDefault: true, shortOid: "e4f5a6b", lastCommitAt: now - 3 * DAY, lastSubject: "dev work", ahead: 4, behind: 1 },
    { name: "main", remote: false, isCurrent: false, isDefault: false, shortOid: "0f1e2d3", lastCommitAt: now - 14 * DAY, lastSubject: "release", ahead: 12, behind: 0 },
    { name: "origin/dev", remote: true, isCurrent: false, isDefault: true, shortOid: "e4f5a6b", lastCommitAt: now - 4 * DAY, lastSubject: "dev work", ahead: 4, behind: 0 },
  ],
  suggested: { name: "dev", mergeBaseShortOid: "e4f5a6b", mergeBaseAt: now - 3 * DAY },
};

const noop = () => {};

function chip(overrides: Partial<Parameters<typeof BasePicker>[0]> = {}) {
  return render(
    <BasePicker
      repoPath="/r"
      strategy={null}
      resolvedLabel="dev"
      onPick={noop}
      onAuto={noop}
      onPin={noop}
      {...overrides}
    />,
  );
}

// Radix opens its menu on pointerdown, not click — fire the full pointer/mouse
// sequence so the portal content mounts under happy-dom.
function openMenu() {
  const trigger = screen.getByRole("button", { name: /base branch/i });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(trigger);
  fireEvent.pointerUp(trigger, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(trigger);
  fireEvent.click(trigger);
}

describe("BasePicker", () => {
  beforeEach(() => {
    listBranches.mockReset().mockResolvedValue(LIST);
  });

  it("shows the resolved base with an (auto) badge when no override and no pin", async () => {
    const { container } = chip({ strategy: null });
    const trigger = screen.getByRole("button", { name: /base branch/i });
    expect(trigger.textContent).toContain("vs");
    expect(trigger.textContent).toContain("dev");
    expect(trigger.textContent).toContain("(auto)");
    // Strategy loaded but auto → the trigger tooltip says so.
    expect(trigger.title).toBe("Base auto-detected");
    expect(container).toBeTruthy();
  });

  it("shows (pinned) when the repo strategy pins a branch", () => {
    chip({ strategy: { kind: "branch", name: "dev" } });
    const trigger = screen.getByRole("button", { name: /base branch/i });
    expect(trigger.textContent).toContain("(pinned)");
  });

  it("shows no badge for an explicit per-window override", () => {
    chip({ override: "release/2.0", strategy: null });
    const trigger = screen.getByRole("button", { name: /base branch/i });
    expect(trigger.textContent).toContain("release/2.0");
    expect(trigger.textContent).not.toContain("(auto)");
    expect(trigger.textContent).not.toContain("(pinned)");
  });

  it("lists branches grouped local/remote, marks default/current, and flags the fork", async () => {
    chip();
    openMenu();
    await waitFor(() => expect(screen.getByText("origin/dev")).toBeInTheDocument());

    const localHeader = screen.getByText("Local");
    const remoteHeader = screen.getByText("Remote");
    expect(localHeader).toBeInTheDocument();
    expect(remoteHeader).toBeInTheDocument();
    // The suggested row says where the branch was cut.
    expect(screen.getByText("cut here")).toBeInTheDocument();
    expect(screen.getAllByText("default").length).toBeGreaterThanOrEqual(2); // dev + origin/dev
    expect(screen.getByText("current")).toBeInTheDocument();
  });

  it("filters branches by the search box", async () => {
    chip();
    openMenu();
    await waitFor(() => expect(screen.getByText("origin/dev")).toBeInTheDocument());
    fireEvent.input(screen.getByPlaceholderText(/filter branches/i), { target: { value: "origin" } });
    expect(screen.queryByText("main")).not.toBeInTheDocument();
    expect(screen.getByText("origin/dev")).toBeInTheDocument();
  });

  it("picking a branch calls onPick with its name", async () => {
    const onPick = vi.fn();
    chip({ onPick });
    openMenu();
    await waitFor(() => expect(screen.getByText("main")).toBeInTheDocument());
    fireEvent.click(screen.getByText("main"));
    expect(onPick).toHaveBeenCalledWith("main");
  });

  it("the footer actions call onAuto and onPin with the resolved base", async () => {
    const onAuto = vi.fn();
    const onPin = vi.fn();
    chip({ onAuto, onPin });
    openMenu();
    await screen.findByRole("menuitem", { name: /always use “dev”/i });

    fireEvent.click(screen.getByRole("menuitem", { name: /auto-detect base/i }));
    expect(onAuto).toHaveBeenCalled();

    // Selecting closed the menu; re-open and re-query (the old node is detached).
    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /always use “dev”/i }));
    expect(onPin).toHaveBeenCalledWith("dev");
  });
});
