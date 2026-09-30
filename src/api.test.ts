import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { api } from "./api";
import type { Target } from "./types";

describe("api", () => {
  beforeEach(() => invokeMock.mockReset());

  it("computeDiff calls the command with the target", async () => {
    const target: Target = { repoPath: "/r", mode: "all-changes" };
    invokeMock.mockResolvedValue({ files: [], baseLabel: "main", headLabel: "x" });
    const res = await api.computeDiff(target);
    expect(invokeMock).toHaveBeenCalledWith("compute_diff", { target });
    expect(res.baseLabel).toBe("main");
  });

  it("getFileDiff passes target and path", async () => {
    const target: Target = { repoPath: "/r", mode: "uncommitted" };
    invokeMock.mockResolvedValue({ status: "modified", binary: false });
    await api.getFileDiff(target, "a.ts");
    expect(invokeMock).toHaveBeenCalledWith("get_file_diff", { target, path: "a.ts" });
  });

  it("openReview calls open_review with the target", async () => {
    const target = { repoPath: "/r", mode: "all-changes" as const };
    invokeMock.mockResolvedValue({ review: { id: "x" }, summary: { files: [], baseLabel: "main", headLabel: "h" } });
    const res = await api.openReview(target);
    expect(invokeMock).toHaveBeenCalledWith("open_review", { target });
    expect(res.review.id).toBe("x");
  });

  it("refreshReview calls refresh_review with the review", async () => {
    const review = { id: "x" } as any;
    invokeMock.mockResolvedValue({ review: { id: "x" }, summary: { files: [], baseLabel: "main", headLabel: "h" } });
    const res = await api.refreshReview(review);
    expect(invokeMock).toHaveBeenCalledWith("refresh_review", { review });
    expect(res.review.id).toBe("x");
  });

  it("saveReview and exportReview pass the review", async () => {
    const review = { id: "x" } as any;
    invokeMock.mockResolvedValue(undefined);
    await api.saveReview(review);
    expect(invokeMock).toHaveBeenCalledWith("save_review", { review });
    invokeMock.mockResolvedValue("# md");
    const md = await api.exportReview(review);
    expect(invokeMock).toHaveBeenCalledWith("export_review", { review });
    expect(md).toBe("# md");
  });

  it("delta ignore rules round-trip the right commands", async () => {
    invokeMock.mockResolvedValue("vendor/\n");
    expect(await api.getGlobalDeltaIgnore()).toBe("vendor/\n");
    expect(invokeMock).toHaveBeenCalledWith("get_global_delta_ignore");

    invokeMock.mockResolvedValue(undefined);
    await api.setGlobalDeltaIgnore("vendor/\n");
    expect(invokeMock).toHaveBeenCalledWith("set_global_delta_ignore", { rules: "vendor/\n" });

    invokeMock.mockResolvedValue("");
    expect(await api.getLocalDeltaIgnore("/r")).toBe("");
    expect(invokeMock).toHaveBeenCalledWith("get_local_delta_ignore", { repoPath: "/r" });

    await api.setLocalDeltaIgnore("/r", "gen/\n");
    expect(invokeMock).toHaveBeenCalledWith("set_local_delta_ignore", { repoPath: "/r", rules: "gen/\n" });
  });
});
