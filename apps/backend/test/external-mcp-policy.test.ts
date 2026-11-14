import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  createExternalMcpServer,
  discoverExternalMcpServer,
  getExternalMcpServer,
  listExternalMcpServers,
  registerExternalMcpTools,
  reviewExternalMcpTool,
  setExternalMcpAccess,
  setExternalMcpToolEnabled,
} from "../src/external-mcp.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { externalMcpD1 } from "./fixtures/external-mcp-schema.js";

const endpoint = "https://mcp.example.com/mcp";
const remoteTools = [
  { name: "sum", description: "Adds values", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } },
];
const agent = { kind: "agent" as const, principal: "assistant-agent", orgId: "org-a", scopes: ["mcp:external" as const], created: 1, revoked: false };
const owner = { principal: "owner@example.test", orgId: "org-a", scopes: ["api:read" as const] };

function environment() {
  const { database, sqlite } = externalMcpD1();
  return { env: { AGENT_AUDIT: database, MCP_TRUSTED_HOSTS: "mcp.example.com" } as unknown as Env, sqlite };
}

function mockMcp() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href !== endpoint) throw new Error("untrusted");
    if (init?.method === "GET") return new Response("GET unsupported", { status: 405 });
    const request = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { method: string; id: number };
    if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "x", version: "1" } } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: remoteTools } });
    if (request.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } });
    throw new Error(`unexpected ${request.method}`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("external MCP tool policy", () => {
  it("refuses when policy flips to deny and logs execution", async () => {
    const { env, sqlite } = environment();
    vi.stubGlobal("fetch", mockMcp());
    const draft = await createExternalMcpServer(env, { orgId: "org-a", ownerId: owner.principal, name: "Fixture", endpoint, credentialRef: null });
    await discoverExternalMcpServer(env, draft!);
    const server = (await getExternalMcpServer(env, "org-a", owner.principal, draft!.id))!;
    const tool = (await listExternalMcpServers(env, "org-a", owner.principal))[0]!.tools[0]!;
    await reviewExternalMcpTool(env, server, tool.id, "read", tool.schemaVersion);
  sqlite.prepare("UPDATE external_mcp_servers SET status = 'enabled', health = 'healthy', last_checked_at = ?").run(Date.now());
    await setExternalMcpToolEnabled(env, server, tool.id, true, tool.schemaVersion);
    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
    const registry = createToolRegistry(env);
    await registerExternalMcpTools(registry, env, agent);
    sqlite.prepare("UPDATE external_mcp_tools SET policy = 'deny', effect = 'unreviewed' WHERE id = ?").run(tool.id);
    const denied = await registry.invoke(tool.gatewayName, { a: 1, b: 2 }, agent);
    expect(denied.isError).toBe(true);
    const row = sqlite.prepare("SELECT decision, status FROM external_mcp_executions ORDER BY created_at DESC LIMIT 1").get() as { decision: string; status: string };
    expect(row).toEqual({ decision: "deny", status: "denied" });
  });
});