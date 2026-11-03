import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_PRINCIPAL_HEADER, type PendingApproval } from "@shiba/shared";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { formatAgentResult, parseAgentToolInput, type CodingTaskInput, type CodingTaskResult } from "../src/opencode-input.js";
import { stagePrPublishApproval, type PrPublicationProposal } from "../src/pr-publish-approval.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";

const mocks = vi.hoisted(() => ({ child: vi.fn(), publish: vi.fn(), destroy: vi.fn() }));
vi.mock("../src/pr-publish-approval.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/pr-publish-approval.js")>(),
  executePrPublishApproval: mocks.publish,
}));
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

const OWNER = "owner@example.test";
const REVIEWER = "reviewer@example.test";
const REPO = "https://github.com/owner/repo";
const PULL_URL = `${REPO}/pull/42`;
const PUBLISHED = { branch: "shiba/approved", commitSha: "commit-sha", pullUrl: PULL_URL, pullNumber: 42 };
const RESULT: CodingTaskResult = {
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
    name: OWNER,
    env: {
      ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "test-worker-github-token",
      DASHBOARD_APPROVERS: REVIEWER,
      ATTACHMENTS: {
        put: async (key: string, bytes: Uint8Array<ArrayBuffer>) => {
          objects.set(key, new Uint8Array(bytes));
          return { key };
        },
      },
    },
    ctx: { waitUntil: (promise: Promise<unknown>) => held.push(promise) },
    state,
    setState(next: OrchestratorState) {
      setStateLikeProduction(this, next);
      writes.push(JSON.parse(JSON.stringify(this.state)) as OrchestratorState);
    },
  });
  return { instance, writes, held };
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
      threadKey: OWNER, result: RESULT,
    });
    createdProposal = changeProposal(staged);
    await beforeReturn?.(context.instance, `agent-tool:${options.toolCallId}`);
    return formatAgentResult({ ...RESULT, publicationProposal: createdProposal });
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
  await Promise.all(context.held);
  if (!capturedInput || !createdProposal) throw new Error("Expected an isolated child result and a publication proposal.");
  return { ...context, runId, input: capturedInput, proposal: createdProposal };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.publish.mockResolvedValue(PUBLISHED);
});

describe("orchestrator external publication approval", () => {
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
    { repoUrl: "https://github.com/owner/other" }, { baseBranch: "release" },
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
