import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UpdaterState } from "../updater/useUpdater";
import type { UpdaterStatus } from "../types";
import { AboutSection } from "./AboutSection";

const fakeUpdater = (status: UpdaterStatus, extra: Partial<UpdaterState> = {}): UpdaterState => ({
  status,
  version: status === "available" || status === "ready" ? "9.9.9" : null,
  progress: status === "downloading" ? 0.42 : null,
  lastCheckedAt: null,
  check: vi.fn(),
  download: vi.fn(),
  restart: vi.fn(),
  ...extra,
});

describe("AboutSection updates row", () => {
  it("offers a manual check when idle, with the last-checked time", () => {
    const updater = fakeUpdater("idle", { lastCheckedAt: new Date("2026-10-02T14:05:00").getTime() });
    render(<AboutSection updater={updater} />);
    expect(screen.getByText(/last checked at/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    expect(updater.check).toHaveBeenCalledOnce();
  });

  it("says so while a check is running", () => {
    render(<AboutSection updater={fakeUpdater("checking")} />);
    expect(screen.getByText(/checking for updates…/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check for updates/i })).toBeNull();
  });

  it("offers download when a version is available", () => {
    const updater = fakeUpdater("available");
    render(<AboutSection updater={updater} />);
    expect(screen.getByText(/version 9\.9\.9 is available/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(updater.download).toHaveBeenCalledOnce();
  });

  it("shows a progress percentage while downloading", () => {
    render(<AboutSection updater={fakeUpdater("downloading")} />);
    expect(screen.getByTestId("about-updates")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("offers restart when the update is ready", () => {
    const updater = fakeUpdater("ready");
    render(<AboutSection updater={updater} />);
    fireEvent.click(screen.getByRole("button", { name: /restart now/i }));
    expect(updater.restart).toHaveBeenCalledOnce();
  });

  it("offers a retry after a failure", () => {
    const updater = fakeUpdater("error");
    render(<AboutSection updater={updater} />);
    expect(screen.getByText(/update failed/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(updater.check).toHaveBeenCalledOnce();
  });
});
