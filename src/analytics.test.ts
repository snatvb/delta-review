import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  TELEMETRY_DORMANT,
  getTelemetryPref,
  setTelemetryPref,
  shouldTrack,
  track,
  __setEnvAllowedForTest,
} from "./analytics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const TAURI = "__TAURI_INTERNALS__";

beforeEach(() => {
  localStorage.clear();
  __setEnvAllowedForTest(false);
  vi.mocked(invoke).mockClear();
  delete (window as unknown as Record<string, unknown>)[TAURI];
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[TAURI];
});

describe("telemetry preference", () => {
  it("defaults to on", () => {
    expect(getTelemetryPref()).toBe("on");
  });

  it("persists a change to localStorage", () => {
    setTelemetryPref("off");
    expect(getTelemetryPref()).toBe("off");
    expect(localStorage.getItem("delta.telemetry")).toBe("off");
  });
});

describe("shouldTrack gate", () => {
  it("is false when not in a Tauri webview", () => {
    __setEnvAllowedForTest(true);
    setTelemetryPref("on");
    // no __TAURI_INTERNALS__ on window
    expect(shouldTrack()).toBe(false);
  });

  // SLEEPING TELEMETRY: the fork ships analytics disabled — the gate stays
  // closed even when webview, build/env, and the user pref would all allow it.
  // If this fails, TELEMETRY_DORMANT was flipped — revisit the revival
  // checklist in src/analytics.ts before updating these expectations.
  it("stays closed while telemetry is dormant", () => {
    expect(TELEMETRY_DORMANT).toBe(true);
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    __setEnvAllowedForTest(true);
    setTelemetryPref("on");
    expect(shouldTrack()).toBe(false);
  });

  it("is false when the user turned it off", () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    __setEnvAllowedForTest(true);
    setTelemetryPref("off");
    expect(shouldTrack()).toBe(false);
  });

  it("is false when build/env disallows", () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    __setEnvAllowedForTest(false);
    setTelemetryPref("on");
    expect(shouldTrack()).toBe(false);
  });
});

describe("track while dormant", () => {
  it("never invokes the Aptabase plugin IPC", () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    __setEnvAllowedForTest(true);
    setTelemetryPref("on");
    expect(() => track("app_started")).not.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
});
