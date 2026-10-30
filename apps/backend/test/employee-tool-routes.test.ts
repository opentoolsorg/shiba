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
});
