import { beforeEach, describe, expect, it, vi } from "vitest";
import { getHideTestFiles, setHideTestFiles } from "./hideTestFilesPref";

describe("hideTestFilesPref", () => {
  beforeEach(() => {
    localStorage.clear();
    setHideTestFiles("off");
  });

  it("defaults to off", () => {
    expect(getHideTestFiles()).toBe("off");
  });

  it("persists the choice", () => {
    setHideTestFiles("on");
    expect(localStorage.getItem("delta.hideTestFiles")).toBe("on");
  });

  it("keeps the choice after a reload", async () => {
    localStorage.setItem("delta.hideTestFiles", "on");
    vi.resetModules();
    const fresh = await import("./hideTestFilesPref");
    expect(fresh.getHideTestFiles()).toBe("on");
  });
});
