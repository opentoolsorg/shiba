import type { DesktopDaemonState, DesktopStatus } from "@shiba/shared";

export interface TrayToggles {
  notifications: boolean;
  startAtLogin: boolean;
}

export type TrayItem =
  | { type: "separator" }
  | { type: "item"; id: string; label: string; enabled?: boolean; checked?: boolean };

const LABELS: Record<DesktopDaemonState, string> = {
  "signed-out": "Sign in to Shiba",
  disabled: "Local runs disabled on this Shiba",
  unpaired: "Not connected",
  "paired-elsewhere": "Paired to another Shiba",
  starting: "Starting…",
  idle: "Connected · idle",
  busy: "Running",
  offline: "Offline · retrying",
  revoked: "Revoked · reconnect",
  conflict: "Another daemon is running",
  crashed: "Daemon crashed · View logs",
};

const CONNECTABLE: DesktopDaemonState[] = ["unpaired", "paired-elsewhere", "revoked"];
// "conflict" is excluded: config.json belongs to the daemon that holds the
// lock, so Disconnect there would delete another daemon's config (REVIEW3 F5).
const DISCONNECTABLE: DesktopDaemonState[] = ["starting", "idle", "busy", "offline", "crashed"];
// These latch with no automatic restart (§3.4), so the user needs a way back.
const RETRYABLE: DesktopDaemonState[] = ["conflict", "crashed"];

export function statusLabel(s: DesktopStatus): string {
  const base = LABELS[s.state];
  if (s.state === "busy" && s.detail) return `${base} · ${s.detail}`;
  return base;
}

// agy is probed by the daemon but not locally runnable: list it, don't promise it.
export function harnessLine(harnesses: string[] | undefined): string | null {
  if (!harnesses?.length) return null;
  return `Harnesses: ${harnesses.map((h) => (h === "agy" ? "agy (listed only)" : h)).join(", ")}`;
}

export function buildTrayMenu(status: DesktopStatus, toggles: TrayToggles): TrayItem[] {
  const item = (id: string, label: string, extra: { enabled?: boolean; checked?: boolean } = {}): TrayItem => ({
    type: "item", id, label, ...extra,
  });
  const sep: TrayItem = { type: "separator" };
  const harness = harnessLine(status.harnesses);
  const connected = DISCONNECTABLE.includes(status.state);
  return [
    item("status", statusLabel(status), { enabled: false }),
    ...(harness ? [item("harnesses", harness, { enabled: false })] : []),
    sep,
    item("open", "Open Shiba"),
    item("approvals", "Approvals"),
    sep,
    ...(RETRYABLE.includes(status.state) ? [item("retry", "Retry")] : []),
    connected
      ? item("disconnect", "Disconnect this computer")
      : item("connect", "Connect this computer…", { enabled: CONNECTABLE.includes(status.state) }),
    sep,
    item("notifications", "Notifications", { checked: toggles.notifications }),
    item("start-at-login", "Start at login", { checked: toggles.startAtLogin }),
    item("change-url", "Change Shiba URL…"),
    sep,
    item("logs", "View logs"),
    item("updates", "Check for updates"),
    item("quit", "Quit"),
  ];
}

// Thin electron wrapper; main.ts owns the Tray lifetime and calls update() on status change.
export function createTray(iconPath: string, onSelect: (id: string) => void) {
  const { Tray, Menu } = require("electron") as typeof import("electron");
  const tray = new Tray(iconPath);
  return {
    update(model: TrayItem[]) {
      tray.setContextMenu(
        Menu.buildFromTemplate(
          model.map((i) =>
            i.type === "separator"
              ? { type: "separator" as const }
              : {
                  label: i.label,
                  enabled: i.enabled ?? true,
                  ...(i.checked !== undefined ? { type: "checkbox" as const, checked: i.checked } : {}),
                  click: () => onSelect(i.id),
                },
          ),
        ),
      );
    },
    destroy: () => tray.destroy(),
  };
}
