import { type ReactNode, useEffect, useRef } from "react";
import type { ApiError } from "../api";
import { useT } from "../i18n";

export function ErrorNote({ error }: { error: ApiError | Error | undefined | null }) {
  if (!error) return null;
  const hints = "body" in error ? error.body.hints : [];
  return (
    <div className="note note-error" role="alert">
      <p>{error.message}</p>
      {hints.length > 0 && (
        <ul>
          {hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** A modal dialog built on <dialog>: focus is trapped and returned by the browser, Escape closes it. */
export function Dialog({
  title,
  open,
  onClose,
  children,
  actions,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="dialog-title" className="dialog">
      {open && (
        <>
          <header className="dialog-head">
            <h2 id="dialog-title">{title}</h2>
            <button type="button" className="button-quiet" onClick={onClose} aria-label={t("common.close")}>
              ✕
            </button>
          </header>
          <div className="dialog-body">{children}</div>
          {actions && <footer className="dialog-actions">{actions}</footer>}
        </>
      )}
    </dialog>
  );
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return <span className={`badge badge-${status}`}>{label}</span>;
}

export function timeAgo(at: number, locale: string): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return format.format(Math.round(seconds / 3600), "hour");
  return format.format(Math.round(seconds / 86400), "day");
}
