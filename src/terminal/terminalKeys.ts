import { isMac } from "../lib/platform";

export interface SelectionSource {
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: () => void;
}

export function isTerminalToggle(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && (e.code === "Backquote" || e.key === "`");
}

function keepFromApp(e: KeyboardEvent): false {
  e.stopPropagation();
  return false;
}

export function routeTerminalKey(e: KeyboardEvent, selection: SelectionSource, mac = isMac): boolean {
  if (isTerminalToggle(e)) {
    return false;
  }
  if (mac || e.type !== "keydown" || !e.ctrlKey || e.altKey || e.metaKey) {
    return true;
  }
  const key = e.key.toLowerCase();
  const copies = key === "c" && (e.shiftKey || selection.hasSelection());
  if (copies) {
    e.preventDefault();
    const text = selection.getSelection();
    if (text) {
      void navigator.clipboard?.writeText(text).catch(() => {});
    }
    selection.clearSelection();
    return keepFromApp(e);
  }
  if (key === "v") {
    return keepFromApp(e);
  }
  return true;
}
