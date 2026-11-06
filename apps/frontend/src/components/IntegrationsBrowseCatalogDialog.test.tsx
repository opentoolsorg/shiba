// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IntegrationsBrowseCatalogDialog", () => {
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
});
