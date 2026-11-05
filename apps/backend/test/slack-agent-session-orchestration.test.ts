import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { formatAgentResult } from "../src/opencode-input.js";
import { signSlackCanvasIntake } from "../src/slack-canvas.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { productionEnvStubs } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ child: vi.fn(), destroy: vi.fn(), failCommit: false }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  state = { runs: [] };
  messages = [];
  name = "slack:T1:C1:1700.0001";
  constructor(readonly ctx: unknown, readonly env: unknown) {}
  setState(next: { runs: [] }) {
    if (mocks.failCommit) throw new Error("Injected orchestration persistence failure");
    this.state = next;
  }
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return fn(); }
  schedule() { return Promise.resolve({}); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.child }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const ORIGIN = "slack:T1:C1:1700.0001";
const SECRET = "native-slack-fixture-worker-signing-key-123456789";
const REVIEWER = "reviewer@example.test";
function savedStorage() {
  const values = new Map<string, unknown>();
  let pending: Promise<unknown> = Promise.resolve();
  const base = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async () => new Map(),
  };
  return { ...base, transaction: <T>(callback: (transaction: typeof base) => Promise<T>): Promise<T> => {
    const operation = pending.then(() => callback(base));
    pending = operation.catch(() => {});
    return operation;
  } };
}
function host(options: { state?: OrchestratorState; storage?: ReturnType<typeof savedStorage>; enabled?: string } = {}) {
  const held: Promise<unknown>[] = [];
  const ctx = { storage: options.storage ?? savedStorage(), waitUntil: (promise: Promise<unknown>) => held.push(promise), abort: vi.fn() };
  const env = { ...productionEnvStubs(), Sandbox: {}, INTERNAL_SIGNING_KEY: SECRET,
    DASHBOARD_APPROVERS: REVIEWER, SLACK_AGENT_SESSIONS_ENABLED: options.enabled ?? "true", SLACK_AGENT_SESSIONS_TEAM_ID: "T1",
    SLACK_BOT_TOKEN: "xoxb-native-fixture-only",
    SLACK_CANVAS_OWNERS: JSON.stringify([{ teamId: "T1", channelId: "C1", ownerId: "owner@example.test" }]),
  } as unknown as Env;
  const instance = new CodingOrchestrator(ctx as unknown as ConstructorParameters<typeof CodingOrchestrator>[0], env);
  if (options.state) Object.assign(instance, { state: structuredClone(options.state) });
  return { instance, held, ctx, env };
}
/** Fixture HTTP only. These tests never contact an installed Slack workspace. */
function slackFixture(context: ReturnType<typeof host>, authResponse?: () => Response | Promise<Response>) {
  const statuses: string[] = [];
  const auth = vi.fn();
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://slack.com/api/auth.test") {
      auth();
      expect(context.instance.state.events?.at(-1)?.seq).toBeGreaterThan(0);
      return authResponse?.() ?? Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, {
        headers: { "x-oauth-scopes": "chat:write,assistant:write,chat:write.customize" },
      });
    }
    if (url === "https://slack.com/api/agents.sessions.setStatus") {
      const body = new URLSearchParams(init?.body as URLSearchParams);
      expect(body.get("channel_id")).toBe("C1");
      expect(body.get("thread_ts")).toBe("1700.0001");
      statuses.push(body.get("status")!);
      return Response.json({ ok: true, agent_status: body.get("status"), status: body.get("status") });
    }
    if (url === "https://slack.com/api/chat.postMessage" || url === "https://slack.com/api/chat.update") {
      return Response.json({ ok: true, channel: "C1", ts: "1700.0002" });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { statuses, auth, fetch };
}
async function queue(context: ReturnType<typeof host>, signed = true) {
  const request = new Request("https://internal/api/runs", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadKey: ORIGIN, repoUrl: "https://github.com/owner/repo", task: "Implement native status fixture.", publishPullRequest: false }) });
  const response = await context.instance.onRequest(signed ? await signSlackCanvasIntake(request, SECRET, ORIGIN) : request);
  expect(response.status).toBe(200);
  return (await response.json() as { approvalId: string }).approvalId;
}
async function approve(context: ReturnType<typeof host>, approvalId: string) {
  const response = await context.instance.onRequest(new Request("https://internal/api/approvals", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId, threadKey: ORIGIN, approved: true, decidedBy: REVIEWER }) }));
  expect(response.status).toBe(200);
}
async function flush(context: ReturnType<typeof host>) {
  for (let pass = 0; pass < 12 && context.held.length; pass += 1) await Promise.all(context.held.splice(0));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.failCommit = false;
  mocks.destroy.mockResolvedValue(undefined);
  mocks.child.mockResolvedValue(formatAgentResult({ status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "Completed status fixture." }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("native Slack lifecycle from committed orchestration with fixture HTTP", () => {
  it("reports queue, human-approved active work and completion without approving from status", async () => {
    const context = host();
    const fixture = slackFixture(context);
    let finish!: (value: string) => void;
    mocks.child.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
    const approvalId = await queue(context);
    await vi.waitFor(() => expect(fixture.statuses).toEqual(["suspended"]));
    expect(context.instance.state.pendingApprovals?.[0]?.status).toBe("pending");
    expect(context.instance.state.runs).toHaveLength(0);
    expect(mocks.child).not.toHaveBeenCalled();
    await approve(context, approvalId);
    await vi.waitFor(() => expect(fixture.statuses).toContain("processing"));
    expect(context.instance.state.pendingApprovals?.[0]?.status).toBe("approved");
    finish(formatAgentResult({ status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "Completed status fixture." }));
    await vi.waitFor(() => expect(context.instance.state.runs[0]?.status).toBe("completed"));
    await flush(context);
    expect(fixture.statuses).toEqual(["suspended", "processing", "active"]);
    expect(mocks.child).toHaveBeenCalledOnce();
    expect(Object.getOwnPropertyNames(CodingOrchestrator.prototype).some((key) => /slackAgentSession/i.test(key))).toBe(false);
  });

  it("recovers the commit-to-outbox gap on start and does not redeliver confirmed status after another restart", async () => {
    const original = host({ enabled: "false" });
    await queue(original);
    const saved = original.ctx.storage;
    const restarted = host({ state: original.instance.state, storage: saved });
    const fixture = slackFixture(restarted);
    await restarted.instance.onStart();
    await flush(restarted);
    expect(fixture.statuses).toEqual(["suspended"]);
    const again = host({ state: restarted.instance.state, storage: saved });
    await again.instance.onStart();
    await flush(again);
    expect(fixture.statuses).toEqual(["suspended"]);
    expect(mocks.child).not.toHaveBeenCalled();
  });

  it.each(["unsigned", "forged origin", "missing room", "revoked owner policy"])("sends no native request from %s source", async (source) => {
    const original = host({ enabled: "false" });
    const approvalId = await queue(original, source !== "unsigned");
    const state = structuredClone(original.instance.state);
    if (source === "forged origin") state.slackCanvasOrigins = { [approvalId]: "slack:T2:C1:1700.0001" };
    if (source === "missing room") state.slackCanvasRunRooms = {};
    const restarted = host({ state, storage: original.ctx.storage });
    if (source === "revoked owner policy") restarted.env.SLACK_CANVAS_OWNERS = "[]";
    const fixture = slackFixture(restarted);
    await restarted.instance.onStart();
    await flush(restarted);
    expect(fixture.auth).not.toHaveBeenCalled();
    expect(fixture.statuses).toHaveLength(0);
    expect(mocks.child).not.toHaveBeenCalled();
  });

  it("rechecks retained provenance after awaited auth.test and makes no write after revocation", async () => {
    const context = host();
    const fixture = slackFixture(context, () => {
      context.instance.setState({ ...context.instance.state, slackCanvasOrigins: {} });
      return Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, { headers: { "x-oauth-scopes": "chat:write,assistant:write,chat:write.customize" } });
    });
    await queue(context);
    await flush(context);
    expect(fixture.auth).toHaveBeenCalledOnce();
    expect(fixture.statuses).toHaveLength(0);
    expect(context.instance.state.pendingApprovals?.[0]?.status).toBe("pending");
    expect(mocks.child).not.toHaveBeenCalled();
  });

  it("starts no status request when the orchestration state commit fails", async () => {
    const context = host();
    const fixture = slackFixture(context);
    mocks.failCommit = true;
    expect(() => context.instance.setState({ ...context.instance.state })).toThrow("Injected orchestration persistence failure");
    expect(context.ctx.abort).toHaveBeenCalledOnce();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("fences an eligible pending status after a failed state commit during auth.test", async () => {
    const context = host();
    let release!: (response: Response) => void;
    const fixture = slackFixture(context, () => new Promise<Response>((resolve) => { release = resolve; }));
    await queue(context);
    await vi.waitFor(() => expect(fixture.auth).toHaveBeenCalledOnce());
    expect(context.instance.state.pendingApprovals?.[0]?.status).toBe("pending");
    mocks.failCommit = true;
    expect(() => context.instance.setState({ ...context.instance.state })).toThrow("Injected orchestration persistence failure");
    expect(context.ctx.abort).toHaveBeenCalledOnce();
    release(Response.json({ ok: true, team_id: "T1", user_id: "U1", bot_id: "B1" }, { headers: { "x-oauth-scopes": "chat:write,assistant:write,chat:write.customize" } }));
    await flush(context);
    expect(fixture.statuses).toHaveLength(0);
    expect(mocks.child).not.toHaveBeenCalled();
  });
});
