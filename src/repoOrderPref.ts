import { useSyncExternalStore } from "react";

const STORAGE_KEY = "delta.repoOrder";
const NONE: readonly string[] = [];

function readPref(): readonly string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) {
      return NONE;
    }
    return [...new Set(stored.filter((id): id is string => typeof id === "string"))];
  } catch {
    return NONE;
  }
}

function writePref(order: readonly string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    return;
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, at) => id === b[at]);
}

let pref: readonly string[] = typeof window !== "undefined" ? readPref() : NONE;
const listeners = new Set<() => void>();

export function getRepoOrder(): readonly string[] {
  return pref;
}

export function setRepoOrder(next: readonly string[]): void {
  if (sameOrder(pref, next)) {
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

export function useRepoOrder(): [readonly string[], typeof setRepoOrder] {
  return [useSyncExternalStore(subscribe, getRepoOrder, () => NONE), setRepoOrder];
}
