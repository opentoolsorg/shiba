import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { createWebSession } from "../src/web-sessions.js";
import { handleV1 } from "../src/v1-routes.js";
import { handleRuns } from "../src/runs-routes.js";
import { handleApprovals } from "../src/approvals-routes.js";
import { formatAgentResult } from "../src/opencode-input.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const fixtures = vi.hoisted(() => ({
  actors: new Map<string, { onRequest(request: Request): Promise<Response> }>(),
  execute: vi.fn(), resolveProfile: vi.fn(),
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  getTools() { return {}; }
  keepAliveWhile<T>(fn: () => Promise<T>) { return fn(); }
  async schedule() { return {}; }
  async onRequest() { return new Response(null, { status: 404 }); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: fixtures.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/custom-agents-resolve.js", async (original) => ({
  ...await original<typeof import("../src/custom-agents-resolve.js")>(), resolveCustomAgentForRun: fixtures.resolveProfile,
}));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async () => true,
  resolveUserId: async (request: Request) => request.headers.get("X-Fixture-Owner") ?? "ordinary-owner",
}));
vi.mock("agents/routing", () => ({ getAgentByName: async (_namespace: unknown, name: string) => ({
  fetch: async (request: Request | string) => {
    const actor = fixtures.actors.get(name);
    return actor ? actor.onRequest(typeof request === "string" ? new Request(request) : request) : Response.json({ error: "Missing actor" }, { status: 404 });
  },
}) }));

const OWNER = "ordinary-owner";
let env: Env;
function actor(name: string) {
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name, env, state: { runs: [] } as OrchestratorState,
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  fixtures.actors.set(name, instance);
  return instance;
}
beforeEach(() => {
  fixtures.actors.clear(); fixtures.execute.mockReset(); fixtures.resolveProfile.mockReset();
  const statement = { bind: (..._values: unknown[]) => statement, run: async () => ({ success: true }), first: async () => null, all: async () => ({ results: [] }) };
  env = { ...productionEnvStubs(), CodingOrchestrator: {}, Sandbox: {}, AGENT_AUDIT: { prepare: () => statement } } as unknown as Env;
  setSandboxHandleResolver(() => ({ destroy: async () => undefined }));
  fixtures.execute.mockResolvedValue(formatAgentResult({ status: "completed", summary: "fixture completed", exitCode: 0, stderrTail: "", changedFiles: ["README.md"], diff: "+fixture", files: [] }));
});

function request(path: string, body: unknown, owner = OWNER) {
  return new Request("https://worker.test"+path, { method: "POST", headers: { "content-type": "application/json", "X-Fixture-Owner": owner }, body: JSON.stringify(body) });
}

describe("trusted run queue ownership reaches actual human approval", () => {
  it.each(["personal", "named"])("lets an ordinary owner approve a v1-created %s run without shared approver membership", async (kind) => {
    const user = actor(OWNER); actor("default");
    const session = createWebSession(OWNER);
    const target = kind === "personal" ? user : actor(session.agentName);
    user.setState({ runs: [], webSessions: [session] });
    const queued = await handleV1(request("/api/v1/threads", {
      repoUrl: "https://github.com/o/r", task: "Inspect safely", threadKey: "default", orgId: "foreign-org",
      ...(kind === "named" ? { session: session.id } : {}),
    }), env, { authorize: async () => ({ principal: OWNER, orgId: "self-hosted", scopes: ["api:read", "api:write"] }) });
    expect(queued?.status, await queued?.clone().text()).toBe(200);
    const approval = target.state.pendingApprovals![0]!;
    expect(approval.threadKey).toBe(kind === "personal" ? OWNER : session.agentName);
    expect(approval.orgId).toBe(OWNER);
    expect(fixtures.execute).not.toHaveBeenCalled();
    const resolved = await handleApprovals(request("/api/approvals", { threadKey: approval.threadKey, approvalId: approval.approvalId, approved: true }), env);
    expect(resolved?.status).toBe(200);
    await vi.waitFor(() => expect(target.state.runs[0]?.status).toBe("completed"));
    expect(target.state.pendingApprovals?.[0]).toMatchObject({ status: "approved", decidedBy: OWNER });
    expect(fixtures.execute).toHaveBeenCalledOnce();
  });

  it("resolves a dashboard-selected profile in the authenticated deployment org despite forged body/header org", async () => {
    const user = actor(OWNER); actor("default");
    fixtures.resolveProfile.mockResolvedValue({ id: "profile", orgId: "self-hosted", version: 1, slug: "own-profile", createdAt: 1, updatedAt: 1,
      config: { name: "Own", instructions: "Use the approved repo", harness: "opencode" } });
    const queued = await handleRuns(request("/api/runs", { repoUrl: "https://github.com/o/r", task: "Inspect", customAgentId: "profile", orgId: "victim-org", threadKey: "victim" }), env);
    expect(queued?.status, await queued?.clone().text()).toBe(200);
    expect(fixtures.resolveProfile).toHaveBeenCalledWith(env, OWNER, "profile", undefined);
    expect(user.state.pendingApprovals?.[0]).toMatchObject({ orgId: OWNER, threadKey: OWNER, customAgentId: "profile" });
  });
});
