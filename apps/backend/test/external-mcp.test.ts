import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createToolRegistry, visibleToolsForPrincipal } from "../src/mcp-gateway.js";
import { createExternalMcpServer, discoverExternalMcpServer, getExternalMcpServer,
  disableExternalMcpServer, listExternalMcpAccess, listExternalMcpServers, registerExternalMcpTools, reviewExternalMcpTool,
  setExternalMcpAccess, setExternalMcpToolEnabled, validateExternalMcpEndpoint } from "../src/external-mcp.js";
import { listCapabilityInvocations } from "../src/capability-invocations.js";
import { listEmployeeActionApprovals } from "../src/employee-tool-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { handleMcp as handleMcpV1 } from "../src/v1/mcp.js";
import type { V1Context } from "../src/v1/context.js";
import { createToken, orgIdForRecord, verifyToken } from "../src/agent-tokens.js";

const endpoint = "https://mcp.example.com/mcp";
const remoteTools = [
  { name: "sum", description: "Adds values in the fixture server.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } },
];
const agent = { kind: "agent" as const, principal: "assistant-agent", orgId: "org-a", scopes: ["mcp:external" as const], created: 1, revoked: false };
const owner = { principal: "owner@example.test", orgId: "org-a", scopes: ["api:read" as const, "api:write" as const] };

function environment() {
  const { database, sqlite } = customAgentD1();
  const tokens = new Map<string, { value: string; metadata?: unknown }>();
  const AGENT_TOKENS = {
    put: async (key: string, value: string, options?: { metadata?: unknown }) => tokens.set(key, { value, metadata: options?.metadata }),
    get: async (key: string) => tokens.get(key)?.value ?? null,
    list: async () => ({ keys: [...tokens].map(([name, item]) => ({ name, metadata: item.metadata })), list_complete: true }),
  };
  return { env: { AGENT_AUDIT: database, AGENT_TOKENS, MCP_TRUSTED_HOSTS: "mcp.example.com" } as unknown as Env, sqlite };
}

async function api(env: Env, path: string, method = "GET", value?: unknown, principal = owner) {
  const url = new URL(`https://shiba.test/api/v1/mcp/servers${path}`);
  const request = new Request(url, { method, headers: { "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return handleMcpV1({ request, env, url, principal, forward: async () => new Response() } as V1Context);
}

function mockMcp() {
  const calls: string[] = [];
  let tools: unknown[] = structuredClone(remoteTools);
  let fail = false;
  let toolCallGate: Promise<void> | null = null;
  let releaseToolCall: (() => void) | null = null;
  let markToolCallStarted: () => void = () => {};
  const toolCallStarted = new Promise<void>((resolve) => { markToolCallStarted = resolve; });
  let toolListGate: Promise<void> | null = null;
  let releaseToolList: (() => void) | null = null;
  let markToolListStarted: () => void = () => {};
  let toolListStarted = Promise.resolve();
  let failToolLists = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href !== endpoint) throw new Error(`untrusted destination ${url.href}`);
    if (init?.redirect !== "error") throw new Error("redirect behavior was not fail closed");
    if (fail) throw new Error("fixture transport failure");
    if (init?.method === "GET") return new Response("GET unsupported", { status: 405 });
    const request = JSON.parse(typeof init?.body === "string" ? init.body : await (input as Request).text()) as { id: number; method: string; params?: Record<string, unknown> };
    calls.push(request.method);
    if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") {
      markToolListStarted();
      if (failToolLists) throw new Error("fixture tools/list failure");
      if (toolListGate) await toolListGate;
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools } });
    }
    if (request.method === "tools/call") {
      markToolCallStarted();
      if (toolCallGate) await toolCallGate;
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "fixture response" }] } });
    }
    throw new Error(`unexpected MCP method ${request.method}`);
  });
  return { calls, fetchMock, waitForToolCall: () => toolCallStarted,
    waitForToolList: () => toolListStarted,
    holdToolCalls() { toolCallGate = new Promise<void>((resolve) => { releaseToolCall = resolve; }); },
    releaseToolCalls() { releaseToolCall?.(); toolCallGate = null; },
    holdToolLists() {
      toolListStarted = new Promise<void>((resolve) => { markToolListStarted = resolve; });
      toolListGate = new Promise<void>((resolve) => { releaseToolList = resolve; });
    },
    releaseToolLists() { releaseToolList?.(); toolListGate = null; },
    set failToolLists(value: boolean) { failToolLists = value; },
    get tools() { return tools; }, set tools(next) { tools = next; }, set fail(value: boolean) { fail = value; } };
}

async function addServer(env: Env) {
  return (await createExternalMcpServer(env, { orgId: "org-a", ownerId: owner.principal, name: "Fixture MCP", endpoint,
    credentialRef: null }))!;
}

async function discoveredServer(env: Env, fetchMock: typeof fetch) {
  vi.stubGlobal("fetch", fetchMock);
  const server = await addServer(env);
  await discoverExternalMcpServer(env, server);
  const fresh = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
  const tool = (await listExternalMcpServers(env, "org-a", owner.principal))[0]!.tools[0]!;
  return { server: fresh, tool };
}

afterEach(() => vi.unstubAllGlobals());

describe("owner-scoped external MCP registry", () => {
  it("supports draft → bounded discovery → review → scoped gateway call → receipt → revoke", async () => {
    const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
    const draft = await addServer(env);
    expect(draft).toMatchObject({ status: "draft", health: "unknown", credentialRef: null });
    await discoverExternalMcpServer(env, draft);
    const server = (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!;
    const tool = (await listExternalMcpServers(env, "org-a", owner.principal))[0]!.tools[0]!;
    expect(tool).toMatchObject({ remoteName: "sum", effect: "unreviewed", enabled: false });
    await expect(registerExternalMcpTools(createToolRegistry(env), env, agent)).resolves.toBeUndefined();
    await reviewExternalMcpTool(env, server, tool.id, "read", tool.schemaVersion);
    const reviewed = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
    await setExternalMcpToolEnabled(env, reviewed, tool.id, true, tool.schemaVersion);
    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
    const registry = createToolRegistry(env);
    await registerExternalMcpTools(registry, env, agent);
    expect(registry.tools().map((entry) => entry.name)).toContain(tool.gatewayName);
    const result = await registry.invoke(tool.gatewayName, { a: 2, b: 3 }, agent, { idempotencyKey: "fixture-call-1" });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("untrusted");
    expect(JSON.stringify(result)).toContain("invocationId");
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
    expect(await listCapabilityInvocations(env, { orgId: "org-a" })).toMatchObject([{ tool: tool.gatewayName, status: "succeeded" }]);

    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: false });
    const denied = await registry.invoke(tool.gatewayName, { a: 2, b: 3 }, agent);
    expect(denied.isError).toBe(true);
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
    await expect(getExternalMcpServer(env, "org-a", "other-owner", server.id)).resolves.toBeNull();
  });

  it("keeps independent capabilities active through review, disable and rediscovery; whole-server disable still stops all calls", async () => {
    const { env } = environment(); const fixture = mockMcp();
    fixture.tools = [remoteTools[0]!, { ...remoteTools[0]!, name: "count" }];
    vi.stubGlobal("fetch", fixture.fetchMock);
    const draft = await addServer(env);
    await discoverExternalMcpServer(env, draft);
    const initial = (await listExternalMcpServers(env, "org-a", owner.principal))[0]!;
    const sum = initial.tools.find((tool) => tool.remoteName === "sum");
    const count = initial.tools.find((tool) => tool.remoteName === "count");
    if (!sum || !count) throw new Error("two fixture capabilities were not discovered");

    for (const tool of [sum, count]) {
      await reviewExternalMcpTool(env, (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!, tool.id, "read", tool.schemaVersion);
      await setExternalMcpToolEnabled(env, (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!, tool.id, true, tool.schemaVersion);
      await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: draft.id, toolId: tool.id, principal: agent.principal, enabled: true });
    }
    let server = (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!;
    const invokeRegistered = async () => {
      const registry = createToolRegistry(env);
      await registerExternalMcpTools(registry, env, agent);
      return registry;
    };
    let registry = await invokeRegistered();
    expect((await registry.invoke(sum.gatewayName, { a: 2, b: 3 }, agent)).isError).not.toBe(true);
    expect((await registry.invoke(count.gatewayName, { a: 1, b: 1 }, agent)).isError).not.toBe(true);

    await discoverExternalMcpServer(env, server);
    server = (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!;
    expect(server.status).toBe("enabled");
    registry = await invokeRegistered();
    expect(registry.tools().map((tool) => tool.name)).toEqual(expect.arrayContaining([sum.gatewayName, count.gatewayName]));

    await reviewExternalMcpTool(env, server, sum.id, "approval_required", sum.schemaVersion);
    server = (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!;
    expect(server.status).toBe("enabled");
    registry = await invokeRegistered();
    expect(registry.tools().map((tool) => tool.name)).toContain(count.gatewayName);
    expect(registry.tools().map((tool) => tool.name)).not.toContain(sum.gatewayName);
    expect((await registry.invoke(count.gatewayName, { a: 1, b: 1 }, agent)).isError).not.toBe(true);

    const access = await listExternalMcpAccess(env, "org-a", draft.id);
    expect(access.find((grant) => grant.capabilityId === count.capabilityId)?.enabled).toBe(true);
    await setExternalMcpToolEnabled(env, server, sum.id, false, sum.schemaVersion);
    expect((await getExternalMcpServer(env, "org-a", owner.principal, draft.id))?.status).toBe("enabled");
    expect((await registry.invoke(count.gatewayName, { a: 1, b: 1 }, agent)).isError).not.toBe(true);

    fixture.tools = [{ ...remoteTools[0]!, description: "Changed schema metadata." }, { ...remoteTools[0]!, name: "count" }];
    expect((await registry.invoke(count.gatewayName, { a: 1, b: 1 }, agent)).isError).toBe(true);
    server = (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!;
    expect(server.status).toBe("enabled");
    const afterDrift = (await listExternalMcpServers(env, "org-a", owner.principal))[0]!.tools;
    expect(afterDrift.find((tool) => tool.remoteName === "sum")).toMatchObject({ enabled: false, effect: "unreviewed" });
    expect(afterDrift.find((tool) => tool.remoteName === "count")?.enabled).toBe(true);
    registry = await invokeRegistered();
    expect((await registry.invoke(count.gatewayName, { a: 1, b: 1 }, agent)).isError).not.toBe(true);

    await disableExternalMcpServer(env, server);
    expect((await getExternalMcpServer(env, "org-a", owner.principal, draft.id))?.status).toBe("disabled");
    expect((await registry.invoke(count.gatewayName, { a: 1, b: 1 }, agent)).isError).toBe(true);
  });

  it("rechecks read grants and capability state after a paused schema refresh", async () => {
    for (const revoke of [true, false]) {
      const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
      const { server, tool } = await discoveredServer(env, fixture.fetchMock);
      await reviewExternalMcpTool(env, server, tool.id, "read", tool.schemaVersion);
      const reviewed = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
      await setExternalMcpToolEnabled(env, reviewed, tool.id, true, tool.schemaVersion);
      await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
      const registry = createToolRegistry(env); await registerExternalMcpTools(registry, env, agent);
      fixture.holdToolLists();
      const attempt = registry.invoke(tool.gatewayName, { a: 2, b: 3 }, agent, { idempotencyKey: `paused-read-${revoke}` });
      await fixture.waitForToolList();
      if (revoke) {
        await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: false });
      } else {
        await setExternalMcpToolEnabled(env, (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!, tool.id, false, tool.schemaVersion);
      }
      fixture.releaseToolLists();
      expect((await attempt).isError).toBe(true);
      expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(0);
    }
  });

  it("queues unknown effects for exact owner approval, then dispatches only the frozen payload and settles its receipt", async () => {
    const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
    const { server, tool } = await discoveredServer(env, fixture.fetchMock);
    await reviewExternalMcpTool(env, server, tool.id, "approval_required", tool.schemaVersion);
    const reviewed = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
    await setExternalMcpToolEnabled(env, reviewed, tool.id, true, tool.schemaVersion);
    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
    const registry = createToolRegistry(env); await registerExternalMcpTools(registry, env, agent);
    const pendingResult = await registry.invoke(tool.gatewayName, { a: 10, b: 5 }, agent, { idempotencyKey: "fixture-write-1" });
    expect(pendingResult).toMatchObject({ _meta: { "com.shiba/invocation": { status: "pending_approval" } } });
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(0);
    const pending = (await listEmployeeActionApprovals(env, { orgId: "org-a", status: "pending" }))[0]!;
    expect(pending).toMatchObject({ employeeId: server.id, action: "sum", payload: { a: 10, b: 5 } });
    const approvalResponse = await api(env, `/${server.id}/approvals/${pending.approvalId}`, "POST", { approved: true });
    expect(approvalResponse?.status).toBe(200);
    expect(await approvalResponse!.json()).toMatchObject({ dispatch: { status: "succeeded" } });
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
    expect(await listCapabilityInvocations(env, { orgId: "org-a" })).toMatchObject([{ status: "succeeded", approvalId: pending.approvalId }]);
    const duplicate = await api(env, `/${server.id}/approvals/${pending.approvalId}`, "POST", { approved: true });
    expect(duplicate?.status).toBe(200);
    expect(await duplicate!.json()).toMatchObject({ dispatch: { status: "succeeded" } });
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
  });

  it("creates a fresh approval after an identical write succeeds while replaying the original operation", async () => {
    const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
    const { server, tool } = await discoveredServer(env, fixture.fetchMock);
    await reviewExternalMcpTool(env, server, tool.id, "approval_required", tool.schemaVersion);
    const reviewed = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
    await setExternalMcpToolEnabled(env, reviewed, tool.id, true, tool.schemaVersion);
    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
    const registry = createToolRegistry(env); await registerExternalMcpTools(registry, env, agent);
    const first = await registry.invoke(tool.gatewayName, { a: 4, b: 9 }, agent, { idempotencyKey: "same-operation" });
    const firstApproval = (first.structuredContent as { approvalId: string }).approvalId;
    const approved = await api(env, `/${server.id}/approvals/${firstApproval}`, "POST", { approved: true });
    expect(await approved!.json()).toMatchObject({ dispatch: { status: "succeeded" } });
    const replay = await registry.invoke(tool.gatewayName, { a: 4, b: 9 }, agent, { idempotencyKey: "same-operation" });
    expect(replay._meta).toMatchObject({ "com.shiba/invocation": { replayed: true, status: "succeeded" } });
    const second = await registry.invoke(tool.gatewayName, { a: 4, b: 9 }, agent, { idempotencyKey: "new-operation" });
    const secondApproval = (second.structuredContent as { approvalId: string }).approvalId;
    expect(secondApproval).not.toBe(firstApproval);
    expect((await listEmployeeActionApprovals(env, { orgId: "org-a", status: "pending" })).map((item) => item.approvalId)).toEqual([secondApproval]);
    expect(await listCapabilityInvocations(env, { orgId: "org-a" })).toMatchObject([
      { tool: tool.gatewayName, status: "pending_approval", approvalId: secondApproval },
      { tool: tool.gatewayName, status: "succeeded", approvalId: firstApproval },
    ]);
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
  });

  it("does not let a duplicate concurrent approval overwrite the in-flight receipt", async () => {
    for (const disableServer of [false, true]) {
      const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
      const { server, tool } = await discoveredServer(env, fixture.fetchMock);
      await reviewExternalMcpTool(env, server, tool.id, "approval_required", tool.schemaVersion);
      const reviewed = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
      await setExternalMcpToolEnabled(env, reviewed, tool.id, true, tool.schemaVersion);
      await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
      const registry = createToolRegistry(env); await registerExternalMcpTools(registry, env, agent);
      const pendingResult = await registry.invoke(tool.gatewayName, { a: 6, b: 2 }, agent);
      const approvalId = (pendingResult.structuredContent as { approvalId: string }).approvalId;
      fixture.holdToolCalls();
      const firstDispatch = api(env, `/${server.id}/approvals/${approvalId}`, "POST", { approved: true });
      await fixture.waitForToolCall();
      if (disableServer) {
        await disableExternalMcpServer(env, (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!);
      } else {
        fixture.failToolLists = true;
      }
      const listCallsBeforeDuplicate = fixture.calls.filter((method) => method === "tools/list").length;
      const duplicateResponse = await api(env, `/${server.id}/approvals/${approvalId}`, "POST", { approved: true });
      expect(await duplicateResponse!.json()).toMatchObject({ dispatch: { status: "in_progress" } });
      expect(await listCapabilityInvocations(env, { orgId: "org-a" })).toMatchObject([{ status: "approved", approvalId }]);
      expect(fixture.calls.filter((method) => method === "tools/list")).toHaveLength(listCallsBeforeDuplicate);
      expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
      fixture.releaseToolCalls();
      expect(await (await firstDispatch)!.json()).toMatchObject({ dispatch: { status: "succeeded" } });
      expect(await listCapabilityInvocations(env, { orgId: "org-a" })).toMatchObject([{ status: "succeeded", approvalId }]);
      expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
    }
  });

  it("rechecks owner approval and grants after paused write preflight before dispatch", async () => {
    for (const disableCapability of [true, false]) {
      const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
      const { server, tool } = await discoveredServer(env, fixture.fetchMock);
      await reviewExternalMcpTool(env, server, tool.id, "approval_required", tool.schemaVersion);
      const reviewed = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
      await setExternalMcpToolEnabled(env, reviewed, tool.id, true, tool.schemaVersion);
      await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
      const registry = createToolRegistry(env); await registerExternalMcpTools(registry, env, agent);
      const pending = await registry.invoke(tool.gatewayName, { a: 5, b: 2 }, agent);
      const approvalId = (pending.structuredContent as { approvalId: string }).approvalId;
      fixture.holdToolLists();
      const dispatch = api(env, `/${server.id}/approvals/${approvalId}`, "POST", { approved: true });
      await fixture.waitForToolList();
      if (disableCapability) {
        await setExternalMcpToolEnabled(env, (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!, tool.id, false, tool.schemaVersion);
      } else {
        await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: false });
      }
      fixture.releaseToolLists();
      expect(await (await dispatch)!.json()).toMatchObject({ dispatch: { status: "failed", errorCode: "approval_stale" } });
      expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(0);
      expect(await listCapabilityInvocations(env, { orgId: "org-a" })).toMatchObject([{ status: "failed", approvalId }]);
    }
  });

  it("fails closed on schema drift, disables grants after transport errors, and reports recovery on retry", async () => {
    const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
    const { server, tool } = await discoveredServer(env, fixture.fetchMock);
    await reviewExternalMcpTool(env, server, tool.id, "read", tool.schemaVersion);
    const reviewed = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
    await setExternalMcpToolEnabled(env, reviewed, tool.id, true, tool.schemaVersion);
    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
    const registry = createToolRegistry(env); await registerExternalMcpTools(registry, env, agent);
    fixture.tools = [{ ...remoteTools[0]!, description: "Changed after owner review." }];
    const drifted = await registry.invoke(tool.gatewayName, { a: 1, b: 1 }, agent);
    expect(drifted.isError).toBe(true);
    let latest = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
    expect(latest.status).toBe("discovered");
    expect((await listExternalMcpServers(env, "org-a", owner.principal))[0]!.tools[0]!.effect).toBe("unreviewed");
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(0);

    fixture.fail = true;
    await expect(discoverExternalMcpServer(env, latest)).rejects.toThrow("transport_unavailable");
    latest = (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!;
    expect(latest).toMatchObject({ status: "error", health: "error", lastErrorCode: "transport_unavailable" });
    fixture.fail = false;
    await discoverExternalMcpServer(env, latest);
    expect((await getExternalMcpServer(env, "org-a", owner.principal, server.id))?.health).toBe("healthy");
  });

  it("requires exact trusted HTTPS hostnames and rejects local/private/metadata targets", async () => {
    const { env } = environment();
    for (const value of ["http://mcp.example.com/mcp", "https://localhost/mcp", "https://127.0.0.1/mcp", "https://metadata.google.internal/mcp", "https://other.example.com/mcp"]) {
      expect(() => validateExternalMcpEndpoint(value, env)).toThrow();
    }
    expect(validateExternalMcpEndpoint(endpoint, env).href).toBe(endpoint);
  });

  it("enforces supported JSON Schema ranges and rejects unsupported assertion keywords", async () => {
    const { env } = environment(); const fixture = mockMcp();
    fixture.tools = [{ name: "bounded", description: "Validated range fixture", inputSchema: {
      type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 3 }, label: { type: "string", minLength: 2, maxLength: 5 } },
      required: ["count", "label"], additionalProperties: false,
    } }];
    vi.stubGlobal("fetch", fixture.fetchMock);
    const draft = await addServer(env);
    await discoverExternalMcpServer(env, draft);
    const server = (await getExternalMcpServer(env, "org-a", owner.principal, draft.id))!;
    const tool = (await listExternalMcpServers(env, "org-a", owner.principal))[0]!.tools[0]!;
    await reviewExternalMcpTool(env, server, tool.id, "read", tool.schemaVersion);
    await setExternalMcpToolEnabled(env, (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!, tool.id, true, tool.schemaVersion);
    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: tool.id, principal: agent.principal, enabled: true });
    const registry = createToolRegistry(env); await registerExternalMcpTools(registry, env, agent);
    expect((await registry.invoke(tool.gatewayName, { count: 4, label: "ok" }, agent)).isError).toBe(true);
    expect((await registry.invoke(tool.gatewayName, { count: 2, label: "x" }, agent)).isError).toBe(true);
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(0);
    expect((await registry.invoke(tool.gatewayName, { count: 3, label: "okay" }, agent)).isError).not.toBe(true);
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);

    const { env: unsupportedEnv } = environment(); const unsupported = mockMcp();
    unsupported.tools = [{ name: "patterned", description: "Unsupported pattern", inputSchema: {
      type: "object", properties: { slug: { type: "string", pattern: "^[a-z]+$" } }, required: ["slug"], additionalProperties: false,
    } }];
    vi.stubGlobal("fetch", unsupported.fetchMock);
    const unsupportedDraft = await addServer(unsupportedEnv);
    await expect(discoverExternalMcpServer(unsupportedEnv, unsupportedDraft)).rejects.toThrow("schema_invalid");
    expect((await getExternalMcpServer(unsupportedEnv, "org-a", owner.principal, unsupportedDraft.id))?.health).toBe("error");
    expect(unsupported.calls.filter((method) => method === "tools/call")).toHaveLength(0);
  });

  it("bounds discovery, namespaces same-name tools across servers, and refuses stale health on enable", async () => {
    const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
    const first = await discoveredServer(env, fixture.fetchMock);
    const secondServer = await createExternalMcpServer(env, { orgId: "org-a", ownerId: owner.principal, name: "Second fixture", endpoint, credentialRef: null });
    if (!secondServer) throw new Error("fixture registration failed");
    await discoverExternalMcpServer(env, secondServer);
    const tools = (await listExternalMcpServers(env, "org-a", owner.principal)).flatMap((server) => server?.tools ?? []);
    expect(tools.map((tool) => tool.gatewayName)).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.gatewayName)).size).toBe(2);
    expect(new Set(tools.map((tool) => tool.capabilityId)).size).toBe(2);

    await reviewExternalMcpTool(env, first.server, first.tool.id, "read", first.tool.schemaVersion);
    const stale = { ...first.server, lastCheckedAt: Date.now() - 6 * 60_000 };
    await expect(setExternalMcpToolEnabled(env, stale, first.tool.id, true, first.tool.schemaVersion)).rejects.toThrow("connection_health_stale");

    fixture.tools = Array.from({ length: 51 }, (_, index) => ({ ...remoteTools[0]!, name: `tool-${index}` }));
    const latest = (await getExternalMcpServer(env, "org-a", owner.principal, first.server.id))!;
    await expect(discoverExternalMcpServer(env, latest)).rejects.toThrow("schema_invalid");
    expect((await getExternalMcpServer(env, "org-a", owner.principal, first.server.id))?.health).toBe("error");
  });

  it("exposes owner-scoped draft, discovery, review, enable, grant and disable API operations", async () => {
    const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
    const draftResponse = await api(env, "", "POST", { name: "Local fixture", transport: "streamable_http", url: endpoint, credentialRef: null });
    expect(draftResponse?.status).toBe(201);
    const draft = (await draftResponse!.json() as { server: { id: string; endpoint: string; credentialRef: string | null } }).server;
    expect(draft).toMatchObject({ endpoint, credentialRef: null });
    expect(JSON.stringify(draft)).not.toContain("secret");
    await expect(api(env, `/${draft.id}/discover`, "POST", {})).resolves.toBeTruthy();
    const toolsResponse = await api(env, `/${draft.id}/tools`);
    const listed = await toolsResponse!.json() as { tools: Array<{ id: string; schemaVersion: string }> };
    const tool = listed.tools[0]!;
    await api(env, `/${draft.id}/tools/${tool.id}/review`, "POST", { effect: "read", schemaVersion: tool.schemaVersion });
    await api(env, `/${draft.id}/tools/${tool.id}/enable`, "POST", { schemaVersion: tool.schemaVersion });
    const token = await createToken(env, agent.principal, ["mcp:external"]);
    const grant = await api(env, `/${draft.id}/tools/${tool.id}/grant`, "POST", { principal: agent.principal, enabled: true });
    expect(grant?.status).toBe(409); // token defaults to self-hosted; it cannot cross org-a's boundary.
    const owned = await api(env, "");
    const servers = await owned!.json() as { servers: Array<{ id: string; tools: Array<{ enabled: boolean }> }> };
    expect(servers.servers).toHaveLength(1);
    expect(servers.servers[0]?.tools[0]?.enabled).toBe(true);
    const noCrossOrgGrant = await api(env, `/${draft.id}/tools`);
    expect((await noCrossOrgGrant!.json() as { access: unknown[] }).access).toEqual([]);
    await api(env, `/${draft.id}`, "DELETE");
    const revoked = await api(env, `/${draft.id}/tools`);
    expect((await revoked!.json() as { access: Array<{ enabled: boolean }> }).access).toEqual([]);
    expect(token.token).toMatch(/^shb_/);
  });

  it("mints a default self-hosted token, grants it to an external MCP capability, then lists and calls that tool", async () => {
    const { env } = environment(); const fixture = mockMcp(); vi.stubGlobal("fetch", fixture.fetchMock);
    const selfHostedOwner = { ...owner, orgId: "self-hosted" };
    const created = await api(env, "", "POST", { name: "Self-hosted fixture", transport: "streamable_http", url: endpoint, credentialRef: null }, selfHostedOwner);
    expect(created?.status).toBe(201);
    const server = (await created!.json() as { server: { id: string } }).server;
    await api(env, `/${server.id}/discover`, "POST", {}, selfHostedOwner);
    const catalog = await api(env, `/${server.id}/tools`, "GET", undefined, selfHostedOwner);
    const tool = ((await catalog!.json() as { tools: Array<{ id: string; gatewayName: string; schemaVersion: string }> }).tools)[0]!;
    await api(env, `/${server.id}/tools/${tool.id}/review`, "POST", { effect: "read", schemaVersion: tool.schemaVersion }, selfHostedOwner);
    await api(env, `/${server.id}/tools/${tool.id}/enable`, "POST", { schemaVersion: tool.schemaVersion }, selfHostedOwner);

    const minted = await createToken(env, "normal-static-agent", ["mcp:external"]);
    expect(minted.record.orgId).toBeUndefined();
    expect(orgIdForRecord(minted.record)).toBe("self-hosted");
    const grant = await api(env, `/${server.id}/tools/${tool.id}/grant`, "POST", { principal: minted.record.principal, enabled: true }, selfHostedOwner);
    expect(grant?.status).toBe(200);

    const authenticated = await verifyToken(env, minted.token);
    expect(authenticated).not.toBeNull();
    const registry = createToolRegistry(env);
    await registerExternalMcpTools(registry, env, authenticated!);
    expect(visibleToolsForPrincipal(registry.tools(), authenticated).map((entry) => entry.name)).toContain(tool.gatewayName);
    const result = await registry.invoke(tool.gatewayName, { a: 7, b: 8 }, authenticated!);
    expect(result.isError).not.toBe(true);
    expect(fixture.calls.filter((method) => method === "tools/call")).toHaveLength(1);
  });
});
