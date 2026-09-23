// src/diff/useBinaryFile.ts
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import type { BinaryFileDiff, Target } from "../types";
import type { FileDiffStore } from "./useFileDiffCache";

// Binary card data (#binary), fetched from get_binary_file_diff: exact sizes per
// side. Image bytes load separately via `api.binaryBlobUrl`, keyed by `rev`.
//
// Module-level cache keyed by target identity + path, so a card re-mounting on
// scroll doesn't refetch its sizes or bust its image URL. Entries are dropped by the same per-path
// invalidation that drops the text-diff store (Refresh / fs-change auto-refresh):
// the hook subscribes to the store's per-path notifications, deletes its entry,
// and wakes its own subscribers so the load effect refetches.
export type BinaryCard = BinaryFileDiff & { rev: number };

const cache = new Map<string, BinaryCard>();
let revSeq = Date.now();
const inflight = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

const keyOf = (t: Target, path: string) =>
  `${t.repoPath}|${t.worktree ?? ""}|${t.mode}|${t.base ?? ""}|${t.commit ?? ""}|${path}`;

const notify = (key: string) => listeners.get(key)?.forEach((cb) => cb());

function load(target: Target, path: string, key: string) {
  if (cache.has(key) || inflight.has(key)) return;
  inflight.add(key);
  api
    .getBinaryFileDiff(target, path)
    .then((bd) => {
      cache.set(key, { ...bd, rev: ++revSeq });
      notify(key);
    })
    .catch((e) => console.error("binary file diff:", e))
    .finally(() => inflight.delete(key));
}

/** Test hook: drop every cached entry (and wake subscribers). */
export function resetBinaryFileCache(): void {
  cache.clear();
  inflight.clear();
  listeners.forEach((set) => set.forEach((cb) => cb()));
}

/**
 * One binary file's sizes, loaded once the card asks for it
 * (`want` — on screen), cached, and invalidated with the text diff.
 */
export function useBinaryFile(target: Target, store: FileDiffStore, path: string, want: boolean): BinaryCard | undefined {
  const key = keyOf(target, path);
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      const off = store.subscribe(path, () => {
        cache.delete(key);
        notify(key);
      });
      return () => {
        set?.delete(cb);
        off();
      };
    },
    [key, store, path],
  );
  const entry = useSyncExternalStore(subscribe, () => cache.get(key));
  useEffect(() => {
    if (want && !entry) load(target, path, key);
  }, [want, entry, target, path, key]);
  return entry;
}
