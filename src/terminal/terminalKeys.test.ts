import { describe, expect, it, vi } from "vitest";
import { isTerminalToggle, routeTerminalKey, type SelectionSource } from "./terminalKeys";

function key(init: KeyboardEventInit & { type?: string }) {
  return new KeyboardEvent(init.type ?? "keydown", { bubbles: true, cancelable: true, ...init });
}

function selection(text: string): SelectionSource & { cleared: boolean } {
  const s = {
    cleared: false,
    hasSelection: () => text.length > 0,
    getSelection: () => text,
    clearSelection: () => { s.cleared = true; },
  };
  return s;
}

describe("isTerminalToggle", () => {
  it("matches ctrl+backquote only", () => {
    expect(isTerminalToggle(key({ key: "`", code: "Backquote", ctrlKey: true }))).toBe(true);
    expect(isTerminalToggle(key({ key: "ё", code: "Backquote", ctrlKey: true }))).toBe(true);
    expect(isTerminalToggle(key({ key: "`", code: "Backquote" }))).toBe(false);
    expect(isTerminalToggle(key({ key: "`", code: "Backquote", ctrlKey: true, metaKey: true }))).toBe(false);
  });
});

describe("routeTerminalKey", () => {
  it("lets the toggle bubble to the app instead of the shell", () => {
    expect(routeTerminalKey(key({ key: "`", code: "Backquote", ctrlKey: true }), selection(""), false)).toBe(false);
  });

  it("sends ctrl+c to the shell when nothing is selected", () => {
    expect(routeTerminalKey(key({ key: "c", ctrlKey: true }), selection(""), false)).toBe(true);
  });

  it("copies the selection on ctrl+c and keeps it from the app", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const sel = selection("hello");
    const event = key({ key: "c", ctrlKey: true });
    const stop = vi.spyOn(event, "stopPropagation");
    expect(routeTerminalKey(event, sel, false)).toBe(false);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(sel.cleared).toBe(true);
    expect(stop).toHaveBeenCalled();
  });

  it("ctrl+shift+c copies even when the app would treat it as copy-for-agents", () => {
    const event = key({ key: "C", ctrlKey: true, shiftKey: true });
    const stop = vi.spyOn(event, "stopPropagation");
    expect(routeTerminalKey(event, selection(""), false)).toBe(false);
    expect(stop).toHaveBeenCalled();
  });

  it("leaves ctrl+v to the browser paste", () => {
    expect(routeTerminalKey(key({ key: "v", ctrlKey: true }), selection(""), false)).toBe(false);
  });

  it("passes everything through on macOS, where cmd handles copy/paste", () => {
    expect(routeTerminalKey(key({ key: "c", ctrlKey: true }), selection("x"), true)).toBe(true);
    expect(routeTerminalKey(key({ key: "v", ctrlKey: true }), selection(""), true)).toBe(true);
  });

  it("passes ordinary keys to the shell", () => {
    expect(routeTerminalKey(key({ key: "r", ctrlKey: true }), selection(""), false)).toBe(true);
    expect(routeTerminalKey(key({ key: "a" }), selection(""), false)).toBe(true);
  });
});
