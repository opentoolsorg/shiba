import type { DesktopClaudeLoginResult } from "@shiba/shared";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_CHANNELS } from "./bridge-contract.js";
import type { IpcBounds } from "./ipc-guard.js";
import { IPC_BUSY_ERROR } from "./ipc-guard.js";

export interface ShellIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  isTrustedSender(senderFrameUrl: string | undefined, configuredOrigin: string): boolean;
  getConfiguredOrigin(): string;
  /** Shared with pairing: one ceiling for the whole bridge. */
  bounds: IpcBounds;
  startClaudeLogin(): Promise<DesktopClaudeLoginResult>;
}

function frameUrl(event: IpcMainInvokeEvent): string | undefined {
  return event.senderFrame?.url;
}

export function registerShellIpc(deps: ShellIpcDeps): void {
  const trusted = (event: IpcMainInvokeEvent) =>
    deps.isTrustedSender(frameUrl(event), deps.getConfiguredOrigin());

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
