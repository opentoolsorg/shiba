import type { DesktopClaudeLoginResult } from "@shiba/shared";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_CHANNELS } from "./bridge-contract.js";
import type { IpcBounds } from "./ipc-guard.js";
import { IPC_BUSY_ERROR } from "./ipc-guard.js";

/** Fixed refusal for the retired native sign-in path; never starts a listener. */
export const CODEX_CALLBACK_RETIRED =
  "Native ChatGPT sign-in is not available in this Shiba Desktop. Use the browser sign-in link instead.";

export interface ShellIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  /** ipc-trust.ts — own window, its main frame, the configured origin. */
  isTrustedEvent(event: IpcMainInvokeEvent): boolean;
  /** Shared with pairing: one ceiling for the whole bridge. */
  bounds: IpcBounds;
  startClaudeLogin(): Promise<DesktopClaudeLoginResult>;
}

export function registerShellIpc(deps: ShellIpcDeps): void {
  const trusted = (event: IpcMainInvokeEvent) => deps.isTrustedEvent(event);

  // Compatibility with an older dashboard: it may still ask for a loopback
  // receiver. There is none, so the call resolves with a fixed refusal instead
  // of throwing, and the page shows the browser instruction.
  deps.ipcMain.handle(
    DESKTOP_CHANNELS.retiredCodexCallback,
    (event): { ok: false; error: string } => {
      if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
      return { ok: false, error: CODEX_CALLBACK_RETIRED };
    },
  );

  // Exclusive: a second invoke must not spawn a second `claude auth login`.
  deps.ipcMain.handle(
    DESKTOP_CHANNELS.claudeLogin,
    async (event): Promise<DesktopClaudeLoginResult> => {
      if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
      if (!deps.bounds.tryEnter("claude-login")) {
        return { ok: false, error: "Claude sign-in is already running on this computer." };
      }
      try {
        return await deps.bounds.run(
          () => deps.startClaudeLogin(),
          () => ({ ok: false, error: IPC_BUSY_ERROR }),
        );
      } finally {
        deps.bounds.leave("claude-login");
      }
    },
  );
}
