import { useSyncExternalStore } from "react";

export type OnOff = "on" | "off";

const isOnOff = (v: unknown): v is OnOff => v === "on" || v === "off";

export interface OnOffPref {
  get: () => OnOff;
  set: (next: OnOff) => void;
  usePref: () => [OnOff, (next: OnOff) => void];
}

// A localStorage-backed on/off preference shared by every consumer; the
// `storage` event syncs a change made in one window to the others.
export function createOnOffPref(storageKey: string, fallback: OnOff): OnOffPref {
  const read = (): OnOff => {
    try {
      const v = localStorage.getItem(storageKey);
      if (isOnOff(v)) {
        return v;
      }
    } catch {
      /* ignore */
    }
    return fallback;
  };

  let pref: OnOff = typeof window !== "undefined" ? read() : fallback;
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((l) => l());

  const get = () => pref;
  const set = (next: OnOff) => {
    if (next === pref) {
      return;
    }
    pref = next;
    try {
      localStorage.setItem(storageKey, next);
    } catch {
      /* ignore */
    }
    publish();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key !== storageKey) {
        return;
      }
      pref = isOnOff(e.newValue) ? e.newValue : fallback;
      publish();
    });
  }

  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };

  const usePref = (): [OnOff, (next: OnOff) => void] => [useSyncExternalStore(subscribe, get, () => fallback), set];

  return { get, set, usePref };
}
