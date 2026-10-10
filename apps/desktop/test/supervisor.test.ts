import { describe, expect, it } from "vitest";
import { backoffMs, createRestartPolicy, resolveDaemonPath, shouldConfirmQuit } from "../src/supervisor";

const ctx = (startedAt = 0, over = {}) => ({ pairing: false, sawPolling: true, startedAt, ...over });

describe("restart policy", () => {
  it("78 -> revoked, 75 -> conflict, 130/143 -> stopped; never restart", () => {
    const p = createRestartPolicy();
    expect(p(78, ctx(), 1)).toEqual({ kind: "revoked" });
    expect(p(75, ctx(), 1)).toEqual({ kind: "conflict" });
    expect(p(143, ctx(), 1)).toEqual({ kind: "stopped" });
    expect(p(130, ctx(), 1)).toEqual({ kind: "stopped" });
  });

  it("backs off 1s,2s,4s then caps at 60s", () => {
    expect([1, 2, 3, 4, 7, 8].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 60000, 60000]);
    const p = createRestartPolicy();
    expect(p(1, ctx(), 1000)).toEqual({ kind: "restart", delayMs: 1000 });
    expect(p(1, ctx(), 2000)).toEqual({ kind: "restart", delayMs: 2000 });
    expect(p(1, ctx(), 3000)).toEqual({ kind: "restart", delayMs: 4000 });
  });

  it("5 abnormal exits within 10 min -> crashed", () => {
    const p = createRestartPolicy();
    for (let i = 1; i <= 4; i++) expect(p(1, ctx(), i * 1000).kind).toBe("restart");
    expect(p(1, ctx(), 5000)).toEqual({ kind: "crashed" });
  });

  it("exits spread past 10 min do not crash", () => {
    const p = createRestartPolicy();
    for (let i = 0; i < 8; i++) expect(p(1, ctx(), i * 11 * 60_000).kind).toBe("restart");
  });

  it("a fork healthy for 10 min resets the counter", () => {
    const p = createRestartPolicy();
    for (let i = 1; i <= 4; i++) p(1, ctx(), i * 1000);
    expect(p(1, ctx(0), 10 * 60_000 + 5000)).toEqual({ kind: "restart", delayMs: 1000 });
  });

  it("pairing fork exiting before polling is a failed pairing", () => {
    const p = createRestartPolicy();
    expect(p(1, ctx(0, { pairing: true, sawPolling: false }), 1)).toEqual({ kind: "failed-pairing" });
    expect(p(1, ctx(0, { pairing: true, sawPolling: true }), 2).kind).toBe("restart");
  });

  it("pair watchdog SIGTERM (143) before polling is a failed pairing, not stopped", () => {
    const p = createRestartPolicy();
    expect(p(143, ctx(0, { pairing: true, sawPolling: false }), 1)).toEqual({ kind: "failed-pairing" });
  });
});

describe("helpers", () => {
  it("confirms quit only while busy", () => {
    expect(shouldConfirmQuit("busy")).toBe(true);
    expect(shouldConfirmQuit("idle")).toBe(false);
  });

  it("resolves packaged vs repo daemon path", () => {
    const o = { resourcesPath: "/R", repoRoot: "/repo" };
    expect(resolveDaemonPath({ ...o, packaged: true })).toBe("/R/daemon/shiba-local-daemon.mjs");
    expect(resolveDaemonPath({ ...o, packaged: false })).toBe("/repo/scripts/shiba-local-daemon.mjs");
  });
});
