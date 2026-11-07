// @vitest-environment happy-dom
import type { IntegrationProviderCatalogItem } from "@shiba/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationCatalogDirectory } from "./IntegrationCatalogDirectory";

vi.mock("./IntegrationsBrowseCatalogDialog", async (importOriginal) => ({
  ...await importOriginal<typeof import("./IntegrationsBrowseCatalogDialog")>(),
  IntegrationsBrowseCatalogDialog: ({ onConnect }: { onConnect: (item: IntegrationProviderCatalogItem) => void }) => (
    <button type="button" onClick={() => onConnect({
      id: "fixture", providerKey: "fixture", name: "Fixture", description: "", source: "openconnector",
      connectable: true, isConnected: false,
    })}>Connect fixture</button>
  ),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("IntegrationCatalogDirectory OAuth redirects", () => {
  it("searches beyond the loaded page and clears discovery filters", async () => {
    const item = { id: "far-away", providerKey: "far-away", name: "Far away app", description: "Only returned by server search", source: "openconnector", connectable: true, isConnected: false, setupState: "ready" };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/connections")) return Response.json({ ok: true, provider: "openconnector", connections: [] });
      if (path.endsWith("/meta")) return Response.json({ health: { provider: "openconnector", status: "healthy", checkedAt: 1 } });
      return Response.json({ items: path.includes("query=Far+away") ? [item] : [], hasMore: false });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<IntegrationCatalogDirectory actorId="alice" bindingInputs={{ setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false, externalMcpServerCount: 0, externalMcpCatalogConnections: [], externalMcpLoading: false }} />);
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "Far away" } });
    expect(await screen.findByText("Far away app")).toBeTruthy();
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("query=Far+away"))).toBe(true);
    fireEvent.change(screen.getByLabelText("Filter integration setup"), { target: { value: "ready" } });
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes("query=Far+away") && String(url).includes("readiness=ready"))).toBe(true));
    expect(await screen.findByText("Far away app")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter integration setup"), { target: { value: "reference" } });
    expect(screen.queryByText("Far away app")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect((screen.getByLabelText("Search integrations") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Filter integration setup") as HTMLSelectElement).value).toBe("all");
  });
  it("preserves a configured MCP path beside an unconnected provider sign-in", async () => {
    const listing = { id: "stripe", providerKey: "stripe", name: "Stripe", description: "App path", source: "openconnector", connectable: true, isConnected: false, setupState: "ready" };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("/connections")
      ? Response.json({ ok: true, provider: "openconnector", connections: [] })
      : Response.json({ items: [listing], hasMore: false })));
    render(<IntegrationCatalogDirectory actorId="alice" bindingInputs={{ setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false, externalMcpServerCount: 1, externalMcpCatalogConnections: [{ catalogId: "stripe", connectionLabel: null, status: "enabled", health: "healthy" }], externalMcpLoading: false }} />);
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "Stripe" } });
    expect(await screen.findByText("Sign-in available")).toBeTruthy();
    const row = screen.getByTestId("integration-catalog-row-stripe");
    expect(within(row).getByText("Configured")).toBeTruthy();
    expect(within(row).queryByText("Account configured")).toBeNull();
  });
  it("keeps the catalog failure visible when readiness and account checks fail later", async () => {
    let failMeta!: (response: Response) => void;
    let failAccounts!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/meta")) return new Promise<Response>((resolve) => { failMeta = resolve; });
      if (path.includes("/connections")) return new Promise<Response>((resolve) => { failAccounts = resolve; });
      return Response.json({ error: "Authenticated owner required." }, { status: 401 });
    }));
    render(<IntegrationCatalogDirectory actorId="default" bindingInputs={{ setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false, externalMcpServerCount: 0, externalMcpCatalogConnections: [], externalMcpLoading: false }} />);
    expect(await screen.findByText(/Sign in to Shiba with a verified user session/)).toBeTruthy();
    await act(async () => {
      failMeta(Response.json({ error: "Temporary meta failure" }, { status: 500 }));
      failAccounts(Response.json({ error: "Temporary account failure" }, { status: 500 }));
    });
    expect(screen.getByText(/Sign in to Shiba with a verified user session/)).toBeTruthy();
    expect(screen.queryByText("Temporary meta failure")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "GitHub" } });
    expect(screen.getByTestId("integration-catalog-row-github")).toBeTruthy();
    expect(screen.queryByText("Account configured")).toBeNull();
  });
  it("refreshes a verified parent connection revision without dropping filters or accepting late old account reads", async () => {
    const bindingInputs = { setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false, externalMcpServerCount: 0, externalMcpCatalogConnections: [], externalMcpLoading: false };
    const listing = { id: "revision-app", providerKey: "revision-app", name: "Revision fixture", description: "Scoped account", source: "openconnector", domain: "marketing", priority: "P0", connectable: true, isConnected: true };
    const account = { id: "old-generation", providerKey: "revision-app", provider: "openconnector", executionReady: true };
    let settleOld!: (response: Response) => void; let first = true; let firstSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/connections")) {
        if (first) { first = false; firstSignal = init?.signal as AbortSignal; return new Promise<Response>((resolve) => { settleOld = resolve; }); }
        return Response.json({ ok: true, provider: "openconnector", connections: [] });
      }
      return Response.json(path.endsWith("/meta") ? { health: { provider: "openconnector", status: "healthy", checkedAt: 1 } } : { items: [listing], hasMore: false });
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<IntegrationCatalogDirectory actorId="alice" bindingInputs={bindingInputs} connectionRevision={0} />);
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "Revision fixture" } });
    fireEvent.change(screen.getByLabelText("Filter by domain"), { target: { value: "marketing" } });
    await screen.findByText("Revision fixture");
    view.rerender(<IntegrationCatalogDirectory actorId="alice" bindingInputs={bindingInputs} connectionRevision={1} />);
    expect(firstSignal?.aborted).toBe(true);
    await screen.findByText("Revision fixture");
    await act(async () => { settleOld(Response.json({ ok: true, provider: "openconnector", connections: [account] })); });
    expect((screen.getByLabelText("Search integrations") as HTMLInputElement).value).toBe("Revision fixture");
    expect((screen.getByLabelText("Filter by domain") as HTMLSelectElement).value).toBe("marketing");
    expect(screen.getByRole("button", { name: "Connect app" })).toBeTruthy();
    expect(screen.queryByText("Account configured")).toBeNull();
  });
  it("filters merged provider entries and never labels deployment-only bindings connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, provider: "openconnector", items: [{ id: "campaign-stats", providerKey: "campaign-stats", name: "Live campaign stats", description: "Provider action catalog", source: "openconnector", domain: "marketing", priority: "P0", connectable: true, isConnected: false }], connections: [] })));
    render(<IntegrationCatalogDirectory bindingInputs={{ setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false, externalMcpServerCount: 0, externalMcpCatalogConnections: [], externalMcpLoading: false }} />);
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "Live campaign stats" } });
    expect(await screen.findByText("Live campaign stats")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter by domain"), { target: { value: "ops" } });
    expect(screen.queryByText("Live campaign stats")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "Telegram" } });
    const telegram = screen.getByTestId("integration-catalog-row-telegram");
    expect(within(telegram).getByText("Available via deployment")).toBeTruthy();
    expect(within(telegram).queryByText("Connected")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search integrations"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Filter by domain"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Recommendations for role"), { target: { value: "finance" } });
    expect(screen.getByTestId("integration-catalog-row-stripe")).toBeTruthy();
    expect(screen.queryByTestId("integration-catalog-row-github")).toBeNull();
    expect(within(screen.getByTestId("integration-catalog-row-stripe")).getByRole("link", { name: "Configure MCP" }).getAttribute("href")).toBe("/integrations/?tab=mcp#mcp-preset-stripe");
  });
  it.each(["https://oauth.example.com/connect", "http://oauth.example.com", "javascript:alert(1)"])(
    "isolates HTTPS popups and rejects unsafe redirects (%s)", async (redirectUrl) => {
      const popup = { opener: {}, location: { replace: vi.fn() }, close: vi.fn(), closed: false } as unknown as Window;
      const open = vi.spyOn(window, "open").mockReturnValue(popup);
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/connect")) return Response.json({ ok: true, redirectUrl, authorizationFingerprint: "a".repeat(64) });
        return Response.json({ ok: true, provider: "openconnector", items: [], connections: [], hasMore: false });
      }));
      render(<IntegrationCatalogDirectory bindingInputs={{
        setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false,
        externalMcpServerCount: 0, externalMcpCatalogConnections: [], externalMcpLoading: false,
      }} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect fixture" }));
      if (redirectUrl.startsWith("https:")) {
        await waitFor(() => expect(popup.location.replace).toHaveBeenCalledWith(redirectUrl)); expect(open).toHaveBeenCalledWith("about:blank", "_blank", "width=520,height=720"); expect(popup.opener).toBeNull();
      } else {
        expect(await screen.findByText("Connect returned an unsafe redirect URL.")).toBeTruthy();
        expect(popup.location.replace).not.toHaveBeenCalled(); expect(popup.close).toHaveBeenCalled();
      }
    },
  );
});
