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

export interface DesktopStatus {
  state: DesktopDaemonState;
  machineId?: string; // not a secret; marks "This computer" in the fleet list
  activeRunId?: string;
  harnesses?: string[];
  pairedTo?: string; // only for paired-elsewhere: the other origin
  detail?: string; // human-readable; never contains a token
}

export type PairResult = { ok: true } | { ok: false; error: string };

/** Views the shell can open in the dashboard. The page at that path is the dashboard's. */
export type DesktopViewName = "tasks" | "diff" | "approvals" | "providers" | "remote";

export type DesktopFailure = { ok: false; error: string };

export type DesktopClaudeLoginResult = { ok: true } | DesktopFailure;

/**
 * Methods this shell implements. The dashboard reads this list instead of
 * probing for truthiness, so a capability the shell does not ship (native
 * ChatGPT sign-in, for one) never renders a control that cannot work.
 */
export const DESKTOP_CAPABILITIES = [
  "status",
  "pair",
  "unpair",
  "onStatus",
  "claudeLogin",
] as const;

export type DesktopCapability = (typeof DESKTOP_CAPABILITIES)[number];

/** Handshake every desktop page receives; `origin` is the only origin it may run on. */
export interface DesktopBridgeHandshake {
  bridgeVersion: number;
  appVersion: string;
  platform: string;
  capabilities: readonly DesktopCapability[];
}

export interface ShibaDesktopBridge extends DesktopBridgeHandshake {
  status(): Promise<DesktopStatus>;
  pair(pairingToken: string): Promise<PairResult>;
  unpair(): Promise<PairResult>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  /** Spawns `claude auth login` on this machine. Stdout is discarded; credentials stay in the user's Claude home. */
  startClaudeLogin(): Promise<DesktopClaudeLoginResult>;
}

/** The bundled setup page's bridge; it can only change the deployment URL. */
export interface ShibaSetupBridge {
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
