// T63 — pairing IPC layer. main.ts (leader wiring) calls registerDesktopIpc
// once. Every handler re-checks the sender frame (D4) and main builds the
// daemon argv itself from the configured origin (D3) — the renderer only
// supplies the single-use pairing token, never a URL (D7: the token reaches
// only the daemon's environment, never argv, IPC replies, logs or
// notifications).
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { DesktopStatus, PairResult } from "@shiba/shared";
import type { ShellPairFailureCode } from "./pair-copy.js";
import { shellFailure } from "./pair-copy.js";
import {
  boundedText,
  DESKTOP_CHANNELS,
  MAX_DEPLOYMENT_URL_CHARS,
  SETUP_CHANNELS,
} from "./bridge-contract.js";
import type { ChildLike } from "./controller.js";
import type { IpcBounds } from "./ipc-guard.js";
import { originOf } from "./navigation.js";

const failure = (code: ShellPairFailureCode): PairResult => shellFailure(code);

export type { DesktopStatus, PairResult };

export interface DesktopSupervisor {
  status(): DesktopStatus;
  stop(): Promise<void> | void;
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
  /** ipc-trust.ts — own window, its main frame, the bundled setup.html page. */
  isSetupEvent(event: IpcMainInvokeEvent): boolean;
  /** navigation.ts#parseDeploymentUrl bound to app.isPackaged; returns the origin or null. */
  parseDeploymentUrl(input: string): string | null;
  /** Applied only when the bundled setup.html frame supplies a new URL; receives the reduced origin. */
  onSetUrl?(origin: string): void | PairResult | Promise<void | PairResult>;
  /** Reads the daemon's config.json — revoke fallback when status dropped machineId (conflict/crashed). */
  readLocalConfig(): { workerUrl?: string; machineId?: string } | null;
  /** Main-process log sink; never receives tokens or request bodies. */
  /** Fixed structured notes only: no status text, response body, or error value. */
  event?(fields: { event: string; state?: string; code?: number }): void;
  /** Surface-wide concurrency ceiling shared with the rest of the bridge. */
  bounds: IpcBounds;
}

// Native pairing is deferred: the Worker mints tokens for the same authorized
// operator session the renderer uses, so the shell has no separate authority to
// offer. The browser CLI flow is the supported path, and the shell answers a
// pairing request with `pairing_deferred` and a fixed browser direction.

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
      if (!res.ok) deps.event?.({ event: "revoke-stale", state: "failed", code: res.status });
    } catch {
      // offline or signed out: the old row ages out after 7 days
      deps.event?.({ event: "revoke-stale", state: "unreachable" });
    }
  }

  deps.ipcMain.handle(DESKTOP_CHANNELS.status, (event): DesktopStatus => {
    if (!trusted(event)) throw new Error("Untrusted sender.");
    return deps.supervisor.status();
  });

  deps.ipcMain.handle(DESKTOP_CHANNELS.pair, async (event): Promise<PairResult> => {
    if (!trusted(event)) return failure("untrusted_sender");
    // No listener, no mint, no token: the browser flow is the supported path.
    return failure("pairing_deferred");
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
          deps.event?.({ event: "revoke", state: "failed", code: res.status });
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
    // A deployment change shares the connection label with unpair, so it waits
    // instead of pointing the daemon at a host that is being disconnected.
    return singleFlight(connectionChange, async () => (await deps.onSetUrl?.(origin)) ?? { ok: true });
  });
  // Native tray actions use the same serialized, origin-bound operation.
  return { unpair };
}
