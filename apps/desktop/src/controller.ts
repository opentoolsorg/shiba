import type { DaemonStatusMessage, DesktopStatus } from "@shiba/shared";
import { createRestartPolicy, QUIT_WAIT_MS } from "./supervisor.js";
import type { ExitContext } from "./supervisor.js";
import { repoSlug } from "./approvals-poller.js";
import { originOf } from "./navigation.js";

// Electron-free daemon/probe state machine (DESKTOP-PLAN §3.4); main.ts injects fork/fetch/timers.
export const REPROBE_MS = 60_000;
export const KILL_WAIT_MS = 1000;

/** The slice of electron's UtilityProcess the controller and pairing IPC use. */
export interface ChildLike {
  on(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  stderr: { on(event: "data", listener: (chunk: { toString(): string }) => void): unknown } | null;
  kill(): unknown;
  pid?: number;
}

export interface LocalConfig {
  workerUrl?: string;
  machineId?: string;
}

export interface ControllerDeps {
  getOrigin(): string;
  /** session.defaultSession.fetch with credentials:"include", redirect:"manual". */
  probeFetch(url: string): Promise<{ status: number }>;
  readLocalConfig(): LocalConfig | null;
  fork(
    args: string[],
    hooks: { onLog(chunk: string): void; onMessage(msg: unknown): void; onExit(code: number | null): void },
  ): ChildLike;
  onStatus(status: DesktopStatus): void;
  onSettled(msg: Extract<DaemonStatusMessage, { state: "settled" }>): void;
  log(line: string): void;
  /** SIGKILL escalation for a daemon that ignored kill(); defaults to process.kill. */
  killPid?(pid: number): void;
  now?(): number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export function createController(deps: ControllerDeps) {
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  const killPid = deps.killPid ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  let policy = createRestartPolicy();
  let status: DesktopStatus = { state: "signed-out" };
  let child: ChildLike | null = null;
  let ctx: ExitContext | null = null;
  let stopping = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let reprobeTimer: ReturnType<typeof setTimeout> | undefined;
  let probing = false;
  let probeGeneration = 0;
  let probeAgain = false;
  let disposed = false;
  let retry = false;
  let lastIdle: DesktopStatus = { state: "idle" };
  // §3.4: "offline" needs 2 consecutive heartbeat {ok:false}; any other
  // status message proves the daemon is alive and resets the count.
  let heartbeatMisses = 0;

  function set(next: DesktopStatus): void {
    status = next;
    deps.onStatus(status);
  }

  function translate(msg: unknown): void {
    const m = msg as DaemonStatusMessage | null;
    if (m?.type !== "status") return;
    if (m.state !== "heartbeat") heartbeatMisses = 0;
    if (m.state === "polling") {
      if (ctx) ctx.sawPolling = true;
      lastIdle = { state: "idle", machineId: m.machineId, harnesses: m.harnesses };
      set(lastIdle);
    } else if (m.state === "claimed") {
      set({ ...lastIdle, state: "busy", activeRunId: m.runId, detail: repoSlug(m.repoUrl ?? "") });
    } else if (m.state === "settled") {
      set(lastIdle);
      deps.onSettled(m);
    } else if (m.state === "heartbeat" && status.state !== "busy") {
      if (m.ok) {
        heartbeatMisses = 0;
        set(lastIdle);
      } else if (++heartbeatMisses >= 2) {
        set({ ...lastIdle, state: "offline" });
      }
    }
  }

  function handleExit(code: number | null, exited: ChildLike, exitCtx: ExitContext): void {
    if (child !== exited) return;
    child = null;
    ctx = null;
    if (stopping) return;
    const action = policy(code, exitCtx, now());
    deps.log(`daemon exited code=${code} action=${action.kind}`);
    switch (action.kind) {
      case "revoked": set({ state: "revoked", machineId: lastIdle.machineId }); return;
      case "conflict": set({ state: "conflict" }); return;
      case "crashed": set({ state: "crashed", detail: `exit ${code}` }); return;
      case "stopped": set({ state: "offline", detail: "daemon stopped" }); return;
      case "failed-pairing": return void probe();
      case "restart":
        set({ ...lastIdle, state: "offline", detail: `restarting in ${Math.round(action.delayMs / 1000)}s` });
        restartTimer = setT(() => start([]), action.delayMs);
    }
  }

  function start(args: string[]): ChildLike {
    // A probe during restart backoff must not leave the timer to fork a duplicate.
    clearT(restartTimer);
    restartTimer = undefined;
    stopping = false;
    const exitCtx: ExitContext = { pairing: args.includes("--pair"), sawPolling: false, startedAt: now() };
    ctx = exitCtx;
    set({ ...lastIdle, state: "starting" });
    const spawned: ChildLike = deps.fork(args, {
      onLog: (chunk) => deps.log(`daemon: ${chunk.replace(/\n$/, "")}`),
      onMessage: (msg) => { if (child === spawned) translate(msg); },
      onExit: (code) => handleExit(code, spawned, exitCtx),
    });
    child = spawned;
    return spawned;
  }

  async function stop(): Promise<void> {
    // A delayed cookie probe must not restart a daemon after the user stops
    // or replaces its deployment while the request is still in flight.
    probeGeneration += 1;
    probeAgain = false;
    retry = false;
    clearT(reprobeTimer);
    reprobeTimer = undefined;
    clearT(restartTimer);
    const current = child;
    if (!current) return;
    stopping = true;
    const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
    const waitExit = (ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setT(() => resolve(false), ms);
        void exited.then(() => { clearT(timer); resolve(true); });
      });
    current.kill();
    // utilityProcess.kill() takes no signal; a daemon ignoring SIGTERM would outlive the app.
    if (!(await waitExit(QUIT_WAIT_MS)) && current.pid !== undefined) {
      deps.log(`daemon pid=${current.pid} ignored SIGTERM; sending SIGKILL`);
      try {
        killPid(current.pid);
      } catch {
        // already gone
      }
      await waitExit(KILL_WAIT_MS);
    }
    if (child === current) { child = null; ctx = null; }
  }

  /** User "Retry" from conflict/crashed: clear the crash window and latch, then re-probe. */
  function retryDaemon(): Promise<DesktopStatus> {
    policy = createRestartPolicy();
    set({ ...lastIdle, state: "offline", detail: "retrying" });
    return probe();
  }

  function scheduleReprobe(): void {
    clearT(reprobeTimer);
    if (status.state === "signed-out" || retry) reprobeTimer = setT(() => void probe(), REPROBE_MS);
  }

  async function probe(): Promise<DesktopStatus> {
    if (disposed) return status;
    if (probing) { probeAgain = true; return status; }
    probing = true;
    const generation = probeGeneration;
    try {
      const origin = deps.getOrigin();
      if (!origin) { set({ state: "signed-out" }); return status; }
      let code: number;
      try {
        code = (await deps.probeFetch(`${origin}/api/computers`)).status;
      } catch {
        code = 0;
      }
      if (disposed || generation !== probeGeneration) return status;
      if (origin !== deps.getOrigin()) { probeAgain = true; return status; }
      retry = code === 405 || code >= 500;
      if (retry) {
        // 405/5xx are outside §3.4: keep the current state and retry in 60s.
        return status;
      }
      if (code === 404) {
        await stop();
        set({ state: "disabled" });
      } else if (code !== 200) {
        // 401, redirects (opaque/3xx) and network errors all mean "not signed in yet".
        set({ state: "signed-out" });
      } else {
        const local = deps.readLocalConfig();
        if (!local?.workerUrl) {
          await stop();
          set({ state: "unpaired" });
        } else if (originOf(local.workerUrl) !== origin) {
          await stop();
          set({ state: "paired-elsewhere", machineId: local.machineId, pairedTo: originOf(local.workerUrl) });
        } else if (!child) {
          lastIdle = { state: "idle", machineId: local.machineId };
          // revoked/conflict/crashed latch until the user acts (§3.4: no
          // restart) — a reprobe on resume or set-url must not respawn.
          if (status.state !== "revoked" && status.state !== "conflict" && status.state !== "crashed") {
            start([]);
          }
        }
      }
      return status;
    } finally {
      probing = false;
      if (!disposed && probeAgain) {
        probeAgain = false;
        void probe();
      } else if (!disposed && generation === probeGeneration) scheduleReprobe();
    }
  }

  return {
    status: () => status,
    probe,
    stop,
    retry: retryDaemon,
    /** Pairing forks run once; after the first "polling" they are the live daemon. */
    forkForPairing: (args: string[]) => start(args),
    setStatus: set,
    dispose: () => {
      disposed = true;
      probeGeneration += 1;
      probeAgain = false;
      clearT(reprobeTimer);
      clearT(restartTimer);
    },
  };
}

export type Controller = ReturnType<typeof createController>;
