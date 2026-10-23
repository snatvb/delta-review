import { describe, it, expect, vi, beforeEach } from "vitest";
import { getHideViewedFiles, setHideViewedFiles } from "./hideViewedFilesPref";

describe("hideViewedFilesPref", () => {
  beforeEach(() => {
    localStorage.clear();
    setHideViewedFiles("off"); // reset the module-level cache between tests
  });

  it("defaults to off", () => {
    expect(getHideViewedFiles()).toBe("off");
  });

  it("persists the choice to localStorage", () => {
    setHideViewedFiles("on");
    expect(localStorage.getItem("delta.hideViewedFiles")).toBe("on");
  });

  it("seeds from storage on load — a reload keeps the hidden state", async () => {
    localStorage.setItem("delta.hideViewedFiles", "on");
    // A reload re-imports the module with storage already set; resetModules
    // simulates exactly that fresh import. (Keep this test last: after it, the
    // static imports above still point at the pre-reset instance.)
    vi.resetModules();
    const fresh = await import("./hideViewedFilesPref");
    expect(fresh.getHideViewedFiles()).toBe("on");
  });
});
