// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalMcpManagement } from "./ExternalMcpManagement";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ExternalMcpManagement persisted state", () => {
  it.each([
    { effect: "unreviewed", recommendedEffect: "read", expected: "read" },
    { effect: "unreviewed", recommendedEffect: "approval_required", expected: "approval_required" },
    { effect: "read", recommendedEffect: "approval_required", expected: "read" },
    { effect: "approval_required", recommendedEffect: "read", expected: "approval_required" },
  ])("submits displayed $expected for stored $effect and recommendation $recommendedEffect", async ({ effect, recommendedEffect, expected }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/mcp/servers") return Response.json({ servers: [{
        id: "recommended-server", name: "Recommended MCP", tools: [],
        endpoint: "https://mcp.example.com/mcp", status: "draft", health: "unknown",
      }] });
      if (path === "/api/agents") return Response.json({ principals: [] });
      if (path.endsWith("/tools")) return Response.json({ tools: [{
        id: "recommended-tool", remoteName: "lookup", gatewayName: "ext_lookup",
        capabilityId: "cap-1", description: "Lookup", schemaVersion: "schema-1",
        effect, recommendedEffect, enabled: false,
      }], access: [] });
      if (path.endsWith("/approvals")) return Response.json({ approvals: [] });
      if (path.endsWith("/review") && init?.method === "POST") return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExternalMcpManagement />);
    const select = await screen.findByLabelText("Effect for lookup");
    expect((select as HTMLSelectElement).value).toBe(expected);
    const review = screen.getByRole("button", { name: "Review effect" });
    expect((review as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(review);
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input).endsWith("/review") && init?.body === JSON.stringify({ effect: expected, schemaVersion: "schema-1" }),
    )).toBe(true));
  });

  it("requires an explicit choice when the recommendation is unreviewed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/v1/mcp/servers") return Response.json({ servers: [{
        id: "custom-server", name: "Custom MCP", tools: [], endpoint: "https://mcp.example.com/mcp",
        status: "draft", health: "unknown",
      }] });
      if (path === "/api/agents") return Response.json({ principals: [] });
      if (path.endsWith("/tools")) return Response.json({ tools: [{
        id: "custom-tool", remoteName: "lookup", gatewayName: "ext_lookup", capabilityId: "cap-1",
        description: "Lookup", schemaVersion: "schema-1", effect: "unreviewed",
        recommendedEffect: "unreviewed", enabled: false,
      }], access: [] });
      return Response.json({ approvals: [] });
    }));
    render(<ExternalMcpManagement />);
    expect(((await screen.findByLabelText("Effect for lookup")) as HTMLSelectElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Review effect" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reloads saved grants and pending approvals without requiring a mutation", async () => {
    const server = {
      id: "server-1",
      name: "Fixture MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.com/mcp",
      credentialRef: null,
      status: "enabled",
      health: "healthy",
      healthStale: false,
      lastCheckedAt: 10,
      lastErrorCode: null,
    };
    const tool = {
      id: "tool-1",
      remoteName: "lookup",
      capabilityId: "cap-1",
      gatewayName: "ext_server_lookup",
      description: "Local fixture lookup",
      schemaVersion: "schema-1",
      effect: "read",
      reviewedAt: 9,
      enabled: true,
    };
    const approval = {
      approvalId: "approval-1",
      action: "write_record",
      actorId: "agent-a",
      payload: { title: "Draft" },
      expiresAt: 1000,
      status: "pending",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/mcp/servers") return Response.json({ servers: [server] });
      if (path === "/api/agents")
        return Response.json({
          principals: [{ principal: "agent-a", scopes: ["mcp:external"], created: 1, live: true }],
        });
      if (path === "/api/v1/mcp/servers/server-1/tools")
        return Response.json({
          tools: [tool],
          access: [{ capabilityId: "cap-1", principal: "agent-a", enabled: true }],
        });
      if (path === "/api/v1/mcp/servers/server-1/approvals")
        return Response.json({ approvals: [approval] });
      return Response.json(
        { error: `unexpected ${init?.method ?? "GET"} ${path}` },
        { status: 404 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ExternalMcpManagement />);

    expect(await screen.findByText("ext_server_lookup")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("agent-a") as HTMLInputElement).checked).toBe(true),
    );
    expect(screen.getByText(/write_record · agent-a · expires/)).toBeTruthy();
    expect(screen.getByText(/"title": "Draft"/)).toBeTruthy();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(
      true,
    );
  });

  it("walks an owner through draft, review, scoped grant, and exact approval", async () => {
    const server = {
      id: "server-2",
      name: "Fixture MCP",
      transport: "streamable_http",
      endpoint: "https://mcp.example.com/mcp",
      credentialRef: null,
      status: "draft",
      health: "unknown",
      healthStale: true,
      lastCheckedAt: null,
      lastErrorCode: null,
    };
    const tool = {
      id: "tool-2",
      remoteName: "write_record",
      capabilityId: "mcp:external:server-2:tool-2",
      gatewayName: "ext_server_2_write_record",
      description: "Fixture write tool",
      schemaVersion: "schema-2",
      effect: "unreviewed",
      reviewedAt: null,
      enabled: false,
    };
    const approval = {
      approvalId: "approval-2",
      action: "write_record",
      actorId: "agent-self-hosted",
      payload: { recordId: "r-7", title: "Approved title" },
      expiresAt: Date.now() + 60_000,
      status: "pending",
    };
    let registered = false;
    let discovered = false;
    let reviewed = false;
    let enabled = false;
    let granted = false;
    let pending = true;
    const requests: Array<{ path: string; method: string; body: unknown }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        requests.push({ path, method, body });

        if (path === "/api/agents")
          return Response.json({
            principals: [
              { principal: "agent-self-hosted", scopes: ["mcp:external"], created: 1, live: true },
            ],
          });
        if (path === "/api/v1/mcp/servers" && method === "GET")
          return Response.json({ servers: registered ? [server] : [] });
        if (path === "/api/v1/mcp/servers" && method === "POST") {
          registered = true;
          return Response.json({ server }, { status: 201 });
        }
        if (path === "/api/v1/mcp/servers/server-2/discover" && method === "POST") {
          discovered = true;
          return Response.json({ ok: true });
        }
        if (path === "/api/v1/mcp/servers/server-2/tools" && method === "GET")
          return Response.json({
            tools: discovered
              ? [
                  {
                    ...tool,
                    effect: reviewed ? "approval_required" : "unreviewed",
                    reviewedAt: reviewed ? 1 : null,
                    enabled,
                  },
                ]
              : [],
            access: granted
              ? [{ capabilityId: tool.capabilityId, principal: "agent-self-hosted", enabled: true }]
              : [],
          });
        if (path === "/api/v1/mcp/servers/server-2/approvals" && method === "GET")
          return Response.json({ approvals: pending ? [approval] : [] });
        if (path === "/api/v1/mcp/servers/server-2/tools/tool-2/review" && method === "POST") {
          reviewed = true;
          return Response.json({ ok: true });
        }
        if (path === "/api/v1/mcp/servers/server-2/tools/tool-2/enable" && method === "POST") {
          enabled = true;
          server.status = "enabled";
          return Response.json({ ok: true });
        }
        if (path === "/api/v1/mcp/servers/server-2/tools/tool-2/grant" && method === "POST") {
          granted = body?.enabled === true;
          return Response.json({ ok: true });
        }
        if (path === "/api/v1/mcp/servers/server-2/approvals/approval-2" && method === "POST") {
          expect(body).toEqual({ approved: true });
          pending = false;
          return Response.json({ ok: true, dispatch: { status: "succeeded" } });
        }
        return Response.json({ error: `unexpected ${method} ${path}` }, { status: 404 });
      }),
    );

    render(<ExternalMcpManagement />);
    fireEvent.change(screen.getByLabelText("MCP server name"), {
      target: { value: "Fixture MCP" },
    });
    fireEvent.change(screen.getByLabelText("MCP server HTTPS endpoint"), {
      target: { value: "https://mcp.example.com/mcp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await screen.findByText("Fixture MCP")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Discover / retry" }));
    expect(await screen.findByText("ext_server_2_write_record")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Effect for write_record"), {
      target: { value: "approval_required" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review effect" }));
    await screen.findByRole("button", { name: "Enable" });
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    const principalCheckbox = await screen.findByLabelText("agent-self-hosted");
    fireEvent.click(principalCheckbox);
    await waitFor(() =>
      expect((screen.getByLabelText("agent-self-hosted") as HTMLInputElement).checked).toBe(true),
    );

    expect(screen.getByText(/"title": "Approved title"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and dispatch exact call" }));
    expect(
      await screen.findByText(
        "Exact external MCP call approved and dispatched. Check the invocation receipt for its outcome.",
      ),
    ).toBeTruthy();
    expect(requests.find((request) => request.path.endsWith("/grant"))?.body).toEqual({
      principal: "agent-self-hosted",
      enabled: true,
    });
    expect(
      requests.find((request) => request.path.endsWith("/approvals/approval-2"))?.body,
    ).toEqual({
      approved: true,
    });
    expect(
      requests.some(
        (request) => request.method === "POST" && JSON.stringify(request.body).includes("secret"),
      ),
    ).toBe(false);
  });
});
