import { describe, expect, it, vi } from "vitest";
import { createController } from "../src/controller.js";
import type { ChildLike, ControllerDeps, LocalConfig } from "../src/controller.js";

const ORIGIN = "https://shiba.example.com";

function setup(opts: { code?: number | "throw"; local?: LocalConfig | null } = {}) {
  const children: Array<{ child: ChildLike; hooks: Parameters<ControllerDeps["fork"]>[1]; args: string[]; killed: boolean }> = [];
  const statuses: string[] = [];
  const timers: Array<() => void> = [];
  const state = { code: opts.code ?? 200, local: opts.local === undefined ? { workerUrl: ORIGIN, machineId: "m1" } : opts.local };
  const deps: ControllerDeps = {
    getOrigin: () => ORIGIN,
    probeFetch: async () => {
      if (state.code === "throw") throw new Error("net");
      return { status: state.code };
    },
    readLocalConfig: () => state.local,
    fork: (args, hooks) => {
      const entry = { args, hooks, killed: false, child: undefined as unknown as ChildLike };
      entry.child = {
        on: () => undefined,
        once: (_e, l) => { (entry as { exitListener?: (c: number | null) => void }).exitListener = l; },
        stderr: null,
        kill: () => {
          entry.killed = true;
          queueMicrotask(() => {
            hooks.onExit(143);
            (entry as { exitListener?: (c: number | null) => void }).exitListener?.(143);
          });
        },
      };
      children.push(entry);
      return entry.child;
    },
    onStatus: (s) => statuses.push(s.state),
    onSettled: vi.fn(),
    log: () => undefined,
    setTimeoutFn: ((fn: () => void) => { timers.push(fn); return timers.length; }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => undefined) as unknown as typeof clearTimeout,
  };
  return { ctl: createController(deps), children, statuses, state, deps, timers };
}

describe("probe state machine", () => {
  it("does not restart from a cookie probe that resolves after stop", async () => {
    const t = setup();
    let resolveProbe!: (result: { status: number }) => void;
    t.deps.probeFetch = () => new Promise((resolve) => { resolveProbe = resolve; });
    const pending = t.ctl.probe();
    await t.ctl.stop();
    resolveProbe({ status: 200 });
    await pending;
    expect(t.children).toHaveLength(0);
    expect(t.timers).toHaveLength(0);
  });

  it("re-probes the selected deployment when an old probe is still pending", async () => {
    const t = setup();
    let origin = ORIGIN;
    let resolveOld!: (result: { status: number }) => void;
    const urls: string[] = [];
    t.deps.getOrigin = () => origin;
    t.deps.probeFetch = (url) => {
      urls.push(url);
      return url.startsWith(ORIGIN)
        ? new Promise((resolve) => { resolveOld = resolve; })
        : Promise.resolve({ status: 200 });
    };
    const oldProbe = t.ctl.probe();
    origin = "https://new.example.com";
    await t.ctl.stop();
    await t.ctl.probe();
    resolveOld({ status: 200 });
    await oldProbe;
    await vi.waitFor(() => expect(t.ctl.status().state).toBe("paired-elsewhere"));
    expect(urls).toEqual([`${ORIGIN}/api/computers`, "https://new.example.com/api/computers"]);
    expect(t.children).toHaveLength(0);
  });

  it("does not let an old404 probe stop a newly paired daemon", async () => {
    const t = setup();
    let resolveProbe!: (result: { status: number }) => void;
    t.deps.probeFetch = () => new Promise((resolve) => { resolveProbe = resolve; });
    const pending = t.ctl.probe();
    await t.ctl.stop();
    t.ctl.forkForPairing(["--connect", ORIGIN, "--pair", "nonce.signature"]);
    resolveProbe({ status: 404 });
    await pending;
    expect(t.children).toHaveLength(1);
    expect(t.children[0]?.killed).toBe(false);
  });

  it("ignores a late probe result after disposal", async () => {
    const t = setup();
    let resolveProbe!: (result: { status: number }) => void;
    t.deps.probeFetch = () => new Promise((resolve) => { resolveProbe = resolve; });
    const pending = t.ctl.probe();
    t.ctl.dispose();
    resolveProbe({ status: 200 });
    await pending;
    expect(t.children).toHaveLength(0);
    expect(t.timers).toHaveLength(0);
  });

  it.each([[401], [302], [0], ["throw" as const]])("%s -> signed-out", async (code) => {
    const t = setup({ code });
    expect((await t.ctl.probe()).state).toBe("signed-out");
    expect(t.children).toHaveLength(0);
  });

  it.each([[405], [500], [503]])("%s keeps the state and retries", async (code) => {
    const t = setup();
    await t.ctl.probe();
    t.state.code = code;
    expect((await t.ctl.probe()).state).toBe("starting");
    expect(t.timers).toHaveLength(1);
  });

  it("404 -> disabled and stops a running daemon", async () => {
    const t = setup();
    await t.ctl.probe();
    t.state.code = 404;
    expect((await t.ctl.probe()).state).toBe("disabled");
    expect(t.children[0]?.killed).toBe(true);
  });

  it("200 with no local config -> unpaired", async () => {
    expect((await setup({ local: null }).ctl.probe()).state).toBe("unpaired");
  });

  it("config for another origin -> paired-elsewhere", async () => {
    const t = setup({ local: { workerUrl: "https://other.example.com/x", machineId: "m9" } });
    expect(await t.ctl.probe()).toMatchObject({ state: "paired-elsewhere", pairedTo: "https://other.example.com", machineId: "m9" });
    expect(t.children).toHaveLength(0);
  });

  it("200 with matching config forks the daemon without args, once", async () => {
    const t = setup();
    await t.ctl.probe();
    await t.ctl.probe();
    expect(t.children).toHaveLength(1);
    expect(t.children[0]?.args).toEqual([]);
    expect(t.ctl.status().state).toBe("starting");
  });

  it("signed-out schedules a re-probe", async () => {
    const t = setup({ code: 401 });
    await t.ctl.probe();
    expect(t.timers).toHaveLength(1);
  });
});

describe("daemon messages and exits", () => {
  it("translates polling/claimed/settled/heartbeat", async () => {
    const t = setup();
    await t.ctl.probe();
    const { onMessage } = t.children[0]!.hooks;
    onMessage({ type: "status", state: "polling", machineId: "m1", harnesses: ["claude"] });
    expect(t.ctl.status()).toMatchObject({ state: "idle", machineId: "m1", harnesses: ["claude"] });
    onMessage({ type: "status", state: "claimed", runId: "r1", harness: "claude", repoUrl: "https://github.com/o/r" });
    expect(t.ctl.status()).toMatchObject({ state: "busy", activeRunId: "r1", detail: "o/r" });
    onMessage({ type: "status", state: "settled", runId: "r1", status: "ok", exitCode: 0, repoUrl: "https://github.com/o/r", posted: true });
    expect(t.ctl.status().state).toBe("idle");
    expect(t.deps.onSettled).toHaveBeenCalledOnce();
    onMessage({ type: "status", state: "heartbeat", ok: false });
    // §3.4 + REVIEW3 F8: offline needs 2 consecutive failed heartbeats.
    expect(t.ctl.status().state).toBe("idle");
    onMessage({ type: "status", state: "heartbeat", ok: false });
    expect(t.ctl.status().state).toBe("offline");
    onMessage({ type: "status", state: "heartbeat", ok: true });
    expect(t.ctl.status().state).toBe("idle");
  });

  it.each([[78, "revoked"], [75, "conflict"], [130, "offline"]])("exit %s -> %s", async (code, expected) => {
    const t = setup();
    await t.ctl.probe();
    t.children[0]!.hooks.onExit(code);
    expect(t.ctl.status().state).toBe(expected);
    expect(t.timers).toHaveLength(0);
  });

  it("abnormal exit restarts with backoff and no args", async () => {
    const t = setup();
    await t.ctl.probe();
    t.children[0]!.hooks.onExit(1);
    expect(t.ctl.status().state).toBe("offline");
    t.timers.at(-1)!();
    expect(t.children).toHaveLength(2);
    expect(t.children[1]?.args).toEqual([]);
  });

  it("pairing fork exiting before polling re-probes instead of restarting", async () => {
    const t = setup({ local: null });
    await t.ctl.probe();
    t.ctl.forkForPairing(["--connect", ORIGIN, "--pair", "a.b"]);
    t.children[0]!.hooks.onExit(1);
    await vi.waitFor(() => expect(t.ctl.status().state).toBe("unpaired"));
    expect(t.children).toHaveLength(1);
  });

  it("stop() SIGTERMs and does not restart", async () => {
    const t = setup();
    await t.ctl.probe();
    await t.ctl.stop();
    expect(t.children[0]?.killed).toBe(true);
    expect(t.children).toHaveLength(1);
  });

  it("stop() escalates to SIGKILL by pid when SIGTERM is ignored, then forgets the child", async () => {
    const t = setup();
    const killPid = vi.fn();
    const ctl = createController({ ...t.deps, killPid });
    await ctl.probe();
    const entry = t.children[0]!;
    entry.child.kill = () => { entry.killed = true; };
    entry.child.pid = 4242;
    const stopping = ctl.stop();
    await vi.waitFor(() => expect(t.timers).toHaveLength(1));
    t.timers[0]!(); // QUIT_WAIT_MS elapses with no exit
    await vi.waitFor(() => expect(killPid).toHaveBeenCalledWith(4242));
    t.timers.at(-1)!(); // KILL_WAIT_MS elapses
    await stopping;
    // child is cleared, so the next probe forks a fresh daemon.
    await ctl.probe();
    expect(t.children).toHaveLength(2);
  });

  it("stop() does not SIGKILL a daemon that exits on SIGTERM", async () => {
    const t = setup();
    const killPid = vi.fn();
    const ctl = createController({ ...t.deps, killPid });
    await ctl.probe();
    t.children[0]!.child.pid = 4242;
    await ctl.stop();
    expect(killPid).not.toHaveBeenCalled();
  });

  it.each([[75, "conflict"], [1, "crashed"]])("retry() leaves %s and respawns the daemon", async (code, latched) => {
    const t = setup();
    await t.ctl.probe();
    const exits = latched === "crashed" ? 5 : 1;
    for (let i = 0; i < exits; i++) {
      t.children.at(-1)!.hooks.onExit(code);
      if (i < exits - 1) t.timers.at(-1)!();
    }
    expect(t.ctl.status().state).toBe(latched);
    const forks = t.children.length;
    expect((await t.ctl.retry()).state).toBe("starting");
    expect(t.children).toHaveLength(forks + 1);
    // The crash window was reset: one more abnormal exit restarts instead of re-latching.
    t.children.at(-1)!.hooks.onExit(1);
    expect(t.ctl.status()).toMatchObject({ state: "offline", detail: "restarting in 1s" });
  });

  it("a good heartbeat resets the consecutive-miss count (F8)", async () => {
    const t = setup();
    await t.ctl.probe();
    const { onMessage } = t.children[0]!.hooks;
    onMessage({ type: "status", state: "polling", machineId: "m1", harnesses: [] });
    onMessage({ type: "status", state: "heartbeat", ok: false });
    onMessage({ type: "status", state: "heartbeat", ok: true });
    onMessage({ type: "status", state: "heartbeat", ok: false });
    expect(t.ctl.status().state).toBe("idle");
    onMessage({ type: "status", state: "heartbeat", ok: false });
    expect(t.ctl.status().state).toBe("offline");
  });

  it.each([[78, "revoked"], [75, "conflict"]])(
    "reprobe does not respawn the daemon after exit %s -> %s (REVIEW3 F7)",
    async (code, expected) => {
      const t = setup();
      await t.ctl.probe();
      t.children[0]!.hooks.onExit(code);
      expect(t.ctl.status().state).toBe(expected);
      await t.ctl.probe();
      expect(t.children).toHaveLength(1);
      expect(t.ctl.status().state).toBe(expected);
    },
  );

  it("reprobe does not respawn the daemon while crashed (REVIEW3 F7)", async () => {
    const t = setup();
    await t.ctl.probe();
    // Five abnormal exits inside the window trip the crash budget (§3.4).
    for (let i = 0; i < 5; i++) {
      t.children.at(-1)!.hooks.onExit(1);
      // The 5th exit trips "crashed" and schedules no restart timer — only
      // fire the backoff timer on the first four.
      if (i < 4) t.timers.at(-1)!();
    }
    expect(t.ctl.status().state).toBe("crashed");
    const forks = t.children.length;
    await t.ctl.probe();
    expect(t.children).toHaveLength(forks);
    expect(t.ctl.status().state).toBe("crashed");
  });
});

describe("restart backoff", () => {
  it("a probe during backoff cancels the pending restart (no duplicate daemon)", async () => {
    const t = setup();
    const pending = new Map<number, () => void>();
    let id = 0;
    const ctl = createController({
      ...t.deps,
      setTimeoutFn: ((fn: () => void) => { pending.set(++id, fn); return id; }) as unknown as typeof setTimeout,
      clearTimeoutFn: ((h: number) => { pending.delete(h); }) as unknown as typeof clearTimeout,
    });
    await ctl.probe();
    t.children[0].hooks.onExit(1);
    await ctl.probe();
    expect(t.children).toHaveLength(2);
    for (const fn of [...pending.values()]) fn();
    expect(t.children).toHaveLength(2);
  });
});
