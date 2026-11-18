import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentByName } from "agents/routing";
import type { Env } from "../src/env.js";
import type { TokenRecord } from "../src/agent-tokens.js";
import type { McpToolHandler, ToolRegistry } from "../src/mcp-gateway.js";
import { registerRunTools } from "../src/mcp-run-tools.js";
import { registerEmailTools } from "../src/mcp-email-tools.js";
import { registerScreenTools } from "../src/mcp-screen-tools.js";
import { handleApiKeys } from "../src/api-keys-routes.js";
import { handleTrigger } from "../src/trigger.js";
import { queueEmailApproval } from "../src/email-approvals.js";
import { handleSlackCommand } from "../src/slack-routes.js";
import { slackApprovalOrchestratorName } from "../src/slack-thread.js";
import { resolveSlackCanvasBinding, verifySlackCanvasIntake } from "../src/slack-canvas.js";
import { slackCanvasOriginPatch } from "../src/agents/orchestrator-slack.js";
import type { OrchestratorState } from "../src/agents/orchestrator.js";
import { localDispatchFor, orchestratorNameFor } from "../src/platform/do-resolver.js";
import { handleReasonNetwork } from "../src/reason-network/routes.js";
import { scheduledJobs } from "../src/scheduled-jobs.js";
import { listAdminWorkspaces } from "../src/governance/admin-console.js";
import { reportError } from "../src/observability.js";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn() }));
vi.mock("../src/governance/admin-console.js", () => ({ listAdminWorkspaces: vi.fn() }));
vi.mock("../src/observability.js", () => ({ reportError: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/v1-auth.js", () => ({
  authorizeV1Request: async () => ({ principal: "agent-a", orgId: "workspace-a", apiKey: {}, scopes: ["api:read"] }),
  apiKeyAllowsHttpMethod: () => true,
  requireV1Scope: () => true,
  v1Forbidden: () => new Response(null, { status: 403 }),
  v1Unauthorized: () => new Response(null, { status: 401 }),
}));
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: async () => true, resolveUserId: async () => "owner-a" }));
vi.mock("../src/reason-network/approval-store.js", () => ({ reasonNetworkApprovalSetup: async () => ({ activeGrants: 0, pendingApprovals: 0 }) }));
vi.mock("../src/local-dispatch.js", () => ({ localDispatchStub: (env: Env, ownerId?: string) => localDispatchFor(env, { ownerId }) }));
vi.mock("../src/slack.js", async (original) => ({
  ...await original<typeof import("../src/slack.js")>(),
  verifySlackRequest: async () => true,
}));

const principal: TokenRecord = { principal: "agent-a", orgId: "workspace-a", scopes: ["sandbox:exec", "runs:read"], created: 0, revoked: false };
const requests: Request[] = [];
const token = "a-deployment-trigger-token-at-least-32-characters";
function environment(flag?: string): Env {
  return { SHIBA_SCOPED_DO: flag, CodingOrchestrator: {}, TRIGGER_TOKEN: token, SLACK_SIGNING_SECRET: "signed" } as unknown as Env;
}
function tools(env: Env) {
  const handlers = new Map<string, McpToolHandler>();
  const registry = { registerTool: (name: string, _scope: string, handler: McpToolHandler) => handlers.set(name, handler) } as unknown as ToolRegistry;
  registerRunTools(registry, env);
  registerScreenTools(registry, env);
  registerEmailTools(registry, env);
  return (name: string, args: Record<string, unknown> = {}, record = principal) => handlers.get(name)!(args, { env, principal: record });
}
function names() { return vi.mocked(getAgentByName).mock.calls.map(([, name]) => name); }
async function slash(env: Env, teamId = "TEAM_A") {
  return handleSlackCommand(new Request("https://worker.test/api/slack/command", {
    method: "POST",
    body: new URLSearchParams({ command: "/shiba", team_id: teamId, channel_id: "CHANNEL_A", user_id: "USER_A", text: "https://github.com/example/repo fix bug" }),
  }), env);
}

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  vi.mocked(listAdminWorkspaces).mockResolvedValue([]);
  vi.mocked(getAgentByName).mockImplementation(async () => ({ fetch: async (request: Request) => {
    requests.push(request);
    return Response.json({ approvalId: "approval-1", runs: [], approvals: [], decided: [] });
  } }) as never);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("scoped Durable Object caller isolation", () => {
  it.each([undefined, "0"])("keeps every formerly shared caller on default with flag %s", async (flag) => {
    const env = environment(flag);
    const call = tools(env);
    await call("queue_run", { repoUrl: "https://github.com/example/repo", task: "fix" });
    await call("list_runs");
    await call("run_status", { runId: "run-1" });
    await call("list_approvals");
    await call("screen_click", { runId: "run-1", x: 1, y: 2 });
    await handleApiKeys(new Request("https://worker.test/api/v1/runs", { headers: { authorization: "Bearer key" } }), env);
    await queueEmailApproval(env, { kind: "email_send", mailbox: "agent@example.test", payload: {} }, { workspaceId: "workspace-a" });
    await handleTrigger(new Request("https://worker.test/api/trigger", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ repoUrl: "https://github.com/example/repo", task: "fix", workspaceId: "workspace-b" }) }), env);
    expect((await slash(env))?.status).toBe(200);
    await scheduledJobs["drafts.sweep"](env);
    expect(names()).toHaveLength(10);
    expect(new Set(names())).toEqual(new Set(["default"]));
    expect(listAdminWorkspaces).not.toHaveBeenCalled();
  });

  it("separates workspaces and threads without scope-component collisions", () => {
    const env = environment("1");
    const a = orchestratorNameFor(env, { workspaceId: "workspace-a" });
    const b = orchestratorNameFor(env, { workspaceId: "workspace-b" });
    const thread = orchestratorNameFor(env, { workspaceId: "workspace-a", threadKey: "thread-1" });
    expect(new Set([a, b, thread]).size).toBe(3);
    expect(thread).toBe("ws:workspace-a:thread:thread-1");
  });

  it("uses the verified MCP principal's workspace, never tool arguments", async () => {
    const env = environment("1");
    const call = tools(env);
    const spoofed = { workspaceId: "workspace-b", orgId: "workspace-b", threadKey: "other-thread", runId: "run-1", repoUrl: "https://github.com/example/repo", task: "fix", x: 1, y: 2 };
    for (const tool of ["queue_run", "run_status", "list_runs", "list_approvals", "screen_click", "screen_type", "screen_scroll", "screen_key", "screen_shot"]) {
      await call(tool, spoofed);
    }
    expect(new Set(names())).toEqual(new Set(["ws:workspace-a"]));
    const queued = await requests[0]!.clone().json() as { threadKey: string };
    expect(queued.threadKey).toBe("ws:workspace-a");
    expect(requests.every((request) => request.headers.get("X-Agent-Principal") === "agent-a")).toBe(true);
    await call("list_runs", {}, { ...principal, orgId: "workspace-b" });
    expect(names().at(-1)).toBe("ws:workspace-b");
  });

  it("uses the API key's verified workspace and the email caller's trusted scope", async () => {
    const env = environment("1");
    await handleApiKeys(new Request("https://worker.test/api/v1/runs?workspaceId=workspace-b", { headers: { authorization: "Bearer key" } }), env);
    await queueEmailApproval(env, { kind: "email_send", mailbox: "agent@example.test", payload: { workspaceId: "workspace-b" } }, { workspaceId: "workspace-a" });
    expect(names()).toEqual(["ws:workspace-a", "ws:workspace-a"]);
    expect((await requests[1]!.clone().json() as { threadKey: string }).threadKey).toBe("ws:workspace-a");
  });

  it.each([undefined, "1"])("email MCP queue uses the verified token's workspace (flag %s)", async (flag) => {
    const env = { ...environment(flag), SEND_EMAIL: {}, Mailbox: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => Response.json({ mailbox: { address: "agent@example.test", agent: "agent-a" } }) }),
    } } as unknown as Env;
    await tools(env)("send_email", { mailbox: "agent@example.test", to: "recipient@example.test", subject: "Subject", body: "Body", workspaceId: "workspace-b" });
    expect(names()).toEqual([flag === "1" ? "ws:workspace-a" : "default"]);
  });

  it("uses the signed Slack team/channel and resolves buttons to the same instance", async () => {
    const env = environment("1");
    await slash(env);
    await slash(env, "TEAM_B");
    expect(names()).toEqual(["ws:TEAM_A:thread:slack-command%3ATEAM_A%3ACHANNEL_A", "ws:TEAM_B:thread:slack-command%3ATEAM_B%3ACHANNEL_A"]);
    expect(slackApprovalOrchestratorName("slack-command:TEAM_A:CHANNEL_A", env)).toBe(names()[0]);
    expect(slackApprovalOrchestratorName("slack-command:TEAM_A:CHANNEL_A", environment())).toBe("default");
  });

  it.each([undefined, "1"])("binds signed Slack canvas intake and provenance to the selected command DO (flag %s)", async (flag) => {
    const env = { ...environment(flag), INTERNAL_SIGNING_KEY: "s".repeat(32), SLACK_CANVAS_OWNERS: JSON.stringify([{ teamId: "TEAM_A", channelId: "CHANNEL_A", ownerId: "owner@example.test" }]) } as Env;
    await slash(env);
    const name = names()[0]!;
    const origin = "slack-command:TEAM_A:CHANNEL_A";
    expect(await verifySlackCanvasIntake(requests[0]!.clone() as Request, env.INTERNAL_SIGNING_KEY, name, Date.now(), undefined, env)).toBe(origin);
    expect(await verifySlackCanvasIntake(requests[0]!.clone() as Request, env.INTERNAL_SIGNING_KEY, "ws:TEAM_B", Date.now(), undefined, env)).toBeNull();
    const room = await resolveSlackCanvasBinding(env, origin, "approval-1");
    expect(room?.orchestratorName).toBe(name);
    expect(slackCanvasOriginPatch({} as OrchestratorState, name, "approval-1", origin, room, env).slackCanvasOrigins).toEqual({ "approval-1": origin });
  });

  it("keeps the deployment trigger and ownerless mailbox sends in self-hosted", async () => {
    const env = environment("1");
    await handleTrigger(new Request("https://worker.test/api/trigger", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ repoUrl: "https://github.com/example/repo", task: "fix", workspaceId: "workspace-b" }) }), env);
    await queueEmailApproval(env, { kind: "email_send", mailbox: "agent@example.test", payload: {} });
    expect(names()).toEqual(["ws:self-hosted", "ws:self-hosted"]);
  });

  it.each([undefined, "1"])("Reason Network selects the authenticated owner, not a supplied owner (flag %s)", async (flag) => {
    const selected: string[] = [];
    const env = { ...environment(flag), AGENT_AUDIT: {}, REASON_NETWORK_ENABLED: "1", SHIBA_LOCAL_RUNTIME: "1", PAIRING_SECRET: "configured", LocalDispatch: {
      idFromName: (name: string) => { selected.push(name); return name; },
      get: () => ({ fetch: async () => Response.json({ computers: [] }) }),
    } } as unknown as Env;
    const response = await handleReasonNetwork(new Request("https://worker.test/api/reason-network/status?ownerId=owner-b"), env);
    expect(response?.status).toBe(200);
    expect(selected).toEqual([flag === "1" ? "dev:owner-a" : "local-dispatch"]);
  });

  it("sweeps every workspace including self-hosted despite one failing workspace", async () => {
    const env = { ...environment("1"), AGENT_AUDIT: {} } as Env;
    vi.mocked(listAdminWorkspaces).mockResolvedValue(["a", "b", "c"].map((workspaceId) => ({ workspaceId, name: workspaceId, memberCount: 1, lastActivity: null })));
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => {
      if (name === "ws:team%3Ab") throw new Error("workspace b unavailable");
      return { fetch: async () => Response.json({ ok: true }) } as never;
    });
    await scheduledJobs["drafts.sweep"](env);
    expect(listAdminWorkspaces).toHaveBeenCalledWith(env, -1);
    expect(new Set(names())).toEqual(new Set(["ws:self-hosted", "ws:team%3Aa", "ws:team%3Ab", "ws:team%3Ac"]));
    expect(reportError).toHaveBeenCalledExactlyOnceWith(env, "scheduled", expect.objectContaining({ message: "workspace b unavailable" }));
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("reports unsuccessful sweep responses without stopping other workspaces", async () => {
    const env = { ...environment("1"), AGENT_AUDIT: {} } as Env;
    vi.mocked(listAdminWorkspaces).mockResolvedValue([{ workspaceId: "a", name: "A", memberCount: 1, lastActivity: null }]);
    vi.mocked(getAgentByName).mockImplementation(async (_namespace, name) => ({ fetch: async () => new Response(null, { status: name === "ws:team%3Aa" ? 503 : 200 }) }) as never);
    await scheduledJobs["drafts.sweep"](env);
    expect(names()).toHaveLength(2);
    expect(reportError).toHaveBeenCalledOnce();
  });
});
