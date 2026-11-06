import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatResponseResult, ThinkSubmissionInspection } from "@cloudflare/think";
import { runInputHash, type PendingApproval } from "@shiba/shared";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { createRun } from "../src/runs.js";

const privateReply = vi.hoisted(() => vi.fn());
vi.mock("../src/slack-command-reply.js", () => ({ deliverSlackCommandReply: privateReply }));

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({}) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const THREAD = "slack:T1:C1:1700.0001";
const pending: PendingApproval = {
  threadKey: THREAD, approvalId: "decision-approval", repoUrl: "https://github.com/o/r", task: "Add cancellation tests.",
  baseBranch: "main", publishPullRequest: true, status: "pending", createdAt: Date.now(),
};

interface DeliveryInternals {
  postToThread(text: string, context?: { runId?: string; threadKey?: string; persona?: "lead" | "explorer" | "fixer" | "reviewer"; causationId?: string; blocks?: unknown[] }): void;
  drainEffectOutbox(): Promise<void>;
  onSubmissionStatus(submission: ThinkSubmissionInspection): void;
}

function host(state: OrchestratorState = { runs: [] }, name = THREAD) {
  const held: Promise<unknown>[] = [];
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name,
    env: { ...productionEnvStubs(), SLACK_BOT_TOKEN: "xoxb-test" },
    state,
    ctx: { waitUntil(promise: Promise<unknown>) { held.push(promise); } },
    setState(next: OrchestratorState) { setStateLikeProduction(this, next); },
  });
  return { instance, internals: instance as unknown as DeliveryInternals, held };
}

function response(text = "Which file should I inspect first?"): ChatResponseResult {
  return { requestId: "slack-buffer:batch-1", continuation: false, status: "completed", message: {
    id: "decision-message", role: "assistant", parts: [{ type: "text", text }],
  } };
}

afterEach(() => { vi.unstubAllGlobals(); privateReply.mockReset(); });

describe("Slack coordinator delivery", () => {
  it("persists intent before posting a coordinator question and delivers a replayed hook once", async () => {
    const { instance, held } = host();
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(instance.state.outbox).toHaveLength(1);
      expect(instance.state.outbox?.[0]?.status).toBe("pending");
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, channel: "C1", ts: "1700.0002" });
    }));
    instance.onChatResponse(response());
    instance.onChatResponse(response());
    await Promise.all(held);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ channel: "C1", thread_ts: "1700.0001", username: "Shiba Lead", text: "Which file should I inspect first?" });
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(instance.state.runs).toHaveLength(0);
    expect(instance.state.outbox?.[0]?.status).toBe("dispatched");
  });

  it("posts a frozen pending run card without approving or starting it", async () => {
    const { instance, held } = host({ runs: [], pendingApprovals: [pending] });
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ok: true, channel: "C1", ts: "1700.0002" });
    }));
    instance.onChatResponse(response(""));
    instance.onChatResponse(response(""));
    await Promise.all(held);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0]?.blocks)).toContain("Approve Action");
    expect(JSON.stringify(calls[0]?.blocks)).toContain("A separate approval is required");
    expect(JSON.stringify(calls[0]?.blocks)).toContain(pending.approvalId);
    expect(instance.state.pendingApprovals).toEqual([pending]);
    expect(instance.state.runs).toHaveLength(0);
  });

  it("starts no network call if recording the delivery intent fails", () => {
    const { instance } = host();
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    vi.spyOn(instance, "setState").mockImplementationOnce(() => { throw new Error("Injected persistence failure."); });
    expect(() => instance.onChatResponse(response())).toThrow("Injected persistence failure");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retains persona and approval blocks through a failed send and restart replay", async () => {
    const first = host();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Known send failure fixture."); }));
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Review report" } }];
    first.internals.postToThread("Review report", { persona: "reviewer", causationId: "review-report:1", blocks });
    await Promise.all(first.held);
    expect(first.instance.state.outbox?.[0]).toMatchObject({ status: "failed", persona: "reviewer", blocks });
    const restarted = host(structuredClone(first.instance.state));
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ username: "Shiba Reviewer", icon_emoji: ":eyes:", blocks });
      return Response.json({ ok: true, channel: "C1", ts: "1700.0002" });
    });
    vi.stubGlobal("fetch", fetchImpl);
    await restarted.internals.drainEffectOutbox();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(restarted.instance.state.outbox?.[0]?.status).toBe("dispatched");
  });

  it("reports a failed queued decision once without creating a replacement run", async () => {
    const { instance, internals, held } = host();
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, channel: "C1", ts: "1700.0002" }));
    vi.stubGlobal("fetch", fetchImpl);
    const submission: ThinkSubmissionInspection = { submissionId: "slack-buffer:batch-1", status: "error", error: "Provider unavailable.", createdAt: Date.now() };
    internals.onSubmissionStatus(submission);
    internals.onSubmissionStatus(submission);
    await Promise.all(held);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(instance.state.runs).toHaveLength(0);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("does not relay dashboard decisions or deleted sessions to Slack", () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    host({ runs: [] }, "session:private").instance.onChatResponse(response());
    host({ runs: [], sessionDeletedAt: Date.now() }).instance.onChatResponse(response());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records a default-DO private command reply and retains its route after approval history is pruned", async () => {
    const fields = { repoUrl: "https://github.com/o/r", task: "Fix it.", baseBranch: "main", publishPullRequest: false };
    const commandRun = { ...createRun({ ...fields, runId: "agent-tool:command-approval", sandboxId: "sandbox", approval: {
      approvalId: "command-approval", decidedBy: "U1", decidedAt: Date.now(), inputHash: runInputHash(fields),
    } }), slackCommandOrigin: "slack-command:T1:C1" };
    const context = host({ runs: [commandRun] }, "default");
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    privateReply.mockImplementation(async (_env, input) => {
      expect(context.instance.state.outbox?.[0]).toMatchObject({ status: "pending", runId: commandRun.runId, target: "slack-command:T1:C1" });
      expect(input).toMatchObject({ orchestratorName: "default", origin: "slack-command:T1:C1", run: commandRun, text: "Done." });
    });
    context.internals.postToThread("Done.", { runId: commandRun.runId, causationId: "private:command-approval" });
    await Promise.all(context.held);
    expect(privateReply).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(context.instance.state.outbox?.[0]?.status).toBe("dispatched");
  });
});
