// @vitest-environment happy-dom

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConnectedApps } from "./ConnectedApps";

describe("ConnectedApps", () => {
  it("lists grants and shows revoke affordance", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/mcp/connected-apps")) {
        return Response.json({
          ok: true,
          grants: [{
            id: "grant1",
            clientName: "MCP Inspector",
            clientId: "shc_demo",
            kind: "oauth",
            access: "full",
            lastUsedAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }],
        });
      }
      return Response.json({ ok: true, revoked: true });
    }));
    render(<ConnectedApps />);
    await waitFor(() => {
      expect(screen.getByText("MCP Inspector").textContent).toContain("MCP Inspector");
    });
    expect(screen.getByRole("button", { name: "Revoke" }).textContent).toContain("Revoke");
    vi.unstubAllGlobals();
  });
});