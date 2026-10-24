import { describe, it, expect, vi, beforeEach } from "vitest";
import { getUnreviewableLast, setUnreviewableLast } from "./unreviewableLastPref";

describe("unreviewableLastPref", () => {
  beforeEach(() => {
    localStorage.clear();
    setUnreviewableLast("off"); // reset the module-level cache between tests
  });

  it("defaults to off", () => {
    expect(getUnreviewableLast()).toBe("off");
  });

  it("persists the choice to localStorage", () => {
    setUnreviewableLast("on");
    expect(localStorage.getItem("delta.unreviewableLast")).toBe("on");
  });

  it("seeds from storage on load — a reload keeps the setting", async () => {
    localStorage.setItem("delta.unreviewableLast", "on");
    // A reload re-imports the module with storage already set; resetModules
    // simulates exactly that fresh import. (Keep this test last: after it, the
    // static imports above still point at the pre-reset instance.)
    vi.resetModules();
    const fresh = await import("./unreviewableLastPref");
    expect(fresh.getUnreviewableLast()).toBe("on");
  });
});
