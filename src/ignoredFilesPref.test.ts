import { describe, it, expect, vi, beforeEach } from "vitest";
import { getHideIgnoredFiles, setHideIgnoredFiles } from "./ignoredFilesPref";

describe("ignoredFilesPref", () => {
  beforeEach(() => {
    localStorage.clear();
    setHideIgnoredFiles("off"); // reset the module-level cache between tests
  });

  it("defaults to off", () => {
    expect(getHideIgnoredFiles()).toBe("off");
  });

  it("persists the choice to localStorage", () => {
    setHideIgnoredFiles("on");
    expect(localStorage.getItem("delta.hideIgnoredFiles")).toBe("on");
  });

  it("seeds from storage on load — a reload keeps the hidden state", async () => {
    localStorage.setItem("delta.hideIgnoredFiles", "on");
    // A reload re-imports the module with storage already set; resetModules
    // simulates exactly that fresh import. (Keep this test last: after it, the
    // static imports above still point at the pre-reset instance.)
    vi.resetModules();
    const fresh = await import("./ignoredFilesPref");
    expect(fresh.getHideIgnoredFiles()).toBe("on");
  });
});
