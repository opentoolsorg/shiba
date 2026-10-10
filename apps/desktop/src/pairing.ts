// T63 — pairing IPC layer. main.ts (leader wiring) calls registerDesktopIpc
// once. Every handler re-checks the sender frame (D4) and main builds the
// daemon argv itself from the configured origin (D3) — the renderer only
// supplies the single-use pairing token, never a URL (D7: the token reaches
// only the daemon argv, never IPC replies, logs or notifications).
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopStatus, PairResult } from "@shiba/shared";
import type { ChildLike } from "./controller.js";
import { originOf } from "./navigation.js";

export type { DesktopStatus, PairResult };

export const DESKTOP_STATUS_CHANNEL = "desktop:status";
export const DESKTOP_PAIR_CHANNEL = "desktop:pair";
export const DESKTOP_UNPAIR_CHANNEL = "desktop:unpair";
export const DESKTOP_SET_URL_CHANNEL = "desktop:set-url";
export const DESKTOP_STATUS_CHANGED_CHANNEL = "desktop:status-changed";

export interface DesktopSupervisor {
  status(): DesktopStatus;
  stop(): Promise<void> | void;
  /** Forks the daemon script with the given argv. Pairing forks never restart. */
  forkDaemon(args: string[]): ChildLike;
  /** Re-reads config.json and restarts the daemon if it is still paired. */
  probe?(): unknown;
}

export interface DesktopIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  /** navigation.ts#isTrustedSender — every handler re-checks D4. */
  isTrustedSender(senderFrameUrl: string | undefined, configuredOrigin: string): boolean;
  supervisor: DesktopSupervisor;
  getConfiguredOrigin(): string;
  /** session.defaultSession.fetch — cookies ride along automatically. */
  sessionFetch(input: string, init?: RequestInit): Promise<Response>;
  /** Daemon runRoot that holds config.json (~/.shiba-local by default). */
  runRoot: string;
  /** Native confirm before re-pairing a machine already paired to another origin. */
  confirmPairElsewhere(pairedTo: string | undefined): Promise<boolean>;
  /** navigation.ts#isSetupSender bound to the bundled setup.html URL (D4). */
  isSetupSender(senderFrameUrl: string | undefined): boolean;
  /** navigation.ts#parseDeploymentUrl bound to app.isPackaged; returns the origin or null. */
  parseDeploymentUrl(input: string): string | null;
  /** Applied only when the bundled setup.html frame supplies a new URL; receives the reduced origin. */
  onSetUrl?(origin: string): void | PairResult | Promise<void | PairResult>;
  /** Reads the daemon's config.json — revoke fallback when status dropped machineId (conflict/crashed). */
  readLocalConfig(): { workerUrl?: string; machineId?: string } | null;
  /** Pair fork watchdog (default PAIR_TIMEOUT_MS); tests pass a few ms. */
  pairTimeoutMs?: number;
  /** Main-process log sink; never receives tokens or request bodies. */
  log?(line: string): void;
}

// Two base64url segments joined by ".", capped at the server schema's 1024
// (local-fleet-schema.ts); real tokens are ~124 chars.
const PAIRING_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PAIRING_TOKEN_MAX = 1024;

function lastStderrLine(tail: string): string {
  const line = tail.trim().split("\n").filter(Boolean).pop() ?? "";
  return line.replace(/^shiba-local:\s*/, "");
}

// Any exit of a --pair fork before its first "polling" message is a pair
// failure — no restart (DESKTOP-PLAN §3.4, §11.3). The daemon already prints
// "pairing token expired, reused, or invalid" on 401 and "pairing failed: …"
// otherwise, so the last stderr line is the user-facing error verbatim.
// A pairing fork that never reaches "polling" and never exits would leave the
// renderer's "Connecting…" spinning forever — cap it (REVIEW3 F9).
export const PAIR_TIMEOUT_MS = 30_000;

function waitForPair(child: ChildLike,timeoutMs = PAIR_TIMEOUT_MS): Promise<PairResult> {
  return new Promise((resolve) => {
    let stderrTail = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PairResult) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone — the exit listener finishes with the stderr error
      }
      finish({ ok: false, error: "pairing timed out" });
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });
    child.on("message", (message: unknown) => {
      const msg = message as { type?: unknown; state?: unknown } | null;
      if (msg?.type === "status" && msg.state === "polling") finish({ ok: true });
    });
    child.once("exit", () => {
      const error = lastStderrLine(stderrTail);
      finish({ ok: false, error: error === "" ? "pairing failed" : error });
    });
  });
}

export function emitStatusChanged(
  webContents: Pick<WebContents, "send"> | undefined | null,
  status: DesktopStatus,
): void {
  webContents?.send(DESKTOP_STATUS_CHANGED_CHANNEL, status);
}

export function registerDesktopIpc(deps: DesktopIpcDeps): void {
  const trusted = (event: IpcMainInvokeEvent): boolean =>
    deps.isTrustedSender(event.senderFrame?.url, deps.getConfiguredOrigin());

  // A second submit would stop() the daemon and kill the in-progress pairing fork.
  const inFlight = new Map<string, Promise<PairResult>>();
  function singleFlight(channel: string, run: () => Promise<PairResult>): Promise<PairResult> {
    if (inFlight.has(channel)) return Promise.resolve({ ok: false, error: "Pairing already in progress." });
    const pending = run().finally(() => inFlight.delete(channel));
    inFlight.set(channel, pending);
    return pending;
  }

  // Re-pairing mints a new machineId, so drop this machine's old row (§11.3).
  // Best-effort: a failed revoke must not block pairing.
  function staleMachineId(origin: string, status: DesktopStatus): string | undefined {
    if (status.state === "paired-elsewhere") return undefined;
    const local = deps.readLocalConfig();
    const localHere = local?.workerUrl !== undefined && originOf(local.workerUrl) === origin;
    // A live-status id can outlive an origin change (set-url), so require config.json to agree.
    return localHere ? (status.machineId ?? local?.machineId) : undefined;
  }

  async function revokeStaleMachine(origin: string, machineId: string | undefined): Promise<void> {
    if (!machineId) return;
    try {
      const res = await deps.sessionFetch(`${origin}/api/computers/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId }),
      });
      if (!res.ok) deps.log?.(`re-pair: revoke returned ${res.status}`);
    } catch (error) {
      // offline or signed out: the old row ages out after 7 days
      deps.log?.(`re-pair: revoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  deps.ipcMain.handle(DESKTOP_STATUS_CHANNEL, (event): DesktopStatus => {
    if (!trusted(event)) throw new Error("Untrusted sender.");
    return deps.supervisor.status();
  });

  deps.ipcMain.handle(DESKTOP_PAIR_CHANNEL, async (event, token: unknown): Promise<PairResult> => {
    const origin = deps.getConfiguredOrigin();
    if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > PAIRING_TOKEN_MAX ||
      !PAIRING_TOKEN.test(token)
    ) {
      return { ok: false, error: "Invalid pairing token." };
    }
    return singleFlight(DESKTOP_PAIR_CHANNEL, async () => {
      const status = deps.supervisor.status();
      if (status.state === "paired-elsewhere") {
        const confirmed = await deps.confirmPairElsewhere(status.pairedTo);
        if (!confirmed) return { ok: false, error: "Pairing cancelled." };
      }
      // Read before stop(): stopping resets the live status and drops machineId.
      const staleId = staleMachineId(origin, status);
      await deps.supervisor.stop();
      const child = deps.supervisor.forkDaemon(["--connect", origin, "--pair", token]);
      const result = await waitForPair(child, deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS);
      // Only after the new pairing lands: a failed re-pair must not leave the old token revoked.
      if (result.ok) await revokeStaleMachine(origin, staleId);
      return result;
    });
  });

  deps.ipcMain.handle(DESKTOP_UNPAIR_CHANNEL, async (event): Promise<PairResult> => {
    const origin = deps.getConfiguredOrigin();
    if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
    return singleFlight(DESKTOP_UNPAIR_CHANNEL, async () => {
      // conflict/crashed drop machineId from the live status; fall back to the
      // on-disk config so the server-side revoke still runs (REVIEW3 F5).
      const machineId = deps.supervisor.status().machineId ?? deps.readLocalConfig()?.machineId;
      // Stop first: a mid-run daemon settles its claim with the token revoke is about to kill.
      await deps.supervisor.stop();
      if (machineId) {
        const res = await deps.sessionFetch(`${origin}/api/computers/revoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ machineId }),
        });
        if (!res.ok) {
          // Config is kept, so the probe brings the stopped daemon back.
          void deps.supervisor.probe?.();
          return { ok: false, error: `Revoke failed with ${res.status}.` };
        }
      }
      await rm(join(deps.runRoot, "config.json"), { force: true });
      return { ok: true };
    });
  });

  // Accepted only from the bundled setup.html frame, never from a remote origin.
  deps.ipcMain.handle(DESKTOP_SET_URL_CHANNEL, async (event, url: unknown): Promise<PairResult> => {
    if (!deps.isSetupSender(event.senderFrame?.url)) {
      return { ok: false, error: "desktop:set-url is only accepted from the setup frame." };
    }
    const origin = typeof url === "string" ? deps.parseDeploymentUrl(url) : null;
    if (!origin) return { ok: false, error: "URL must be https:// (http://localhost only in dev)." };
    return (await deps.onSetUrl?.(origin)) ?? { ok: true };
  });
}
