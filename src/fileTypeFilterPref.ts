import { useSyncExternalStore } from "react";
import { isTestFile } from "./files/isTestFile";

export type FileTypeFilter = "all" | "exclude-tests" | "only-tests";

export const FILE_TYPE_FILTERS: { value: FileTypeFilter; label: string; shortLabel: string }[] = [
  { value: "all", label: "All files", shortLabel: "All files" },
  { value: "exclude-tests", label: "Exclude tests", shortLabel: "No tests" },
  { value: "only-tests", label: "Only tests", shortLabel: "Only tests" },
];

const STORAGE_KEY = "delta.fileTypeFilter";
const LEGACY_KEY = "delta.hideTestFiles";
const isFilter = (v: unknown): v is FileTypeFilter => v === "all" || v === "exclude-tests" || v === "only-tests";

function readPref(): FileTypeFilter {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (isFilter(value)) {
      return value;
    }
    // Preserve the existing Hide tests choice until a three-way mode is saved.
    if (value === null && localStorage.getItem(LEGACY_KEY) === "on") {
      return "exclude-tests";
    }
  } catch {
    /* Storage may be unavailable; the in-memory preference still works. */
  }
  return "all";
}

let pref: FileTypeFilter = typeof window !== "undefined" ? readPref() : "all";
const listeners = new Set<() => void>();
const publish = () => listeners.forEach((listener) => listener());

export function getFileTypeFilter(): FileTypeFilter {
  return pref;
}

export function setFileTypeFilter(next: FileTypeFilter): void {
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
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY && event.key !== LEGACY_KEY) {
      return;
    }
    pref = readPref();
    publish();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useFileTypeFilter(): [FileTypeFilter, typeof setFileTypeFilter] {
  return [useSyncExternalStore(subscribe, getFileTypeFilter, () => "all"), setFileTypeFilter];
}

export function matchesFileType(path: string, filter: FileTypeFilter): boolean {
  return filter === "all" || isTestFile(path) === (filter === "only-tests");
}
