/** Shortcuts the shell actually handles. The dialog and the key listener stay in step. */
export const KEYBOARD_SHORTCUTS: { id: string; label: string; keys: string }[] = [
  { id: "submit", label: "Send task", keys: "⌘/Ctrl + Enter" },
  { id: "new", label: "New thread", keys: "⌘/Ctrl + Shift + O" },
  { id: "next", label: "Next thread", keys: "J" },
  { id: "prev", label: "Previous thread", keys: "K" },
  { id: "sidebar", label: "Toggle sidebar", keys: "⌘/Ctrl + B or [" },
  { id: "escape", label: "Close dialogs", keys: "Esc" },
  { id: "help", label: "Shortcut list", keys: "?" },
  { id: "command", label: "Command menu", keys: "⌘/Ctrl + K" },
  { id: "settings", label: "Settings", keys: "⌘/Ctrl + ," },
  { id: "theme", label: "Toggle theme", keys: "D" },
];
