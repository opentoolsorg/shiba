// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { DesktopStatus, ShibaDesktopBridge } from "@shiba/shared";
import { RemoteAccessView } from "./RemoteAccessView";

const mint = "/api/computers/pairing-token";

function stubFetch(status: number, body: unknown = { computers: [] }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      calls.push(url);
      if (url.includes(mint)) return Response.json({ token: "t", expiresAt: Date.now() + 60_000, connectCommand: "pair me" });
      if (url.includes("/api/whoami")) return Response.json({ agent: "owner" });
      if (url.includes("/api/computers")) return status === 200 ? Response.json(body) : new Response(null, { status });
      return new Response(null, { status: 404 });
    }),
  );
  return calls;
}

/** Today's shell: a bridge with the capability list the preload ships. */
function currentBridge(s: DesktopStatus): ShibaDesktopBridge {
  return {
    bridgeVersion: 1,
    appVersion: "0.1.0",
    platform: "darwin",
    surface: "dashboard",
    capabilities: ["status", "unpair", "onStatus", "claudeLogin"],
    status: async () => s,
    pair: async () => ({ ok: false as const, code: "pairing_deferred" as const }),
    unpair: async () => ({ ok: true as const }),
    onStatus: () => () => {},
    startClaudeLogin: async () => ({ ok: true as const }),
  } as unknown as ShibaDesktopBridge;
}

/** An older preload: same bridge, no capability list at all. */
function legacyBridge(s: DesktopStatus): ShibaDesktopBridge {
  return {
    bridgeVersion: 1,
    appVersion: "0.0.9",
    platform: "darwin",
    status: async () => s,
    pair: async () => ({ ok: false as const, code: "pairing_deferred" as const }),
    unpair: async () => ({ ok: true as const }),
    onStatus: () => () => {},
    startClaudeLogin: async () => ({ ok: true as const }),
  } as unknown as ShibaDesktopBridge;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { shibaDesktop?: unknown }).shibaDesktop;
});

describe("RemoteAccessView inside Electron", () => {
  it.each([
    ["current bridge", currentBridge],
    ["legacy bridge without capabilities", legacyBridge],
  ])("never mints or shows the CLI modal (%s)", async (_name, make) => {
    (window as unknown as { shibaDesktop?: ShibaDesktopBridge }).shibaDesktop = make({ state: "unpaired" });
    const calls = stubFetch(200);
    render(<RemoteAccessView />);
    await waitFor(() => expect(screen.getByText(/No computers paired/i)).toBeTruthy());

    // No add button, no dialog, and the browser direction is what the page says.
    expect(screen.queryByRole("button", { name: "Add computer" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByText(/open this Shiba in your browser/i).length).toBeGreaterThan(0);
    expect(calls.some((u) => u.includes(mint))).toBe(false);
  });

  it("keeps the shell free of a mint path even when a token was in flight", async () => {
    (window as unknown as { shibaDesktop?: ShibaDesktopBridge }).shibaDesktop = currentBridge({ state: "unpaired" });
    const calls = stubFetch(200);
    render(<RemoteAccessView />);
    await waitFor(() => expect(screen.getByText(/No computers paired/i)).toBeTruthy());
    // Nothing on the page can reach the mint endpoint: no control exists for it.
    const buttons = screen.queryAllByRole("button").map((b) => b.textContent ?? "");
    expect(buttons.join(" ")).not.toMatch(/Add computer/i);
    expect(calls.filter((u) => u.includes(mint))).toHaveLength(0);
  });
});

describe("RemoteAccessView in a plain browser", () => {
  it("mints on Add computer and shows the command", async () => {
    stubFetch(200);
    render(<RemoteAccessView />);
    await waitFor(() => expect(screen.getByText(/No computers paired/i)).toBeTruthy());
    const add = screen.getByRole("button", { name: "Add computer" });
    add.click();
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText("pair me")).toBeTruthy();
    expect(screen.queryByText(/open this Shiba in your browser/i)).toBeNull();
  });
});
