// T63 — pairing IPC layer. main.ts (leader wiring) calls registerDesktopIpc
// once. Every handler re-checks the sender frame (D4) and main builds the
// daemon argv itself from the configured origin (D3) — the renderer only
// supplies the single-use pairing token, never a URL (D7: the token reaches
// only the daemon's environment, never argv, IPC replies, logs or
// notifications).
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopStatus, PairFailureCode, PairResult } from "@shiba/shared";
import {
  boundedText,
  DESKTOP_CHANNELS,
  MAX_DEPLOYMENT_URL_CHARS,
  SETUP_CHANNELS,
} from "./bridge-contract.js";
import type { ChildLike } from "./controller.js";
import type { IpcBounds } from "./ipc-guard.js";
import { originOf } from "./navigation.js";

/** A mint that failed, or the single-use token main will hand the daemon. */
export type MintedToken = { ok: true; token: string } | { ok: false; code: PairFailureCode };

const failure = (code: PairFailureCode): PairResult => ({ ok: false, code });

export type { DesktopStatus, PairResult };

export interface DesktopSupervisor {
  status(): DesktopStatus;
  stop(): Promise<void> | void;
  /**
   * Forks the daemon script with the given argv. The pairing token travels in
   * the child's environment, never in argv. Pairing forks never restart.
   */
  forkDaemon(args: string[], pairingToken: string): ChildLike;
  /** Re-reads config.json and restarts the daemon if it is still paired. */
  probe?(): unknown;
}

export interface DesktopIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  /** ipc-trust.ts — own window, its main frame, the configured origin. */
  isTrustedEvent(event: IpcMainInvokeEvent): boolean;
  supervisor: DesktopSupervisor;
  getConfiguredOrigin(): string;
  /** session.defaultSession.fetch — cookies ride along automatically. */
  sessionFetch(input: string, init?: RequestInit): Promise<Response>;
  /** Daemon runRoot that holds config.json (~/.shiba-local by default). */
  runRoot: string;
  /** Native confirm before re-pairing a machine already paired to another origin. */
  confirmPairElsewhere(pairedTo: string | undefined): Promise<boolean>;
  /** ipc-trust.ts — own window, its main frame, the bundled setup.html page. */
  isSetupEvent(event: IpcMainInvokeEvent): boolean;
  /** Mints a single-use pairing token in main, so the page never holds one. */
  mintPairingToken(): Promise<MintedToken>;
  /** Daemon stderr from a failed pair, for the log sink only. */
  onPairStderr?(tail: string): void;
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
  /** Surface-wide concurrency ceiling shared with the rest of the bridge. */
  bounds: IpcBounds;
}

// Two base64url segments joined by "."; real tokens are ~124 chars.
const PAIRING_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Any exit of a --pair fork before its first "polling" message is a pair
// failure — no restart (DESKTOP-PLAN §3.4, §11.3). The daemon's own stderr is
// logged as a bounded event and never travels back to the renderer: the page
// gets a fixed code and owns the copy.
export const PAIR_TIMEOUT_MS = 30_000;

const EXIT_RUNTIME_OFF = 79;

function waitForPair(
  child: ChildLike,
  onStderr: (tail: string) => void,
  timeoutMs = PAIR_TIMEOUT_MS,
): Promise<PairResult> {
  return new Promise((resolve) => {
    let stderrTail = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: PairResult) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      if (!result.ok) onStderr(stderrTail);
      resolve(result);
    };
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish(failure("pairing_timeout"));
    }, timeoutMs);
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4096);
    });
    child.on("message", (message: unknown) => {
      const msg = message as { type?: unknown; state?: unknown } | null;
      if (msg?.type === "status" && msg.state === "polling") finish({ ok: true });
    });
    child.once("exit", (code: number | null) => {
      finish(failure(code === EXIT_RUNTIME_OFF ? "not_configured" : "pairing_rejected"));
    });
  });
}

export function emitStatusChanged(
  webContents: Pick<WebContents, "send"> | undefined | null,
  status: DesktopStatus,
): void {
  webContents?.send(DESKTOP_CHANNELS.statusChanged, status);
}

export function registerDesktopIpc(deps: DesktopIpcDeps): { unpair(): Promise<PairResult> } {
  const trusted = (event: IpcMainInvokeEvent): boolean => deps.isTrustedEvent(event);

  // A second submit would stop() the daemon and kill the in-progress pairing fork.
  const inFlight = new Map<string, Promise<PairResult>>();
  const connectionChange = "connection-change";
  function singleFlight(channel: string, run: () => Promise<PairResult>): Promise<PairResult> {
    if (inFlight.has(channel)) return Promise.resolve(failure("pairing_busy"));
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
    } catch {
      // offline or signed out: the old row ages out after 7 days
      deps.log?.("re-pair: revoke request failed");
    }
  }

  deps.ipcMain.handle(DESKTOP_CHANNELS.status, (event): DesktopStatus => {
    if (!trusted(event)) throw new Error("Untrusted sender.");
    return deps.supervisor.status();
  });

  // The token is minted here, in main, and handed straight to the daemon's
  // environment: it never enters the renderer, its clipboard, or the DOM.
  deps.ipcMain.handle(DESKTOP_CHANNELS.pair, async (event): Promise<PairResult> => {
    const origin = deps.getConfiguredOrigin();
    if (!trusted(event)) return failure("untrusted_sender");
    return deps.bounds.run(
      () =>
        singleFlight(connectionChange, async () => {
          const minted = await deps.mintPairingToken();
          if (!minted.ok) return failure(minted.code);
          const local = deps.readLocalConfig();
          const savedOrigin = local?.workerUrl ? originOf(local.workerUrl) : undefined;
          const status = deps.supervisor.status();
          const replacingOtherDeployment =
            status.state === "paired-elsewhere" ||
            (savedOrigin !== undefined && savedOrigin !== origin);
          if (replacingOtherDeployment) {
            const pairedTo = status.state === "paired-elsewhere" ? status.pairedTo : savedOrigin;
            const confirmed = await deps.confirmPairElsewhere(pairedTo);
            if (!confirmed) return failure("pairing_cancelled");
          }
          // Read before stop(): stopping resets the live status and drops machineId.
          const staleId = staleMachineId(origin, status);
          await deps.supervisor.stop();
          const child = deps.supervisor.forkDaemon(["--connect", origin, "--pair"], minted.token);
          const result = await waitForPair(
            child,
            (tail) => deps.onPairStderr?.(tail),
            deps.pairTimeoutMs ?? PAIR_TIMEOUT_MS,
          );
          // Only after the new pairing lands: a failed re-pair must not leave the old token revoked.
          if (result.ok) {
            await revokeStaleMachine(origin, staleId);
            // Re-read config and refresh tray/bridge status if the polling message raced IPC return.
            void deps.supervisor.probe?.();
          }
          return result;
        }),
      () => failure("pairing_busy"),
    );
  });

  async function unpair(): Promise<PairResult> {
    const origin = deps.getConfiguredOrigin();
    return singleFlight(connectionChange, async () => {
      const local = deps.readLocalConfig();
      const status = deps.supervisor.status();
      // The current page cannot revoke a machine from another deployment
      // using this origin's cookies or accidentally discard that pairing.
      if ((local?.workerUrl && originOf(local.workerUrl) !== origin) || status.state === "paired-elsewhere") {
        return failure("revoke_unreachable");
      }
      // conflict/crashed drop machineId from the live status; fall back to the
      // on-disk config so the server-side revoke still runs (REVIEW3 F5).
      const machineId = status.machineId ?? local?.machineId;
      // Stop first: a mid-run daemon settles its claim with the token revoke is about to kill.
      await deps.supervisor.stop();
      if (machineId) {
        let res: Response;
        try {
          res = await deps.sessionFetch(`${origin}/api/computers/revoke`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ machineId }),
          });
        } catch {
          void deps.supervisor.probe?.();
          return failure("revoke_unreachable");
        }
        if (!res.ok) {
          // Config is kept, so the probe brings the stopped daemon back.
          void deps.supervisor.probe?.();
          deps.log?.(`revoke returned ${res.status}`);
          return failure("revoke_failed");
        }
      }
      await rm(join(deps.runRoot, "config.json"), { force: true });
      return { ok: true };
    });
  }

  deps.ipcMain.handle(DESKTOP_CHANNELS.unpair, async (event): Promise<PairResult> => {
    if (!trusted(event)) return failure("untrusted_sender");
    return deps.bounds.run(unpair, () => failure("pairing_busy"));
  });

  // Accepted only from the setup page's own main frame, never from a remote origin.
  deps.ipcMain.handle(SETUP_CHANNELS.setUrl, async (event, url: unknown): Promise<PairResult> => {
    if (!deps.isSetupEvent(event)) return failure("url_wrong_frame");
    const candidate = boundedText(url, MAX_DEPLOYMENT_URL_CHARS);
    const origin = candidate ? deps.parseDeploymentUrl(candidate) : null;
    if (!origin) return failure("url_invalid");
    if (inFlight.has(connectionChange)) return failure("pairing_busy");
    return (await deps.onSetUrl?.(origin)) ?? { ok: true };
  });
  // Native tray actions use the same serialized, origin-bound operation.
  return { unpair };
}
