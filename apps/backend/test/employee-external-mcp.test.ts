import { afterEach, describe, expect, it, vi } from "vitest";
const sessions = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async () => Response.json({ sessions: sessions.rows }) }) }));
vi.mock("../src/request-auth.js", async (original) => ({ ...await original<typeof import("../src/request-auth.js")>(), resolveUserId: async () => "owner@example.test" }));
vi.mock("../src/org-request-auth.js", () => ({ resolveOrgForApiRequest: async () => ({ orgId: "self-hosted" }) }));

import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { createWebSession } from "../src/web-sessions.js";
import { handleEmployeeTools } from "../src/employee-tool-routes.js";
import { callEmployeeExternalMcp, employeeExternalMcpCatalog } from "../src/employee-external-mcp.js";
import { createExternalMcpServer, discoverExternalMcpServer, getExternalMcpServer, listExternalMcpAccess, listExternalMcpTools,
  registerExternalMcpTools, reviewExternalMcpTool, setExternalMcpAccess, setExternalMcpToolEnabled } from "../src/external-mcp.js";
import { listEmployeeActionApprovals } from "../src/employee-tool-store.js";
import { listCapabilityInvocations } from "../src/capability-invocations.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { handleMcp } from "../src/v1/mcp.js";
import type { V1Context } from "../src/v1/context.js";

const owner = "owner@example.test";
const endpoint = "https://mcp.example.com/mcp";
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, CodingOrchestrator: {}, MCP_TRUSTED_HOSTS: "mcp.example.com" } as unknown as Env;
  const schema = { type: "object", properties: { resourceId: { type: "string" }, body: { type: "string" } }, required: ["resourceId"], additionalProperties: false };
  let remote = [
    { name: "read_item", description: "Read selected record", inputSchema: schema },
    { name: "write_item", description: "Write selected record", inputSchema: schema },
    { name: "hidden_item", description: "SECRET_UNAUTHORIZED_SCHEMA", inputSchema: schema },
  ];
  const calls: Array<{ name: string; arguments: unknown }> = [];
  let hold: Promise<void> | null = null;
  let release = () => {};
  let markListed = () => {};
  let listed = Promise.resolve();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    expect(url.href).toBe(endpoint);
    expect(init?.redirect).toBe("error");
    if (init?.method === "GET") return new Response("No SSE", { status: 405 });
    const rpc = JSON.parse(typeof init?.body === "string" ? init.body : await (input as Request).text());
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "employee-fixture", version: "1" },
    } });
    if (rpc.method === "tools/list") {
      markListed(); if (hold) await hold;
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: remote } });
    }
    if (rpc.method === "tools/call") {
      calls.push(rpc.params);
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "Actual selected-record fixture response" }] } });
    }
    throw new Error(`Unexpected fixture method ${rpc.method}`);
  }));
  const draft = await createExternalMcpServer(env, { orgId: "self-hosted", ownerId: owner, name: "Reviewed fixture", endpoint, credentialRef: null });
  if (!draft) throw new Error("Server not created");
  await discoverExternalMcpServer(env, draft);
  const tools = await listExternalMcpTools(env, draft.id);
  for (const tool of tools) {
    const server = await getExternalMcpServer(env, "self-hosted", owner, draft.id);
    if (!server) throw new Error("Server not found");
    await reviewExternalMcpTool(env, server, tool.id, tool.remoteName === "write_item" ? "approval_required" : "read", tool.schemaVersion);
    await setExternalMcpToolEnabled(env, server, tool.id, true, tool.schemaVersion);
  }
  const employee = await createCustomAgent(env, "self-hosted", "external-reader", { name: "External reader", instructions: "Use selected records", harness: "opencode" });
  const read = tools.find((tool) => tool.remoteName === "read_item");
  const write = tools.find((tool) => tool.remoteName === "write_item");
  if (!read || !write) throw new Error("Fixture tools missing");
  const alias = (name: string) => `mcp:shiba:${name}`;
  const stale = await handleEmployeeTools(new Request(`https://shiba.test/api/employee-tools/${employee.id}/policy`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1, actorId: owner, role: "operator",
      resourcesByCapability: { [alias(read.gatewayName)]: ["record-1"] }, externalResourceArguments: { [alias(read.gatewayName)]: "resourceId" },
      externalSchemaVersions: { [alias(read.gatewayName)]: "0".repeat(64) },
    }),
  }), env);
  expect(stale?.status).toBe(409);
  const configured = await handleEmployeeTools(new Request(`https://shiba.test/api/employee-tools/${employee.id}/policy`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1, actorId: owner, role: "operator",
      resourcesByCapability: { [alias(read.gatewayName)]: ["record-1"], [alias(write.gatewayName)]: ["record-1"] },
      externalResourceArguments: { [alias(read.gatewayName)]: "resourceId", [alias(write.gatewayName)]: "resourceId" },
      externalSchemaVersions: { [alias(read.gatewayName)]: read.schemaVersion, [alias(write.gatewayName)]: write.schemaVersion },
    }),
  }), env);
  expect(configured?.status).toBe(200);
  const session = createWebSession(owner, { metadata: { customAgentId: employee.id } });
  sessions.rows = [session];
  const binding = { orgId: "self-hosted", actorId: owner, employeeId: employee.id, employeeVersion: 2, executionContextId: session.agentName };
  const approve = async (approvalId: string) => {
    const url = new URL(`https://shiba.test/api/v1/mcp/servers/${draft.id}/approvals/${approvalId}`);
    const response = await handleMcp({ env, url, request: new Request(url, { method: "POST", body: JSON.stringify({ approved: true }) }),
      principal: { principal: owner, orgId: "self-hosted", scopes: ["api:read", "api:write"] }, forward: async () => new Response() } as V1Context);
    return response?.json();
  };
  return { env, sqlite, tools, read, write, serverId: draft.id, binding, calls, approve,
    drift() { remote = remote.map((tool) => ({ ...tool, description: `${tool.description} changed` })); },
    holdLists() { listed = new Promise<void>((resolve) => { markListed = resolve; }); hold = new Promise<void>((resolve) => { release = resolve; }); },
    listed: () => listed, release() { hold = null; release(); },
  };
}

describe("ordinary employee external MCP boundary", () => {
  it("filters schemas/counts, calls a reviewed read, and dispatches an exact write only after owner consent", async () => {
    const f = await fixture();
    const catalog = await employeeExternalMcpCatalog(f.env, f.binding);
    expect(catalog).toMatchObject({ totalAuthorized: 2, returned: 2 });
    expect(catalog.actions.map((action) => action.tool).sort()).toEqual([f.read.gatewayName, f.write.gatewayName].sort());
    expect(JSON.stringify(catalog)).not.toContain("SECRET_UNAUTHORIZED_SCHEMA");
    expect(catalog.actions[0]).toMatchObject({ resources: ["record-1"], resourceArgument: "resourceId", inputSchema: { required: ["resourceId"] } });
    expect(await employeeExternalMcpCatalog(f.env, { ...f.binding, employeeVersion: 3 })).toEqual({ actions: [], totalAuthorized: 0, returned: 0 });
    expect(await employeeExternalMcpCatalog(f.env, { ...f.binding, actorId: "another-actor" })).toEqual({ actions: [], totalAuthorized: 0, returned: 0 });
    expect(await listExternalMcpAccess(f.env, "self-hosted", f.serverId)).toEqual([]);
    const principal = { kind: "agent" as const, principal: owner, orgId: "self-hosted", scopes: ["mcp:external" as const], created: 0, revoked: false };
    const direct = createToolRegistry(f.env); await registerExternalMcpTools(direct, f.env, principal);
    expect(direct.tools()).toEqual([]);
    expect((await direct.invoke(f.read.gatewayName, { resourceId: "record-1", employeeContext: f.binding }, principal)).isError).toBe(true);
    const read = await callEmployeeExternalMcp(f.env, f.binding, f.read.gatewayName, { resourceId: "record-1" }, "read-1");
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read)).toContain("Actual selected-record fixture response");
    expect(JSON.stringify(read)).toContain("UNTRUSTED");
    expect(f.calls).toEqual([{ name: "read_item", arguments: { resourceId: "record-1" } }]);
    expect((await callEmployeeExternalMcp(f.env, f.binding, f.read.gatewayName, { resourceId: "not-granted" }, "read-denied")).isError).toBe(true);
    const pending = await callEmployeeExternalMcp(f.env, f.binding, f.write.gatewayName, { resourceId: "record-1", body: "exact write" }, "write-1");
    expect(pending).toMatchObject({ structuredContent: { status: "pending_approval" } });
    const approval = (await listEmployeeActionApprovals(f.env, { orgId: "self-hosted", status: "pending" }))[0];
    if (!approval) throw new Error("Approval not queued");
    expect(approval.employeeContext).toMatchObject({ ...f.binding, schemaVersion: f.write.schemaVersion, resourceIds: ["record-1"] });
    expect(f.calls).toHaveLength(1);
    expect(await f.approve(approval.approvalId)).toMatchObject({ dispatch: { status: "succeeded" } });
    expect(f.calls).toHaveLength(2);
    expect(await f.approve(approval.approvalId)).toMatchObject({ dispatch: { status: "succeeded" } });
    expect(f.calls).toHaveLength(2);
    expect((await callEmployeeExternalMcp(f.env, f.binding, f.write.gatewayName, { resourceId: "record-1", body: "changed write" }, "write-1")).isError).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("quarantines schema drift and hides the changed capabilities and schemas", async () => {
    const f = await fixture(); f.drift();
    expect((await callEmployeeExternalMcp(f.env, f.binding, f.read.gatewayName, { resourceId: "record-1" }, "drift-read")).isError).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(await employeeExternalMcpCatalog(f.env, f.binding)).toEqual({ actions: [], totalAuthorized: 0, returned: 0 });
    expect((await getExternalMcpServer(f.env, "self-hosted", owner, f.serverId))?.status).toBe("discovered");
  });

  it("requires each workspace, actor and role resource grant before exposing or calling a tool", async () => {
    for (const subject of ["workspace", "actor", "role"]) {
      const f = await fixture();
      await f.env.AGENT_AUDIT.prepare("DELETE FROM employee_tool_grants WHERE employee_id=? AND subject_type=?").bind(f.binding.employeeId, subject).run();
      expect(await employeeExternalMcpCatalog(f.env, f.binding)).toEqual({ actions: [], totalAuthorized: 0, returned: 0 });
      await expect(callEmployeeExternalMcp(f.env, f.binding, f.read.gatewayName, { resourceId: "record-1" }, `missing-${subject}`)).rejects.toThrow("unavailable");
      expect(f.calls).toHaveLength(0);
    }
  });

  it("never falls back to broad actor access when employee grants are revoked during owner write preflight", async () => {
    const f = await fixture();
    await setExternalMcpAccess(f.env, { orgId: "self-hosted", ownerId: owner, serverId: f.serverId, toolId: f.write.id, principal: owner, enabled: true });
    await callEmployeeExternalMcp(f.env, f.binding, f.write.gatewayName, { resourceId: "record-1", body: "frozen" }, "write-revoked");
    const approval = (await listEmployeeActionApprovals(f.env, { orgId: "self-hosted", status: "pending" }))[0];
    if (!approval) throw new Error("Approval not queued");
    f.holdLists();
    const dispatch = f.approve(approval.approvalId); await f.listed();
    await f.env.AGENT_AUDIT.prepare("UPDATE employee_tool_grants SET lifecycle='revoked' WHERE employee_id=?").bind(f.binding.employeeId).run();
    f.release();
    expect(await dispatch).toMatchObject({ dispatch: { status: "failed", errorCode: "approval_stale" } });
    expect(f.calls).toHaveLength(0);
    expect(await employeeExternalMcpCatalog(f.env, f.binding)).toEqual({ actions: [], totalAuthorized: 0, returned: 0 });
    await expect(callEmployeeExternalMcp(f.env, f.binding, f.write.gatewayName, { resourceId: "record-1" }, "after-revoke")).rejects.toThrow("unavailable");
    expect(await listCapabilityInvocations(f.env, { orgId: "self-hosted" })).toMatchObject([expect.objectContaining({ status: "failed" })]);
  });
});
