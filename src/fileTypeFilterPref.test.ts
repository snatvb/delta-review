import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileTypeFilter, matchesFileType, setFileTypeFilter, useFileTypeFilter } from "./fileTypeFilterPref";

describe("fileTypeFilterPref", () => {
  beforeEach(() => {
    setFileTypeFilter("all");
    localStorage.clear();
  });

  it("defaults to all files and persists mutually exclusive modes", () => {
    expect(getFileTypeFilter()).toBe("all");
    setFileTypeFilter("exclude-tests");
    expect(getFileTypeFilter()).toBe("exclude-tests");
    setFileTypeFilter("only-tests");
    expect(getFileTypeFilter()).toBe("only-tests");
    expect(localStorage.getItem("delta.fileTypeFilter")).toBe("only-tests");
  });

  it.each(["on", "off"])("restores the legacy Hide tests choice %s", async (legacy) => {
    localStorage.setItem("delta.hideTestFiles", legacy);
    vi.resetModules();
    const fresh = await import("./fileTypeFilterPref");
    expect(fresh.getFileTypeFilter()).toBe(legacy === "on" ? "exclude-tests" : "all");
  });

  it("prefers the new choice over the legacy value after a reload", async () => {
    localStorage.setItem("delta.hideTestFiles", "on");
    localStorage.setItem("delta.fileTypeFilter", "only-tests");
    vi.resetModules();
    const fresh = await import("./fileTypeFilterPref");
    expect(fresh.getFileTypeFilter()).toBe("only-tests");
  });

  it("syncs other windows and resets when storage is cleared", () => {
    const { result } = renderHook(() => useFileTypeFilter());
    act(() => {
      localStorage.setItem("delta.fileTypeFilter", "only-tests");
      window.dispatchEvent(new StorageEvent("storage", { key: "delta.fileTypeFilter", newValue: "only-tests" }));
    });
    expect(result.current[0]).toBe("only-tests");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current[0]).toBe("all");
  });

  it("matches both directions of the existing test-file detector", () => {
    expect(matchesFileType("src/a.ts", "all")).toBe(true);
    expect(matchesFileType("src/a.test.ts", "all")).toBe(true);
    expect(matchesFileType("tests/setup.ts", "exclude-tests")).toBe(false);
    expect(matchesFileType("src/a.ts", "exclude-tests")).toBe(true);
    expect(matchesFileType("src/a.ts", "only-tests")).toBe(false);
    expect(matchesFileType("src/a.test.ts", "only-tests")).toBe(true);
  });
});
