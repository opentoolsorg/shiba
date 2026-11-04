// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIntegrationOAuth } from "./integration-oauth";
import type { IntegrationProviderCatalogItem } from "@shiba/shared";
const item: IntegrationProviderCatalogItem = {
  id: "github",
  providerKey: "github",
  name: "GitHub",
  description: "",
  isConnected: false,
  connectable: true,
  source: "openconnector",
  setupState: "ready",
};
const connection = {
  id: "owned-id",
  provider: "openconnector",
  providerKey: "github",
  identityLabel: "Owned account",
  authorizationFingerprint: "a".repeat(64),
};
function popup() {
  return {
    opener: {},
    location: { replace: vi.fn() },
    close: vi.fn(),
    closed: false,
  } as unknown as Window;
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("verified app OAuth reconciliation", () => {
  it("confirms via an owned account read after popup close without a completion message", async () => {
    vi.useFakeTimers();
    const tab = popup();
    vi.spyOn(window, "open").mockReturnValue(tab);
    let begun = false;
    const fetcher = vi.fn(async (path: RequestInfo | URL) =>
      String(path).endsWith("/connect")
        ? (begun = true, Response.json({ ok: true, redirectUrl: "https://oauth.example.test/consent", authorizationFingerprint: connection.authorizationFingerprint }))
        : Response.json({ ok: true, provider: "openconnector", connections: begun ? [connection] : [] }),
    );
    vi.stubGlobal("fetch", fetcher);
    const verified = vi.fn();
    const hook = renderHook(() => useIntegrationOAuth({ actorId: "alice", onVerified: verified }));
    await act(async () => {
      await hook.result.current.beginConnect(item);
    });
    expect(verified).not.toHaveBeenCalled();
    Object.assign(tab, { closed: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(verified).toHaveBeenCalledWith(connection);
    expect(hook.result.current.connectingKey).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => String(path).endsWith("/connect"))).toHaveLength(
      1,
    );
  });
  it("does not treat closing an unsuccessful consent window as a connected account", async () => {
    vi.useFakeTimers();
    const tab = popup();
    vi.spyOn(window, "open").mockReturnValue(tab);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: RequestInfo | URL) =>
        String(path).endsWith("/connect")
          ? Response.json({ ok: true, redirectUrl: "https://oauth.example.test/consent", authorizationFingerprint: connection.authorizationFingerprint })
          : Response.json({ ok: true, provider: "openconnector", connections: [] }),
      ),
    );
    const verified = vi.fn();
    const hook = renderHook(() => useIntegrationOAuth({ actorId: "alice", onVerified: verified }));
    await act(async () => {
      await hook.result.current.beginConnect(item);
    });
    Object.assign(tab, { closed: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(verified).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toContain("No connected account was confirmed");
    expect(hook.result.current.connectingKey).toBeNull();
  });
  it("closes and aborts actor A's pending authorization on an actor switch", async () => {
    let resolve!: (value: Response) => void;
    const tab = popup();
    vi.spyOn(window, "open").mockReturnValue(tab);
    const fetcher = vi.fn(
      (_path: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const verified = vi.fn();
    const hook = renderHook(
      ({ actor }) => useIntegrationOAuth({ actorId: actor, onVerified: verified }),
      { initialProps: { actor: "alice" } },
    );
    let action!: Promise<void>;
    act(() => {
      action = hook.result.current.beginConnect(item);
    });
    hook.rerender({ actor: "bob" });
    await act(async () => {
      resolve(Response.json({ ok: true, redirectUrl: "https://oauth.example.test/alice" }));
      await action;
    });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();
  });
  it("never starts unsupported or signed-out connections", async () => {
    const open = vi.spyOn(window, "open");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const hook = renderHook(() => useIntegrationOAuth({ actorId: "alice" }));
    await act(async () => {
      await hook.result.current.beginConnect({
        ...item,
        connectable: false,
        setupState: "unsupported",
      });
    });
    expect(hook.result.current.error).toContain("no verified sign-in path");
    expect(open).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    hook.unmount();
    const signedOut = renderHook(() => useIntegrationOAuth({ actorId: null }));
    await act(async () => {
      await signedOut.result.current.beginConnect(item);
    });
    expect(open).not.toHaveBeenCalled();
  });
  it("refuses old and expired baseline accounts before creating a new authorization", async () => {
    const tab = popup(); vi.spyOn(window, "open").mockReturnValue(tab);
    const fetcher = vi.fn(async () => Response.json({ ok: true, provider: "openconnector", connections: [{ ...connection, connectionState: "reauth_required" }] }));
    vi.stubGlobal("fetch", fetcher);
    const verified = vi.fn(); const hook = renderHook(() => useIntegrationOAuth({ actorId: "alice", onVerified: verified }));
    await act(async () => { await hook.result.current.beginConnect(item); });
    expect(hook.result.current.error).toContain("Disconnect the existing");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(tab.close).toHaveBeenCalled(); expect(verified).not.toHaveBeenCalled();
  });
  it("cannot confirm another consent's new account or reconcile before the authorization responds", async () => {
    vi.useFakeTimers(); const tab = popup(); vi.spyOn(window, "open").mockReturnValue(tab);
    let complete!: (response: Response) => void; let accountAvailable = false;
    const fetcher = vi.fn(async (path: RequestInfo | URL) => String(path).endsWith("/connect") ? new Promise<Response>((resolve) => { complete = resolve; }) : Response.json({ ok: true, provider: "openconnector", connections: accountAvailable ? [{ ...connection, authorizationFingerprint: "b".repeat(64) }] : [] }));
    vi.stubGlobal("fetch", fetcher); const verified = vi.fn(); const hook = renderHook(() => useIntegrationOAuth({ actorId: "alice", onVerified: verified }));
    let action!: Promise<void>; await act(async () => { action = hook.result.current.beginConnect(item); });
    accountAvailable = true; act(() => { window.dispatchEvent(new Event("focus")); }); expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { complete(Response.json({ ok: true, redirectUrl: "https://oauth.example.test/consent", authorizationFingerprint: connection.authorizationFingerprint })); await action; });
    Object.assign(tab, { closed: true }); await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
    expect(verified).not.toHaveBeenCalled(); expect(hook.result.current.notice).toContain("No connected account was confirmed");
  });
});
