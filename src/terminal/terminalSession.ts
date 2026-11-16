import { api } from "../api";
import type { TerminalEvent } from "../types";

export interface TerminalSurface {
  cols: number;
  rows: number;
  write: (data: string) => void;
  onData: (listener: (data: string) => void) => { dispose: () => void };
  onResize: (listener: (size: { cols: number; rows: number }) => void) => { dispose: () => void };
}

const ignore = () => {};

export function exitBanner(code: number | null): string {
  const status = code === null ? "" : ` with code ${code}`;
  return `\r\n\x1b[2m[process exited${status}]\x1b[0m\r\n`;
}

export function errorBanner(error: unknown): string {
  return `\x1b[31m${String(error)}\x1b[0m\r\n`;
}

export function connectSession(
  term: TerminalSurface,
  cwd: string,
  shell: string,
  onExit: (code: number | null) => void,
): { dispose: () => void } {
  let id: number | null = null;
  let disposed = false;
  const queued: string[] = [];

  const onEvent = (event: TerminalEvent) => {
    if (disposed) {
      return;
    }
    if (event.kind === "data") {
      term.write(event.data);
      return;
    }
    term.write(exitBanner(event.code));
    onExit(event.code);
  };

  api
    .terminalOpen(cwd, shell, term.cols, term.rows, onEvent)
    .then((opened) => {
      if (disposed) {
        void api.terminalClose(opened).catch(ignore);
        return;
      }
      id = opened;
      for (const data of queued.splice(0)) {
        void api.terminalWrite(opened, data).catch(ignore);
      }
      void api.terminalResize(opened, term.cols, term.rows).catch(ignore);
    })
    .catch((error) => {
      if (disposed) {
        return;
      }
      term.write(errorBanner(error));
      onExit(null);
    });

  const input = term.onData((data) => {
    if (id === null) {
      queued.push(data);
      return;
    }
    void api.terminalWrite(id, data).catch(ignore);
  });
  const resize = term.onResize(({ cols, rows }) => {
    if (id !== null) {
      void api.terminalResize(id, cols, rows).catch(ignore);
    }
  });

  return {
    dispose() {
      disposed = true;
      input.dispose();
      resize.dispose();
      if (id !== null) {
        void api.terminalClose(id).catch(ignore);
      }
    },
  };
}
