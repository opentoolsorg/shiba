// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IntegrationsBrowseCatalogDialog } from "./IntegrationsBrowseCatalogDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("IntegrationsBrowseCatalogDialog", () => {
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
