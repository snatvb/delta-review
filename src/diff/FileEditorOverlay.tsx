import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SaveDiscardDialog } from "@/components/ui/save-discard-dialog";
import { api } from "../api";
import type { Target } from "../types";
import { useCodeFont, rowHeightFor } from "../codeFont";
import { offsetForLine, isStaleWriteError } from "./fileEditor";
import { codeMirrorLanguageFor } from "./codeMirrorLang";
import { loadCodeMirror } from "./loadCodeMirror";

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready" };

export function FileEditorOverlay({
  target,
  path,
  initialLine,
  onClose,
  onSaved,
}: {
  target: Target;
  path: string;
  initialLine: number | null;
  onClose: () => void;
  onSaved: (path: string) => void;
}) {
  const { size: codeSize } = useCodeFont();
  const rowH = rowHeightFor(codeSize);

  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  const hashRef = useRef<string | null>(null);
  const originalRef = useRef<string>("");
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorViewType | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.readFileText(target, path).then(
      (result) => {
        if (cancelled) return;
        originalRef.current = result.content;
        hashRef.current = result.hash;
        setLoadState({ kind: "ready" });
      },
      (e: unknown) => {
        if (cancelled) return;
        setLoadState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loadState.kind !== "ready") return;
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let view: EditorViewType | null = null;
    void (async () => {
      const { EditorState, EditorView, basicSetup, codeMirrorAppTheme, languageExtensions } = await loadCodeMirror(codeMirrorLanguageFor(path));
      if (cancelled) return;
      const state = EditorState.create({
        doc: originalRef.current,
        extensions: [
          basicSetup,
          ...languageExtensions,
          ...codeMirrorAppTheme(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) setDirty(true);
          }),
        ],
      });
      view = new EditorView({ state, parent: host });
      viewRef.current = view;
      if (initialLine != null) {
        const offset = offsetForLine(originalRef.current, initialLine);
        view.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: "center" }) });
      }
      view.focus();
    })();
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
  }, [loadState.kind, path, initialLine]);

  const trySave = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view || hashRef.current == null || saving) return false;
    const content = view.state.doc.toString();
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.writeFileText(target, path, hashRef.current, content);
      hashRef.current = result.hash;
      originalRef.current = result.content;
      setDirty(false);
      setSaving(false);
      onSaved(path);
      return true;
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
      return false;
    }
  }, [target, path, onSaved, saving]);

  const requestClose = useCallback(() => {
    if (dirty) setConfirmClose(true);
    else onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (confirmClose) return;
      if ((e.key === "s" || e.key === "S") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void trySave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        requestClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose, trySave, requestClose]);

  const confirmSave = useCallback(() => {
    setConfirmClose(false);
    void trySave().then((ok) => {
      if (ok) onClose();
    });
  }, [trySave, onClose]);
  const confirmDiscard = useCallback(() => {
    setConfirmClose(false);
    onClose();
  }, [onClose]);
  const confirmBack = useCallback(() => setConfirmClose(false), []);

  const reloadLatest = useCallback(() => {
    setSaveError(null);
    setLoadState({ kind: "loading" });
    setDirty(false);
    void api.readFileText(target, path).then(
      (result) => {
        originalRef.current = result.content;
        hashRef.current = result.hash;
        setLoadState({ kind: "ready" });
      },
      (e: unknown) => setLoadState({ kind: "error", message: e instanceof Error ? e.message : String(e) }),
    );
  }, [target, path]);

  const base = path.slice(path.lastIndexOf("/") + 1);
  const dir = path.slice(0, path.length - base.length);

  return createPortal(
    <>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${path}`}
        className="fixed inset-0 z-50 flex flex-col bg-background"
      >
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
          <button
            type="button"
            onClick={requestClose}
            aria-label="Back to the diff"
            title="Back to the diff (Esc)"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background pl-1.5 pr-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <ArrowLeft className="size-4" /> Back
            <Kbd keys="esc" className="border-border/60 bg-muted/50" />
          </button>
          <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
            {dir && <span className="text-muted-foreground">{dir}</span>}
            <span className="font-medium text-foreground">{base}</span>
            {dirty && <span aria-label="unsaved changes" title="Unsaved changes" className="ml-2 inline-block size-1.5 rounded-full bg-primary align-middle" />}
          </span>
          {saveError && (
            <div className="delta-comment-ui flex max-w-md items-center gap-2 truncate rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[12px] text-destructive" title={saveError}>
              <span className="truncate">{saveError}</span>
              {isStaleWriteError(saveError) && (
                <button type="button" onClick={reloadLatest} className="shrink-0 whitespace-nowrap underline underline-offset-2 hover:no-underline">
                  Reload latest
                </button>
              )}
            </div>
          )}
          <Button size="sm" onClick={() => void trySave()} disabled={saving || !dirty} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {saving ? "Saving…" : "Save"}
            <Kbd keys="⌘S" className="border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground/90" />
          </Button>
        </header>
        <div className="min-h-0 flex-1" style={{ "--code-fs": `${codeSize}px`, "--code-lh": `${rowH}px`, "--gutter-fs": `${Math.max(9, codeSize - 2)}px` } as CSSProperties}>
          {loadState.kind === "loading" && (
            <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {loadState.kind === "error" && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-[13px] text-muted-foreground">
              <span>Couldn’t open this file — {loadState.message}</span>
              <Button size="sm" variant="outline" onClick={onClose}>Back to the diff</Button>
            </div>
          )}
          {loadState.kind === "ready" && <div ref={hostRef} className="h-full overflow-auto" />}
        </div>
      </div>
      <SaveDiscardDialog
        open={confirmClose}
        title="Unsaved changes"
        message={`${base} has unsaved changes. Save them before closing?`}
        onSave={confirmSave}
        onDiscard={confirmDiscard}
        onBack={confirmBack}
      />
    </>,
    document.body,
  );
}
