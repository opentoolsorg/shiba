import { describe, expect, it } from "vitest";
import type { DesktopDaemonState, DesktopStatus } from "@shiba/shared";
import { createLatest, shouldShowConnect, targetMachineFields } from "./desktop-status";

const status = (state: DesktopDaemonState, machineId?: string): DesktopStatus =>
  machineId ? { state, machineId } : { state };

describe("createLatest", () => {
  it("ignores a superseded load result (RemoteAccessView load)", async () => {
    const loads = createLatest();
    const applied: string[] = [];
    const load = async (label: string, delay: number) => {
      const seq = loads.next();
      await new Promise((r) => setTimeout(r, delay));
      if (loads.isLatest(seq)) applied.push(label);
    };
    await Promise.all([load("slow-first", 20), load("fast-second", 1)]);
    expect(applied).toEqual(["fast-second"]);
  });

  it("drops a pulled status when a push arrived during the pull (useDesktopStatus)", async () => {
    const pushes = createLatest();
    let current: string | null = null;
    let resolvePull!: (s: string) => void;
    const seq = pushes.peek();
    const pull = new Promise<string>((r) => { resolvePull = r; }).then((s) => {
      if (pushes.isLatest(seq)) current = s;
    });
    pushes.next();
    current = "pushed";
    resolvePull("pulled-stale");
    await pull;
    expect(current).toBe("pushed");
  });

  it("applies a pull when no push intervened", () => {
    const pushes = createLatest();
    const seq = pushes.peek();
    expect(pushes.isLatest(seq)).toBe(true);
    pushes.next();
    expect(pushes.isLatest(seq)).toBe(false);
  });
});

describe("shouldShowConnect", () => {
  const hidden: DesktopDaemonState[] = ["disabled", "signed-out", "idle", "busy", "starting"];
  const shown: DesktopDaemonState[] = ["unpaired", "paired-elsewhere", "offline", "revoked", "conflict", "crashed"];

  it.each(hidden)("hides for %s", (state) => {
    expect(shouldShowConnect(true, status(state))).toBe(false);
  });
  it.each(shown)("shows for %s", (state) => {
    expect(shouldShowConnect(true, status(state))).toBe(true);
  });
  it("shows with a bridge but no status yet", () => {
    expect(shouldShowConnect(true, null)).toBe(true);
  });
  it.each([...hidden, ...shown])("never shows without a bridge (%s)", (state) => {
    expect(shouldShowConnect(false, status(state))).toBe(false);
  });
  it("never shows without a bridge or status", () => {
    expect(shouldShowConnect(false, null)).toBe(false);
  });
});

describe("targetMachineFields", () => {
  it("adds targetMachineId when machineId exists", () => {
    expect(targetMachineFields(status("idle", "m-1"))).toEqual({ targetMachineId: "m-1" });
  });
  it.each([null, status("idle"), status("idle", "")])("omits the key otherwise (%o)", (s) => {
    expect(targetMachineFields(s)).toEqual({});
    expect("targetMachineId" in targetMachineFields(s)).toBe(false);
  });
});
