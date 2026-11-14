import { Command } from "cmdk";
import { useEffect, useRef, type JSX, type ReactNode } from "react";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// A native modal keeps keyboard focus inside and makes the page behind it inert.
export function CommandDialog({
  open,
  onClose,
  children,
  wide = false,
  label = "Command menu",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  label?: string;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={dialogRef}
      aria-label={label}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-transparent p-4 pt-[15vh] text-[var(--fg)] backdrop:bg-[var(--overlay)]"
    >
      <div className="relative mx-auto bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-md w-full shadow-[var(--sh-overlay)] overflow-hidden" style={wide ? { maxWidth: "36rem" } : undefined}>
        {children}
        <button type="button" onClick={onClose} className="min-h-11 w-full border-t border-[var(--border-1)] px-4 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
          Close command menu
        </button>
      </div>
    </dialog>
  );
}

// TODO: wire "@bot in this thread" so an open room thread can insert @agent:<id> into its composer.
export function CommandMenu({
  open,
  onClose,
  commands,
  onQueryChange,
}: {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
  onQueryChange?: (query: string) => void;
}): JSX.Element | null {
  return (
    <CommandDialog open={open} onClose={onClose}>
      <Command label="Command menu" shouldFilter={onQueryChange === undefined}>
        <Command.Input
          placeholder="Type a command or search…"
          className="w-full bg-transparent px-4 py-3 text-base text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] border-b border-[var(--border-1)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--primary)]"
          onValueChange={onQueryChange}
        />
        <Command.List className="max-h-72 overflow-y-auto py-1.5">
          <Command.Empty className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">
            No matching commands.
          </Command.Empty>
          {commands.map((item) => (
            <Command.Item
              key={item.id}
              value={item.label}
              onSelect={() => {
                onClose();
                item.run();
              }}
              className="min-h-11 w-full flex items-center justify-between px-4 py-2 text-left text-sm text-[var(--muted-foreground-2)] cursor-pointer data-[selected=true]:bg-[var(--primary-soft)] data-[selected=true]:text-[var(--fg)]"
            >
              <span>{item.label}</span>
              {item.hint ? (
                <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">
                  {item.hint}
                </span>
              ) : null}
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </CommandDialog>
  );
}
