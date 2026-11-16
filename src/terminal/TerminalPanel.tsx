import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, RotateCw, SquareTerminal, Trash2 } from "lucide-react";
import { Hint } from "@/components/Hint";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { fontStack, getCodeFont, useCodeFont } from "../codeFont";
import { PaneResizer, TERMINAL_PANE, usePaneResize, useResizableWidth } from "../lib/resizablePane";
import { connectSession } from "./terminalSession";
import { routeTerminalKey } from "./terminalKeys";
import { terminalTheme } from "./terminalTheme";
import { getTerminalShell } from "./terminalShellPref";

const SCROLLBACK_LINES = 5000;
const HEADER_BUTTON =
  "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type DestructiveAction = "kill" | "restart";

const CONFIRMATIONS: Record<DestructiveAction, { title: string; message: string; confirmLabel: string }> = {
  kill: {
    title: "Kill terminal?",
    message: "The shell and everything running in it will be stopped. Its output is lost.",
    confirmLabel: "Kill",
  },
  restart: {
    title: "Restart terminal?",
    message: "The shell and everything running in it will be stopped and a fresh shell started. Its output is lost.",
    confirmLabel: "Restart",
  },
};

export interface TerminalPanelProps {
  cwd: string;
  visible: boolean;
  onHide: () => void;
  onClose: () => void;
}

export function TerminalPanel({ cwd, visible, onHide, onClose }: TerminalPanelProps) {
  const [height, setHeight] = useResizableWidth(TERMINAL_PANE);
  const { resizing, separatorProps } = usePaneResize(TERMINAL_PANE, height, setHeight, "top");
  const [generation, setGeneration] = useState(0);
  const [exited, setExited] = useState(false);
  const [pending, setPending] = useState<DestructiveAction | null>(null);

  const restart = () => {
    setExited(false);
    setGeneration((g) => g + 1);
  };
  const perform = (action: DestructiveAction) => {
    setPending(null);
    if (action === "kill") {
      onClose();
    } else {
      restart();
    }
  };
  const requestRestart = () => {
    if (exited) {
      restart();
    } else {
      setPending("restart");
    }
  };

  return (
    <section
      aria-label="Terminal"
      style={{ height }}
      className={`${visible ? "flex" : "hidden"} relative max-h-[75vh] shrink-0 flex-col border-t border-border bg-code`}
    >
      <PaneResizer edge="top" label="Resize terminal" resizing={resizing} separatorProps={separatorProps} />
      <header className="flex h-8 shrink-0 items-center gap-2 pl-3 pr-1.5 text-[12px] text-muted-foreground">
        <SquareTerminal className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-foreground">Terminal</span>
        <span className="min-w-0 truncate font-mono text-[11px]" title={cwd}>{cwd}</span>
        {exited && <span className="shrink-0">· exited</span>}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Hint tip="Restart terminal">
            <button type="button" aria-label="Restart terminal" className={HEADER_BUTTON} onClick={requestRestart}>
              <RotateCw className="size-3.5" />
            </button>
          </Hint>
          <Hint tip="Hide terminal" kbd="⌃`">
            <button type="button" aria-label="Hide terminal" className={HEADER_BUTTON} onClick={onHide}>
              <ChevronDown className="size-4" />
            </button>
          </Hint>
          <Hint tip="Kill terminal">
            <button type="button" aria-label="Kill terminal" className={`${HEADER_BUTTON} hover:text-destructive`} onClick={() => setPending("kill")}>
              <Trash2 className="size-3.5" />
            </button>
          </Hint>
        </div>
      </header>
      {pending && (
        <ConfirmDialog
          open
          {...CONFIRMATIONS[pending]}
          onConfirm={() => perform(pending)}
          onCancel={() => setPending(null)}
        />
      )}
      <XtermView key={generation} cwd={cwd} visible={visible} onExit={() => setExited(true)} />
    </section>
  );
}

function fitWhenShown(fit: FitAddon, host: HTMLElement) {
  if (host.clientWidth > 0 && host.clientHeight > 0) {
    fit.fit();
  }
}

function XtermView({ cwd, visible, onExit }: { cwd: string; visible: boolean; onExit: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const onExitRef = useRef(onExit);
  const font = useCodeFont();

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const initialFont = getCodeFont();
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: fontStack(initialFont.family),
      fontSize: initialFont.size,
      scrollback: SCROLLBACK_LINES,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fitWhenShown(fit, host);
    term.attachCustomKeyEventHandler((e) => routeTerminalKey(e, term));
    termRef.current = { term, fit };

    const session = connectSession(term, cwd, getTerminalShell(), () => onExitRef.current());
    const resizeObserver = new ResizeObserver(() => fitWhenShown(fit, host));
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      term.options.theme = terminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      themeObserver.disconnect();
      resizeObserver.disconnect();
      session.dispose();
      termRef.current = null;
      term.dispose();
    };
  }, [cwd]);

  useEffect(() => {
    const current = termRef.current;
    if (!current) {
      return;
    }
    current.term.options.fontFamily = fontStack(font.family);
    current.term.options.fontSize = font.size;
    if (hostRef.current) {
      fitWhenShown(current.fit, hostRef.current);
    }
  }, [font.family, font.size]);

  useEffect(() => {
    const current = termRef.current;
    if (!visible || !current || !hostRef.current) {
      return;
    }
    fitWhenShown(current.fit, hostRef.current);
    current.term.focus();
  }, [visible]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden pb-1 pl-3" />;
}
