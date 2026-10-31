// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ExternalMcpManagement } from "./ExternalMcpManagement";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExternalMcpManagement persisted state", () => {
  it("reloads saved grants and pending approvals without requiring a mutation", async () => {
    const server = { id: "server-1", name: "Fixture MCP", transport: "streamable_http", endpoint: "https://mcp.example.com/mcp",
      credentialRef: null, status: "enabled", health: "healthy", healthStale: false, lastCheckedAt: 10, lastErrorCode: null };
    const tool = { id: "tool-1", remoteName: "lookup", capabilityId: "cap-1", gatewayName: "ext_server_lookup",
      description: "Local fixture lookup", schemaVersion: "schema-1", effect: "read", reviewedAt: 9, enabled: true };
    const approval = { approvalId: "approval-1", action: "write_record", actorId: "agent-a", payload: { title: "Draft" }, expiresAt: 1000, status: "pending" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/mcp/servers") return Response.json({ servers: [server] });
      if (path === "/api/agents") return Response.json({ principals: [{ principal: "agent-a", scopes: ["mcp:external"], created: 1, live: true }] });
      if (path === "/api/v1/mcp/servers/server-1/tools") return Response.json({ tools: [tool], access: [{ capabilityId: "cap-1", principal: "agent-a", enabled: true }] });
      if (path === "/api/v1/mcp/servers/server-1/approvals") return Response.json({ approvals: [approval] });
      return Response.json({ error: `unexpected ${init?.method ?? "GET"} ${path}` }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExternalMcpManagement />);

    expect(await screen.findByText("ext_server_lookup")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("agent-a") as HTMLInputElement).checked).toBe(true));
    expect(screen.getByText(/write_record · agent-a · expires/)).toBeTruthy();
    expect(screen.getByText(/\"title\": \"Draft\"/)).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});
