// Picker data with revalidate-on-focus. Seeds from the shared cache for an instant
// paint, fetches once on mount, then refetches whenever the window regains focus (or
// becomes visible again) AND whenever the backend reports the registry changed (a
// repo imported, a review opened/saved/deleted). The backend enumerates worktrees
// live on every list_picker call, but a long-lived picker — the Home launcher, or a
// re-shown webview — only ever asked once, so worktrees created after it mounted
// never appeared. Focus covers "I came back to the window"; the registry event
// covers "something changed while I was looking" — including on Windows, where
// WebView2 doesn't reliably emit DOM focus on native window activation, which is
// why focus alone left a running app's list stale until restart. (#refresh)
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { loadPicker, peekPickerCache } from "./pickerData";
import type { PickerData } from "../types";

export function usePickerData(): PickerData | null {
  const [data, setData] = useState<PickerData | null>(() => peekPickerCache());
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const revalidate = () => {
      // Foregrounding fires focus AND visibilitychange together — coalesce into one fetch.
      if (inFlight) return;
      inFlight = true;
      void loadPicker()
        .then((d) => !cancelled && setData(d))
        // Never hang on the "Loading…" state if the first fetch errors with no cache.
        .catch(() => !cancelled && setData((d) => d ?? { worktrees: [] }))
        .finally(() => (inFlight = false));
    };
    revalidate();
    const onFocus = () => revalidate();
    const onVisible = () => document.visibilityState === "visible" && revalidate();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    // Backend-driven freshness: the registry changed under us (import, open,
    // delete) — refetch now rather than waiting for the next focus.
    let unlisten: (() => void) | undefined;
    if (!import.meta.env.VITE_MOCK_IPC) {
      void (async () => {
        try {
          const un = await listen("registry:changed", () => revalidate());
          if (cancelled) un();
          else unlisten = un;
        } catch {
          /* not running under Tauri */
        }
      })();
    }
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      unlisten?.();
    };
  }, []);
  return data;
}
