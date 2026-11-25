import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRepoOrder, setRepoOrder, useRepoOrder } from "./repoOrderPref";

describe("repoOrderPref", () => {
  beforeEach(() => {
    setRepoOrder([]);
    localStorage.clear();
  });

  it("starts empty and persists an arrangement", () => {
    expect(getRepoOrder()).toEqual([]);
    setRepoOrder(["b", "a"]);
    expect(getRepoOrder()).toEqual(["b", "a"]);
    expect(localStorage.getItem("delta.repoOrder")).toBe('["b","a"]');
  });

  it("ignores a corrupted, duplicated or non-string saved order", async () => {
    localStorage.setItem("delta.repoOrder", "{not json");
    vi.resetModules();
    expect((await import("./repoOrderPref")).getRepoOrder()).toEqual([]);
    localStorage.setItem("delta.repoOrder", JSON.stringify(["b", "a", "b", 3, null]));
    vi.resetModules();
    expect((await import("./repoOrderPref")).getRepoOrder()).toEqual(["b", "a"]);
  });

  it("follows an arrangement made in another window", () => {
    const { result } = renderHook(() => useRepoOrder());
    act(() => {
      localStorage.setItem("delta.repoOrder", '["b","a"]');
      window.dispatchEvent(new StorageEvent("storage", { key: "delta.repoOrder", newValue: '["b","a"]' }));
    });
    expect(result.current[0]).toEqual(["b", "a"]);
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current[0]).toEqual([]);
  });
});
