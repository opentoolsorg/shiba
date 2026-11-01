import { join } from "node:path";
import type { UtilityProcess } from "electron";

const WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 5;
const BACKOFF_CAP_MS = 60_000;

export type ExitAction =
  | { kind: "revoked" }
  | { kind: "conflict" }
  | { kind: "stopped" }
  | { kind: "failed-pairing" }
  | { kind: "crashed" }
  | { kind: "restart"; delayMs: number };

export interface ExitContext {
  // Fork was started with --connect/--pair.
  pairing: boolean;
  // Daemon reported its first "polling" message before exiting.
  sawPolling: boolean;
  // When this fork started (ms epoch).
  startedAt: number;
}

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.max(0, attempt - 1));
}

// Stateful: tracks abnormal exits in a sliding 10-minute window.
export function createRestartPolicy() {
  let exits: number[] = [];
  return function onExit(code: number | null, ctx: ExitContext, now: number): ExitAction {
    if (code === 78) return { kind: "revoked" };
    if (code === 75) return { kind: "conflict" };
    if (code === 70) return { kind: "crashed" };
    // Before 130/143: the pair watchdog SIGTERMs a stalled pairing fork.
    if (ctx.pairing && !ctx.sawPolling) return { kind: "failed-pairing" };
    if (code === 130 || code === 143) return { kind: "stopped" };
    // A fork that stayed up 10 min was healthy: forget earlier failures.
    if (now - ctx.startedAt >= WINDOW_MS) exits = [];
    exits = exits.filter((t) => now - t < WINDOW_MS);
    exits.push(now);
    if (exits.length >= CRASH_LIMIT) return { kind: "crashed" };
    return { kind: "restart", delayMs: backoffMs(exits.length) };
  };
}

// Quitting mid-run: main.ts shows a native confirm ("A local run is in progress.
// Quitting stops it and reports it failed"), SIGTERMs the daemon, waits up to
// QUIT_WAIT_MS for its exit, then calls app.exit().
export const QUIT_WAIT_MS = 3000 + 2000;

export function shouldConfirmQuit(state: string): boolean {
  return state === "busy";
}

export function resolveDaemonPath(o: { packaged: boolean; resourcesPath: string; repoRoot: string }): string {
  return o.packaged
    ? join(o.resourcesPath, "daemon", "shiba-local-daemon.mjs")
    : join(o.repoRoot, "scripts", "shiba-local-daemon.mjs");
}

export interface ForkOptions {
  daemonPath: string;
  args: string[];
  env: Record<string, string>;
  onLog(chunk: string): void;
  onMessage(msg: unknown): void;
  onExit(code: number | null): void;
}

// Thin electron wrapper; electron is required lazily so the policy above loads under plain Node.
export function forkDaemon(o: ForkOptions): UtilityProcess {
  const { utilityProcess } = require("electron") as typeof import("electron");
  const child = utilityProcess.fork(o.daemonPath, o.args, {
    env: o.env,
    stdio: "pipe",
    serviceName: "shiba-local-daemon",
  });
  child.stdout?.on("data", (b: Buffer) => o.onLog(b.toString()));
  child.stderr?.on("data", (b: Buffer) => o.onLog(b.toString()));
  child.on("message", o.onMessage);
  child.on("exit", o.onExit);
  return child;
}
