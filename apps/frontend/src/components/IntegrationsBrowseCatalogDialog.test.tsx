// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IntegrationsBrowseCatalogDialog", () => {
  it("blocks another connect while one is pending and keeps its outcome in the dialog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: ["one", "two"].map((id) => ({ id, providerKey: id, name: id, description: "", source: "openconnector", connectable: true, isConnected: false })), hasMore: false })));
    const connect = vi.fn();
    render(<IntegrationsBrowseCatalogDialog open actorId="alice" connectingKey="one" connectionNotice="Finish signing in in the new window." onConnect={connect} onClose={() => {}} />);
    const pending = await screen.findByRole("button", { name: "Connecting…" });
    const other = screen.getByRole("button", { name: "Connect" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    expect((other as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(other);
    expect(connect).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Finish signing in");
  });
  it.each([401, 503])("distinguishes a %s failure from an empty catalog and supports retry", async (status) => {
    let available = false;
    const fetcher = vi.fn(async () => available
      ? Response.json({ items: [{ id: "fixture-app", providerKey: "fixture-app", name: "Recovered fixture app", description: "Fixture only", source: "openconnector", connectable: false, isConnected: false }], hasMore: false, total: 1, oauthCapable: 0 })
      : Response.json({ error: status === 401 ? "Authenticated owner required." : "Integration catalog unavailable." }, { status }));
    vi.stubGlobal("fetch", fetcher);
    render(<IntegrationsBrowseCatalogDialog open actorId="default" onClose={() => {}} />);
    const error = await screen.findByRole("alert");
    expect(error.textContent).toContain(status === 401 ? "Sign in to Shiba with a verified user session" : "check the sibling service");
    expect(screen.queryByText(/No connectors match/)).toBeNull();
    expect(screen.queryByText(/0 shown/)).toBeNull();
    expect(screen.getByText("Provider catalog not loaded")).toBeTruthy();
    available = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry catalog" }));
    expect(await screen.findByText("Recovered fixture app")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry catalog" })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("discards an older search response and clears cards when the dialog closes", async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(async (path: RequestInfo | URL) => String(path).includes("query=new") ? Response.json({ items: [{ id: "new", providerKey: "new", name: "New result", description: "", source: "openconnector", connectable: false, isConnected: false }], hasMore: false }) : new Promise<Response>((done) => { resolve = done; })); vi.stubGlobal("fetch", fetcher);
    const view = render(<IntegrationsBrowseCatalogDialog open actorId="alice" onClose={() => {}} />); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Search connector catalog"), { target: { value: "new" } }); await screen.findByText("New result");
    await act(async () => { resolve(Response.json({ items: [{ id: "old", providerKey: "old", name: "Old result", description: "", source: "openconnector", connectable: true, isConnected: true }], hasMore: false })); });
    expect(screen.queryByText("Old result")).toBeNull();
    view.rerender(<IntegrationsBrowseCatalogDialog open={false} actorId="alice" onClose={() => {}} />); expect(screen.queryByText("New result")).toBeNull();
  });
  it("filters loaded provider rows by explicit role without connecting a catalog listing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [
      { id: "stripe", providerKey: "stripe", name: "Stripe", description: "Payments", source: "openconnector", isConnected: false, connectable: false },
      { id: "hubspot", providerKey: "hubspot", name: "HubSpot", description: "CRM", source: "openconnector", isConnected: false, connectable: true },
    ], hasMore: false })));
    const connect = vi.fn();
    render(<IntegrationsBrowseCatalogDialog open onClose={() => {}} onConnect={connect} roleFilter="finance" />);
    expect(await screen.findByText("Stripe")).toBeTruthy();
    expect(screen.queryByText("HubSpot")).toBeNull();
    expect(screen.getByText("Operator setup required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Catalog recommendations for role"), { target: { value: "sales" } });
    expect(screen.getByText("HubSpot")).toBeTruthy();
    expect(screen.queryByText("Stripe")).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
  it("does not render when open is false", () => {
    const { container } = render(
      <IntegrationsBrowseCatalogDialog open={false} onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders search and catalog items when open is true", async () => {
    const mockCatalog = {
      items: [
        {
          source: "openconnector",
          providerKey: "hubspot",
          name: "HubSpot",
          description: "Inbound marketing, sales, and service software.",
          isConnected: false,
          connectable: true,
          priority: "P0",
        },
        {
          source: "openconnector",
          providerKey: "zendesk",
          name: "Zendesk",
          description: "Customer service and ticketing platform.",
          isConnected: true,
          connectable: true,
          connectionId: "conn-zd-1",
        },
      ],
      hasMore: false,
    };

    vi.stubGlobal("fetch", vi.fn(async () => Response.json(mockCatalog)));

    const onConnect = vi.fn();
    const onLinkExisting = vi.fn();

    render(
      <IntegrationsBrowseCatalogDialog
        open={true}
        onClose={() => {}}
        onConnect={onConnect}
        onLinkExisting={onLinkExisting}
      />
    );

    expect(await screen.findByText("Browse catalog")).toBeTruthy();
    expect(await screen.findByText("HubSpot")).toBeTruthy();
    expect(screen.getByText("Zendesk")).toBeTruthy();

    // Click connect on HubSpot
    const connectBtn = screen.getByRole("button", { name: "Connect" });
    fireEvent.click(connectBtn);
    expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ providerKey: "hubspot" }));

    // Click link existing on Zendesk
    const linkBtn = screen.getByRole("button", { name: "Add to view" });
    fireEvent.click(linkBtn);
    expect(onLinkExisting).toHaveBeenCalledWith(expect.objectContaining({ providerKey: "zendesk" }));
  });
  it("requests a readiness-filtered page and labels services only from setup metadata", async () => {
    const fetcher = vi.fn(async (path: RequestInfo | URL) => Response.json(String(path).includes("readiness=needs_configuration")
      ? { items: [{ id: "zoom", providerKey: "zoom", name: "Zoom", description: "", source: "openconnector", isConnected: false, connectable: false, setupState: "needs_configuration" }], hasMore: false, total: 120, oauthCapable: 80 }
      : { items: [
        { id: "notion", providerKey: "notion", name: "Notion", description: "", source: "openconnector", isConnected: false, connectable: true, setupState: "ready" },
        { id: "stripe", providerKey: "stripe", name: "Stripe", description: "", source: "openconnector", isConnected: false, connectable: false, setupState: "unsupported", authTypes: ["api_key"] },
        { id: "odd", providerKey: "odd", name: "Odd", description: "", source: "openconnector", isConnected: false, connectable: false, setupState: "unverified" },
      ], hasMore: true, nextCursor: "50", total: 120, oauthCapable: 80 }));
    vi.stubGlobal("fetch", fetcher);
    const connect = vi.fn();
    render(<IntegrationsBrowseCatalogDialog open actorId="alice" onClose={() => {}} onConnect={connect} />);
    expect(await screen.findByText("Sign-in available")).toBeTruthy();
    expect(screen.getByText("No OAuth sign-in (api_key)")).toBeTruthy();
    expect(screen.getByText("Readiness unverified")).toBeTruthy();
    expect(screen.getByText(/120 provider services match · 80 declare OAuth sign-in/)).toBeTruthy();
    expect(screen.queryByText(/Live|Connected/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Filter by readiness"), { target: { value: "needs_configuration" } });
    expect(await screen.findByText("OAuth app setup required")).toBeTruthy();
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("readiness=needs_configuration");
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(connect).not.toHaveBeenCalled();
  });
});
