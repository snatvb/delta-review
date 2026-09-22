import { describe, it, expect, vi } from "vitest";

const openTargetIpc = vi.fn();
vi.mock("../api", () => ({ api: { openTarget: (...a: unknown[]) => openTargetIpc(...a) } }));

import { openTarget } from "./openTarget";
import { onNotice, type Notice } from "./notify";

describe("openTarget", () => {
  it("passes the target through to the backend", async () => {
    openTargetIpc.mockImplementation(() => Promise.resolve());
    const seen: Notice[] = [];
    const off = onNotice((n) => seen.push(n));

    await openTarget("/r/demo", "uncommitted");
    off();

    expect(openTargetIpc).toHaveBeenCalledWith("/r/demo", "uncommitted", undefined);
    expect(seen).toEqual([]);
  });

  it("surfaces a failure as a notice instead of failing silently", async () => {
    openTargetIpc.mockImplementation(() => Promise.reject(new Error("open repo: failed to resolve path 'D:/gone'")));
    const seen: Notice[] = [];
    const off = onNotice((n) => seen.push(n));

    await openTarget("D:/gone", "uncommitted");
    off();

    expect(seen).toHaveLength(1);
    expect(seen[0].message).toContain("D:/gone");
  });
});
