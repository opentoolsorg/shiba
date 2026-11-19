// T63 — desktop:pair/unpair/set-url handler rules (DESKTOP-PLAN §4 D3/D4/D7).
// Native pairing is deferred (§11.3), so the pair handler answers with a fixed
// refusal and the tests below cover only unpair, set-url, and status.
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSetupSender, isTrustedSender, parseDeploymentUrl } from "../src/navigation.js";
import { createIpcBounds } from "../src/ipc-guard.js";
import { registerDesktopIpc } from "../src/pairing.js";
import type { DesktopIpcDeps, DesktopStatus } from "../src/pairing.js";
import { PAIR_FAILURE_MESSAGES } from "@shiba/shared";

const ORIGIN = "https://shiba.example.com";
const SETUP_URL = "file:///app/dist/setup.html";

function makeDeps(overrides: Partial<DesktopIpcDeps> = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const deps: DesktopIpcDeps = {
    ipcMain: {
      handle: (channel: string, fn: (event: never, ...a: never[]) => unknown) => {
        handlers.set(channel, fn as never);
      },
    },
    isTrustedEvent: (event) =>
      isTrustedSender(
        (event as { senderFrame?: { url?: string } }).senderFrame?.url,
        ORIGIN,
      ),
    supervisor: {
      status: () => ({ state: "unpaired" }) as DesktopStatus,
      stop: vi.fn(),
    },
    isSetupEvent: (event) =>
      isSetupSender(
        (event as { senderFrame?: { url?: string } }).senderFrame?.url,
        SETUP_URL,
      ),
    parseDeploymentUrl: (input) => parseDeploymentUrl(input, false),
    getConfiguredOrigin: () => ORIGIN,
    sessionFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    runRoot: mkdtempSync(join(tmpdir(), "shiba-pair-test-")),
    readLocalConfig: () => null,
    bounds: createIpcBounds(),
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
    const res = await invoke(handlers, "desktop:pair", "https://evil.example/x", "renderer.token");
    expect(res).toEqual({ ok: false, code: "untrusted_sender", error: PAIR_FAILURE_MESSAGES.untrusted_sender });
  });

  it("defers native pairing with a fixed browser direction and mints nothing", async () => {
    const { deps, handlers } = makeDeps();
    registerDesktopIpc(deps);
    // A token-shaped argument from the page changes nothing: nothing is minted,
    // nothing forks, and no reply quotes the page's input.
    const res = await invoke(handlers, "desktop:pair", `${ORIGIN}/app/`, "nonce.sig");
    expect(res).toEqual({
      ok: false,
      code: "pairing_deferred",
      error: PAIR_FAILURE_MESSAGES.pairing_deferred,
    });
    expect(deps.supervisor.stop).not.toHaveBeenCalled();
    expect(deps.sessionFetch).not.toHaveBeenCalled();
  });

  it("keeps the browser direction free of the origin and any secret", () => {
    expect(PAIR_FAILURE_MESSAGES.pairing_deferred).not.toContain(ORIGIN);
    expect(PAIR_FAILURE_MESSAGES.pairing_deferred).not.toMatch(/token|bearer|https?:\/\//i);
  });
});

describe("desktop:unpair", () => {
  it("refuses cross-origin revocation and preserves the pairing config", async () => {
    const { deps, handlers } = makeDeps({
      readLocalConfig: () => ({ workerUrl: "https://other.example.com", machineId: "other-machine" }),
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`)).toMatchObject({
      ok: false,
      code: "revoke_unreachable",
    });
    expect(deps.sessionFetch).not.toHaveBeenCalled();
    expect(deps.supervisor.stop).not.toHaveBeenCalled();
    expect(existsSync(join(deps.runRoot, "config.json"))).toBe(true);
  });

  it("keeps config and resumes probing after a revoke network failure", async () => {
    const probe = vi.fn();
    const { deps, handlers } = makeDeps({
      supervisor: { status: () => ({ state: "idle", machineId: "m1" }), stop: vi.fn()
, probe },
      sessionFetch: vi.fn(async () => { throw new Error("offline"); }),
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`)).toMatchObject({
      ok: false,
      code: "revoke_unreachable",
    });
    expect(probe).toHaveBeenCalledOnce();
    expect(existsSync(join(deps.runRoot, "config.json"))).toBe(true);
  });

  it("serializes disconnect and deployment changes behind one connection label", async () => {
    const onSetUrl = vi.fn(async () => ({ ok: true as const }));
    let releaseStop: () => void = () => {};
    const stop = vi.fn(() => new Promise<void>((resolve) => { releaseStop = resolve; }));
    const { deps, handlers } = makeDeps({
      onSetUrl,
      supervisor: { status: () => ({ state: "unpaired" }), stop },
    });
    const native = registerDesktopIpc(deps);
    const pending = invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`) as Promise<unknown>;
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Both the native tray action and a setup-page address change are refused
    // while the disconnect is still stopping the daemon.
    expect(await native.unpair()).toMatchObject({ ok: false, code: "pairing_busy" });
    expect(await invoke(handlers, "desktop:set-url", SETUP_URL, "https://new.example.com")).toMatchObject({
      ok: false,
      code: "pairing_busy",
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(onSetUrl).not.toHaveBeenCalled();
    releaseStop();
    expect(await pending).toEqual({ ok: true });
  });

  it("revokes, stops the daemon, and deletes config.json", async () => {
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "idle", machineId: "mach-1" }),
        stop: vi.fn(),
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
          probe: vi.fn(),
      },
      sessionFetch: vi.fn(async () => new Response("nope", { status: 500 })),
    });
    writeFileSync(join(deps.runRoot, "config.json"), "{}");
    registerDesktopIpc(deps);
    const res = await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`);
    expect(res).toMatchObject({ ok: false, code: "revoke_failed" });
    expect(deps.supervisor.probe).toHaveBeenCalledTimes(1);
    expect(existsSync(join(deps.runRoot, "config.json"))).toBe(true);
  });

  it("stops the daemon before revoking so a mid-run settle still authenticates", async () => {
    const order: string[] = [];
    const { deps, handlers } = makeDeps({
      supervisor: {
        status: () => ({ state: "busy", machineId: "mach-1" }),
        stop: vi.fn(async () => { order.push("stop"); }),
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
        },
    });
    registerDesktopIpc(deps);
    const first = invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`);
    expect(await invoke(handlers, "desktop:unpair", `${ORIGIN}/app/`)).toMatchObject({
      ok: false,
      code: "pairing_busy",
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
    const { deps, handlers } = makeDeps({ onSetUrl: () => ({ ok: false, code: "url_invalid" }) });
    registerDesktopIpc(deps);
    expect(await invoke(handlers, "desktop:set-url", SETUP_URL, "https://a.example.com")).toEqual({
      ok: false,
      code: "url_invalid",
    });
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
