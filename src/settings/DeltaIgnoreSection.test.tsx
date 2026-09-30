import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const getLocalDeltaIgnore = vi.fn();
vi.mock("../api", () => ({
  api: {
    getGlobalDeltaIgnore: vi.fn().mockResolvedValue(""),
    getLocalDeltaIgnore: (...a: unknown[]) => getLocalDeltaIgnore(...a),
    setGlobalDeltaIgnore: vi.fn(),
    setLocalDeltaIgnore: vi.fn(),
  },
}));

import { DeltaIgnoreSection } from "./DeltaIgnoreSection";

describe("DeltaIgnoreSection", () => {
  it("names the git info file for a git checkout", async () => {
    getLocalDeltaIgnore.mockResolvedValue({ storage: "gitInfo", rules: "gen/\n" });
    render(<DeltaIgnoreSection target={{ repoPath: "/r", mode: "uncommitted" }} />);
    expect(await screen.findByDisplayValue("gen/")).toBeInTheDocument();
    expect(screen.getByText(".git/info/deltaignore")).toBeInTheDocument();
  });

  it("points an SVN working copy at the app data dir", async () => {
    getLocalDeltaIgnore.mockResolvedValue({ storage: "appData", rules: "vendor/\n" });
    render(<DeltaIgnoreSection target={{ repoPath: "/wc", mode: "uncommitted" }} />);
    expect(await screen.findByDisplayValue("vendor/")).toBeInTheDocument();
    expect(screen.getByText(/Stored in Delta's app data/)).toBeInTheDocument();
    expect(screen.queryByText(".git/info/deltaignore")).toBeNull();
  });
});
