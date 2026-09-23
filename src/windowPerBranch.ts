import { useSyncExternalStore } from "react";
import { api } from "./api";

// Persisted by the backend, not localStorage: it routes window opens that start
// before any webview exists (CLI launches).
const DEFAULT = true;

let pref = DEFAULT;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  pref = next;
  listeners.forEach((l) => l());
}

export function reloadWindowPerBranch(): void {
  void api.getSettings().then((s) => publish(s.windowPerBranch), () => {});
}

export function setWindowPerBranch(next: boolean): void {
  if (next === pref) return;
  publish(next);
  void api.setSettings({ windowPerBranch: next }).catch(() => {});
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useWindowPerBranch(): [boolean, (v: boolean) => void] {
  const v = useSyncExternalStore(subscribe, () => pref, () => DEFAULT);
  return [v, setWindowPerBranch];
}
