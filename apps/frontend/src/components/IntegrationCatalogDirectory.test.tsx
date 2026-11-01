// @vitest-environment happy-dom
import type { IntegrationProviderCatalogItem } from "@shiba/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it.each(["https://oauth.example.com/connect", "http://oauth.example.com", "javascript:alert(1)"])(
    "isolates HTTPS popups and rejects unsafe redirects (%s)", async (redirectUrl) => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/connect")) return Response.json({ ok: true, redirectUrl });
        return Response.json({ items: [], connections: [], hasMore: false });
      }));
      render(<IntegrationCatalogDirectory bindingInputs={{
        setupLoading: false, mailboxCount: 0, mailboxLoading: false, gmailConnected: false, gmailLoading: false,
        externalMcpServerCount: 0, externalMcpCatalogConnections: [], externalMcpLoading: false,
      }} />);
      fireEvent.click(screen.getByRole("button", { name: "Connect fixture" }));
      if (redirectUrl.startsWith("https:")) {
        await waitFor(() => expect(open).toHaveBeenCalledWith(redirectUrl, "shiba-integrations-oauth", "width=520,height=720,noopener,noreferrer"));
      } else {
        expect(await screen.findByText("Connect returned an unsafe redirect URL.")).toBeTruthy();
        expect(open).not.toHaveBeenCalled();
      }
    },
  );
});
