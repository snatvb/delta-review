import { useSyncExternalStore } from "react";

export type RepoSort = "manual" | "recent" | "name";

export const REPO_SORTS: { value: RepoSort; label: string; shortLabel: string }[] = [
  { value: "manual", label: "Manual", shortLabel: "Manual" },
  { value: "recent", label: "Recent activity", shortLabel: "Recent" },
  { value: "name", label: "Name", shortLabel: "Name" },
];

const STORAGE_KEY = "delta.repoSort";
const DEFAULT: RepoSort = "manual";
const isSort = (v: unknown): v is RepoSort => REPO_SORTS.some((item) => item.value === v);

function readPref(): RepoSort {
  try {
    const stored: unknown = localStorage.getItem(STORAGE_KEY);
    return isSort(stored) ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function writePref(value: RepoSort): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    return;
  }
}

let pref: RepoSort = typeof window !== "undefined" ? readPref() : DEFAULT;
const listeners = new Set<() => void>();

export function getRepoSort(): RepoSort {
  return pref;
}

export function setRepoSort(next: RepoSort): void {
  if (next === pref) {
    return;
  }
  pref = next;
  writePref(next);
  listeners.forEach((listener) => listener());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) {
      return;
    }
    pref = readPref();
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener: () => void): () => boolean {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRepoSort(): [RepoSort, typeof setRepoSort] {
  return [useSyncExternalStore(subscribe, getRepoSort, () => DEFAULT), setRepoSort];
}
