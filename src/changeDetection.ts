import { useSyncExternalStore } from "react";

// Whether a review window re-diffs in the background on file changes to offer the
// Refresh button. Off skips that re-diff entirely; manual refresh still works.
export type ChangeDetection = "on" | "off";

const STORAGE_KEY = "delta.changeDetection";
const DEFAULT: ChangeDetection = "on";
const isValue = (v: unknown): v is ChangeDetection => v === "on" || v === "off";

function readPref(): ChangeDetection {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isValue(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT;
}

let pref: ChangeDetection = typeof window !== "undefined" ? readPref() : DEFAULT;
const listeners = new Set<() => void>();

export function getChangeDetection(): ChangeDetection {
  return pref;
}

export function setChangeDetection(next: ChangeDetection): void {
  if (next === pref) return;
  pref = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    pref = isValue(e.newValue) ? e.newValue : DEFAULT;
    listeners.forEach((l) => l());
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useChangeDetection(): [ChangeDetection, (v: ChangeDetection) => void] {
  const v = useSyncExternalStore(subscribe, getChangeDetection, () => DEFAULT);
  return [v, setChangeDetection];
}
