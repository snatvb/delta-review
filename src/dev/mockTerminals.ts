import type { TerminalEvent } from "../types";

export type MockTerminalSink = (event: TerminalEvent) => void;

const ENTER = "\r";
const BACKSPACE = "\x7f";
const NEWLINE = "\r\n";
const PROMPT = "$ ";

export class MockTerminals {
  private nextId = 1;
  private sessions = new Map<number, { sink: MockTerminalSink; line: string }>();

  open(cwd: string, sink: MockTerminalSink): number {
    const id = this.nextId++;
    this.sessions.set(id, { sink, line: "" });
    sink({ kind: "data", data: `mock shell in ${cwd}${NEWLINE}${PROMPT}` });
    return id;
  }

  write(id: number, data: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error("terminal: session is gone");
    }
    for (const ch of data) {
      if (ch === ENTER) {
        const line = session.line;
        session.line = "";
        if (line.trim() === "exit") {
          this.sessions.delete(id);
          session.sink({ kind: "data", data: NEWLINE });
          session.sink({ kind: "exit", code: 0 });
          return;
        }
        const echoed = line ? `${line}${NEWLINE}` : "";
        session.sink({ kind: "data", data: `${NEWLINE}${echoed}${PROMPT}` });
      } else if (ch === BACKSPACE) {
        if (session.line) {
          session.line = session.line.slice(0, -1);
          session.sink({ kind: "data", data: "\b \b" });
        }
      } else {
        session.line += ch;
        session.sink({ kind: "data", data: ch });
      }
    }
  }

  close(id: number): void {
    this.sessions.delete(id);
  }
}
