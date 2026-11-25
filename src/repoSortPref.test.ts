import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRepoSort, setRepoSort, useRepoSort } from "./repoSortPref";

describe("repoSortPref", () => {
  beforeEach(() => {
    setRepoSort("manual");
    localStorage.clear();
  });

  it("defaults to a manual order and persists the choice", () => {
    expect(getRepoSort()).toBe("manual");
    setRepoSort("name");
    expect(getRepoSort()).toBe("name");
    expect(localStorage.getItem("delta.repoSort")).toBe("name");
  });

  it.each([
    ["manual", "manual"],
    ["name", "name"],
    ["recent", "recent"],
    ["bogus", "manual"],
    [null, "manual"],
  ])("restores %s from storage as %s", async (stored, expected) => {
    if (stored !== null) {
      localStorage.setItem("delta.repoSort", stored);
    }
    vi.resetModules();
    const fresh = await import("./repoSortPref");
    expect(fresh.getRepoSort()).toBe(expected);
  });

  it("follows a change made in another window and resets when storage is cleared", () => {
    const { result } = renderHook(() => useRepoSort());
    act(() => {
      localStorage.setItem("delta.repoSort", "name");
      window.dispatchEvent(new StorageEvent("storage", { key: "delta.repoSort", newValue: "name" }));
    });
    expect(result.current[0]).toBe("name");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current[0]).toBe("manual");
  });
});
