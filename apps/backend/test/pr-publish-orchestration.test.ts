import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PRINCIPAL_HEADER, type DelegatedRun, type PendingApproval, type RunPatch } from "@shiba/shared";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { formatAgentResult, parseAgentToolInput, type CodingTaskInput, type CodingTaskResult } from "../src/opencode-input.js";
import { stagePrPublishApproval, type PrPublicationProposal } from "../src/pr-publish-approval.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ child: vi.fn(), specialist: vi.fn(), contextAppend: vi.fn(), publish: vi.fn(), destroy: vi.fn(), persist: vi.fn(), abort: vi.fn() }));
vi.mock("../src/pr-publish-approval.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/pr-publish-approval.js")>(),
  executePrPublishApproval: mocks.publish,
}));
vi.mock("@cloudflare/think", () => ({ Think: class {
  messages?: UIMessage[];
  async addMessages(messages: UIMessage[], options?: { mode?: string }) {
    await mocks.contextAppend(messages, options);
    const ids = new Set(messages.map((message) => message.id));
    this.messages = [...(this.messages ?? []).filter((message) => !ids.has(message.id)), ...messages];
  }
  setState(state: OrchestratorState) {
    Object.assign(this, { state });
    mocks.persist(state);
  }
  onStart() {}
  getTools() { return {}; }
  onRequest() { return new Response(null, { status: 404 }); }
  keepAliveWhile(fn: () => Promise<unknown>) { return fn(); }
  schedule() { return Promise.resolve({}); }
} }));
vi.mock("agents/agent-tools", () => ({ agentTool: (cls: { name: string }) => ({ execute: cls.name === "ReviewerAgent" ? mocks.specialist : mocks.child }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

const OWNER = "owner@example.test";
const REVIEWER = "reviewer@example.test";
const REPO = "https://github.com/owner/repo";
const PULL_URL = `${REPO}/pull/42`;
const PUBLISHED = { branch: "shiba/approved", commitSha: "commit-sha", pullUrl: PULL_URL, pullNumber: 42 };
const RESULT: CodingTaskResult = {
  baseRevision: "a".repeat(40),
  status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["source.ts"],
  diff: "+approved change", summary: "Prepared the requested source change.",
  files: [{ path: "source.ts", content: "export const changed = true;", encoding: "utf8" }],
};

function post(path: string, body: unknown, principal?: string) {
  return new Request(`https://internal${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(principal ? { [AGENT_PRINCIPAL_HEADER]: principal } : {}),
    },
    body: JSON.stringify(body),
  });
}

function host(state: OrchestratorState = { runs: [] }) {
  const held: Promise<unknown>[] = [];
  const writes: OrchestratorState[] = [];
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const instance = Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    name: OWNER, messages: [] as UIMessage[],
    env: {
      ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "test-worker-github-token",
      DASHBOARD_APPROVERS: REVIEWER,
      ATTACHMENTS: {
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } : null;
        },
        put: async (key: string, bytes: Uint8Array<ArrayBuffer>) => {
          objects.set(key, new Uint8Array(bytes));
          return { key };
        },
      },
    },
    abortSubAgent: vi.fn(),
    ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) },
    state,
    setState(next: OrchestratorState) {
      setStateLikeProduction(this, next);
      writes.push(JSON.parse(JSON.stringify(this.state)) as OrchestratorState);
    },
  });
  return { instance, writes, held, objects };
}

function publication(instance: CodingOrchestrator): PendingApproval | undefined {
  return instance.state.pendingApprovals?.find((approval) => approval.kind === "pr_publish");
}

function decide(instance: CodingOrchestrator, record: PendingApproval, decidedBy = REVIEWER, principal?: string) {
  return instance.onRequest(post("/api/approvals", {
    threadKey: record.threadKey, approvalId: record.approvalId, approved: true, decidedBy,
  }, principal));
}

async function completeRun(
  changeProposal: (proposal: PrPublicationProposal) => PrPublicationProposal = (proposal) => proposal,
  beforeReturn?: (instance: CodingOrchestrator, runId: string) => Promise<unknown>,
  result: CodingTaskResult = RESULT,
) {
  const context = host();
  let capturedInput: CodingTaskInput | undefined;
  let createdProposal: PrPublicationProposal | undefined;
  mocks.child.mockImplementation(async (envelope: string, options: { toolCallId: string }) => {
    const input = parseAgentToolInput([{ role: "user", text: envelope }]);
    capturedInput = input;
    const staged = await stagePrPublishApproval(context.instance.env, {
      ownerId: OWNER, runId: `agent-tool:${options.toolCallId}`, sandboxId: input.sandboxId,
      repoUrl: input.repoUrl, baseBranch: input.baseBranch, task: input.task,
      threadKey: OWNER, result,
    });
    createdProposal = changeProposal(staged);
    await beforeReturn?.(context.instance, `agent-tool:${options.toolCallId}`);
    return formatAgentResult({ ...result, diff: result.diff.slice(0, 20_000), files: [], publicationProposal: createdProposal });
  });
  const queued = await context.instance.onRequest(post("/api/runs", {
    repoUrl: REPO, task: "Fix the source and prepare a pull request.", baseBranch: "main", publishPullRequest: true,
    threadKey: OWNER,
  }));
  expect(queued.status).toBe(200);
  const { approvalId } = await queued.json() as { approvalId: string };
  const initial = context.instance.state.pendingApprovals?.find((approval) => approval.approvalId === approvalId);
  if (!initial) throw new Error("Expected the sandbox execution approval.");
  expect(mocks.child).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect((await decide(context.instance, initial)).status).toBe(200);
  const runId = `agent-tool:${approvalId}`;
  await vi.waitFor(() => expect(context.instance.state.runs.find((run) => run.runId === runId)?.status).toMatch(/completed|error|cancelled|unknown/));
  await (context.instance as unknown as { reviewPublication(runId: string): Promise<void> }).reviewPublication(runId);
  await Promise.all(context.held);
  if (!capturedInput || !createdProposal) throw new Error("Expected an isolated child result and a publication proposal.");
  return { ...context, runId, input: capturedInput, proposal: createdProposal };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(PUBLISHED);
  mocks.specialist.mockResolvedValue({ agent: "reviewer", status: "completed", summary: "Captured changes reviewed.", report: "Reviewed the exact captured unified diff against the approved task.", findings: [] });
});

afterEach(() => vi.useRealTimers());

describe("orchestrator external publication approval", () => {
  it("adds one inert body-free observation without resolving the SDK approval tool part", async () => {
    const pendingPart = { type: "dynamic-tool" as const, toolName: "delegate_coding_task", toolCallId: "unresolved-tool", state: "approval-requested" as const, input: {}, approval: { id: "sdk-approval" } };
    const context = await completeRun(undefined, async (instance) => {
      instance.messages.push({ id: "approval-message", role: "assistant", parts: [pendingPart] });
    });
    const messages = context.instance.messages.filter((message) => message.id === `run-result:${context.runId}`);
    expect(messages).toHaveLength(1);
    const part = messages[0]?.parts[0];
    if (part?.type !== "text") throw new Error("Expected a text observation.");
    expect(part.text).toContain("Untrusted child run data");
    const observation = JSON.parse(part.text.slice(part.text.indexOf("\n") + 1));
    expect(observation).toMatchObject({ kind: "child_run_observation", runId: context.runId, status: "completed", summary: RESULT.summary, exitCode: 0, changedFileCount: 1 });
    expect(observation).not.toHaveProperty("files"); expect(observation).not.toHaveProperty("diff");
    expect(part.text).not.toContain("export const changed");
    expect(part.text.length).toBeLessThan(8_200);
    expect(context.instance.messages.find((message) => message.id === "approval-message")?.parts).toEqual([pendingPart]);
    expect(mocks.child).toHaveBeenCalledOnce(); expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("recovers a failed context append on restart without rerunning coding or publication", async () => {
    mocks.contextAppend.mockRejectedValue(new Error("Injected context write failure."));
    const context = await completeRun();
    expect(context.instance.messages.some((message) => message.id === `run-result:${context.runId}`)).toBe(false);
    expect(context.instance.state.runResultContext?.[context.runId]?.summary).toBe(RESULT.summary);
    expect(publication(context.instance)?.status).toBe("pending");
    mocks.contextAppend.mockResolvedValue(undefined);
    const restarted = host(JSON.parse(JSON.stringify(context.instance.state)) as OrchestratorState);
    await restarted.instance.onStart();
    await restarted.instance.onStart();
    expect(restarted.instance.messages.filter((message) => message.id === `run-result:${context.runId}`)).toHaveLength(1);
    expect(mocks.child).toHaveBeenCalledOnce(); expect(mocks.specialist).toHaveBeenCalledOnce(); expect(mocks.publish).not.toHaveBeenCalled();
    expect(publication(restarted.instance)?.status).toBe("pending");
  });

  it("reviews the complete staged diff against the frozen task before exposing publication approval", async () => {
    const diff = `diff --git a/source.ts b/source.ts\n${"+line\n".repeat(4_000)}`;
    const context = await completeRun(undefined, undefined, { ...RESULT, diff });
    const request = mocks.specialist.mock.calls[0]?.[0] as { input: { diff: string; specification: string }; childTaskId: string };
    expect(request.input.diff).toBe(diff);
    expect(request.input.specification).toBe(context.input.task);
    expect(request.childTaskId).toBe(`agent-tool:publication-review:${context.runId}`);
    expect(request.input.diff.length).toBeGreaterThan(20_000);
    expect(context.instance.state.publicationReviews?.[0]).toMatchObject({ ownerId: OWNER, runId: context.runId, publicationSha256: context.proposal.payload.sha256, status: "completed" });
    expect(mocks.child).toHaveBeenCalledOnce();
    expect(mocks.specialist).toHaveBeenCalledOnce();
    expect(publication(context.instance)?.status).toBe("pending");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each([
    { agent: "reviewer", status: "failed", summary: "Could not audit.", report: "Incomplete.", findings: [] },
    { agent: "explorer", status: "completed", summary: "Wrong child.", report: "Not a review.", findings: [] },
    { agent: "reviewer", status: "completed", summary: "Missing report fields." },
    { agent: "reviewer", status: "completed", summary: "No report.", report: " ", findings: [] },
  ])("keeps completed coding work without publication when the reviewer result is invalid %j", async (observation) => {
    mocks.specialist.mockResolvedValue(observation);
    const context = await completeRun();
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("completed");
    expect(context.instance.state.publicationReviews?.[0]?.status).toBe("failed");
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.receipts?.at(-1)?.message).toContain("Publication review failed");
    expect(publication(context.instance)).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not approve a partial diff that exceeds the bounded reviewer input", async () => {
    const context = await completeRun(undefined, undefined, { ...RESULT, diff: "+".repeat(64_001) });
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("completed");
    expect(context.instance.state.publicationReviews?.[0]?.status).toBe("failed");
    expect(mocks.specialist).not.toHaveBeenCalled();
    expect(publication(context.instance)).toBeUndefined();
  });

  it.each(["missing", "digest", "owner", "run", "report"])("refuses publication when the durable review binding is %s", async (kind) => {
    const context = await completeRun();
    const pending = publication(context.instance);
    const review = context.instance.state.publicationReviews?.[0];
    if (!pending || !review) throw new Error("Expected completed read-only review and pending action.");
    const changed = { ...review,
      ...(kind === "digest" ? { publicationSha256: "f".repeat(64) } : {}),
      ...(kind === "owner" ? { ownerId: "intruder" } : {}),
      ...(kind === "run" ? { runId: "other-run" } : {}),
      ...(kind === "report" ? { observation: undefined } : {}),
    };
    context.instance.setState({ ...context.instance.state, publicationReviews: kind === "missing" ? [] : [changed] });
    await decide(context.instance, pending);
    expect(publication(context.instance)?.execution?.status).toBe("failed");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("bounds a hung publication review without turning coding success into an approved action", async () => {
    vi.useFakeTimers();
    mocks.specialist.mockImplementation(() => new Promise<never>(() => {}));
    const pending = completeRun();
    await vi.waitFor(() => expect(mocks.specialist).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_001);
    const context = await pending;
    expect(context.instance.state.publicationReviews?.[0]).toMatchObject({ status: "failed", error: expect.stringContaining("deadline") });
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("completed");
    expect(publication(context.instance)).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("recovers a pending review after restart with the same child identity and original deadline", async () => {
    const context = await completeRun();
    const checkpoint = context.writes.find((state) => state.publicationReviews?.[0]?.status === "pending");
    if (!checkpoint) throw new Error("Expected the atomic pending review checkpoint.");
    const restarted = host(JSON.parse(JSON.stringify(checkpoint)) as OrchestratorState);
    for (const [key, bytes] of context.objects) restarted.objects.set(key, bytes);
    await restarted.instance.onStart();
    await Promise.all(restarted.held);
    const first = mocks.specialist.mock.calls[0]?.[0] as { childTaskId: string; expiresAt: number };
    const recovered = mocks.specialist.mock.calls[1]?.[0] as { childTaskId: string; expiresAt: number };
    expect(recovered.childTaskId).toBe(first.childTaskId);
    expect(recovered.expiresAt).toBe(first.expiresAt);
    expect(restarted.instance.state.publicationReviews?.[0]?.status).toBe("completed");
    expect(publication(restarted.instance)?.status).toBe("pending");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("marks a restarted expired review failed without resetting its execution budget", async () => {
    const context = await completeRun();
    const checkpoint = context.writes.find((state) => state.publicationReviews?.[0]?.status === "pending");
    if (!checkpoint?.publicationReviews?.[0]) throw new Error("Expected pending review checkpoint.");
    const expiresAt = checkpoint.publicationReviews[0].expiresAt;
    vi.useFakeTimers(); vi.setSystemTime(expiresAt);
    mocks.specialist.mockClear();
    const restarted = host(JSON.parse(JSON.stringify(checkpoint)) as OrchestratorState);
    await restarted.instance.onStart();
    await Promise.all(restarted.held);
    expect(restarted.instance.state.publicationReviews?.[0]).toMatchObject({ status: "failed", expiresAt, error: expect.stringContaining("deadline") });
    expect(mocks.specialist).not.toHaveBeenCalled();
    expect(publication(restarted.instance)).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("commits completion with pending review, then atomically records the report and publication approval", async () => {
    const context = await completeRun();
    const writesWithCompletion = context.writes.filter((state) => state.runs.some((run) => run.runId === context.runId && run.status === "completed"));
    expect(writesWithCompletion.length).toBeGreaterThan(0);
    expect(writesWithCompletion[0]?.publicationReviews?.[0]?.status).toBe("pending");
    expect(writesWithCompletion[0]?.pendingApprovals?.some((approval) => approval.kind === "pr_publish")).toBe(false);
    const approvals = writesWithCompletion.filter((state) => state.pendingApprovals?.some((approval) => approval.approvalId === context.proposal.approvalId));
    expect(approvals.length).toBeGreaterThan(0);
    for (const state of approvals) {
      expect(state.publicationReviews?.[0]).toMatchObject({ status: "completed", publicationSha256: context.proposal.payload.sha256, observation: { agent: "reviewer", status: "completed" } });
      expect(state.events?.some((event) => event.kind === "approval.requested" && event.approvalId === context.proposal.approvalId)).toBe(true);
    }
  });

  it("leaves both projections unchanged on a rejected atomic write and allows one fenced retry", async () => {
    const context = await completeRun();
    const beforeCompletion = context.writes.filter((state) => state.runs.some((run) => run.runId === context.runId && run.status === "running")).at(-1);
    if (!beforeCompletion) throw new Error("Expected a retained running checkpoint.");
    const restarted = host(JSON.parse(JSON.stringify(beforeCompletion)) as OrchestratorState);
    for (const [key, bytes] of context.objects) restarted.objects.set(key, bytes);
    const running = restarted.instance.state.runs.find((run) => run.runId === context.runId)!;
    const internals = restarted.instance as unknown as {
      completeRunWithPublication(runId: string, patch: RunPatch, generation: number, proposal: PrPublicationProposal): DelegatedRun | null;
    };
    const snapshot = JSON.stringify(restarted.instance.state);
    const write = restarted.instance.setState.bind(restarted.instance);
    const persistence = vi.spyOn(restarted.instance, "setState").mockImplementationOnce(() => {
      throw new Error("Injected atomic persistence failure.");
    }).mockImplementation(write);
    expect(() => internals.completeRunWithPublication(context.runId, { summary: "Prepared source change." }, running.generation, context.proposal)).toThrow("Injected atomic persistence failure");
    expect(JSON.stringify(restarted.instance.state)).toBe(snapshot);
    expect(publication(restarted.instance)).toBeUndefined();
    expect(internals.completeRunWithPublication(context.runId, { summary: "Prepared source change." }, running.generation, context.proposal)?.status).toBe("completed");
    expect(internals.completeRunWithPublication(context.runId, { summary: "Retried completion." }, running.generation, context.proposal)).toBeNull();
    expect(persistence).toHaveBeenCalledTimes(2);
    expect(restarted.instance.state.publicationReviews?.[0]?.status).toBe("pending");
    expect(restarted.instance.state.pendingApprovals?.some((approval) => approval.kind === "pr_publish")).toBe(false);
    expect(restarted.instance.state.events?.filter((event) => event.kind === "run.completed" && event.runId === context.runId)).toHaveLength(1);
    await restarted.instance.onStart();
    await Promise.all(restarted.held);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(publication(restarted.instance)?.status).toBe("pending");
  });

  it("retains a discoverable pending approval if notification fails after the atomic commit", async () => {
    const context = await completeRun((proposal) => proposal, async (instance) => {
      vi.spyOn(instance as unknown as { postPublicationCard(id: string): void }, "postPublicationCard").mockImplementation(() => {
        throw new Error("Injected card delivery failure.");
      });
    });
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("completed");
    const restarted = host(JSON.parse(JSON.stringify(context.instance.state)) as OrchestratorState);
    await restarted.instance.onStart();
    expect(publication(restarted.instance)?.status).toBe("pending");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("resets and refuses later writes when SDK memory changes before persistence throws", async () => {
    const context = await completeRun();
    const checkpoint = context.writes.filter((state) => state.runs.some((run) => run.runId === context.runId && run.status === "running")).at(-1)!;
    const persisted = JSON.parse(JSON.stringify(checkpoint)) as OrchestratorState;
    const interrupted = host(JSON.parse(JSON.stringify(checkpoint)) as OrchestratorState);
    Object.assign((interrupted.instance as unknown as { ctx: object }).ctx, { abort: mocks.abort });
    interrupted.instance.setState = CodingOrchestrator.prototype.setState;
    const internals = interrupted.instance as unknown as {
      completeRunWithPublication(runId: string, patch: RunPatch, generation: number, proposal: PrPublicationProposal): DelegatedRun | null;
    };
    const generation = persisted.runs.find((run) => run.runId === context.runId)!.generation;
    mocks.persist.mockImplementationOnce(() => { throw new Error("Injected SQL failure after memory assignment."); });
    expect(() => internals.completeRunWithPublication(context.runId, { summary: "Ready." }, generation, context.proposal)).toThrow("Injected SQL failure");
    expect(interrupted.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("completed");
    expect(mocks.abort).toHaveBeenCalledOnce();
    expect(() => interrupted.instance.setState({ ...interrupted.instance.state, slackBufferRevision: 1 })).toThrow("must reset");
    expect(mocks.persist).toHaveBeenCalledOnce();
    const restarted = host(persisted);
    await restarted.instance.onStart();
    expect(restarted.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("unknown");
    expect(publication(restarted.instance)).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("completes approved sandbox work while retaining a separate pending publication action", async () => {
    const context = await completeRun();
    expect(context.input).toMatchObject({ publishPullRequest: true, deferPullRequestPublish: true, accessAgent: OWNER, approvalThreadKey: OWNER });
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)).toMatchObject({ status: "completed" });
    expect(publication(context.instance)).toMatchObject({
      approvalId: `pr-publish:${context.runId}`, threadKey: OWNER, status: "pending", kind: "pr_publish",
      payload: { ownerId: OWNER, runId: context.runId, sandboxId: context.input.sandboxId, repoUrl: REPO, baseBranch: "main" },
    });
    expect(publication(context.instance)?.execution).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
    await context.instance.onStart();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("marks an interrupted review publication claim unknown before startup can resume it", async () => {
    const context = await completeRun();
    const state = JSON.parse(JSON.stringify(context.instance.state)) as OrchestratorState;
    state.reviewRounds = [{
      roundId: `${context.runId}:interrupted-head`, codingRunId: context.runId, reviewRunId: "interrupted-review",
      pull: { owner: "owner", repo: "repo", number: 42, headSha: "interrupted-head", url: PULL_URL },
      status: "running", publicationOutcome: "posting", findings: [], summary: "Completed review awaiting GitHub receipt.", generation: 2,
    }];
    const restarted = host(state);
    await restarted.instance.onStart();
    expect(restarted.instance.state.reviewRounds?.[0]).toMatchObject({
      status: "failed", publicationOutcome: "unknown", error: expect.stringContaining("Inspect GitHub"),
    });
    const retry = await restarted.instance.onRequest(post(`/api/runs/${encodeURIComponent(context.runId)}/review/retry`, {}));
    expect(retry.status).toBe(409);
    expect(mocks.child).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each([
    { decidedBy: "intruder@example.test" },
    { decidedBy: "automation:nightly" },
    { decidedBy: "agent:fixer" },
    { decidedBy: REVIEWER, principal: "agent-fixer" },
  ])("refuses autonomous or unauthorized publication decisions %j without changing approval state", async ({ decidedBy, principal }) => {
    const context = await completeRun();
    const pending = publication(context.instance);
    if (!pending) throw new Error("Expected publication approval.");
    const approvalsBefore = JSON.stringify(context.instance.state.pendingApprovals);
    expect((await decide(context.instance, pending, decidedBy, principal)).status).toBe(403);
    expect(JSON.stringify(context.instance.state.pendingApprovals)).toBe(approvalsBefore);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("persists a claim before the authorized human approval publishes exactly once", async () => {
    const context = await completeRun();
    const pending = publication(context.instance);
    if (!pending) throw new Error("Expected publication approval.");
    let release: (value: typeof PUBLISHED) => void = () => {};
    const publishing = new Promise<typeof PUBLISHED>((resolve) => { release = resolve; });
    mocks.publish.mockImplementation(() => {
      expect(publication(context.instance)?.execution?.status).toBe("executing");
      return publishing;
    });
    expect((await decide(context.instance, pending)).status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith(context.instance.env, expect.objectContaining({
      approvalId: pending.approvalId, status: "approved", decidedBy: REVIEWER,
    }), {
      ownerId: OWNER, runId: context.runId, sandboxId: context.input.sandboxId, repoUrl: REPO, baseBranch: "main",
    });
    expect(mocks.publish.mock.calls[0]?.[1].execution).toBeUndefined();
    expect((await decide(context.instance, pending)).status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledOnce();
    release(PUBLISHED);
    await vi.waitFor(() => expect(publication(context.instance)?.execution?.status).toBe("executed"));
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.pullUrl).toBe(PULL_URL);
    expect(context.instance.state.runs).toHaveLength(1);
    expect(context.writes.some((state) => state.pendingApprovals?.some((approval) => approval.kind === "pr_publish" && approval.execution?.status === "executing"))).toBe(true);
    const restarted = host(JSON.parse(JSON.stringify(context.instance.state)) as OrchestratorState);
    await restarted.instance.onStart();
    await decide(restarted.instance, pending);
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("never retries an executing publication claim after reconstruction or a duplicate decision", async () => {
    const context = await completeRun();
    const pending = publication(context.instance);
    if (!pending) throw new Error("Expected publication approval.");
    let release: (value: typeof PUBLISHED) => void = () => {};
    mocks.publish.mockReturnValue(new Promise<typeof PUBLISHED>((resolve) => { release = resolve; }));
    await decide(context.instance, pending);
    expect(publication(context.instance)?.execution?.status).toBe("executing");
    const restarted = host(JSON.parse(JSON.stringify(context.instance.state)) as OrchestratorState);
    await restarted.instance.onStart();
    expect(mocks.publish).toHaveBeenCalledOnce();
    await decide(restarted.instance, pending);
    await restarted.instance.onStart();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(publication(restarted.instance)?.execution?.status).toBe("unknown");
    release(PUBLISHED);
    await vi.waitFor(() => expect(publication(context.instance)?.execution?.status).toBe("executed"));
  });

  it("recovers a failed review handoff from the committed publication receipt without publishing twice", async () => {
    const context = await completeRun();
    const pending = publication(context.instance);
    if (!pending) throw new Error("Expected publication approval.");
    const review = vi.spyOn(context.instance as unknown as { afterRunSettled(run: DelegatedRun, output: string): Promise<void> }, "afterRunSettled")
      .mockRejectedValueOnce(new Error("Injected interruption before review dispatch."));
    await decide(context.instance, pending);
    await vi.waitFor(() => expect(publication(context.instance)?.execution?.status).toBe("executed"));
    expect(review).toHaveBeenCalledOnce();
    expect(context.instance.state.prBindings?.["owner/repo#42"]).toBe(context.runId);
    const restarted = host(JSON.parse(JSON.stringify(context.instance.state)) as OrchestratorState);
    const recoveredReview = vi.spyOn(restarted.instance as unknown as { afterRunSettled(run: DelegatedRun, output: string): Promise<void> }, "afterRunSettled").mockResolvedValue(undefined);
    await restarted.instance.onStart();
    expect(recoveredReview).toHaveBeenCalledWith(expect.objectContaining({ runId: context.runId, pullUrl: PULL_URL }), "");
    expect(publication(restarted.instance)?.execution?.status).toBe("executed");
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it("retains an uncertain publisher failure and refuses replay after restart", async () => {
    const context = await completeRun();
    const pending = publication(context.instance);
    if (!pending) throw new Error("Expected publication approval.");
    mocks.publish.mockRejectedValue(new Error("Connection lost after GitHub may have accepted the request."));
    await decide(context.instance, pending);
    await vi.waitFor(() => expect(publication(context.instance)?.execution?.status).toBe("unknown"));
    expect(publication(context.instance)?.execution?.error).toMatch(/Inspect GitHub before retrying/);
    await decide(context.instance, pending);
    const restarted = host(JSON.parse(JSON.stringify(context.instance.state)) as OrchestratorState);
    await restarted.instance.onStart();
    await decide(restarted.instance, pending);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(publication(restarted.instance)?.execution?.status).toBe("unknown");
  });

  it.each([
    { ownerId: "another-owner" }, { runId: "another-run" }, { sandboxId: "another-sandbox" },
    { repoUrl: "https://github.com/owner/other" }, { baseBranch: "release" }, { baseRevision: "b".repeat(40) },
  ])("does not mint a publication approval from a proposal outside the completed scope %j", async (change) => {
    const context = await completeRun((proposal) => ({ ...proposal, payload: { ...proposal.payload, ...change } }));
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("error");
    expect(publication(context.instance)).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not mint a publication approval under another conversation owner", async () => {
    const context = await completeRun((proposal) => ({ ...proposal, threadKey: "another-owner" }));
    expect(publication(context.instance)).toBeUndefined();
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("error");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not mint a publication action from a late child result after cancellation", async () => {
    const context = await completeRun((proposal) => proposal, (instance, runId) => instance.cancelRun(runId));
    expect(context.instance.state.runs.find((run) => run.runId === context.runId)?.status).toBe("cancelled");
    expect(publication(context.instance)).toBeUndefined();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("refuses publication if a retained completed run is a child run", async () => {
    const context = await completeRun();
    const pending = publication(context.instance);
    if (!pending) throw new Error("Expected publication approval.");
    context.instance.setState({ ...context.instance.state, runs: context.instance.state.runs.map((run) => ({ ...run, parentRunId: "coordinator-run" })) });
    expect((await decide(context.instance, pending)).status).toBe(200);
    expect(publication(context.instance)?.execution).toMatchObject({ status: "failed", error: expect.stringContaining("outside this owner") });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
