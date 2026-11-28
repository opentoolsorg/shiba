export type DesktopDaemonState =
  | "signed-out"
  | "disabled"
  | "unpaired"
  | "paired-elsewhere"
  | "starting"
  | "idle"
  | "busy"
  | "offline"
  | "revoked"
  | "conflict"
  | "crashed";

/** Why the daemon is in the state it reports; the page owns the copy. */
export type DesktopStatusReason = "daemon-stopped" | "retrying" | "exit";

export interface DesktopStatus {
  state: DesktopDaemonState;
  machineId?: string; // not a secret; marks "This computer" in the fleet list
  activeRunId?: string;
  harnesses?: string[];
  pairedTo?: string; // only for paired-elsewhere: the other origin
  /** Typed reason only: no repository names, daemon text, or URLs. */
  reason?: DesktopStatusReason;
  /** Milliseconds until the automatic retry, when reason is "retrying". */
  retryInMs?: number;
  /** Daemon exit code, when reason is "exit". */
  exitCode?: number;
}

/**
 * Every failure the shell can report is a fixed code, so no daemon text, URL,
 * or token can ride back into the renderer's copy.
 */
export type PairFailureCode =
  | "pairing_deferred"
  | "untrusted_sender"
  | "pairing_busy"
  | "pairing_timeout"
  | "pairing_rejected"
  | "pairing_unavailable"
  | "pairing_cancelled"
  | "mint_failed"
  | "not_configured"
  | "url_invalid"
  | "url_wrong_frame"
  | "revoke_failed"
  | "revoke_unreachable";

/**
 * `error` exists only so an older dashboard that renders `result.error` still
 * shows a fixed sentence instead of a blank toast. It is always one of the
 * constants below, never dynamic text.
 */
export type PairResult = { ok: true } | { ok: false; code: PairFailureCode; error?: string };

export const PAIR_FAILURE_MESSAGES: Record<PairFailureCode, string> = {
  pairing_deferred:
    "Connecting this computer runs from the browser: open Shiba there and use Add computer.",
  untrusted_sender: "Shiba Desktop refused a request that did not come from its own window.",
  pairing_busy: "A connection change is already running.",
  pairing_timeout: "Pairing timed out. Check the connection and try again.",
  pairing_rejected: "This computer could not be paired. Mint a new token and retry.",
  pairing_unavailable: "This Shiba does not allow local runs.",
  pairing_cancelled: "Pairing was cancelled.",
  mint_failed: "Could not mint a pairing token. Check the connection and retry.",
  not_configured: "Pairing is not configured on this Shiba.",
  url_invalid: "That is not a Shiba address. Use https:// (http://localhost only in dev).",
  url_wrong_frame: "Only the setup page can change the address.",
  revoke_failed: "Could not disconnect this computer. Check the connection and retry.",
  revoke_unreachable: "Could not reach your Shiba to disconnect this computer.",
};

/** The page's copy for a failure code; the shell ships its own copy of this table. */
export function pairFailureMessage(code: PairFailureCode): string {
  return PAIR_FAILURE_MESSAGES[code];
}

/** Views the shell can open in the dashboard. The page at that path is the dashboard's. */
export type DesktopViewName =
  | "work"
  | "dashboard"
  | "tasks"
  | "threads"
  | "activity"
  | "analytics"
  | "diff"
  | "approvals"
  | "swarm"
  | "collaboration"
  | "team"
  | "agents"
  | "inbox"
  | "memory"
  | "files"
  | "notes"
  | "projects"
  | "outputs"
  | "automations"
  | "providers"
  | "integrations"
  | "skills"
  | "spaces"
  | "custom-agents"
  | "employee-tools"
  | "chief-of-staff"
  | "remote"
  | "settings";

export type DesktopFailure = { ok: false; error: string };

export type DesktopClaudeLoginResult = { ok: true } | DesktopFailure;

/**
 * Methods this shell implements. The dashboard reads this list instead of
 * probing for truthiness, so a capability the shell does not ship (native
 * ChatGPT sign-in, for one) never renders a control that cannot work.
 */
export const DESKTOP_CAPABILITIES = ["status", "unpair", "onStatus", "claudeLogin"] as const;

export type DesktopCapability = (typeof DESKTOP_CAPABILITIES)[number];

/** Which bundled page the bridge is running in. */
export type DesktopBridgeSurface = "dashboard" | "setup";

/** Handshake every desktop page receives; `origin` is the only origin it may run on. */
export interface DesktopBridgeHandshake {
  bridgeVersion: number;
  appVersion: string;
  platform: string;
  surface: DesktopBridgeSurface;
  capabilities: readonly DesktopCapability[];
}

export interface ShibaDesktopBridge extends DesktopBridgeHandshake {
  status(): Promise<DesktopStatus>;
  /**
   * Compatibility only. Native pairing is deferred: the shell has no mint
   * authority separate from the browser session, so this resolves with
   * `pairing_deferred` and the page sends the user to the browser flow.
   */
  pair(): Promise<PairResult>;
  unpair(): Promise<PairResult>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  /** Spawns `claude auth login` on this machine. Stdout is discarded; credentials stay in the user's Claude home. */
  startClaudeLogin(): Promise<DesktopClaudeLoginResult>;
}

/** The bundled setup page's bridge; it can only change the deployment URL. */
export interface ShibaSetupBridge {
  surface: "setup";
  setUrl(url: string): Promise<PairResult>;
}

// Daemon → main over process.parentPort (hand-mirrored in the dep-free daemon).
export type DaemonStatusMessage =
  | { type: "status"; state: "polling"; machineId: string; harnesses: string[] }
  | { type: "status"; state: "claimed"; runId: string; harness: string; repoUrl: string }
  // Sent after the result POST. `posted` = the Worker accepted it. `status` is the daemon's
  // own view; harness.verify and PR publish still run Worker-side (§11.7).
  | {
      type: "status";
      state: "settled";
      runId: string;
      status: string;
      exitCode: number;
      repoUrl: string;
      posted: boolean;
    }
  | { type: "status"; state: "heartbeat"; ok: boolean };
