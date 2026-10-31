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
      return status.detail ? `This computer · running · ${status.detail}` : "This computer · running";
    case "offline":
      return status.detail ? `This computer · offline · ${status.detail}` : "This computer · offline";
    case "revoked":
      return "Revoked · reconnect from Remote Access";
    case "conflict":
      return "Another daemon is running on this machine";
    case "crashed":
      return status.detail ? `Daemon crashed · ${status.detail}` : "Daemon crashed · check logs";
  }
}

/** Short harness summary for the desktop row; never includes secrets. */
export function formatDesktopHarnessSummary(harnesses: string[] | undefined): string | null {
  if (!harnesses?.length) return null;
  const parts = harnesses.map((h) => (h === "agy" ? "agy (listed only)" : h));
  return parts.join(", ");
}
