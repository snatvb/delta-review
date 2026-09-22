import { useEffect } from "react";
import { createPortal } from "react-dom";

// The three-way sibling of ConfirmDialog/NoticeDialog: Back (return to
// editing) / Discard (close without saving) / Save (write then close).
// Same centered-card chrome as the other dialogs; stacks above them (z-60)
// since it's raised from inside the full-file editor overlay.
export function SaveDiscardDialog({
  open,
  title,
  message,
  onSave,
  onDiscard,
  onBack,
}: {
  open: boolean;
  title: string;
  message?: string;
  onSave: () => void;
  onDiscard: () => void;
  onBack: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onBack();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onSave, onBack]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4 duration-100 data-[open]:animate-in data-[open]:fade-in-0"
      data-open
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onBack();
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-96 max-w-[92vw] rounded-xl border border-border bg-popover p-5 shadow-2xl ring-1 ring-foreground/5 duration-150 data-[open]:animate-in data-[open]:fade-in-0 data-[open]:zoom-in-95 dark:ring-foreground/10"
        data-open
      >
        <h2 className="font-heading text-[15px] font-semibold leading-snug text-foreground">{title}</h2>
        {message && <p className="mt-1.5 text-[13px] leading-normal text-muted-foreground">{message}</p>}
        <div className="mt-5 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="h-8 min-w-[4.5rem] rounded-lg border border-border bg-card px-3.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Back
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="h-8 min-w-[4.5rem] rounded-lg bg-destructive px-3.5 text-[13px] font-medium text-white shadow-sm transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          >
            Discard
          </button>
          <button
            type="button"
            autoFocus
            onClick={onSave}
            className="h-8 min-w-[4.5rem] rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground shadow-sm transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
