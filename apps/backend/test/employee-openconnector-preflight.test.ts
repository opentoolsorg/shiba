import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { handleEmployeeTools } from "../src/employee-tool-routes.js";
import { openConnectorConnectionName } from "../src/integrations/openconnector-provider.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createEmployeeRunTools } from "../src/employee-run-tools.js";
import { buildSessionAgentName } from "../src/web-sessions.js";

const auth = vi.hoisted(() => ({ human: true, sessions: [] as unknown[] }));
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: async () => auth.human, resolveUserId: async () => "owner@example.test" }));
vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: async () => auth.human ? '["better-auth","owner-a"]' : null }));
vi.mock("../src/v1-auth.js", async (original) => ({ ...await original<typeof import("../src/v1-auth.js")>(), authorizeV1Request: async () => null }));
vi.mock("../src/agent-tokens.js", async (original) => ({ ...await original<typeof import("../src/agent-tokens.js")>(),
  verifyToken: async () => ({ principal: "agent-a", orgId: "self-hosted", kind: "agent", scopes: ["integrations:execute"], created: 1, revoked: false }),
}));
vi.mock("agents/routing", () => ({ getAgentByName: async () => ({ fetch: async () => Response.json({ sessions: auth.sessions }) }) }));

const ACCOUNT = '["better-auth","owner-a"]';
const ARGS = { toolkitSlug: "github", toolSlug: "github.create_issue", arguments: { title: "Human-approved frozen issue" } };
function request(path: string, body: unknown, human = auth.human) {
  return new Request(`https://shiba.test${path}`, { method: "POST", headers: {
    "content-type": "application/json", ...(human ? { "CF-Access-Authenticated-User-Email": "owner@example.test" } : { authorization: "Bearer shb_fixture" }),
  }, body: JSON.stringify(body) });
}
beforeEach(() => { auth.human = true; auth.sessions = []; });
afterEach(() => { vi.restoreAllMocks(); });

describe("employee route through the real OpenConnector provider with fixture HTTP", () => {
  it.each(["route grant revoked", "route allowed", "factory cancelled", "factory cancelled during final local grant", "factory expires during final local grant", "factory allowed", "factory initially aborted"])("rechecks authority during the final account lookup: %s", async (scenario) => {
    const { database, sqlite } = customAgentD1();
    let finalLocalChecks = false;
    let finalGrantReads = 0;
    let resumeGrant!: () => void;
    let pausedGrant!: () => void;
    const grantPaused = new Promise<void>((resolve) => { pausedGrant = resolve; });
    const grantReleased = new Promise<void>((resolve) => { resumeGrant = resolve; });
    const prepare = database.prepare.bind(database);
    const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql);
        if (property === "first") return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.first, target, args);
          if (finalLocalChecks && sql.includes("FROM employee_tool_grants") && sql.includes("subject_type = 'actor'") && ++finalGrantReads === 2) {
            pausedGrant();
            await grantReleased;
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    vi.spyOn(database, "prepare").mockImplementation((sql) => wrap(prepare(sql), sql));
    const alias = await openConnectorConnectionName(ACCOUNT);
    const row = { id: "approved-account-row", service: "github", connectionName: alias, configured: true, virtual: false,
      oauthAuthorizationId: "approved-consent", profile: { displayName: "Owner" } };
    let sawActionLookup = false;
    let readsAfterActionLookup = 0;
    let release!: (response: Response) => void;
    let paused!: () => void;
    const pausedLookup = new Promise<void>((resolve) => { paused = resolve; });
    const actionPosts: RequestInit[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/connections") {
        if (sawActionLookup && ++readsAfterActionLookup === 3) {
          paused();
          return new Promise<Response>((resolve) => { release = resolve; });
        }
        return Response.json([row]);
      }
      if (path === "/v1/actions/github.create_issue") {
        if (init?.method !== "POST") {
          sawActionLookup = true;
          return Response.json({ success: true, data: { id: "github.create_issue", service: "github", name: "Create issue" } });
        }
        actionPosts.push(init);
        expect(new Headers(init.headers).get("x-oo-connector-alias")).toBe(alias);
        expect(new Headers(init.headers).get("x-oo-connector-app-id")).toBe(row.id);
        expect(JSON.parse(String(init.body))).toEqual({ input: ARGS.arguments });
        return Response.json({ success: true, data: { id: "created-once" } });
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const env = { AGENT_AUDIT: database, CodingOrchestrator: {}, OPEN_CONNECTOR: { fetch: transport },
      OPEN_CONNECTOR_ADMIN_TOKEN: "fixture-admin", OPEN_CONNECTOR_RUNTIME_TOKEN: "fixture-runtime", DASHBOARD_APPROVERS: "owner@example.test",
    } as unknown as Env;
    const employee = await createCustomAgent(env, "self-hosted", "real-provider-preflight", { name: "Connector", instructions: "Use approved GitHub actions", harness: "opencode" });
    const policy = new Request(`https://shiba.test/api/employee-tools/${employee.id}/policy`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, actorId: "agent-a", role: "operator", resourcesByCapability: { "mcp:shiba:integrations.execute": ["github"] } }),
    });
    expect((await handleEmployeeTools(policy, env))?.status).toBe(200);
    const controller = new AbortController();
    let call: { execute(input: { tool: string; args: typeof ARGS }, options: { toolCallId: string; messages: never[]; abortSignal: AbortSignal }): Promise<{ approvalId?: string; status?: string; result?: { isError?: boolean } }> } | undefined;
    if (scenario.startsWith("factory")) {
      const sessionId = crypto.randomUUID();
      const agentName = buildSessionAgentName("agent-a", sessionId);
      auth.sessions.push({ id: sessionId, agentName, userId: "agent-a", name: "Connector fixture", createdAt: Date.now(), updatedAt: Date.now(),
        metadata: { customAgentId: employee.id, orgId: "self-hosted" } });
      call = createEmployeeRunTools(env, () => employee.id, () => agentName, () => "self-hosted", () => "agent-a").employee_tool_call as unknown as typeof call;
    }
    const invoke = async () => call
      ? call.execute({ tool: "integrations.execute", args: ARGS }, { toolCallId: "approved-fixture-call", messages: [], abortSignal: controller.signal })
      : (await (await handleEmployeeTools(request(`/api/employee-tools/${employee.id}/call`, { tool: "integrations.execute", args: ARGS }), env))!.json()) as { approvalId?: string; status?: string; result?: { isError?: boolean } };
    auth.human = false;
    if (scenario === "factory initially aborted") {
      transport.mockClear();
      controller.abort();
      await expect(invoke()).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
      expect(actionPosts).toHaveLength(0);
      return;
    }
    const pending = await invoke();
    expect(pending.status).toBe("pending_approval");
    const approvalId = pending.approvalId!;
    expect(actionPosts).toHaveLength(0);
    auth.human = true;
    expect((await handleEmployeeTools(request(`/api/employee-tools/approvals/${approvalId}`, { employeeId: employee.id, approved: true }), env))?.status).toBe(200);
    auth.human = false;
    let expiryBoundary = 0;
    if (scenario.startsWith("factory expires")) {
      const approval = sqlite.prepare("SELECT expires_at FROM employee_tool_approvals WHERE approval_id=?").get(approvalId);
      expiryBoundary = Number(approval?.expires_at);
      expect(Number.isSafeInteger(expiryBoundary)).toBe(true);
      vi.spyOn(Date, "now").mockReturnValue(expiryBoundary - 1);
    }
    const execution = invoke();
    await pausedLookup;
    if (scenario === "route grant revoked") sqlite.prepare("UPDATE employee_tool_grants SET lifecycle='revoked' WHERE employee_id=?").run(employee.id);
    if (scenario === "factory cancelled") controller.abort();
    if (scenario.endsWith("during final local grant")) finalLocalChecks = true;
    release(Response.json([row]));
    if (scenario.endsWith("during final local grant")) {
      await grantPaused;
      if (scenario.startsWith("factory expires")) vi.mocked(Date.now).mockReturnValue(expiryBoundary + 1);
      else controller.abort();
      resumeGrant();
    }
    const body = await execution;
    const blocked = scenario === "route grant revoked" || scenario.startsWith("factory cancelled") || scenario.startsWith("factory expires");
    expect(body.result?.isError === true).toBe(blocked);
    expect(actionPosts).toHaveLength(blocked ? 0 : 1);
    expect(readsAfterActionLookup).toBe(3);
  });
});
