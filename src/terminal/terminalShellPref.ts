import { useSyncExternalStore } from "react";

const STORAGE_KEY = "delta.terminalShell";

function readPref(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

let pref = typeof window !== "undefined" ? readPref() : "";
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((l) => l());

export function getTerminalShell(): string {
  return pref;
}

export function setTerminalShell(next: string): void {
  if (next === pref) {
    return;
  }
  pref = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  publish();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) {
      return;
    }
    pref = e.newValue ?? "";
    publish();
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useTerminalShell(): [string, (next: string) => void] {
  return [useSyncExternalStore(subscribe, getTerminalShell, () => ""), setTerminalShell];
}
