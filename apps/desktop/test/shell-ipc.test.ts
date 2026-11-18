import { describe, expect, it, vi } from "vitest";
import { ALLOWED_CHANNELS, DESKTOP_CHANNELS } from "../src/bridge-contract.js";
import { createIpcBounds } from "../src/ipc-guard.js";
import { registerShellIpc, type ShellIpcDeps } from "../src/shell-ipc.js";

const ORIGIN = "https://app.tryshiba.dev";

function makeDeps(overrides: Partial<ShellIpcDeps> = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const deps: ShellIpcDeps = {
    ipcMain: {
      handle: (channel: string, fn: (event: never, ...args: never[]) => unknown) => {
        handlers.set(channel, fn as never);
      },
    },
    isTrustedSender: (frame, origin) => frame === `${origin}/app/`,
    getConfiguredOrigin: () => ORIGIN,
    bounds: createIpcBounds(2),
    startClaudeLogin: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
  registerShellIpc(deps);
  return { deps, handlers };
}

const invoke = (
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>,
  channel: string,
  frameUrl: string | undefined,
  ...args: unknown[]
) => handlers.get(channel)?.({ senderFrame: { url: frameUrl } }, ...args);

describe("shell ipc", () => {
  it("registers only allowlisted channels", () => {
    const { handlers } = makeDeps();
    for (const channel of handlers.keys()) expect(ALLOWED_CHANNELS).toContain(channel);
    expect(handlers.has("desktop:show-diff")).toBe(false);
    expect(handlers.has("desktop:open-pr")).toBe(false);
    expect(handlers.has("desktop:codex-callback")).toBe(false);
  });

  it("rejects an untrusted sender without starting a login", async () => {
    const { deps, handlers } = makeDeps();
    expect(await invoke(handlers, DESKTOP_CHANNELS.claudeLogin, "https://evil.example/")).toEqual({
      ok: false,
      error: "Untrusted sender.",
    });
    expect(deps.startClaudeLogin).not.toHaveBeenCalled();
  });

  it("keeps a second concurrent login out instead of spawning a second process", async () => {
    let release: (value: { ok: true }) => void = () => {};
    const startClaudeLogin = vi.fn(
      () => new Promise<{ ok: true }>((resolve) => { release = resolve; }),
    );
    const { handlers } = makeDeps({ startClaudeLogin });
    const first = invoke(handlers, DESKTOP_CHANNELS.claudeLogin, `${ORIGIN}/app/`);
    expect(await invoke(handlers, DESKTOP_CHANNELS.claudeLogin, `${ORIGIN}/app/`)).toEqual({
      ok: false,
      error: "Claude sign-in is already running on this computer.",
    });
    release({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(startClaudeLogin).toHaveBeenCalledTimes(1);
  });

  it("releases the exclusive lock so a later sign-in still runs", async () => {
    const { handlers } = makeDeps();
    expect(await invoke(handlers, DESKTOP_CHANNELS.claudeLogin, `${ORIGIN}/app/`)).toEqual({ ok: true });
    expect(await invoke(handlers, DESKTOP_CHANNELS.claudeLogin, `${ORIGIN}/app/`)).toEqual({ ok: true });
  });
});
