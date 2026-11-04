// @vitest-environment happy-dom
import type { IntegrationProviderCatalogItem } from "@shiba/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationCatalogDirectory } from "./IntegrationCatalogDirectory";

vi.mock("./IntegrationsBrowseCatalogDialog", () => ({
  IntegrationsBrowseCatalogDialog: ({ onConnect }: { onConnect: (item: IntegrationProviderCatalogItem) => void }) => (
    <button type="button" onClick={() => onConnect({
      id: "fixture", providerKey: "fixture", name: "Fixture", description: "", source: "openconnector",
      connectable: true, isConnected: false,
    })}>Connect fixture</button>
  ),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("IntegrationCatalogDirectory OAuth redirects", () => {
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
