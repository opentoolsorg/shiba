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
import { createEmployeeRunTools, isSupportedEmployeeToolScope, resolveAppToolsEmployeeContext, resolveEmployeeRunToolContext } from "../src/employee-run-tools.js";
import { handleEmployeeDraftRequest, type EmployeeDraftStore, type EmployeeDraft, type EmployeeReadReceipt } from "../src/employee-drafts.js";

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
  let failWrite = false;
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
      if (failWrite && rpc.params.name === "write_item") throw new Error("Connection lost after remote write may have happened");
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
    failWrite() { failWrite = true; },
    drift() { remote = remote.map((tool) => ({ ...tool, description: `${tool.description} changed` })); },
    holdLists() { listed = new Promise<void>((resolve) => { markListed = resolve; }); hold = new Promise<void>((resolve) => { release = resolve; }); },
    listed: () => listed, release() { hold = null; release(); },
  };
}

describe("ordinary employee external MCP boundary", () => {
  it("uses the ordinary Work factory for a selected read and retained draft without broad token scopes or Sandbox", async () => {
    const f = await fixture();
    Object.defineProperty(f.env, "Sandbox", { get: () => { throw new Error("Sandbox must not be used"); } });
    expect(isSupportedEmployeeToolScope(`mcp:shiba:${f.read.gatewayName}`)).toBe(false);
    expect(await resolveEmployeeRunToolContext(f.env, f.binding.employeeId, "self-hosted", owner)).toBeNull();
    const context = await resolveAppToolsEmployeeContext(f.env, f.binding.executionContextId);
    expect(context?.allowed.sort()).toEqual([`mcp:shiba:${f.read.gatewayName}`, `mcp:shiba:${f.write.gatewayName}`].sort());
    expect(context?.principal.scopes).not.toContain("mcp:external");
    const reads = new Map<string, EmployeeReadReceipt>(), drafts = new Map<string, EmployeeDraft>(), objects = new Map<string, string>();
    const store: EmployeeDraftStore = { getReadReceipt: (id) => reads.get(id) ?? null, saveReadReceipt: (value) => { reads.set(value.id, structuredClone(value)); },
      getDraft: (id) => drafts.get(id) ?? null, listDrafts: () => [...drafts.values()], saveDraft: (value) => { drafts.set(value.id, structuredClone(value)); } };
    const put = vi.fn(async (key: string, body: string) => { objects.set(key, body); return { key }; });
    f.env.ATTACHMENTS = { put, get: async (key: string) => {
      const body = objects.get(key); if (body === undefined) return null;
      const bytes = new TextEncoder().encode(body); return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
    } } as unknown as R2Bucket;
    const tools = createEmployeeRunTools(f.env, () => f.binding.employeeId, () => f.binding.executionContextId, () => "self-hosted", () => owner, store,
      () => resolveAppToolsEmployeeContext(f.env, f.binding.executionContextId));
    const catalog = tools.employee_tool_catalog!.execute as (input: object, options: unknown) => Promise<unknown>;
    const call = tools.employee_tool_call!.execute as (input: object, options: unknown) => Promise<{ sourceReadId?: string; result: unknown }>;
    const retain = tools.employee_retain_draft!.execute as (input: object, options: unknown) => Promise<{ draft: EmployeeDraft; downloadUrl: string }>;
    expect(JSON.stringify(await catalog({}, {}))).not.toContain("SECRET_UNAUTHORIZED_SCHEMA");
    const read = await call({ tool: f.read.gatewayName, args: { resourceId: "record-1" } }, { toolCallId: "factory-read" });
    expect(read.sourceReadId).toMatch(/^read_[a-f0-9]{64}$/);
    const receipt = reads.get(read.sourceReadId!)!;
    expect(receipt).toMatchObject({ tool: f.read.gatewayName, sourceMessageIds: [], external: { schemaVersion: f.read.schemaVersion, resourceIds: ["record-1"], effect: "read", adapterVersion: 1 } });
    const output = await retain({ path: "drafts/record.md", content: "Internal selected-record summary", sourceReadId: read.sourceReadId }, { toolCallId: "factory-draft" });
    expect(output.draft.source).toEqual(receipt); expect([...objects.values()]).toEqual(["Internal selected-record summary"]);
    expect(await (await handleEmployeeDraftRequest(new Request(`https://shiba.test${output.downloadUrl}`), f.env, store, f.binding))?.text()).toBe("Internal selected-record summary");
    const pending = await call({ tool: f.write.gatewayName, args: { resourceId: "record-1", body: "Exact write" } }, { toolCallId: "factory-write" });
    expect(pending.sourceReadId).toBeUndefined(); expect(reads.size).toBe(1); expect(f.calls).toHaveLength(1);
    const hidden = f.tools.find((tool) => tool.remoteName === "hidden_item")!;
    await expect(call({ tool: hidden.gatewayName, args: { resourceId: "record-1" } }, { toolCallId: "hidden-write" })).rejects.toThrow("unavailable");
    await f.env.AGENT_AUDIT.prepare("UPDATE employee_tool_grants SET lifecycle='revoked' WHERE employee_id=?").bind(f.binding.employeeId).run();
    await expect(retain({ path: "another.md", content: "Draft", sourceReadId: read.sourceReadId }, { toolCallId: "revoked-draft" })).rejects.toThrow("authority changed");
    expect(put).toHaveBeenCalledTimes(1); expect(reads.get(read.sourceReadId!)).toEqual(receipt);
  });

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

  it("keeps an unknown approved write one-shot and never turns it into read evidence", async () => {
    const f = await fixture();
    const pending = await callEmployeeExternalMcp(f.env, f.binding, f.write.gatewayName, { resourceId: "record-1", body: "Exact" }, "unknown-write");
    expect(pending).toMatchObject({ structuredContent: { status: "pending_approval" } });
    expect(pending._meta?.["com.shiba/employee-mcp-read"]).toBeUndefined();
    const approval = (await listEmployeeActionApprovals(f.env, { orgId: "self-hosted", status: "pending" }))[0];
    if (!approval) throw new Error("Approval missing");
    f.failWrite();
    expect(await f.approve(approval.approvalId)).toMatchObject({ dispatch: { status: "unknown_outcome" } });
    expect(await f.approve(approval.approvalId)).toMatchObject({ dispatch: { status: "unknown_outcome" } });
    await expect(callEmployeeExternalMcp(f.env, f.binding, f.write.gatewayName, { resourceId: "record-1", body: "Exact" }, "unknown-write")).rejects.toThrow("unavailable");
    expect(f.calls).toEqual([{ name: "write_item", arguments: { resourceId: "record-1", body: "Exact" } }]);
    expect((await listCapabilityInvocations(f.env, { orgId: "self-hosted" }))[0]?.status).toBe("unknown_outcome");
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
