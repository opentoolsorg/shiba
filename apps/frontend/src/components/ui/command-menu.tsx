import { Command } from "cmdk";
import type { JSX, ReactNode } from "react";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// cmdk has no Dialog wrapper; this is the app-level command dialog surface.
function CommandDialog({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] p-4">
      <button
        type="button"
        aria-label="Close command menu"
        className="absolute inset-0 bg-[var(--warning)]lack/60"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        className="relative bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-md w-full shadow-[var(--sh-overlay)] overflow-hidden"
      >
        {children}
      </div>
    </div>
  );
}

export function CommandMenu({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
}): JSX.Element | null {
  return (
    <CommandDialog open={open} onClose={onClose}>
      <Command label="Command menu">
        <Command.Input
          autoFocus
          placeholder="Type a command or search…"
          className="w-full bg-transparent px-4 py-3 text-sm text-[var(--fg)] placeholder:text-[var(--muted-foreground-2)] border-b border-[var(--border-1)] focus:outline-none"
        />
        <Command.List className="max-h-72 overflow-y-auto py-1.5">
          <Command.Empty className="px-4 py-6 text-[var(--success)]enter text-xs text-[var(--muted-foreground-2)]">
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
              className="w-full flex items-center justify-between px-4 py-2 text-left text-sm text-[var(--muted-foreground-2)] cursor-pointer data-[selected=true]:bg-[var(--primary-soft)] data-[selected=true]:text-[var(--fg)]"
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
