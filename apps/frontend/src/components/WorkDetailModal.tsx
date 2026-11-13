import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** Native modal semantics keep the board and app shortcuts inert while inspecting work. */
export function WorkDetailModal({
  children,
  label,
  onClose,
  compact = false,
}: {
  children: ReactNode;
  label: string;
  onClose(): void;
  compact?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previous = document.activeElement;
    const fallback = document.querySelector<HTMLElement>("[data-work-surface]");
    dialog.showModal();
    // Focus a harmless close control, never a mutating approval or archive action.
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="Close task"]');
    (close ?? dialog).focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else if (fallback?.isConnected) fallback.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label={label}
      aria-modal="true"
      tabIndex={-1}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-0 text-[var(--fg)] backdrop:bg-black/40 open:flex open:justify-end"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
      onKeyDown={(event) => {
        // Prevent app-level navigation shortcuts from firing behind the modal.
        event.stopPropagation();
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onCloseRef.current();
        }
        if (event.key !== "Tab") return;
        const elements = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ),
        ).filter(
          (element) =>
            !element.closest("[hidden], [inert]") && element.getAttribute("aria-hidden") !== "true",
        );
        const first = elements[0];
        const last = elements.at(-1);
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        className={`flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-[var(--border-1)] bg-[var(--card)] ${compact ? "max-w-[510px]" : "max-w-[48rem]"}`}
      >
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
