// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceConnectorsPanel } from "./WorkspaceConnectorsPanel";
import type { IntegrationBindingInputs } from "../integration-connection-bindings";

const bindingInputs: IntegrationBindingInputs = {
  setupLoading: false,
  mailboxCount: 0,
  mailboxLoading: false,
  gmailConnected: false,
  gmailLoading: false,
  externalMcpServerCount: 0,
  externalMcpCatalogConnections: [],
  externalMcpLoading: false,
};
const account = {
  id: "owned-hubspot",
  provider: "openconnector",
  providerKey: "hubspot",
  identityLabel: "Alice HubSpot",
  authorizationFingerprint: "a".repeat(64),
};
const listing = {
  id: "hubspot",
  providerKey: "hubspot",
  name: "HubSpot",
  description: "CRM",
  source: "openconnector",
  isConnected: false,
  connectable: true,
  setupState: "ready",
};
function popup() {
  return {
    opener: {},
    location: { replace: vi.fn() },
    close: vi.fn(),
    closed: false,
  } as unknown as Window;
}
function fixture() {
  let connected = false,
    failure = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/connect"))
      return Response.json({ ok: true, redirectUrl: "https://oauth.example.test/consent", authorizationFingerprint: account.authorizationFingerprint });
    if (path.endsWith("/disconnect")) {
      connected = false;
      return Response.json({ ok: true });
    }
    if (path.includes("/connections"))
      return failure
        ? Response.json({ error: "Account state unavailable" }, { status: 503 })
        : Response.json({
            ok: true,
            provider: "openconnector",
            connections: connected ? [account] : [],
          });
    if (path.endsWith("/meta"))
      return Response.json({
        health: { provider: "openconnector", status: "healthy", checkedAt: 1 },
      });
    return Response.json({ items: [{ ...listing, isConnected: connected }], hasMore: false, nextCursor: null });
  });
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    connected: () => {
      connected = true;
    },
    fail: () => {
      failure = true;
    },
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("owned OpenConnector accounts through normal HTTP paths", () => {
  it("shows the catalog directly instead of burying it beneath MCP credential forms", async () => {
    fixture();
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    expect(screen.getByRole("heading", { name: "Integration catalog" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up MCP servers" }).getAttribute("href")).toBe("/integrations/?tab=mcp");
    expect(screen.queryByText("Custom MCP connections")).toBeNull();
    expect(screen.queryByLabelText("MCP presets for role")).toBeNull();
    expect(await screen.findByText(/provider listings loaded/)).toBeTruthy();
    expect(screen.getByLabelText("Search integrations")).toBeTruthy();
  });
  it("explains missing owner authentication without claiming there are no owned accounts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Authenticated owner required." }, { status: 401 })));
    render(<WorkspaceConnectorsPanel actorId="default" bindingInputs={bindingInputs} />);
    expect((await within(screen.getByRole("region", { name: "Your app accounts" })).findByRole("alert")).textContent).toContain("Sign in to Shiba with a verified user session");
    expect(screen.queryByText(/No owned app accounts confirmed/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Integration catalog" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "GitHub" } });
    expect(screen.getByTestId("integration-catalog-row-github")).toBeTruthy();
  });
  it("reads canonical accounts without fixture mode or a shadow connector registry", async () => {
    const { fetcher, connected } = fixture();
    connected();
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    expect(await screen.findByText(/Alice HubSpot/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to Workspace" })).toBeNull();
    expect(
      fetcher.mock.calls.every(([path]) => !String(path).includes("/extensions/connectors")),
    ).toBe(true);
    expect(screen.getByText(/does not share its credentials, grant employee access/)).toBeTruthy();
  });
  it("starts modal OAuth in the click stack and confirms only a fresh owned account on return", async () => {
    const { fetcher, connected } = fixture();
    const tab = popup();
    const open = vi.spyOn(window, "open").mockReturnValue(tab);
    const changed = vi.fn();
    render(
      <WorkspaceConnectorsPanel
        actorId="alice"
        bindingInputs={bindingInputs}
        onChanged={changed}
      />,
    );
    fireEvent.click(
      within(screen.getByRole("region", { name: "Your app accounts" })).getByRole("button", {
        name: "Browse catalog",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Browse integration catalog" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Connect" }));
    expect(open).toHaveBeenCalledWith("about:blank", "_blank", "width=520,height=720");
    expect(tab.opener).toBeNull();
    await waitFor(() =>
      expect(tab.location.replace).toHaveBeenCalledWith("https://oauth.example.test/consent"),
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByText(/Alice HubSpot/)).toBeNull();
    connected();
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Alice HubSpot/)).toBeTruthy();
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Connect" })).toBeNull());
    expect(within(dialog).getByText("Account configured")).toBeTruthy();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(
      fetcher.mock.calls.every(([path]) => !String(path).includes("/extensions/connectors")),
    ).toBe(true);
  });
  it("shows a blocked-popup error inside the catalog dialog", async () => {
    fixture();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Your app accounts" })).getByRole("button", { name: "Browse catalog" }));
    const dialog = await screen.findByRole("dialog", { name: "Browse integration catalog" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Connect" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Popup blocked. Allow popups for Shiba, then try connecting again.");
  });
  it("does not create an authorization when popups are blocked", async () => {
    const { fetcher } = fixture();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    fireEvent.change(screen.getByLabelText("Search integrations"), {
      target: { value: "HubSpot" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Connect app" }));
    expect(await screen.findByText(/Popup blocked/)).toBeTruthy();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
  it("clears old accounts after a failed refresh rather than preserving connected badges", async () => {
    const { connected, fail } = fixture();
    connected();
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    await screen.findByText(/Alice HubSpot/);
    fail();
    fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
    await screen.findByRole("alert");
    expect(screen.queryByText(/Alice HubSpot/)).toBeNull();
  });
  it("disconnects the owned provider explicitly and does not invoke registry mutations or tools", async () => {
    const { connected, fetcher } = fixture();
    connected();
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    const button = await screen.findByRole("button", { name: "Disconnect hubspot" });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText(/hubspot disconnected/);
    expect(
      fetcher.mock.calls.filter(([path]) => String(path).endsWith("/disconnect")),
    ).toHaveLength(1);
    expect(screen.queryByText(/Alice HubSpot/)).toBeNull();
    expect(fetcher.mock.calls.some(([path]) => String(path).includes("/execute"))).toBe(false);
  });
  it("hides account A immediately and ignores its delayed response after an actor switch", async () => {
    let resolve!: (response: Response) => void;
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: RequestInfo | URL) =>
        String(path).includes("/connections")
          ? first
            ? ((first = false),
              new Promise<Response>((done) => {
                resolve = done;
              }))
            : Response.json({ ok: true, provider: "openconnector", connections: [] })
          : Response.json({ items: [], hasMore: false }),
      ),
    );
    const view = render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    view.rerender(<WorkspaceConnectorsPanel actorId="bob" bindingInputs={bindingInputs} />);
    await act(async () => {
      resolve(Response.json({ ok: true, provider: "openconnector", connections: [account] }));
    });
    expect(screen.queryByText(/Alice HubSpot/)).toBeNull();
  });
  it("shows expired owned accounts only for explicit recovery, without claiming employee readiness", async () => {
    let present = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/disconnect")) { present = false; return Response.json({ ok: true }); }
      if (path.includes("/connections")) return Response.json({ ok: true, provider: "openconnector", connections: path.includes("includeUnavailable=1") && present ? [{ ...account, connectionState: "reauth_required", executionReady: false, unavailableReason: "Disconnect this expired account before signing in again." }] : [] });
      return Response.json(path.endsWith("/meta") ? { health: { provider: "openconnector", status: "healthy", checkedAt: 1 } } : { items: [listing], hasMore: false });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    expect(await screen.findByText(/Sign-in expired/)).toBeTruthy();
    expect(screen.getByText("Disconnect this expired account before signing in again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect hubspot" }));
    await screen.findByText(/hubspot disconnected/); expect(screen.queryByText(/Sign-in expired/)).toBeNull();
    expect(fetcher.mock.calls.some(([path]) => String(path).endsWith("/execute"))).toBe(false);
  });
  it.each(["browse", "inline"])("replaces a disconnect notice with verified reconnect status from %s", async (entrypoint) => {
    const { connected } = fixture(); connected();
    const tab = popup(); vi.spyOn(window, "open").mockReturnValue(tab);
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    if (entrypoint === "inline") {
      fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "HubSpot" } });
      await screen.findByText("Account configured");
    }
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect hubspot" }));
    await screen.findByText(/hubspot disconnected/);
    if (entrypoint === "browse") {
      fireEvent.click(within(screen.getByRole("region", { name: "Your app accounts" })).getByRole("button", { name: "Browse catalog" }));
      const dialog = await screen.findByRole("dialog", { name: "Browse integration catalog" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Connect" }));
    } else {
      fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "HubSpot" } });
      fireEvent.click(await screen.findByRole("button", { name: "Connect app" }));
    }
    expect(screen.queryByText(/hubspot disconnected/)).toBeNull();
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith("https://oauth.example.test/consent"));
    connected(); fireEvent(window, new Event("focus"));
    expect(await within(screen.getByRole("region", { name: "Your app accounts" })).findByText(/hubspot account confirmed/)).toBeTruthy();
    expect(screen.queryByText(/hubspot disconnected/)).toBeNull();
    expect(await screen.findByText(/Alice HubSpot/)).toBeTruthy();
  });
  it("reconnects an expired owned account through replacement consent, never for an active one", async () => {
    let state: "expired" | "fresh" = "expired";
    const fresh = { ...account, id: "owned-hubspot-2", authorizationFingerprint: "b".repeat(64), connectionState: "active", executionReady: true };
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith("/connect")) return Response.json({ ok: true, redirectUrl: "https://oauth.example.test/consent", authorizationFingerprint: fresh.authorizationFingerprint });
      if (path.includes("/connections")) return Response.json({ ok: true, provider: "openconnector", connections: state === "fresh" ? [fresh] : path.includes("includeUnavailable=1") ? [{ ...account, connectionState: "reauth_required", executionReady: false }] : [] });
      return Response.json(path.endsWith("/meta") ? { health: { provider: "openconnector", status: "healthy", checkedAt: 1 } } : { items: [listing], hasMore: false });
    });
    vi.stubGlobal("fetch", fetcher);
    const tab = popup(); vi.spyOn(window, "open").mockReturnValue(tab);
    render(<WorkspaceConnectorsPanel actorId="alice" bindingInputs={bindingInputs} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect hubspot" }));
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith("https://oauth.example.test/consent"));
    const post = fetcher.mock.calls.find(([path]) => String(path).endsWith("/connect"));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ providerKey: "hubspot", replaceUnavailable: true });
    state = "fresh"; fireEvent(window, new Event("focus"));
    expect(await within(screen.getByRole("region", { name: "Your app accounts" })).findByText(/hubspot account confirmed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect hubspot" })).toBeNull();
    expect(fetcher.mock.calls.some(([path]) => String(path).endsWith("/execute"))).toBe(false);
  });
});
