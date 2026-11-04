import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenRecord } from "../src/agent-tokens.js";
import { createCustomAgent, updateCustomAgent } from "../src/custom-agents-store.js";
import { dispatchEmployeeToolForPrincipal, handleEmployeeTools } from "../src/employee-tool-routes.js";
import { getEmployeeActionApproval, replaceEmployeeToolGrants, requestEmployeeActionApproval } from "../src/employee-tool-store.js";
import { hashToolArgs } from "../src/mcp-gateway.js";
import type { Env } from "../src/env.js";
import { createWebSession, type WebSessionRecord } from "../src/web-sessions.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const state = vi.hoisted(() => ({
  owners: new Map<string, string>(), sessions: [] as WebSessionRecord[], queueRequests: [] as Request[],
  execute: vi.fn(async () => ({ ok: true, status: "completed", output: { id: "fixture-only" } })),
}));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async (request: Request) => Boolean(request.headers.get("X-Fixture-User")),
  resolveUserId: async (request: Request) => request.headers.get("X-Fixture-User"),
}));
vi.mock("../src/gmail-routes.js", () => ({
  gmailOwner: async (request: Request) => state.owners.get(request.headers.get("X-Fixture-User") ?? "") ?? null,
}));
vi.mock("../src/v1-auth.js", async (original) => ({
  ...await original<typeof import("../src/v1-auth.js")>(),
  authorizeV1Request: async (request: Request) => request.headers.has("authorization")
    ? { orgId: "self-hosted", principal: "agent:fixture", scopes: ["admin:tokens"], kind: "agent" } : null,
  requireV1Read: () => true, requireV1Write: () => true,
}));
vi.mock("../src/integrations/runtime.js", () => ({ getIntegrationProvider: () => ({
  id: "openconnector", listConnections: async ({ userId }: { userId: string }) => [{ id: `connection:${userId}`, providerKey: "github" }],
  searchActions: async () => [{ id: "github.create_issue", service: "github", name: "Create issue" }], executeTool: state.execute,
}) }));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async (request: Request | string) => {
  const actual = typeof request === "string" ? new Request(request) : request;
  const url = new URL(actual.url);
  if (url.pathname === "/internal/web-sessions") return Response.json({ sessions: state.sessions });
  if (url.pathname === "/api/runs" && actual.method === "POST") {
    state.queueRequests.push(actual);
    return Response.json({ approvalId: "separate-human-run-approval" }, { status: 202 });
  }
  return Response.json({ error: "Not found" }, { status: 404 });
} }) }));

const OWNER = "owner@example.test";
const THIRD = "third@example.test";
const OPERATOR = "operator@example.test";
const ACCOUNT = JSON.stringify(["access", "https://fixture.cloudflareaccess.com", "fixture-aud", "stable-owner-sub"]);
const ORG = "self-hosted";
const PRIVATE_ARGS = { toolkitSlug: "github", toolSlug: "github.create_issue", arguments: { title: "Private owner payload" } };
type Action = "integrations.execute" | "queue_run" | "send_email";

beforeEach(() => {
  state.owners.clear(); state.owners.set(OWNER, ACCOUNT);
  state.owners.set(THIRD, JSON.stringify(["access", "https://fixture.cloudflareaccess.com", "fixture-aud", "third-sub"]));
  state.sessions = []; state.queueRequests.length = 0; state.execute.mockClear();
});

async function fixture(action: Action = "integrations.execute", appSession = false, missingPrivateAccount = false) {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, CodingOrchestrator: {} } as unknown as Env;
  const capabilityId = `mcp:shiba:${action}`;
  const employee = await createCustomAgent(env, ORG, "writer", { name: "Writer", instructions: "Prepare a draft", harness: "opencode", toolScopes: [capabilityId] });
  const actorId = appSession ? OWNER : "worker-agent";
  const resourceId = action === "integrations.execute" ? "github" : action === "queue_run" ? "https://github.com/example/repo" : "mailbox-a";
  const accountId = action === "integrations.execute" && !missingPrivateAccount ? ACCOUNT : undefined;
  const connectionId = accountId ? `connection:${accountId}` : `shiba:${employee.id}:${capabilityId}`;
  const policyVersion = action === "integrations.execute" ? "integrations:openconnector" : "employee-policy-current";
  await replaceEmployeeToolGrants(env, { orgId: ORG, employeeId: employee.id, employeeVersion: employee.version, actorId, role: "member",
    capabilityIds: [capabilityId], resourcesByCapability: { [capabilityId]: [resourceId] },
    resourceConnectionsByCapability: { [capabilityId]: { [resourceId]: connectionId } },
    resourcePolicyVersionsByCapability: { [capabilityId]: { [resourceId]: policyVersion } },
    ...(accountId ? { resourceAccountsByCapability: { [capabilityId]: { [resourceId]: accountId } } } : {}),
  });
  const session = appSession ? createWebSession(OWNER, { metadata: { customAgentId: employee.id, orgId: ORG } }) : undefined;
  if (session) state.sessions = [session];
  const args: Record<string, unknown> = action === "integrations.execute" ? structuredClone(PRIVATE_ARGS)
    : action === "queue_run" ? { repoUrl: resourceId, task: "Private repository task" }
    : { mailbox: resourceId, to: "recipient@example.test", subject: "Private subject", text: "Private email draft" };
  const principal: TokenRecord = { kind: "agent", principal: actorId, orgId: ORG, scopes: [
    action === "integrations.execute" ? "integrations:execute" : action === "queue_run" ? "sandbox:exec" : "email:send",
  ], created: 1, revoked: false };
  const pending = await requestEmployeeActionApproval(env, { orgId: ORG, employeeId: employee.id, employeeVersion: employee.version,
    actorId, connectionId, connectionGeneration: 1, capability: { kind: "mcp", id: capabilityId }, action, resourceId,
    ...(accountId ? { accountId } : {}), ...(session ? { executionContextId: session.agentName } : {}),
    argumentDigest: await hashToolArgs(args), payload: args, policyVersion, expiresAt: Date.now() + 60_000,
  });
  const request = (userId: string, method = "GET", body?: unknown, bearer = false) => new Request(`https://dashboard.test/api/employee-tools/approvals${method === "POST" ? `/${pending.approvalId}` : ""}`, {
    method, headers: { "X-Fixture-User": userId, Origin: "https://dashboard.test", "Content-Type": "application/json", ...(bearer ? { Authorization: "Bearer fixture" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const list = (userId = OWNER, bearer = false) => handleEmployeeTools(request(userId, "GET", undefined, bearer), env);
  const decide = (userId = OWNER, approved = true, bearer = false) => handleEmployeeTools(request(userId, "POST", { employeeId: employee.id, approved }, bearer), env);
  const dispatch = () => dispatchEmployeeToolForPrincipal(env, employee.id, principal, action, args, session?.agentName);
  const stored = () => getEmployeeActionApproval(env, { orgId: ORG, employeeId: employee.id, approvalId: pending.approvalId });
  return { env, sqlite, employee, pending, session, list, decide, dispatch, stored };
}

async function approvals(response: Response | null): Promise<Array<{ approvalId: string; payload: unknown }>> {
  expect(response?.status).toBe(200);
  return ((await response!.json()) as { approvals: Array<{ approvalId: string; payload: unknown }> }).approvals;
}
function noEffects() { expect(state.execute).not.toHaveBeenCalled(); expect(state.queueRequests).toHaveLength(0); }

describe("native employee approval owner and operator authorization", () => {
  it("keeps another connection owner's payload and decision private, including from an unrelated allowlisted operator", async () => {
    const f = await fixture();
    f.env.DASHBOARD_APPROVERS = `${THIRD},${OPERATOR}`;
    expect(await approvals(await f.list(THIRD))).toEqual([]);
    expect((await f.decide(THIRD))?.status).toBe(404);
    expect((await f.stored())?.status).toBe("pending");
    expect(await approvals(await f.list(OPERATOR))).toEqual([]);
    expect((await f.decide(OPERATOR))?.status).toBe(404);
    noEffects();
    expect(await approvals(await f.list())).toEqual([expect.objectContaining({ approvalId: f.pending.approvalId, payload: PRIVATE_ARGS })]);
    expect((await f.decide())?.status).toBe(200);
    expect(await f.stored()).toMatchObject({ status: "approved", decidedBy: OWNER, decisionOwnerAccountId: ACCOUNT });
    expect((await f.dispatch()).status).toBe(200);
    expect(state.execute).toHaveBeenCalledExactlyOnceWith({ ...PRIVATE_ARGS, userId: ACCOUNT });
    expect(state.queueRequests).toHaveLength(0);
  });

  it("compares canonical verified account identity even when the email/display identity is unchanged", async () => {
    const f = await fixture();
    state.owners.set(OWNER, JSON.stringify(["access", "https://different-issuer.test", "fixture-aud", "stable-owner-sub"]));
    expect(await approvals(await f.list())).toEqual([]);
    expect((await f.decide())?.status).toBe(404);
    noEffects();
  });

  it("rejects agent bearer decisions even when a human dashboard cookie would otherwise be authorized", async () => {
    const f = await fixture();
    expect((await f.list(OWNER, true))?.status).toBe(403);
    expect((await f.decide(OWNER, true, true))?.status).toBe(403);
    expect((await f.stored())?.status).toBe("pending");
    noEffects();
  });

  it("rejects approved private legacy records without durable canonical decision proof", async () => {
    const f = await fixture();
    f.sqlite.prepare("UPDATE employee_tool_approvals SET status='approved',decided_by=?,decided_at=? WHERE approval_id=?").run(OWNER, Date.now(), f.pending.approvalId);
    expect((await f.dispatch()).status).toBe(403);
    expect((await f.stored())?.consumedAt).toBeUndefined();
    noEffects();
  });

  it("does not restore legacy private records with missing account provenance through an operator allowlist", async () => {
    const f = await fixture("integrations.execute", false, true);
    f.env.DASHBOARD_APPROVERS = OWNER;
    expect(await approvals(await f.list())).toEqual([]);
    expect((await f.decide())?.status).toBe(404);
    noEffects();
  });

  it.each(["queue_run", "send_email"] as const)("requires explicit current dashboard operator authorization for shared %s rows", async (action) => {
    const f = await fixture(action);
    expect(await approvals(await f.list())).toEqual([]);
    expect((await f.decide())?.status).toBe(404);
    f.env.DASHBOARD_APPROVERS = OPERATOR;
    expect(await approvals(await f.list(THIRD))).toEqual([]);
    expect((await f.decide(THIRD))?.status).toBe(404);
    expect(await approvals(await f.list(OPERATOR))).toHaveLength(1);
    expect((await f.decide(OPERATOR))?.status).toBe(200);
    expect((await f.decide(OPERATOR, false))?.status).toBe(409);
    expect((await f.stored())?.status).toBe("approved");
    noEffects();
  });

  it("rechecks operator removal before dispatch and leaves the approval unconsumed", async () => {
    const f = await fixture("queue_run");
    f.env.DASHBOARD_APPROVERS = OPERATOR;
    expect((await f.decide(OPERATOR))?.status).toBe(200);
    f.env.DASHBOARD_APPROVERS = "";
    expect((await f.dispatch()).status).toBe(403);
    expect((await f.stored())?.consumedAt).toBeUndefined();
    noEffects();
  });

  it("proves retained app-session ownership instead of treating a model-supplied actor label as a human", async () => {
    const f = await fixture("queue_run", true);
    f.env.DASHBOARD_APPROVERS = THIRD;
    expect(await approvals(await f.list(THIRD))).toEqual([]);
    expect((await f.decide(THIRD))?.status).toBe(404);
    expect(await approvals(await f.list())).toHaveLength(1);
    expect((await f.decide())?.status).toBe(200);
    state.sessions = [];
    expect((await f.dispatch()).status).toBe(403);
    expect((await f.stored())?.consumedAt).toBeUndefined();
    noEffects();
  });

  it.each(["profile", "grant", "session-profile", "session-org"])("denies changed %s authority for pending reads and approved dispatch", async (change) => {
    const f = await fixture("integrations.execute", true);
    expect((await f.decide())?.status).toBe(200);
    if (change === "profile") await updateCustomAgent(f.env, ORG, f.employee.id, { ...f.employee.config, instructions: "Changed definition" }, f.employee.version);
    else if (change === "grant") f.sqlite.prepare("UPDATE employee_tool_grants SET lifecycle='revoked'").run();
    else state.sessions = [{ ...f.session!, metadata: { ...f.session!.metadata, [change === "session-profile" ? "customAgentId" : "orgId"]: "other" } }];
    expect((await f.dispatch()).status).toBe(403);
    f.sqlite.prepare("UPDATE employee_tool_approvals SET status='pending' WHERE approval_id=?").run(f.pending.approvalId);
    expect(await approvals(await f.list())).toEqual([]);
    expect((await f.decide())?.status).toBe(404);
    noEffects();
  });

  it.each(["default", "agent:worker", "Automation:daily", " system:job", "mcp:worker", "subagent:worker"])("rejects nonhuman approval identity %s", async (identity) => {
    const f = await fixture();
    state.owners.set(identity, ACCOUNT);
    expect((await f.list(identity))?.status).toBe(401);
    expect((await f.decide(identity))?.status).toBe(401);
    noEffects();
  });
});
