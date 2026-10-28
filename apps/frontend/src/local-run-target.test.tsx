// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectedComputer, DesktopStatus } from "@shiba/shared";
import { LOCAL_HEARTBEAT_STALE_MS } from "@shiba/shared";
import { eligibleLocalComputers, useLocalRunTarget } from "./local-run-target";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const machine = (machineId = "machine-a", extra: Partial<ConnectedComputer> = {}): ConnectedComputer => ({
  machineId, hostname: machineId, platform: "darwin-arm64", daemonVersion: "1.0",
  harnesses: ["opencode", "claude", "codex"], status: "idle", lastHeartbeat: Date.now(), ...extra,
});

describe("authoritative local computer eligibility", () => {
  it("matches daemon harness names without trusting incompatible or subscription-only profiles", () => {
    const rows = [machine("claude", { harnesses: ["claude"] }), machine("codex", { harnesses: ["codex"] })];
    expect(eligibleLocalComputers(rows, "claude-code").map((row) => row.machineId)).toEqual(["claude"]);
    expect(eligibleLocalComputers(rows, "codex").map((row) => row.machineId)).toEqual(["codex"]);
    expect(eligibleLocalComputers(rows, "claude-subscription")).toEqual([]);
    expect(eligibleLocalComputers(rows, "unknown-harness")).toEqual([]);
  });

  it("excludes offline, stale, revoked, malformed and impossible future heartbeats", () => {
    const now = Date.now();
    const rows = [
      machine("idle"), machine("busy", { status: "busy" }),
      machine("offline", { status: "offline" }),
      machine("stale", { lastHeartbeat: now - LOCAL_HEARTBEAT_STALE_MS - 1 }),
      machine("future", { lastHeartbeat: now + LOCAL_HEARTBEAT_STALE_MS + 1 }),
      { ...machine("revoked"), revokedAt: now },
      { ...machine("revoked-flag"), revoked: true },
      machine("invalid-clock", { lastHeartbeat: Number.NaN }),
      { machineId: "invalid-shape" },
    ];
    expect(eligibleLocalComputers(rows, "opencode", now).map((row) => row.machineId)).toEqual(["busy", "idle"]);
  });
});

describe("web and desktop local target selection", () => {
  it("loads a paired web computer without any native bridge and pins its ID", async () => {
    const request = vi.fn(async () => Response.json({ computers: [machine()] }));
    vi.stubGlobal("fetch", request);
    const { result } = renderHook(() => useLocalRunTarget({ harness: "opencode", desktopStatus: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.localRunAvailable).toBe(true);
    expect(result.current.targetMachineId).toBe("machine-a");
    expect(request).toHaveBeenCalledWith("/api/computers", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("does not poll before identity is authenticated", async () => {
    const request = vi.fn(async () => Response.json({ computers: [machine()] }));
    vi.stubGlobal("fetch", request);
    const { result, rerender } = renderHook(({ enabled }) => useLocalRunTarget({ harness: "opencode", desktopStatus: null, enabled }), {
      initialProps: { enabled: false },
    });
    expect(request).not.toHaveBeenCalled();
    expect(result.current.localRunAvailable).toBe(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.targetMachineId).toBe("machine-a"));
  });

  it("does not accept a native bridge's claimed machine without server proof", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [] })));
    const { result } = renderHook(() => useLocalRunTarget({
      harness: "opencode", desktopStatus: { state: "idle", machineId: "forged-native" },
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.localRunAvailable).toBe(false);
    expect(result.current.targetMachineId).toBeUndefined();
  });

  it("requires an explicit computer when the paired fleet is ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [machine("a"), machine("b")] })));
    const { result } = renderHook(() => useLocalRunTarget({ harness: "opencode", desktopStatus: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.localRunAvailable).toBe(true);
    expect(result.current.selectionRequired).toBe(true);
    expect(result.current.targetMachineId).toBeUndefined();
    act(() => result.current.selectMachine("not-listed"));
    expect(result.current.targetMachineId).toBeUndefined();
    act(() => result.current.selectMachine("b"));
    expect(result.current.targetMachineId).toBe("b");
  });

  it("prefers the verified native machine but preserves a user's explicit alternative", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [machine("a"), machine("b")] })));
    const { result, rerender } = renderHook(({ desktopStatus }: { desktopStatus: DesktopStatus | null }) =>
      useLocalRunTarget({ harness: "opencode", desktopStatus }), {
      initialProps: { desktopStatus: { state: "busy", machineId: "a" } as DesktopStatus | null },
    });
    await waitFor(() => expect(result.current.targetMachineId).toBe("a"));
    act(() => result.current.selectMachine("b"));
    rerender({ desktopStatus: { state: "idle", machineId: "a" } });
    expect(result.current.targetMachineId).toBe("b");
  });

  it("never silently retargets to another computer after the selected one disappears", async () => {
    let computers = [machine("a")];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers })));
    const { result } = renderHook(() => useLocalRunTarget({ harness: "opencode", desktopStatus: null }));
    await waitFor(() => expect(result.current.targetMachineId).toBe("a"));
    computers = [machine("b")];
    await act(async () => { await result.current.refresh(); });
    expect(result.current.localRunAvailable).toBe(true);
    expect(result.current.targetMachineId).toBeUndefined();
    expect(result.current.error).toContain("selected computer");
    act(() => result.current.selectMachine("b"));
    expect(result.current.targetMachineId).toBe("b");
  });

  it.each([401, 404, 503])("fails closed after a fleet %s instead of trusting cached availability", async (status) => {
    let failed = false;
    vi.stubGlobal("fetch", vi.fn(async () => failed ? Response.json({}, { status }) : Response.json({ computers: [machine()] })));
    const { result } = renderHook(() => useLocalRunTarget({ harness: "opencode", desktopStatus: null }));
    await waitFor(() => expect(result.current.targetMachineId).toBe("machine-a"));
    failed = true;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.localRunAvailable).toBe(false);
    expect(result.current.targetMachineId).toBeUndefined();
    expect(result.current.error).toBeTruthy();
  });

  it("discards an old identity's fleet request after sign-in changes", async () => {
    let finishOld!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockImplementation(async () => Response.json({ computers: [machine("user-b-machine")] })));
    const { result, rerender } = renderHook(({ identityKey }) => useLocalRunTarget({ harness: "opencode", desktopStatus: null, identityKey }), {
      initialProps: { identityKey: "user-a" },
    });
    rerender({ identityKey: "user-b" });
    await waitFor(() => expect(result.current.targetMachineId).toBe("user-b-machine"));
    await act(async () => { finishOld(Response.json({ computers: [machine("user-a-private-machine")] })); });
    expect(result.current.targetMachineId).toBe("user-b-machine");
  });

  it("expires a heartbeat between network polls", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ computers: [machine("a", { lastHeartbeat: now })] })));
    const { result } = renderHook(() => useLocalRunTarget({ harness: "opencode", desktopStatus: null }));
    await act(async () => {});
    expect(result.current.targetMachineId).toBe("a");
    vi.setSystemTime(now + LOCAL_HEARTBEAT_STALE_MS + 1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(result.current.localRunAvailable).toBe(false);
    expect(result.current.targetMachineId).toBeUndefined();
  });
});
