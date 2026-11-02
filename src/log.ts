// src/log.ts
import { api } from "./api";

// Frontend → persistent app log (src-tauri/src/applog.rs), mirrored to the
// console. Fire-and-forget and never throws: logging must not be the thing that
// breaks a load path (and the IPC may be absent in tests / mock mode).
export function logClient(level: "info" | "warn" | "error", message: string): void {
  (level === "error" ? console.error : level === "warn" ? console.warn : console.info)(message);
  try {
    void api.logClient(level, message).catch(() => {});
  } catch {
    // api.logClient unavailable (test mock) — the console line above is enough.
  }
}
