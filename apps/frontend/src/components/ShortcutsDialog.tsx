import { useEffect, useRef, type JSX } from "react";
import { KEYBOARD_SHORTCUTS } from "../keyboard-shortcuts";

export function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--overlay)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="w-full max-w-md border border-[var(--border-1)] bg-[var(--card)] p-6 shadow-[var(--sh-overlay)]"
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 id="shortcuts-title" className="text-base text-[var(--fg)]">
            Keyboard shortcuts
          </h3>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="px-2 py-1 font-mono text-sm text-[var(--muted-foreground-2)] hover:text-[var(--fg)]"
          >
            Esc
          </button>
        </div>
        <ul className="flex flex-col gap-2.5 text-xs">
          {KEYBOARD_SHORTCUTS.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] py-1.5"
            >
              <span className="text-[var(--muted-foreground-2)]">{row.label}</span>
              <kbd className="border border-[var(--border-1)] bg-[var(--panel)] px-2 py-0.5 font-mono text-[var(--fg)]">
                {row.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <div className="mt-5 text-right">
          <button
            type="button"
            className="border border-[var(--border-1)] bg-[var(--card)] px-4 py-1.5 text-xs font-medium text-[var(--fg)] hover:bg-[var(--secondary)]"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
