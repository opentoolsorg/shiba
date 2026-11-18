import type { DesktopStatus } from "./desktop-bridge.js";

/** Dashboard copy for the desktop shell row (Remote Access → Connections). */
export function formatDesktopConnectionLabel(status: DesktopStatus): string {
  switch (status.state) {
    case "signed-out":
      return "Sign in to Shiba";
    case "disabled":
      return "Local runs disabled on this Shiba";
    case "unpaired":
      return "Not connected";
    case "paired-elsewhere":
      return status.pairedTo ? `Paired to ${status.pairedTo}` : "Paired to another Shiba";
    case "starting":
      return "Connecting this computer…";
    case "idle":
      return "This computer · idle";
    case "busy":
      return "This computer · running";
    case "offline":
      return `This computer · ${offlineCopy(status)}`;
    case "revoked":
      return "Revoked · reconnect from Remote Access";
    case "conflict":
      return "Another daemon is running on this machine";
    case "crashed":
      return status.reason === "exit" && status.exitCode !== undefined
        ? `Daemon crashed · exit ${status.exitCode}`
        : "Daemon crashed · check logs";
  }
}

/**
 * Offline copy from typed reasons only. The shell never sends daemon text,
 * repository names, or URLs, so every branch here is fixed wording.
 */
function offlineCopy(status: DesktopStatus): string {
  if (status.reason === "retrying" && status.retryInMs !== undefined) {
    return `offline · retrying in ${Math.max(1, Math.ceil(status.retryInMs / 1000))}s`;
  }
  if (status.reason === "daemon-stopped") return "offline · daemon stopped";
  return "offline";
}

/** Short harness summary for the desktop row; never includes secrets. */
export function formatDesktopHarnessSummary(harnesses: string[] | undefined): string | null {
  if (!harnesses?.length) return null;
  const parts = harnesses.map((h) => (h === "agy" ? "agy (listed only)" : h));
  return parts.join(", ");
}
