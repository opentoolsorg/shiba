// T63 — desktop:pair/unpair/set-url handler rules (DESKTOP-PLAN §4 D3/D4/D7,
// §11.3 pairing-fork rule: exit before first "polling" = pair failure).
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { isSetupSender, parseDeploymentUrl } from "../src/navigation.js";
import { registerDesktopIpc } from "../src/pairing.js";
import type { ChildLike } from "../src/controller.js";
import type { DesktopIpcDeps, DesktopStatus } from "../src/pairing.js";

const ORIGIN = "https://shiba.example.com";
const SETUP_URL = "file:///app/dist/setup.html";

type FakeChild = ChildLike & EventEmitter & { stderr: EventEmitter };

function fakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stderr = new EventEmitter();
  ee.kill = vi.fn();
  return ee;
}

function makeDeps(overrides: Partial<DesktopIpcDeps> = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const deps: DesktopIpcDeps = {
    ipcMain: {
      handle: (channel: string, fn: (event: never, ...a: never[]) => unknown) => {
        handlers.set(channel, fn as never);
      },
    },
    isTrustedSender: (frame, origin) => frame === `${origin}/app/`,
    supervisor: {
      status: () => ({ state: "unpaired" }) as DesktopStatus,
      stop: vi.fn(),
      forkDaemon: vi.fn(() => fakeChild()),
    },
    isSetupSender: (frame) => isSetupSender(frame, SETUP_URL),
    parseDeploymentUrl: (input) => parseDeploymentUrl(input, false),
    getConfiguredOrigin: () => ORIGIN,
    sessionFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    runRoot: mkdtempSync(join(tmpdir(), "shiba-pair-test-")),
    confirmPairElsewhere: vi.fn(async () => true),
    readLocalConfig: () => null,
    ...overrides,
  };
  return { deps, handlers };
}

const invoke = (
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>,
  channel: string,
  frameUrl: string | undefined,
  ...args: unknown[]
) => handlers.get(channel)!({ senderFrame: { url: frameUrl } }, ...args);

describe("desktop:pair", () => {
  it("rejects an untrusted sender frame (D4)", async () => {
    const { deps, handlers } = makeDeps();
    registerDesktopIpc(deps);
    const res = await invoke(handlers, "desktop:pair", "https://evil.example/x", "aa.bb");
    expect(res).toEqual({ ok: false, error: "Untrusted sender." });
    expect(deps.supervisor.forkDaemon).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-token", "a.b.c", `${"x".repeat(1025)}.y`])(
    "rejects a malformed token %j",
    async (token) => {
      const { deps, handlers } = makeDeps();
      registerDesktopIpc(deps);
      const res = await invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, token);
      expect(res).toEqual({ ok: false, error: "Invalid pairing token." });
      expect(deps.supervisor.forkDaemon).not.toHaveBeenCalled();
    },
  );

  it("stops the daemon, forks with --connect <origin> --pair <token>, resolves on first polling", async () => {
    const child = fakeChild();
    const forkDaemon = vi.fn(() => child);
    const { deps, handlers } = makeDeps({
      supervisor: { status: () => ({ state: "unpaired" }), stop: vi.fn(), forkDaemon },
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.supervisor.stop).toHaveBeenCalled();
    expect(forkDaemon).toHaveBeenCalledWith(["--connect", ORIGIN, "--pair", "nonce.sig"]);
    child.emit("message", { type: "status", state: "polling", machineId: "m1", harnesses: [] });
    expect(await pending).toEqual({ ok: true });
  });

  it("resolves {ok:false} with the last stderr line when the pair fork exits first", async () => {
    const child = fakeChild();
    const { deps, handlers } = makeDeps({
      supervisor: { status: () => ({ state: "unpaired" }), stop: vi.fn(), forkDaemon: () => child },
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    child.stderr!.emit("data", "shiba-local: pairing token expired, reused, or invalid — mint a new one\n");
    child.emit("exit", 1);
    expect(await pending).toEqual({
      ok: false,
      error: "pairing token expired, reused, or invalid — mint a new one",
    });
  });

  it("rejects a concurrent submit without killing the in-progress pair fork", async () => {
    const child = fakeChild();
    const forkDaemon = vi.fn(() => child);
    const { deps, handlers } = makeDeps({
      supervisor: { status: () => ({ state: "unpaired" }), stop: vi.fn(), forkDaemon },
    });
    registerDesktopIpc(deps);
    const first = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    expect(await invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig")).toEqual({
      ok: false,
      error: "Pairing already in progress.",
    });
    expect(deps.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(forkDaemon).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit("message", { type: "status", state: "polling", machineId: "m1", harnesses: [] });
    expect(await first).toEqual({ ok: true });
    // The guard releases once the first pairing settles.
    const again = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    expect(forkDaemon).toHaveBeenCalledTimes(2);
    child.emit("message", { type: "status", state: "polling", machineId: "m1", harnesses: [] });
    expect(await again).toEqual({ ok: true });
  });

  it("asks for confirmation when already paired-elsewhere and honours a cancel", async () => {
    const confirmPairElsewhere = vi.fn(async () => false);
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "paired-elsewhere", pairedTo: "https://other.example.com" }),
        stop: vi.fn(),
        forkDaemon: vi.fn(() => fakeChild()),
      },
      confirmPairElsewhere,
    });
    registerDesktopIpc(deps);
    const res = await invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    expect(confirmPairElsewhere).toHaveBeenCalledWith("https://other.example.com");
    expect(res).toEqual({ ok: false, error: "Pairing cancelled." });
    expect(deps.supervisor.forkDaemon).not.toHaveBeenCalled();
  });

  const LOCAL_HERE = { workerUrl: ORIGIN, machineId: "old-id" };
  const polling = { type: "status", state: "polling", machineId: "new-id", harnesses: [] };

  it("revokes the old machineId after the new pairing lands, and stop() comes first (§11.3)", async () => {
    const order: string[] = [];
    const child = fakeChild();
    let live: DesktopStatus = { state: "idle", machineId: "old-id" };
    const { deps, handlers } = makeDeps({
      readLocalConfig: () => LOCAL_HERE,
      sessionFetch: vi.fn(async (url: string, init?: RequestInit) => {
        order.push(`fetch ${url} ${init?.body}`);
        return new Response("{}", { status: 200 });
      }),
      supervisor: {
        status: () => live,
        stop: vi.fn(() => {
          order.push("stop");
          live = { state: "unpaired" };
        }),
        forkDaemon: vi.fn(() => {
          order.push("fork");
          return child;
        }),
      },
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["stop", "fork"]);
    child.emit("message", polling);
    expect(await pending).toEqual({ ok: true });
    expect(order).toEqual(["stop", "fork", `fetch ${ORIGIN}/api/computers/revoke {"machineId":"old-id"}`]);
  });

  it("re-probes after a successful pair so the bridge resyncs", async () => {
    const child = fakeChild();
    const probe = vi.fn();
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "unpaired" }),
        stop: vi.fn(),
        forkDaemon: () => child,
        probe,
      },
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    child.emit("message", polling);
    expect(await pending).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("keeps the old pairing untouched when the new pair fails", async () => {
    const child = fakeChild();
    const { deps, handlers } = makeDeps({
      readLocalConfig: () => LOCAL_HERE,
      supervisor: { status: () => ({ state: "idle", machineId: "old-id" }), stop: vi.fn(), forkDaemon: () => child },
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    child.emit("exit", 1);
    expect((await pending) as { ok: boolean }).toMatchObject({ ok: false });
    expect(deps.sessionFetch).not.toHaveBeenCalled();
  });

  it("falls back to config.json's machineId when the status dropped it", async () => {
    const child = fakeChild();
    const { deps, handlers } = makeDeps({
      readLocalConfig: () => ({ workerUrl: ORIGIN, machineId: "cfg-id" }),
      supervisor: { status: () => ({ state: "unpaired" }), stop: vi.fn(), forkDaemon: () => child },
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    child.emit("message", polling);
    await pending;
    expect(deps.sessionFetch).toHaveBeenCalledWith(
      `${ORIGIN}/api/computers/revoke`,
      expect.objectContaining({ body: JSON.stringify({ machineId: "cfg-id" }) }),
    );
  });

  it("still returns ok when the revoke call fails", async () => {
    const child = fakeChild();
    const { deps, handlers } = makeDeps({
      readLocalConfig: () => LOCAL_HERE,
      sessionFetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      supervisor: { status: () => ({ state: "idle", machineId: "old-id" }), stop: vi.fn(), forkDaemon: () => child },
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    child.emit("message", polling);
    expect(await pending).toEqual({ ok: true });
  });

  it("logs a non-ok revoke status without the token and still returns ok", async () => {
    const child = fakeChild();
    const log = vi.fn();
    const { deps, handlers } = makeDeps({
      readLocalConfig: () => LOCAL_HERE,
      sessionFetch: vi.fn(async () => new Response("{}", { status: 500 })),
      supervisor: { status: () => ({ state: "idle", machineId: "old-id" }), stop: vi.fn(), forkDaemon: () => child },
      log,
    });
    registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((r) => setTimeout(r, 0));
    child.emit("message", polling);
    expect(await pending).toEqual({ ok: true });
    expect(log).toHaveBeenCalledWith("re-pair: revoke returned 500");
    expect(JSON.stringify(log.mock.calls)).not.toContain("nonce.sig");
  });

  it("does not revoke when unpaired, paired to another origin, or config.json is for another origin", async () => {
    const cases: Partial<DesktopIpcDeps>[] = [
      {},
      {
        readLocalConfig: () => ({ workerUrl: "https://other.example.com", machineId: "other-id" }),
        supervisor: {
          status: () => ({ state: "paired-elsewhere", machineId: "other-id", pairedTo: "https://other.example.com" }),
          stop: vi.fn(),
          forkDaemon: () => fakeChild(),
        },
      },
      {
        readLocalConfig: () => ({ workerUrl: "https://other.example.com", machineId: "other-id" }),
        supervisor: { status: () => ({ state: "idle", machineId: "other-id" }), stop: vi.fn(), forkDaemon: () => fakeChild() },
      },
    ];
    for (const overrides of cases) {
      const child = fakeChild();
      const { deps, handlers } = makeDeps({
        ...overrides,
        supervisor: { ...(overrides.supervisor ?? { status: () => ({ state: "unpaired" }), stop: vi.fn() }), forkDaemon: () => child },
      });
      registerDesktopIpc(deps);
      const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
      await new Promise((r) => setTimeout(r, 0));
      child.emit("message", polling);
      await pending;
      expect(deps.sessionFetch).not.toHaveBeenCalled();
    }
  });

  it("kills a hung pair fork and resolves after pairTimeoutMs (REVIEW3 F9)", async () => {
    const child = fakeChild();
    const { deps, handlers } = makeDeps({
      pairTimeoutMs: 10,
      supervisor: { status: () => ({ state: "unpaired" }), stop: vi.fn(), forkDaemon: () => child },
    });
    registerDesktopIpc(deps);
    const res = await invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    expect(res).toEqual({ ok: false, error: "pairing timed out" });
    expect(child.kill).toHaveBeenCalled();
  });
});

describe("desktop:unpair", () => {
  it("refuses cross-origin revocation and preserves the pairing config", async () => {
    const { deps, handlers } = makeDeps({
      readLocalConfig: () => ({ workerUrl: "https://other.example.com", machineId: "other-machine" }),
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`)).toEqual({
      ok: false, error: "Switch to the paired Shiba URL before disconnecting this computer.",
    });
    expect(deps.sessionFetch).not.toHaveBeenCalled();
    expect(deps.supervisor.stop).not.toHaveBeenCalled();
    expect(existsSync(join(deps.runRoot, "config.json"))).toBe(true);
  });

  it("keeps config and resumes probing after a revoke network failure", async () => {
    const probe = vi.fn();
    const { deps, handlers } = makeDeps({
      supervisor: { status: () => ({ state: "idle", machineId: "m1" }), stop: vi.fn(), forkDaemon: () => fakeChild(), probe },
      sessionFetch: vi.fn(async () => { throw new Error("offline"); }),
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`)).toEqual({
      ok: false, error: "Could not revoke this computer. Check the connection and retry.",
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(existsSync(join(deps.runRoot, "config.json"))).toBe(true);
  });

  it("serializes pairing, native disconnect, renderer unpair and deployment changes together", async () => {
    const child = fakeChild();
    const onSetUrl = vi.fn();
    const { deps, handlers } = makeDeps({
      onSetUrl,
      supervisor: { status: () => ({ state: "unpaired" }), stop: vi.fn(), forkDaemon: () => child },
    });
    const native = registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await native.unpair()).toMatchObject({ ok: false });
    expect(await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`)).toMatchObject({ ok: false });
    expect(await invoke(handlers, "desktop:set-url", SETUP_URL, "https://new.example.com")).toMatchObject({ ok: false });
    expect(deps.supervisor.stop).toHaveBeenCalledOnce();
    expect(onSetUrl).not.toHaveBeenCalled();
    child.emit("message", { type: "status", state: "polling" });
    expect(await pending).toEqual({ ok: true });
  });

  it("revokes, stops the daemon, and deletes config.json", async () => {
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "idle", machineId: "mach-1" }),
        stop: vi.fn(),
        forkDaemon: vi.fn(() => fakeChild()),
      },
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    const res = await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`);
    expect(res).toEqual({ ok: true });
    expect(deps.sessionFetch).toHaveBeenCalledWith(
      `${ORIGIN}/api/computers/revoke`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse((deps.sessionFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string)).toEqual({
      machineId: "mach-1",
    });
    expect(deps.supervisor.stop).toHaveBeenCalled();
    expect(existsSync(join(deps.runRoot, "config.json"))).toBe(false);
  });

  it("returns the revoke failure, keeps the daemon config and re-probes", async () => {
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "idle", machineId: "mach-1" }),
        stop: vi.fn(),
        forkDaemon: vi.fn(() => fakeChild()),
        probe: vi.fn(),
      },
      sessionFetch: vi.fn(async () => new Response("nope", { status: 500 })),
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    const res = await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`);
    expect(res).toEqual({ ok: false, error: "Revoke failed with 500." });
    expect(deps.supervisor.probe).toHaveBeenCalledTimes(1);
    expect(existsSync(join(deps.runRoot, "config.json"))).toBe(true);
  });

  it("stops the daemon before revoking so a mid-run settle still authenticates", async () => {
    const order: string[] = [];
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "busy", machineId: "mach-1" }),
        stop: vi.fn(async () => { order.push("stop"); }),
        forkDaemon: vi.fn(() => fakeChild()),
      },
      sessionFetch: vi.fn(async () => { order.push("revoke"); return new Response("{}", { status: 200 }); }),
    });
    registerDesktopIpc(deps);
    await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`);
    expect(order).toEqual(["stop", "revoke"]);
  });

  it("rejects a concurrent unpair while the first is still stopping the daemon", async () => {
    let releaseStop!: () => void;
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "idle", machineId: "mach-1" }),
        stop: vi.fn(() => new Promise<void>((r) => { releaseStop = r; })),
        forkDaemon: vi.fn(() => fakeChild()),
      },
    });
    registerDesktopIpc(deps);
    const first = invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`);
    expect(await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`)).toEqual({
      ok: false,
      error: "Pairing already in progress.",
    });
    releaseStop();
    expect(await first).toEqual({ ok: true });
    expect(deps.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(deps.sessionFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to config.json's machineId when the status dropped it (REVIEW3 F5)", async () => {
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "crashed" }),
        stop: vi.fn(),
        forkDaemon: vi.fn(() => fakeChild()),
      },
      readLocalConfig: () => ({ workerUrl: ORIGIN, machineId: "mach-disk" }),
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    const res = await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`);
    expect(res).toEqual({ ok: true });
    expect(
      JSON.parse((deps.sessionFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string),
    ).toEqual({ machineId: "mach-disk" });
  });
});

describe("desktop:set-url", () => {
  it("accepts only the bundled setup.html frame and an https/loopback URL, passing the origin on", async () => {
    const onSetUrl = vi.fn();
    const { deps, handlers } = makeDeps({ onSetUrl });
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:set-url", SETUP_URL, "https://a.example.com/app?x=1")).toEqual({ ok: true });
    expect(onSetUrl).toHaveBeenCalledWith("https://a.example.com");
    expect(await invoke(handlers, "desktop:set-url", `${ORIGIN}/app/`, "https://a.example.com")).toMatchObject({ ok: false });
    expect(await invoke(handlers, "desktop:set-url", "file:///tmp/evil/setup.html", "https://a.example.com")).toMatchObject({ ok: false });
    expect(await invoke(handlers, "desktop:set-url", SETUP_URL, "http://evil.example.com")).toMatchObject({ ok: false });
    expect(onSetUrl).toHaveBeenCalledTimes(1);
  });

  it("rejects http loopback when packaged", async () => {
    const onSetUrl = vi.fn();
    const { deps, handlers } = makeDeps({ onSetUrl, parseDeploymentUrl: (i) => parseDeploymentUrl(i, true) });
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:set-url", SETUP_URL, "http://localhost:5173")).toMatchObject({ ok: false });
    expect(onSetUrl).not.toHaveBeenCalled();
  });

  it("returns the PairResult from onSetUrl", async () => {
    const { deps, handlers } = makeDeps({ onSetUrl: () => ({ ok: false, error: "nope" }) });
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:set-url", SETUP_URL, "https://a.example.com")).toEqual({ ok: false, error: "nope" });
  });
});

describe("desktop:status", () => {
  it("returns the supervisor status for a trusted sender and throws otherwise", () => {
    const { deps, handlers } = makeDeps();
    registerDesktopIpc(deps);
    expect(invoke(handlers, "desktop:status", `${ORIGIN}/app/`)).toEqual({ state: "unpaired" });
    expect(() => invoke(handlers, "desktop:status", "https://evil.example/")).toThrow("Untrusted sender.");
  });
});
