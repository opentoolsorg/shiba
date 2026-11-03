import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { formatAgentResult, parseAgentToolInput, type CodingTaskInput } from "../src/opencode-input.js";
import { resolveSlackCanvasBinding, signSlackCanvasIntake, signSlackCanvasRequest } from "../src/slack-canvas.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ child: vi.fn(), destroy: vi.fn() }));
vi.mock("@cloudflare/think", () => ({ Think: class {
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return fn(); }
  schedule() { return Promise.resolve({}); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.child }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const SECRET = "canvas-worker-only-signing-key-123456789";
const ORIGIN = "slack:T1:C1:1700.0001";
const COMMAND = "slack-command:T1:C1";
const OTHER_COMMAND = "slack-command:T2:C2";
const REPO = "https://github.com/owner/repo";
const REVIEWER = "reviewer@example.test";

function host(name = ORIGIN) {
  const writes: OrchestratorState[] = [];
  const held: Promise<unknown>[] = [];
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name, messages: [],
    env: { ...productionEnvStubs(), Sandbox: {}, INTERNAL_SIGNING_KEY: SECRET,
      DASHBOARD_APPROVERS: REVIEWER,
      SLACK_CANVAS_OWNERS: JSON.stringify([
        { teamId: "T1", channelId: "C1", ownerId: "alice@example.test" },
        { teamId: "T2", channelId: "C2", ownerId: "bob@example.test" },
      ]),
    },
    state: { runs: [] } as OrchestratorState,
    ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) },
    setState(next: OrchestratorState) {
      setStateLikeProduction(this, next);
      writes.push(JSON.parse(JSON.stringify(this.state)) as OrchestratorState);
    },
  });
  return { instance, writes, held };
}

function queueRequest(origin: string, extra: Record<string, unknown> = {}) {
  return new Request("https://internal/api/runs", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadKey: origin, repoUrl: REPO, task: "Prepare an isolated change.", publishPullRequest: false, ...extra }) });
}

async function queue(instance: CodingOrchestrator, origin = ORIGIN) {
  const request = await signSlackCanvasIntake(queueRequest(origin, { runRoom: { ownerId: "intruder@example.test", sessionId: "default" } }), SECRET, origin);
  const response = await instance.onRequest(request);
  expect(response.status).toBe(200);
  return (await response.json() as { approvalId: string }).approvalId;
}

async function snapshot(instance: CodingOrchestrator, origin: string, approvalId: string, signed = true) {
  const url = new URL("https://internal/internal/slack-canvas");
  url.searchParams.set("origin", origin);
  url.searchParams.set("approval", approvalId);
  const request = new Request(url);
  return instance.onRequest(signed ? await signSlackCanvasRequest(request, SECRET, origin) : request);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.child.mockResolvedValue(formatAgentResult({ status: "completed", exitCode: 0, stderrTail: "", changedFiles: [], diff: "", files: [], summary: "Completed the local fixture." }));
});

describe("trusted Slack canvas provenance", () => {
  it("commits proof, pending approval and its private room together before execution", async () => {
    const context = host();
    const approvalId = await queue(context.instance);
    const room = await resolveSlackCanvasBinding(context.instance.env, ORIGIN, approvalId);
    expect(room).not.toBeNull();
    const first = context.writes.find((state) => state.pendingApprovals?.some((approval) => approval.approvalId === approvalId));
    expect(first?.slackCanvasOrigins?.[approvalId]).toBe(ORIGIN);
    expect(first?.slackCanvasThreadOrigin).toBe(ORIGIN);
    expect(first?.slackCanvasRunRooms?.[`agent-tool:${approvalId}`]).toMatchObject({ ownerId: room?.ownerId, sessionId: room?.sessionId, runId: room?.runId });
    expect(mocks.child).not.toHaveBeenCalled();
    const response = await snapshot(context.instance, ORIGIN, approvalId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: "slack", origin: ORIGIN, approval: { approvalId, status: "pending" } });
    expect((await snapshot(context.instance, ORIGIN, approvalId, false)).status).toBe(404);
  });

  it("binds the actual child stream to the retained owner and room after human approval", async () => {
    const context = host();
    const approvalId = await queue(context.instance);
    const response = await context.instance.onRequest(new Request("https://internal/api/approvals", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId, threadKey: ORIGIN, approved: true, decidedBy: REVIEWER }) }));
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(context.instance.state.runs[0]?.status).toBe("completed"));
    await Promise.all(context.held);
    const input = parseAgentToolInput([{ role: "user", text: mocks.child.mock.calls[0]?.[0] as string }]) as CodingTaskInput;
    const expected = await resolveSlackCanvasBinding(context.instance.env, ORIGIN, approvalId);
    expect(input.runRoom).toEqual({ ownerId: expected?.ownerId, sessionId: expected?.sessionId, runId: expected?.runId });
    expect(input.runRoom?.ownerId).not.toContain("intruder");
    const view = await snapshot(context.instance, ORIGIN, approvalId);
    expect(await view.json()).toMatchObject({ run: { runId: expected?.runId, status: "completed", approval: { approvalId } }, runRoom: input.runRoom });
  });

  it("rejects a changed signed body and forged provenance before any approval mutation", async () => {
    const context = host();
    const signed = await signSlackCanvasIntake(queueRequest(ORIGIN), SECRET, ORIGIN);
    const changed = new Request(signed, { body: JSON.stringify({ threadKey: ORIGIN, repoUrl: REPO, task: "Changed after signing." }) });
    expect((await context.instance.onRequest(changed)).status).toBe(403);
    expect(context.writes).toHaveLength(0);
    const forged = queueRequest(ORIGIN);
    forged.headers.set("X-Shiba-Slack-Canvas-Origin", ORIGIN);
    expect((await context.instance.onRequest(forged)).status).toBe(403);
    expect(context.writes).toHaveLength(0);
  });

  it("never grants canvas access from an unsigned source or threadKey body", async () => {
    const context = host();
    const response = await context.instance.onRequest(queueRequest(ORIGIN, { source: "slack" }));
    expect(response.status).toBe(200);
    const { approvalId } = await response.json() as { approvalId: string };
    expect(context.instance.state.slackCanvasOrigins).toBeUndefined();
    expect((await snapshot(context.instance, ORIGIN, approvalId)).status).toBe(404);
    expect(mocks.child).not.toHaveBeenCalled();
  });

  it("keeps shared command approvals separated by signed team and channel", async () => {
    const context = host("default");
    const first = await queue(context.instance, COMMAND);
    const second = await queue(context.instance, OTHER_COMMAND);
    expect(context.instance.state.slackCanvasThreadOrigin).toBeUndefined();
    expect((await snapshot(context.instance, COMMAND, first)).status).toBe(200);
    expect((await snapshot(context.instance, OTHER_COMMAND, second)).status).toBe(200);
    expect((await snapshot(context.instance, OTHER_COMMAND, first)).status).toBe(404);
    expect((await snapshot(context.instance, COMMAND, second)).status).toBe(404);
    const a = context.instance.state.slackCanvasRunRooms?.[`agent-tool:${first}`];
    const b = context.instance.state.slackCanvasRunRooms?.[`agent-tool:${second}`];
    expect(a?.ownerId).toBe("alice@example.test");
    expect(b?.ownerId).toBe("bob@example.test");
    expect(a?.sessionId).not.toBe(b?.sessionId);
  });

  it("inherits only a verified thread anchor into new coordinator approval pointers", async () => {
    const context = host();
    await queue(context.instance);
    const delegate = context.instance.getTools()["delegate_coding_task"] as unknown as { needsApproval(input: unknown, options: { toolCallId: string }): PromiseLike<boolean> };
    expect(await delegate.needsApproval({ repoUrl: REPO, task: "A follow-up decision.", baseBranch: "main", publishPullRequest: false }, { toolCallId: "followup-1" })).toBe(true);
    expect(context.instance.state.slackCanvasOrigins?.["followup-1"]).toBe(ORIGIN);
    expect((await snapshot(context.instance, ORIGIN, "followup-1")).status).toBe(200);
    const unproven = host();
    const unprovenDelegate = unproven.instance.getTools()["delegate_coding_task"] as unknown as typeof delegate;
    await unprovenDelegate.needsApproval({ repoUrl: REPO, task: "Unproven source.", baseBranch: "main", publishPullRequest: false }, { toolCallId: "followup-2" });
    expect(unproven.instance.state.slackCanvasOrigins).toBeUndefined();
    expect((await snapshot(unproven.instance, ORIGIN, "followup-2")).status).toBe(404);
  });
});
