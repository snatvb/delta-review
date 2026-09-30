import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "./api";

// ─── SLEEPING TELEMETRY (dormant) ────────────────────────────────────────────
// This fork disabled upstream's Aptabase analytics: NOTHING is collected or
// sent, and there is no Settings toggle or other user-facing surface. The whole
// pipeline (event taxonomy, the gate below, the preference store, the Rust
// plugin wiring in src-tauri) is intentionally kept in the tree so it can be
// revived later against an endpoint WE own. Upstream's key pathway is gone for
// good — the Rust side now only reads the fork-owned
// DELTA_REVIEW_TELEMETRY_KEY env var at build time (never APTABASE_KEY).
// To wake it up:
//   1. flip TELEMETRY_DORMANT to false (below);
//   2. build a release with DELTA_REVIEW_TELEMETRY_KEY set to an Aptabase app
//      key you own (self-hosted works too: an "SH"-region key plus the host
//      option in src-tauri/src/lib.rs);
//   3. restore the Settings toggle (see git history of SettingsDialog.tsx).
// Original design: docs/specs/2026-07-03-usage-analytics-design.md. (#analytics)
export const TELEMETRY_DORMANT = true;

// The fixed event taxonomy. Feature names + bucketed/numeric props only — never
// content (no repo names, paths, branches, diff or comment text). (#analytics)
export type EventName =
  | "app_started"
  | "review_opened"
  | "copy_for_agents"
  | "copy_comment_for_agents"
  | "comment_added"
  | "comment_resolved"
  | "diff_layout_changed"
  | "find_used"
  | "cli_installed"
  | "update_applied";

type Props = Record<string, string | number | boolean>;

// --- Are we in a real Tauri webview? (not dev:mock, not Vitest/happy-dom) ---
function isTauri(): boolean {
  return (
    !import.meta.env.VITE_MOCK_IPC &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

// --- Build/env permission, resolved once from the backend and cached. ---
let envAllowed = false;
let inited = false;

/** Resolve whether build+env permit telemetry. Idempotent; call once at startup.
 * No-op while telemetry is dormant (no point querying the backend). */
export async function initAnalytics(): Promise<void> {
  if (TELEMETRY_DORMANT || inited || !isTauri()) return;
  inited = true;
  try {
    envAllowed = await api.telemetryAllowed();
  } catch {
    envAllowed = false;
  }
}

/** Test seam: set the cached build/env permission directly. */
export function __setEnvAllowedForTest(v: boolean): void {
  envAllowed = v;
}

// --- User preference: localStorage-backed, cross-window synced (mirrors theme.ts). ---
export type TelemetryPref = "on" | "off";
const STORAGE_KEY = "delta.telemetry";

function readPref(): TelemetryPref {
  try {
    return localStorage.getItem(STORAGE_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

let pref: TelemetryPref = typeof window !== "undefined" ? readPref() : "on";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getTelemetryPref(): TelemetryPref {
  return pref;
}

export function setTelemetryPref(next: TelemetryPref): void {
  if (next === pref) return;
  pref = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  emit();
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    pref = e.newValue === "off" ? "off" : "on";
    emit();
  });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useTelemetryPref(): [TelemetryPref, (p: TelemetryPref) => void] {
  const p = useSyncExternalStore(subscribe, getTelemetryPref, () => "on" as TelemetryPref);
  return [p, setTelemetryPref];
}

// --- The one gate + the fire-and-forget tracker. ---
export function shouldTrack(): boolean {
  // SLEEPING TELEMETRY: the dormant flag short-circuits everything — the other
  // conditions (webview, build/env, user pref) are the revival-time checks.
  return !TELEMETRY_DORMANT && isTauri() && envAllowed && pref !== "off";
}

export function track(event: EventName, props?: Props): void {
  if (!shouldTrack()) return;
  try {
    // Aptabase's track_event props only accept string | number. Our public Props
    // type intentionally also allows boolean, for callers' convenience and
    // forward-compatibility, so stringify booleans here at the call boundary
    // before handing off to the plugin. (#analytics)
    const aptabaseProps = props
      ? Object.fromEntries(
          Object.entries(props).map(([k, v]) => [k, typeof v === "boolean" ? String(v) : v]),
        )
      : undefined;
    // Invoke the aptabase plugin command directly via the Tauri v2 IPC. The
    // `@aptabase/tauri` npm package is Tauri v1-only (its `invoke` posts to the
    // removed `window.__TAURI_IPC__` bridge), so under Tauri v2 every call
    // silently rejected and nothing ever reached the Rust plugin. The command
    // contract (`plugin:aptabase|track_event`, `{ name, props }`) is stable.
    void invoke("plugin:aptabase|track_event", { name: event, props: aptabaseProps }).catch(
      () => {
        /* analytics must never break the app */
      },
    );
  } catch {
    /* analytics must never break the app */
  }
}
