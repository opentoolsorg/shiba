export type DesktopDaemonState =
  | "signed-out" | "disabled" | "unpaired" | "paired-elsewhere"
  | "starting" | "idle" | "busy" | "offline" | "revoked" | "conflict" | "crashed";

export interface DesktopStatus {
  state: DesktopDaemonState;
  machineId?: string;      // not a secret; marks "This computer" in the fleet list
  activeRunId?: string;
  harnesses?: string[];
  pairedTo?: string;       // only for paired-elsewhere: the other origin
  detail?: string;         // human-readable; never contains a token
}

export type PairResult = { ok: true } | { ok: false; error: string };

export interface ShibaDesktopBridge {
  readonly version: string;
  status(): Promise<DesktopStatus>;
  pair(pairingToken: string): Promise<PairResult>;
  unpair(): Promise<PairResult>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
}

// Daemon → main over process.parentPort (hand-mirrored in the dep-free daemon).
export type DaemonStatusMessage =
  | { type: "status"; state: "polling"; machineId: string; harnesses: string[] }
  | { type: "status"; state: "claimed"; runId: string; harness: string; repoUrl: string }
  // Sent after the result POST. `posted` = the Worker accepted it. `status` is the daemon's
  // own view; harness.verify and PR publish still run Worker-side (§11.7).
  | { type: "status"; state: "settled"; runId: string; status: string; exitCode: number; repoUrl: string; posted: boolean }
  | { type: "status"; state: "heartbeat"; ok: boolean };
