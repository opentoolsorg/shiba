/**
 * Who may call the privileged IPC handlers. A matching frame URL is not enough:
 * the call must come from the shell's own window and from that window's main
 * frame, so a subframe inside the dashboard cannot reach the bridge.
 */

import { isSetupSender, isTrustedSender } from "./navigation.js";

interface FrameLike {
  url: string;
}

export interface IpcSenderEvent {
  senderFrame: FrameLike | null;
  sender: { mainFrame: FrameLike | null } | null;
}

function isMainFrameOfOwnWindow(event: IpcSenderEvent, owned: unknown): boolean {
  if (!event.sender || !event.senderFrame) return false;
  if (owned === null || owned !== event.sender) return false;
  return event.sender.mainFrame === event.senderFrame;
}

export interface TrustOptions {
  /** The window contents the shell created; any other webContents is foreign. */
  ownedContents(): unknown;
}

/** Privileged dashboard call: own window, its main frame, the configured origin. */
export function createDashboardTrust(
  options: TrustOptions & { configuredOrigin(): string },
): (event: IpcSenderEvent) => boolean {
  return (event) => {
    if (!isMainFrameOfOwnWindow(event, options.ownedContents())) return false;
    return isTrustedSender(event.senderFrame?.url, options.configuredOrigin());
  };
}

/** Setup call: own window, its main frame, the bundled setup page. */
export function createSetupTrust(
  options: TrustOptions & { setupFileUrl: string },
): (event: IpcSenderEvent) => boolean {
  return (event) => {
    if (!isMainFrameOfOwnWindow(event, options.ownedContents())) return false;
    return isSetupSender(event.senderFrame?.url, options.setupFileUrl);
  };
}
