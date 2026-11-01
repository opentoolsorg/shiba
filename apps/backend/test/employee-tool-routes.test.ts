import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ dashboard: false }));
const tokenState = vi.hoisted(() => ({ principal: "agent-a", orgId: "self-hosted", scopes: ["runs:read", "sandbox:exec"] as string[] }));
const orchestrator = vi.hoisted(() => ({ requests: [] as Request[] }));

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => authState.dashboard),
  resolveUserId: vi.fn(async () => "owner@example.test"),
}));
vi.mock("../src/v1-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/v1-auth.js")>();
  return { ...actual, authorizeV1Request: vi.fn(async () => null) };
});
vi.mock("../src/agent-tokens.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-tokens.js")>();
  return {
    ...actual,
    verifyToken: vi.fn(async () => ({
      principal: tokenState.principal, orgId: tokenState.orgId, kind: "agent", scopes: tokenState.scopes,
      created: 1, revoked: false,
    })),
  };
});
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async (request: Request) => {
    orchestrator.requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === "/api/runs" && request.method === "POST") {
      return Response.json({ approvalId: "run-approval-1" }, { status: 202 });
    }
    if (url.pathname === "/api/runs/run-1" && request.method === "GET") {
      return Response.json({ id: "run-1", status: "running" });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  } }),
  routeAgentRequest: async () => null,
}));

import type { Env } from "../src/env.js";
import { createCustomAgent, getCustomAgentById } from "../src/custom-agents-store.js";
import { handleEmployeeTools } from "../src/employee-tool-routes.js";
import { createEmployeeRunTools } from "../src/employee-run-tools.js";
import {
  beginCapabilityInvocation,
  claimEmployeeActionInvocation,
  EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX,
  finishCapabilityInvocation,
  getCapabilityInvocationByIdempotencyKey,
  pruneCapabilityInvocations,
} from "../src/capability-invocations.js";
import { hashToolArgs } from "../src/mcp-gateway.js";
import { isOrgApiPath } from "../src/public-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

function env(): Env {
  return { AGENT_AUDIT: customAgentD1().database, CodingOrchestrator: {} } as unknown as Env;
}

function policyRequest(employeeId: string, body: unknown, expectedVersion = 1) {
  return new Request(`https://x/api/employee-tools/${employeeId}/policy`, {
    method: "PUT", headers: { "content-type": "application/json", "CF-Access-Authenticated-User-Email": "owner@example.test" },
    body: JSON.stringify({ expectedVersion, actorId: tokenState.principal, role: "operator", resourcesByCapability: body }),
  });
}

function callRequest(employeeId: string, tool: string, args: Record<string, unknown>) {
  return new Request(`https://x/api/employee-tools/${employeeId}/call`, {
    method: "POST", headers: { authorization: "Bearer shb_test", "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
}

describe("employee tool local workflow", () => {
  beforeEach(() => {
    authState.dashboard = false;
    tokenState.principal = "agent-a";
    tokenState.orgId = "self-hosted";
    tokenState.scopes = ["runs:read", "sandbox:exec"];
    orchestrator.requests.length = 0;
  });

  it("routes employee endpoints through the org-authenticated API lane", () => {
    expect(isOrgApiPath("/api/employee-tools/agent-a/policy")).toBe(true);
    expect(isOrgApiPath("/api/employee-tools/approvals/apv-1")).toBe(true);
  });

  it("persists owned read scopes, dispatches existing run_status, and rechecks revoked grants", async () => {
    authState.dashboard = true;
    const bindings = env();
    const employee = await createCustomAgent(bindings, "self-hosted", "scout", {
      name: "Scout", instructions: "Read run status", harness: "opencode",
    });
    const configured = await handleEmployeeTools(policyRequest(employee.id, {
      "mcp:shiba:run_status": ["run-1"],
    }), bindings);
    expect(configured?.status).toBe(200);
    expect(await configured?.json()).toMatchObject({ employeeVersion: 2, toolScopes: ["mcp:shiba:run_status"] });
    const policyRead = await handleEmployeeTools(new Request(`https://x/api/employee-tools/${employee.id}/policy`, {
      headers: { "CF-Access-Authenticated-User-Email": "owner@example.test" },
    }), bindings);
    const policyBody = await policyRead?.json() as { employeeVersion: number; toolScopes: string[]; grants: Array<Record<string, unknown>> };
    expect(policyBody).toMatchObject({ employeeVersion: 2, toolScopes: ["mcp:shiba:run_status"] });
    expect(policyBody.grants).toEqual(expect.arrayContaining([expect.objectContaining({
      subjectType: "workspace", subjectId: "self-hosted", capabilityId: "mcp:shiba:run_status", resourceId: "run-1", lifecycle: "active",
    })]));
    authState.dashboard = false;

    const result = await handleEmployeeTools(callRequest(employee.id, "run_status", { runId: "run-1" }), bindings);
    expect(result?.status).toBe(200);
    expect(await result?.json()).toMatchObject({ ok: true, result: { structuredContent: { id: "run-1", status: "running" }, _meta: { "com.shiba/invocation": { status: "succeeded" } } } });
    expect(orchestrator.requests).toHaveLength(1);
    expect(orchestrator.requests[0]?.headers.get("x-agent-principal")).toBe("agent-a");

    authState.dashboard = true;
    const revoked = await handleEmployeeTools(policyRequest(employee.id, {}, 2), bindings);
    expect(revoked?.status).toBe(200);
    authState.dashboard = false;
    const denied = await handleEmployeeTools(callRequest(employee.id, "run_status", { runId: "run-1" }), bindings);
    expect(denied?.status).toBe(403);
    expect(orchestrator.requests).toHaveLength(1);
    expect((await getCustomAgentById(bindings, "self-hosted", employee.id))?.config.toolScopes).toEqual([]);
  });

  it("freezes a queue_run payload, requires a dashboard decision, replays only the approved call, and emits a receipt", async () => {
    authState.dashboard = true;
    const bindings = env();
    const employee = await createCustomAgent(bindings, "self-hosted", "builder", {
      name: "Builder", instructions: "Queue approved work", harness: "opencode",
    });
    const repoUrl = "https://github.com/acme/demo";
    const configured = await handleEmployeeTools(policyRequest(employee.id, { "mcp:shiba:queue_run": [repoUrl] }), bindings);
    expect(configured?.status).toBe(200);
    authState.dashboard = false;
    const args = { repoUrl, task: "Inspect the CI failure" };
    const pending = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
    expect(pending?.status).toBe(202);
    const pendingBody = await pending!.json() as { approvalId: string; status: string };
    expect(pendingBody).toMatchObject({ status: "pending_approval", employeeVersion: 2, tool: "queue_run" });
    expect(orchestrator.requests).toHaveLength(0);

    authState.dashboard = true;
    const list = await handleEmployeeTools(new Request("https://x/api/employee-tools/approvals", {
      headers: { "CF-Access-Authenticated-User-Email": "owner@example.test" },
    }), bindings);
    expect(await list?.json()).toMatchObject({ approvals: [{ approvalId: pendingBody.approvalId, payload: args, status: "pending" }] });
    const decision = await handleEmployeeTools(new Request(`https://x/api/employee-tools/approvals/${pendingBody.approvalId}`, {
      method: "POST", headers: { "content-type": "application/json", "CF-Access-Authenticated-User-Email": "owner@example.test" },
      body: JSON.stringify({ employeeId: employee.id, approved: true }),
    }), bindings);
    expect(await decision?.json()).toMatchObject({ status: "approved" });
    authState.dashboard = false;

    const changed = await handleEmployeeTools(callRequest(employee.id, "queue_run", { ...args, task: "Altered after approval" }), bindings);
    expect(changed?.status).toBe(202);
    expect(await changed?.json()).toMatchObject({ status: "pending_approval" });
    expect(orchestrator.requests).toHaveLength(0);

    const dispatched = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
    expect(dispatched?.status).toBe(200);
    expect(await dispatched?.json()).toMatchObject({
      result: { structuredContent: { status: "pending_approval", approvalId: "run-approval-1" }, _meta: { "com.shiba/invocation": { status: "pending_approval" } } },
    });
    expect(orchestrator.requests).toHaveLength(1);
    expect(await orchestrator.requests[0]!.clone().json()).toMatchObject({ repoUrl, task: args.task, kind: "run" });
    const replay = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
    expect(await replay?.json()).toMatchObject({ result: { _meta: { "com.shiba/invocation": { status: "pending_approval", replayed: true } } } });
    expect(orchestrator.requests).toHaveLength(1);
  });

  it("fails closed for unsupported actions and callers missing the registered tool's scope", async () => {
    authState.dashboard = true;
    const bindings = env();
    const employee = await createCustomAgent(bindings, "self-hosted", "reader", {
      name: "Reader", instructions: "Read status", harness: "opencode",
    });
    expect((await handleEmployeeTools(policyRequest(employee.id, { "mcp:shiba:run_status": ["run-1"] }), bindings))?.status).toBe(200);
    authState.dashboard = false;
    tokenState.scopes = ["sandbox:exec"];
    const missing = await handleEmployeeTools(callRequest(employee.id, "run_status", { runId: "run-1" }), bindings);
    expect(missing?.status).toBe(403);
    const unsupported = await handleEmployeeTools(callRequest(employee.id, "delete_email", { emailId: "e1" }), bindings);
    expect(unsupported?.status).toBe(400);
    expect(orchestrator.requests).toHaveLength(0);
  });

  it("applies current employee grants to normal run tools and blocks unselected or revoked resources", async () => {
    authState.dashboard = true;
    const bindings = env();
    const employee = await createCustomAgent(bindings, "self-hosted", "normal-run-reader", {
      name: "Normal run reader", instructions: "Read one approved run", harness: "opencode",
    });
    expect((await handleEmployeeTools(policyRequest(employee.id, { "mcp:shiba:run_status": ["run-1"] }), bindings))?.status).toBe(200);
    authState.dashboard = false;

    const tools = createEmployeeRunTools(bindings, () => employee.id, () => "web:owner:session-reader", () => "self-hosted", () => "agent-a");
    const catalog = tools.employee_tool_catalog as unknown as { execute: (args: Record<string, never>) => Promise<Record<string, unknown>> };
    const call = tools.employee_tool_call as unknown as { execute: (args: { tool: string; args: Record<string, unknown> }) => Promise<Record<string, unknown>> };
    const discovered = await catalog.execute({});
    expect(discovered).toMatchObject({ employee: { id: employee.id, version: 2, role: "operator" }, actions: [{ tool: "run_status", resources: ["run-1"] }] });
    expect(await call.execute({ tool: "run_status", args: { runId: "run-1" } })).toMatchObject({
      ok: true, result: { structuredContent: { id: "run-1", status: "running" } },
    });
    const wrongActor = createEmployeeRunTools(bindings, () => employee.id, () => "web:other:session", () => "self-hosted", () => "agent-b");
    const wrongActorCatalog = wrongActor.employee_tool_catalog as unknown as { execute: (args: Record<string, never>) => Promise<Record<string, unknown>> };
    const wrongActorCall = wrongActor.employee_tool_call as unknown as { execute: (args: { tool: string; args: Record<string, unknown> }) => Promise<Record<string, unknown>> };
    expect(await wrongActorCatalog.execute({})).toMatchObject({ actions: [] });
    await expect(wrongActorCall.execute({ tool: "run_status", args: { runId: "run-1" } })).rejects.toThrow("unavailable under the current policy");
    await expect(call.execute({ tool: "queue_run", args: { repoUrl: "https://github.com/acme/demo", task: "not selected" } })).rejects.toThrow("unavailable under the current policy");
    await expect(call.execute({ tool: "run_status", args: { runId: "run-2" } })).rejects.toThrow("employee_connection_or_resource_grant_missing");
    expect(orchestrator.requests).toHaveLength(1);

    authState.dashboard = true;
    expect((await handleEmployeeTools(policyRequest(employee.id, {}, 2), bindings))?.status).toBe(200);
    authState.dashboard = false;
    expect(await catalog.execute({})).toMatchObject({ actions: [] });
    await expect(call.execute({ tool: "run_status", args: { runId: "run-1" } })).rejects.toThrow("unavailable under the current policy");
    expect(orchestrator.requests).toHaveLength(1);
  });

  it("binds normal employee-run approvals to the session and profile version", async () => {
    authState.dashboard = true;
    const bindings = env();
    const employee = await createCustomAgent(bindings, "self-hosted", "normal-run-builder", {
      name: "Normal run builder", instructions: "Queue one approved repository", harness: "opencode",
    });
    const repoUrl = "https://github.com/acme/demo";
    expect((await handleEmployeeTools(policyRequest(employee.id, { "mcp:shiba:queue_run": [repoUrl] }), bindings))?.status).toBe(200);
    const args = { repoUrl, task: "Inspect the repository" };
    const sessionA = createEmployeeRunTools(bindings, () => employee.id, () => "web:owner:session-a", () => "self-hosted", () => "agent-a").employee_tool_call as unknown as {
      execute: (input: { tool: string; args: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
    const sessionB = createEmployeeRunTools(bindings, () => employee.id, () => "web:owner:session-b", () => "self-hosted", () => "agent-a").employee_tool_call as unknown as {
      execute: (input: { tool: string; args: Record<string, unknown> }) => Promise<Record<string, unknown>>;
    };
    authState.dashboard = false;
    const pendingA = await sessionA.execute({ tool: "queue_run", args });
    expect(pendingA).toMatchObject({ status: "pending_approval", employeeVersion: 2 });
    const approvalA = String(pendingA.approvalId);
    authState.dashboard = true;
    const listed = await handleEmployeeTools(new Request("https://x/api/employee-tools/approvals", {
      headers: { "CF-Access-Authenticated-User-Email": "owner@example.test" },
    }), bindings);
    expect(await listed?.json()).toMatchObject({ approvals: [expect.objectContaining({ approvalId: approvalA, executionContextId: "web:owner:session-a" })] });
    const decision = await handleEmployeeTools(new Request(`https://x/api/employee-tools/approvals/${approvalA}`, {
      method: "POST", headers: { "content-type": "application/json", "CF-Access-Authenticated-User-Email": "owner@example.test" },
      body: JSON.stringify({ employeeId: employee.id, approved: true }),
    }), bindings);
    expect(await decision?.json()).toMatchObject({ status: "approved" });

    authState.dashboard = false;
    const fromOtherSession = await sessionB.execute({ tool: "queue_run", args });
    expect(fromOtherSession).toMatchObject({ status: "pending_approval", employeeVersion: 2 });
    expect(fromOtherSession.approvalId).not.toBe(approvalA);
    expect(orchestrator.requests).toHaveLength(0);

    authState.dashboard = true;
    expect((await handleEmployeeTools(policyRequest(employee.id, { "mcp:shiba:queue_run": [repoUrl] }, 2), bindings))?.status).toBe(200);
    authState.dashboard = false;
    const afterProfileChange = await sessionA.execute({ tool: "queue_run", args });
    expect(afterProfileChange).toMatchObject({ status: "pending_approval", employeeVersion: 3 });
    expect(afterProfileChange.approvalId).not.toBe(approvalA);
    expect(orchestrator.requests).toHaveLength(0);
  });

  it("reconsents expired unused writes while consumed and unknown receipts fence replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    try {
      authState.dashboard = true;
      const bindings = env();
      const employee = await createCustomAgent(bindings, "self-hosted", "expiring-builder", {
        name: "Expiring builder", instructions: "Queue approved work", harness: "opencode",
      });
      const repoUrl = "https://github.com/acme/expiry-demo";
      expect((await handleEmployeeTools(policyRequest(employee.id, { "mcp:shiba:queue_run": [repoUrl] }), bindings))?.status).toBe(200);
      const args = { repoUrl, task: "First approved task" };
      authState.dashboard = false;
      const original = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
      const originalBody = await original!.json() as { approvalId: string };
      authState.dashboard = true;
      const decide = async (approvalId: string) => handleEmployeeTools(new Request(`https://x/api/employee-tools/approvals/${approvalId}`, {
        method: "POST", headers: { "content-type": "application/json", "CF-Access-Authenticated-User-Email": "owner@example.test" },
        body: JSON.stringify({ employeeId: employee.id, approved: true }),
      }), bindings);
      expect(await (await decide(originalBody.approvalId))?.json()).toMatchObject({ status: "approved" });

      vi.advanceTimersByTime(16 * 60_000);
      authState.dashboard = false;
      const renewed = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
      expect(renewed?.status, JSON.stringify(await renewed?.clone().json())).toBe(202);
      const renewedBody = await renewed!.json() as { approvalId: string; status: string };
      expect(renewedBody).toMatchObject({ status: "pending_approval" });
      expect(renewedBody.approvalId).not.toBe(originalBody.approvalId);

      authState.dashboard = true;
      await decide(renewedBody.approvalId);
      authState.dashboard = false;
      const consumed = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
      expect(consumed?.status).toBe(200);
      expect(orchestrator.requests).toHaveLength(1);
      vi.advanceTimersByTime(16 * 60_000);
      const replay = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
      expect(await replay?.json()).toMatchObject({ result: { _meta: { "com.shiba/invocation": { status: "pending_approval", replayed: true } } } });
      expect(orchestrator.requests).toHaveLength(1);

      const unknownArgs = { repoUrl, task: "Check the unknown receipt" };
      const unknownRequest = await handleEmployeeTools(callRequest(employee.id, "queue_run", unknownArgs), bindings);
      const unknownPending = await unknownRequest!.json() as { approvalId: string };
      authState.dashboard = true;
      await decide(unknownPending.approvalId);
      authState.dashboard = false;
      const unknownKey = `${EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX}${unknownPending.approvalId}`;
      const begun = await beginCapabilityInvocation(bindings, {
        principal: tokenState.principal, orgId: tokenState.orgId, tool: "queue_run",
        argsHash: await hashToolArgs(unknownArgs), idempotencyKey: unknownKey,
      });
      expect(begun.kind).toBe("created");
      if (begun.kind !== "created") throw new Error("Could not seed unknown dispatch receipt.");
      expect(await finishCapabilityInvocation(bindings, {
        invocationId: begun.receipt.invocationId, status: "unknown_outcome", errorCode: "test_unknown",
      })).toBe(true);
      vi.advanceTimersByTime(16 * 60_000);
      const unknownReplay = await handleEmployeeTools(callRequest(employee.id, "queue_run", unknownArgs), bindings);
      expect(await unknownReplay?.json()).toMatchObject({ result: { _meta: { "com.shiba/invocation": { status: "unknown_outcome", replayed: true } } } });
      expect(orchestrator.requests).toHaveLength(1);
      await pruneCapabilityInvocations(bindings, Number.MAX_SAFE_INTEGER);
      const prunedUnknown = await handleEmployeeTools(callRequest(employee.id, "queue_run", unknownArgs), bindings);
      expect(prunedUnknown?.status).toBe(409);
      expect(await prunedUnknown?.json()).toMatchObject({ error: "employee_invocation_receipt_pruned_no_replay" });
      expect(orchestrator.requests).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets expiry win against a dispatch held before the atomic claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    try {
      authState.dashboard = true;
      const bindings = env();
      const employee = await createCustomAgent(bindings, "self-hosted", "held-claim-builder", {
        name: "Held claim builder", instructions: "Queue approved work", harness: "opencode",
      });
      const repoUrl = "https://github.com/acme/held-claim";
      expect((await handleEmployeeTools(policyRequest(employee.id, { "mcp:shiba:queue_run": [repoUrl] }), bindings))?.status).toBe(200);
      const args = { repoUrl, task: "Held before begin" };
      authState.dashboard = false;
      const first = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
      const pending = await first!.json() as { approvalId: string };
      authState.dashboard = true;
      const approved = await handleEmployeeTools(new Request(`https://x/api/employee-tools/approvals/${pending.approvalId}`, {
        method: "POST", headers: { "content-type": "application/json", "CF-Access-Authenticated-User-Email": "owner@example.test" },
        body: JSON.stringify({ employeeId: employee.id, approved: true }),
      }), bindings);
      expect(await approved?.json()).toMatchObject({ status: "approved" });

      let releaseClaim!: () => void;
      const hold = new Promise<void>((resolve) => { releaseClaim = resolve; });
      const delayedClaim = hold.then(async () => claimEmployeeActionInvocation(bindings, {
        approvalId: pending.approvalId, orgId: tokenState.orgId, principal: tokenState.principal,
        tool: "queue_run", argsHash: await hashToolArgs(args),
        idempotencyKey: `${EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX}${pending.approvalId}`,
        now: Date.now(),
      }));
      vi.advanceTimersByTime(16 * 60_000);
      releaseClaim();
      expect(await delayedClaim).toMatchObject({ kind: "expired" });
      expect(await getCapabilityInvocationByIdempotencyKey(bindings, {
        orgId: tokenState.orgId, principal: tokenState.principal,
        idempotencyKey: `${EMPLOYEE_ACTION_IDEMPOTENCY_PREFIX}${pending.approvalId}`,
      })).toBeNull();

      authState.dashboard = false;
      const reconsent = await handleEmployeeTools(callRequest(employee.id, "queue_run", args), bindings);
      expect(reconsent?.status).toBe(202);
      expect(orchestrator.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
