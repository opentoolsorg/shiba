import { useEffect, useRef, type JSX } from "react";
import { X } from "lucide-react";

export interface ShortcutItem {
  id: string;
  label: string;
  keys: string;
  /** True if this is an upcoming shortcut planned for the shell agent. */
  upcoming?: boolean;
}

export interface ShortcutGroup {
  group: "Global" | "Navigation" | "Work" | "Chat" | "Composer";
  items: ShortcutItem[];
}

export const KEYBOARD_SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    group: "Global",
    items: [
      { id: "command", label: "Command menu", keys: "⌘K" },
      { id: "help", label: "Shortcut list", keys: "?" },
      { id: "theme", label: "Toggle theme", keys: "D" },
      { id: "settings", label: "Settings", keys: "⌥7" },
      { id: "escape", label: "Close dialogs", keys: "Esc" },
    ],
  },
  {
    group: "Navigation",
    items: [
      { id: "rail", label: "Rail items 1–6", keys: "⌥1–6", upcoming: true },
      { id: "sidebar", label: "Toggle sidebar", keys: "⌘B" },
      { id: "new", label: "New thread", keys: "⌘⇧O" },
      { id: "next", label: "Next thread", keys: "J" },
      { id: "prev", label: "Previous thread", keys: "K" },
    ],
  },
  {
    group: "Work",
    items: [
      { id: "work-new-task", label: "New task (focus add)", keys: "C", upcoming: true },
    ],
  },
  {
    group: "Chat",
    items: [
      { id: "chat-focus", label: "Focus composer", keys: "/", upcoming: true },
    ],
  },
  {
    group: "Composer",
    items: [
      { id: "submit", label: "Send task", keys: "⌘↵" },
      { id: "newline", label: "New line", keys: "⇧↵" },
    ],
  },
];

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
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="w-full max-w-lg rounded-xl border border-[#e4e4e7] dark:border-zinc-800 bg-white dark:bg-[#121214] shadow-xl overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#e4e4e7] dark:border-zinc-800 shrink-0">
          <div>
            <h3 id="shortcuts-title" className="text-sm font-semibold text-[#0a0a0a] dark:text-zinc-100">
              Keyboard shortcuts
            </h3>
            <p className="text-xs text-[#71717a] dark:text-zinc-400 mt-0.5">
              Available across Shiba and the application shell
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
            className="size-7 rounded-md flex items-center justify-center text-[#71717a] hover:text-[#0a0a0a] dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-[#f4f4f5] dark:hover:bg-zinc-800 transition-colors"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {KEYBOARD_SHORTCUT_GROUPS.map((group) => (
            <section key={group.group} aria-label={group.group}>
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[#71717a] dark:text-zinc-400 mb-2">
                {group.group}
              </h4>
              <ul className="divide-y divide-[#e4e4e7]/60 dark:divide-zinc-800/60 rounded-lg border border-[#e4e4e7] dark:border-zinc-800 bg-[#f4f4f5]/30 dark:bg-zinc-900/40">
                {group.items.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                  >
                    <span className="text-[#0a0a0a] dark:text-zinc-200">
                      {row.label}
                    </span>
                    <kbd className="inline-flex items-center justify-center min-w-6 px-1.5 py-0.5 font-mono text-[11px] font-medium text-[#0a0a0a] dark:text-zinc-200 bg-white dark:bg-zinc-800 border border-[#e4e4e7] dark:border-zinc-700 rounded shadow-2xs">
                      {row.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="border-t border-[#e4e4e7] dark:border-zinc-800 px-5 py-3 flex items-center justify-end bg-[#f4f4f5]/40 dark:bg-zinc-900/60 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-[#0a0a0a] text-white hover:bg-[#27272a] dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 px-3.5 py-1.5 text-xs font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
