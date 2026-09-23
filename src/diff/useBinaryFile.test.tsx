// The binary card's data hook (#binary): loads once wanted, caches across
// unmount/remount (scroll virtualization must not refetch bytes), and drops +
// refetches when the text-diff store invalidates the path (Refresh/auto-refresh).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const getBinaryFileDiff = vi.fn();
vi.mock("../api", () => ({
  api: { getBinaryFileDiff: (...a: unknown[]) => getBinaryFileDiff(...a) },
  __setInvokeForDev: vi.fn(),
}));

import { useBinaryFile, resetBinaryFileCache } from "./useBinaryFile";
import type { FileDiffStore } from "./useFileDiffCache";
import type { BinaryFileDiff, Target } from "../types";

const target: Target = { repoPath: "/r", mode: "uncommitted" };
const bd: BinaryFileDiff = { oldSize: 1, newSize: 2 };

// Minimal stand-in with observable per-path notifications, like the real store.
function makeStore(): FileDiffStore {
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: () => undefined,
    load: () => Promise.resolve(),
    subscribe: (p, cb) => {
      let s = listeners.get(p);
      if (!s) listeners.set(p, (s = new Set()));
      s.add(cb);
      return () => void s!.delete(cb);
    },
    clear: () => {},
    invalidate: (paths) => {
      for (const p of paths) listeners.get(p)?.forEach((cb) => cb());
    },
    refreshAll: () => {
      for (const s of listeners.values()) for (const cb of s) cb();
    },
  };
}

describe("useBinaryFile", () => {
  beforeEach(() => {
    getBinaryFileDiff.mockReset();
    getBinaryFileDiff.mockResolvedValue(bd);
    resetBinaryFileCache();
  });

  it("loads only when wanted", async () => {
    const store = makeStore();
    const { result, rerender } = renderHook(({ want }: { want: boolean }) => useBinaryFile(target, store, "logo.png", want), {
      initialProps: { want: false },
    });
    expect(getBinaryFileDiff).not.toHaveBeenCalled();
    expect(result.current).toBeUndefined();

    rerender({ want: true });
    await waitFor(() => expect(getBinaryFileDiff).toHaveBeenCalledWith(target, "logo.png"));
    await waitFor(() => expect(result.current).toMatchObject(bd));
  });

  it("serves a remount from cache instead of refetching", async () => {
    const store = makeStore();
    const first = renderHook(() => useBinaryFile(target, store, "logo.png", true));
    await waitFor(() => expect(first.result.current).toMatchObject(bd));
    const firstRev = first.result.current!.rev;
    first.unmount();

    const second = renderHook(() => useBinaryFile(target, store, "logo.png", true));
    await waitFor(() => expect(second.result.current?.rev).toBe(firstRev));
    expect(getBinaryFileDiff).toHaveBeenCalledTimes(1);
  });

  it("drops and refetches when the diff store invalidates the path", async () => {
    const store = makeStore();
    const { result } = renderHook(() => useBinaryFile(target, store, "logo.png", true));
    await waitFor(() => expect(result.current).toMatchObject(bd));
    const firstRev = result.current!.rev;

    act(() => store.invalidate(["logo.png"]));
    expect(result.current).toBeUndefined(); // dropped with the text diff
    await waitFor(() => expect(getBinaryFileDiff).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current?.rev).toBeGreaterThan(firstRev)); // new rev busts the cached image URL
  });
});
