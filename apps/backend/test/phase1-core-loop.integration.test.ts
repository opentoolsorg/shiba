/**
 * Repository execution and separate publication approval integration coverage.
 * The harness and GitHub API use deterministic fixtures.
 * Review checks cover deferred publication and retained publications with their
 * original human review authorization, lifecycle wakes, findings, and retries.
 */
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { createRun } from "../src/runs.js";
import { stagePrPublishApproval } from "../src/pr-publish-approval.js";
import type { CodingTaskResult } from "../src/opencode-input.js";
import {
  RESULT_MARKER,
  formatAgentResult,
  parseAgentToolInput,
} from "../src/opencode-input.js";
import { runInputHash } from "@shiba/shared";
import { deliverableStorageKey, persistRunDeliverables, verifyExpectedDeliverables } from "../src/run-deliverables.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const REPO = "https://github.com/o/r";
const TOKEN = "ghp_testtoken12345678";
const API_BASE = "http://127.0.0.1:8799";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "new-commit";
const PULL_URL = "https://github.com/o/r/pull/7";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  specialist: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
  harnessMode: "happy" as "happy" | "coding-error" | "review-error" | "review-invalid",
}));

vi.mock("@cloudflare/think", () => ({
  Think: class {
    messages?: UIMessage[];
    async addMessages(messages: UIMessage[]) {
      const ids = new Set(messages.map((message) => message.id));
      this.messages = [...(this.messages ?? []).filter((message) => !ids.has(message.id)), ...messages];
    }
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
    keepAliveWhile(fn: () => Promise<unknown>) {
      return mocks.keepAliveWhile(fn);
    }
    schedule(...args: unknown[]) {
      return mocks.schedule(...args);
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: (cls: { name: string }) => ({ execute: cls.name === "ReviewerAgent" ? mocks.specialist : mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function createMockGitHubFetch() {
  const calls: RecordedCall[] = [];
  const postedReviews: Array<{ id: number; html_url: string; body: string }> = [];
  let postReviewFails = false;
  let postReviewResponseLost = false;

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.endsWith("/user")) {
      return json({ login: "shiba-bot" });
    }
    if (url.endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: BASE_SHA } });
    }
    if (url.endsWith(`/git/commits/${BASE_SHA}`)) {
      return json({ tree: { sha: "base-tree" } });
    }
    if (url.endsWith("/git/blobs")) {
      return json({ sha: `blob-${calls.length}` });
    }
    if (url.endsWith("/git/trees")) {
      return json({ sha: "new-tree" });
    }
    if (url.endsWith("/git/commits")) {
      return json({ sha: HEAD_SHA });
    }
    if (url.endsWith("/git/refs")) {
      return json({});
    }
    if (url.endsWith("/pulls") && init?.method === "POST") {
      return json({ html_url: PULL_URL, number: 7, head: { sha: HEAD_SHA } });
    }
    if (/\/pulls\/7$/.test(url) && (!init?.method || init.method === "GET")) {
      return json({ number: 7, html_url: PULL_URL, head: { sha: HEAD_SHA, ref: "shiba/run" } });
    }
    if (url.endsWith("/pulls/7/reviews") && init?.method === "POST") {
      if (postReviewFails) {
        return new Response("review validation rejected", { status: 422 });
      }
      const body = JSON.parse(String(init.body)) as { body: string };
      const review = {
        id: postedReviews.length + 1,
        html_url: `${PULL_URL}#pullrequestreview-${postedReviews.length + 1}`,
        body: body.body,
        user: { login: "shiba-bot" },
      };
      postedReviews.push(review);
      if (postReviewResponseLost) throw new Error("Connection lost after GitHub accepted the review.");
      return json(review);
    }
    if (url.endsWith("/pulls/7/reviews")) {
      return json(
        postedReviews.map((review) => ({
          id: review.id,
          html_url: review.html_url,
          body: review.body,
          user: { login: "shiba-bot" },
        })),
      );
    }
    return json({ message: "not found" }, 404);
  });

  return {
    calls,
    postedReviews,
    fetchImpl,
    setPostReviewFails: (value: boolean) => {
      postReviewFails = value;
    },
    setPostReviewResponseLost: (value: boolean) => { postReviewResponseLost = value; },
  };
}

const finding = {
  path: "README.md",
  line: 1,
  category: "bug" as const,
  severity: "high" as const,
  confidence: "confirmed" as const,
  title: "Missing newline",
  failureScenario: "Parsers may choke on EOF.",
};

function reviewerEnvelope(summary: string) {
  return `${RESULT_MARKER}\n${JSON.stringify({
    status: "completed",
    exitCode: 0,
    stderrTail: "",
    changedFiles: [],
    diff: "",
    files: [],
    summary,
    findings: [finding],
  })}`;
}

let publicationBucket: R2Bucket;

function memoryPublicationBucket(): R2Bucket {
  const stored = new Map<string, Uint8Array>();
  return {
    put: vi.fn(async (key: string, value: string | Uint8Array) => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value.slice();
      stored.set(key, bytes);
      return { key, size: bytes.byteLength };
    }),
    get: vi.fn(async (key: string) => {
      const bytes = stored.get(key);
      return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice().buffer } : null;
    }),
  } as unknown as R2Bucket;
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ...productionEnvStubs(),
    Sandbox: {},
    DASHBOARD_APPROVERS: "tester",
    GITHUB_TOKEN: TOKEN,
    GITHUB_API_BASE: API_BASE,
    ATTACHMENTS: publicationBucket,
    ...overrides,
  } as Env;
}

function agent(overrides: Partial<Env> = {}) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: env(overrides),
    name: "default", messages: [],
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) {
      setStateLikeProduction(this, state);
    },
  });
}

async function queueAndApprove(instance: CodingOrchestrator, body: Record<string, unknown> = {}) {
  const queued = await instance.onRequest(
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...((body.executionTarget as { kind?: unknown } | undefined)?.kind === "artifact-workspace" ? {} : { repoUrl: REPO }),
        task: "Add a README",
        publishPullRequest: true,
        reviewAfterPublish: true,
        ...body,
      }),
    }),
  );
  expect(queued.status).toBe(200);
  const { approvalId } = (await queued.json()) as { approvalId: string };
  const approved = await instance.onRequest(
    new Request("https://internal/api/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "tester" }),
    }),
  );
  expect(approved.status).toBe(200);
  return { approvalId, codingRunId: `agent-tool:${approvalId}` };
}

function wireFakeHarness() {
  mocks.execute.mockImplementation(async (text: string) => {
    const input = parseAgentToolInput([{ role: "user", text }]);
    const reviewer = input.task.includes("Purpose: review");

    if (!reviewer) {
      if (mocks.harnessMode === "coding-error") {
        return formatAgentResult({
          status: "error",
          exitCode: 1,
          stderrTail: "boom",
          changedFiles: [],
          diff: "",
          files: [],
          summary: "Harness failed.",
        });
      }
      const files = [{ path: "README.md", content: "# edited\n", encoding: "utf8" as const }];
      const result: CodingTaskResult = {
        baseRevision: BASE_SHA,
        status: "completed", exitCode: 0, stderrTail: "", changedFiles: ["README.md"],
        diff: "+# edited", files, summary: "Edited README.",
      };
      if (!input.publishPullRequest) return formatAgentResult(result);
      expect(input.deferPullRequestPublish).toBe(true);
      if (!input.accessAgent || !input.dispatchApprovalId) throw new Error("Missing approved publication owner.");
      const publicationProposal = await stagePrPublishApproval(env(), {
        ownerId: input.accessAgent, runId: `agent-tool:${input.dispatchApprovalId}`,
        sandboxId: input.sandboxId, repoUrl: input.repoUrl, baseBranch: input.baseBranch,
        task: input.task, result,
      });
      return formatAgentResult({ ...result, publicationProposal });
    }

    if (mocks.harnessMode === "review-error") {
      return formatAgentResult({
        status: "error",
        exitCode: 2,
        stderrTail: "reviewer died",
        changedFiles: [],
        diff: "",
        files: [],
        summary: "Reviewer harness failed.",
      });
    }
    if (mocks.harnessMode === "review-invalid") {
      return reviewerEnvelope("Invalid findings").replace(JSON.stringify([finding]), JSON.stringify([{ title: "Lost finding" }]));
    }
    return reviewerEnvelope("One high finding on README.");
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.harnessMode = "happy";
  mocks.specialist.mockResolvedValue({ agent: "reviewer", status: "completed", summary: "Captured diff reviewed.", report: "The frozen task and captured diff were inspected.", findings: [] });
  publicationBucket = memoryPublicationBucket();
});


/** Retained legacy publications carry their original human review authorization. */
async function seedApprovedHistoricalPull(instance: CodingOrchestrator) {
  const fields = { repoUrl: REPO, task: "Add a README", baseBranch: "main", publishPullRequest: true, reviewAfterPublish: true };
  const codingRunId = "agent-tool:historical-publication";
  const coding = {
    ...createRun({ ...fields, runId: codingRunId, sandboxId: "historical-workspace", approval: {
      approvalId: "historical-human-approval", decidedBy: "tester", decidedAt: Date.now(), inputHash: runInputHash(fields),
    } }),
    status: "completed" as const, pullUrl: PULL_URL, diff: "+# edited",
  };
  instance.setState({ runs: [coding] });
  const wake = await instance.onRequest(new Request("https://internal/internal/pr-lifecycle", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ githubEvent: "pull_request", mapped: { event: "pull_request", action: "synchronize", repo: "o/r", pullNumber: 7, headSha: HEAD_SHA } }),
  }));
  expect(wake.status).toBe(200);
  expect(await wake.json()).toMatchObject({ queued: "review" });
  return { codingRunId };
}

async function approvePublication(instance: CodingOrchestrator, codingRunId: string) {
  const approvalId = `pr-publish:${codingRunId}`;
  await vi.waitFor(() => expect(instance.state.pendingApprovals?.find((approval) => approval.approvalId === approvalId)?.status).toBe("pending"));
  const approved = await instance.onRequest(new Request("https://internal/api/approvals", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "tester" }),
  }));
  expect(approved.status).toBe(200);
  await vi.waitFor(() => expect(instance.state.pendingApprovals?.find((approval) => approval.approvalId === approvalId)?.execution?.status).toBe("executed"));
}

describe("Phase 1 core loop (integration)", () => {
  it("rejects a disabled computer deployment instead of freezing sandbox approval", async () => {
    const instance = agent({ RUNTIME: "computer", SHIBA_VERIFY_STANDIN: "1" });
    const queued = await instance.onRequest(new Request("https://internal/api/runs", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl: REPO, task: "Add a README", publishPullRequest: false }),
    }));
    expect(queued.status).toBe(400);
    expect(await queued.text()).toContain("preview-only");
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("does not start work before approval and publishes the captured diff only after a separate action approval", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness();
    const instance = agent({ AI_GATEWAY_TOKEN: undefined, SHIBA_VERIFY_STANDIN: "1" });
    const queued = await instance.onRequest(
      new Request("https://internal/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: REPO,
          task: "Add a README",
          publishPullRequest: true,
        }),
      }),
    );
    expect(queued.status).toBe(200);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
    const { approvalId } = (await queued.json()) as { approvalId: string };
    const approved = await instance.onRequest(
      new Request("https://internal/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadKey: "default", approvalId, approved: true, decidedBy: "tester" }),
      }),
    );
    expect(approved.status).toBe(200);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalled());
    const codingRunId = `agent-tool:${approvalId}`;
    await vi.waitFor(() => expect(instance.state.runs.find((run) => run.runId === codingRunId)?.status).toBe("completed"));
    const coding = instance.state.runs.find((run) => run.runId === codingRunId);
    expect(coding?.pullUrl).toBeUndefined();
    expect(coding?.diff ?? "").not.toBe("");
    expect(github.calls.some((call) => call.init?.method === "POST")).toBe(false);
    await approvePublication(instance, codingRunId);
    expect(instance.state.runs.find((run) => run.runId === codingRunId)?.pullUrl).toBe(PULL_URL);
    expect(github.calls.some((call) => call.url.includes("/pulls") && call.init?.method === "POST")).toBe(true);
    expect(github.calls.some((call) => /api\.openai\.com|generativelanguage|api\.anthropic\.com/.test(call.url))).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });

  it("waits for publication approval before dispatching the approved reviewer and registering the PR", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness();
    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);
    await vi.waitFor(() => expect(instance.state.runs.find((run) => run.runId === codingRunId)?.status).toBe("completed"));
    expect(instance.state.runs).toHaveLength(1);
    expect(instance.state.reviewRounds ?? []).toHaveLength(0);
    expect(instance.state.prBindings ?? {}).toEqual({});
    expect(github.postedReviews).toHaveLength(0);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    await approvePublication(instance, codingRunId);
    await vi.waitFor(() => expect(instance.state.reviewRounds?.[0]?.status).toBe("posted"));
    expect(instance.state.prBindings?.["o/r#7"]).toBe(codingRunId);
    expect(instance.state.runs.find((run) => run.reviewOf === codingRunId)?.status).toBe("completed");
    expect(instance.state.reviewRounds).toHaveLength(1);
    expect(github.postedReviews).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    const restarted = agent();
    restarted.setState(JSON.parse(JSON.stringify(instance.state)) as OrchestratorState);
    await restarted.onStart();
    await vi.waitFor(() => expect(github.calls.filter((call) => /\/pulls\/7$/.test(call.url)).length).toBeGreaterThan(1));
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(github.postedReviews).toHaveLength(1);
    expect(github.calls.filter((call) => call.url.endsWith("/pulls") && call.init?.method === "POST")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("retains an unknown review outcome after lost delivery and refuses restart, wake and explicit retries", async () => {
    const github = createMockGitHubFetch();
    github.setPostReviewResponseLost(true);
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness();
    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);
    await approvePublication(instance, codingRunId);
    await vi.waitFor(() => expect(instance.state.reviewRounds?.[0]?.publicationOutcome).toBe("unknown"));
    expect(github.postedReviews).toHaveLength(1);
    const restarted = agent();
    restarted.setState(JSON.parse(JSON.stringify(instance.state)) as OrchestratorState);
    await restarted.onStart();
    const retry = await restarted.onRequest(new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review/retry`, { method: "POST" }));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: "review_publication_unknown" });
    await restarted.onRequest(new Request("https://internal/internal/pr-lifecycle", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubEvent: "pull_request", mapped: { event: "pull_request", action: "synchronize", repo: "o/r", pullNumber: 7, headSha: HEAD_SHA } }),
    }));
    expect(restarted.state.reviewRounds?.[0]?.publicationOutcome).toBe("unknown");
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(github.postedReviews).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("resumes an approved historical PR, chains review, stores findings, and posts the round", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness();

    const instance = agent();
    const { codingRunId } = await seedApprovedHistoricalPull(instance);

    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));

    const coding = instance.state.runs.find((run) => run.runId === codingRunId);
    expect(coding?.status).toBe("completed");
    expect(coding?.pullUrl).toBe(PULL_URL);
    expect(coding?.reviewAfterPublish).toBe(true);

    const rounds = instance.state.reviewRounds ?? [];
    expect(rounds).toHaveLength(1);
    const round = rounds[0]!;
    expect(round.status).toBe("posted");
    expect(round.findings).toHaveLength(1);
    expect(round.findings[0]?.title).toBe("Missing newline");
    expect(round.codingRunId).toBe(codingRunId);
    expect(round.githubReviewId).toBe(1);
    expect(github.postedReviews).toHaveLength(1);
    expect(github.calls.some((call) => call.url.endsWith("/pulls") && call.init?.method === "POST")).toBe(false);

    const reviewGet = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review`),
    );
    expect(reviewGet.status).toBe(200);
    const body = (await reviewGet.json()) as { round?: { status: string } };
    expect(body.round?.status).toBe("posted");

    vi.unstubAllGlobals();
  });

  it("stores an approved employee run's requested artifact before marking it completed", async () => {
    const stored = new Map<string, string>();
    const attachments = {
      put: vi.fn(async (key: string, body: string) => {
        stored.set(key, body);
        return { key };
      }),
    } as unknown as R2Bucket;
    const instance = agent({ ATTACHMENTS: attachments });
    mocks.execute.mockImplementation(async (text: string) => {
      const input = parseAgentToolInput([{ role: "user", text }]);
      const file = { path: "research/report.md", content: "# Research draft\nSynthetic evidence only.\n", encoding: "utf8" as const };
      const artifacts = await verifyExpectedDeliverables(input.expectedDeliverables, [file]);
      const deliverables = await persistRunDeliverables({ ATTACHMENTS: attachments }, input.sandboxId, artifacts);
      return formatAgentResult({
        status: "completed", exitCode: 0, stderrTail: "", changedFiles: [file.path],
        diff: "+# Research draft", files: [file], deliverables, summary: "Created a synthetic research draft.",
      });
    });

    const { approvalId, codingRunId } = await queueAndApprove(instance, {
      task: "Prepare the research report", publishPullRequest: false, reviewAfterPublish: false,
      expectedDeliverables: ["research/report.md"],
    });
    await vi.waitFor(() => expect(instance.state.runs.find((item) => item.runId === codingRunId)?.status).toBe("completed"));

    const run = instance.state.runs.find((item) => item.runId === codingRunId);
    expect(run?.approval?.approvalId).toBe(approvalId);
    expect(run?.status).toBe("completed");
    expect(run?.expectedDeliverables).toEqual(["research/report.md"]);
    expect(run?.deliverables).toEqual([expect.objectContaining({ path: "research/report.md", mediaType: "text/markdown; charset=utf-8" })]);
    expect(stored.get(deliverableStorageKey(run!.sandboxId, run!.deliverables![0]!.sha256, 0))).toBe("# Research draft\nSynthetic evidence only.\n");
    expect(JSON.stringify(run?.deliverables)).not.toContain("Synthetic evidence only");
  });

  it("accepts a repo-free artifact workspace, freezes its target at approval, and stores the verified output", async () => {
    const stored = new Map<string, string>();
    const attachments = {
      put: vi.fn(async (key: string, body: string) => {
        stored.set(key, body);
        return { key };
      }),
    } as unknown as R2Bucket;
    const instance = agent({ ATTACHMENTS: attachments });
    const expectedDeliverables = ["sales/account-brief.md"];
    const executionTarget = {
      kind: "artifact-workspace",
      workspaceName: "Sales workspace",
      expectedDeliverables,
    } as const;
    mocks.execute.mockImplementation(async (text: string) => {
      const input = parseAgentToolInput([{ role: "user", text }]);
      expect(input.repoUrl).toBe("");
      expect(input.executionTarget).toEqual(executionTarget);
      expect(input.expectedDeliverables).toEqual(expectedDeliverables);
      expect(input.publishPullRequest).toBe(false);
      const file = { path: expectedDeliverables[0]!, content: "# Account brief\nSynthetic fixture.\n", encoding: "utf8" as const };
      const artifacts = await verifyExpectedDeliverables(input.expectedDeliverables, [file]);
      const deliverables = await persistRunDeliverables({ ATTACHMENTS: attachments }, input.sandboxId, artifacts);
      return formatAgentResult({
        status: "completed", exitCode: 0, stderrTail: "", changedFiles: [file.path],
        diff: "+# Account brief", files: [file], deliverables, summary: "Created a synthetic account brief.",
      });
    });

    const { approvalId, codingRunId } = await queueAndApprove(instance, {
      executionTarget,
      task: "Draft an evidence-grounded account brief",
      publishPullRequest: false,
      reviewAfterPublish: false,
    });
    await vi.waitFor(() => {
      const run = instance.state.runs.find((item) => item.runId === codingRunId);
      if (run?.status === "error") throw new Error(run.error ?? "Artifact workspace run failed.");
      expect(run?.status).toBe("completed");
    });

    const run = instance.state.runs.find((item) => item.runId === codingRunId);
    expect(run?.approval?.approvalId).toBe(approvalId);
    expect(run?.executionTarget).toEqual(executionTarget);
    expect(run?.repoUrl).toBe("");
    expect(run?.expectedDeliverables).toEqual(expectedDeliverables);
    expect(run?.approval?.inputHash).toMatch(/^[a-f0-9]{64}$/);
    const frozenInput = {
      repoUrl: run!.repoUrl,
      executionTarget: run!.executionTarget,
      task: run!.task,
      baseBranch: run!.baseBranch,
      publishPullRequest: run!.publishPullRequest,
      route: run!.route,
      runtime: run!.runtime,
      expectedDeliverables: run!.expectedDeliverables,
    };
    expect(runInputHash(frozenInput)).toBe(run!.approval!.inputHash);
    expect(runInputHash({
      ...frozenInput,
      executionTarget: { ...executionTarget, workspaceName: "Changed after approval" },
    })).not.toBe(run!.approval!.inputHash);
    expect(run?.deliverables).toEqual([expect.objectContaining({ path: expectedDeliverables[0], mediaType: "text/markdown; charset=utf-8" })]);
    expect(stored.get(deliverableStorageKey(run!.sandboxId, run!.deliverables![0]!.sha256, 0))).toBe("# Account brief\nSynthetic fixture.\n");
  });

  it("validates direct execution-target intake before approval and deduplicates command replay", async () => {
    const instance = agent({ AI_GATEWAY_TOKEN: undefined, SHIBA_VERIFY_STANDIN: "1" });
    const postRun = (body: Record<string, unknown>) => instance.onRequest(
      new Request("https://internal/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "Create an account brief", publishPullRequest: false, ...body }),
      }),
    );
    const target = {
      kind: "artifact-workspace",
      workspaceName: "Sales workspace",
      expectedDeliverables: ["sales/account-brief.md"],
    } as const;

    const connected = await postRun({
      executionTarget: { kind: "connected-app", connectionId: "crm", action: "create-record" },
    });
    expect(connected.status).toBe(501);
    expect(await connected.json()).toEqual({ error: "Connected-app execution is not available until a permissioned adapter is implemented." });

    const invalidRequests: Array<Record<string, unknown>> = [
      { executionTarget: target, repoUrl: REPO },
      { executionTarget: target, expectedDeliverables: ["sales/other.md"] },
      { executionTarget: { ...target, expectedDeliverables: ["../private.md"] } },
      { executionTarget: target, publishPullRequest: true },
      { executionTarget: target, runSetup: true },
    ];
    for (const body of invalidRequests) {
      const response = await postRun(body);
      expect(response.status).toBe(400);
      expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    }
    // Local artifact work is valid input, but this non-dashboard intake cannot
    // request local execution. The dashboard also requires an enabled local runtime.
    const local = await postRun({ executionTarget: target, runtime: "local" });
    expect(local.status).toBe(403);
    expect(await local.json()).toEqual({ error: 'runtime "local" is admitted only through the dashboard.' });
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    expect(instance.state.runs ?? []).toHaveLength(0);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();

    const payload = { executionTarget: target, commandId: "artifact-command-1" };
    const first = await postRun(payload);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { approvalId: string; approvalInputHash: string };
    const approval = instance.state.pendingApprovals?.find((item) => item.approvalId === firstBody.approvalId);
    expect(approval?.executionTarget).toEqual(target);
    expect(approval?.expectedDeliverables).toEqual(target.expectedDeliverables);
    expect(approval?.repoUrl).toBe("");

    const replay = await postRun(payload);
    expect(replay.status).toBe(200);
    expect(firstBody.approvalInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await replay.json()).toEqual({ ok: true, approvalId: firstBody.approvalId, approvalInputHash: firstBody.approvalInputHash, deduped: true });
    expect(instance.state.pendingApprovals).toHaveLength(1);
  });

  it("does not leave a review round when the coding harness fails", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    mocks.harnessMode = "coding-error";
    wireFakeHarness();

    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);

    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    expect(instance.state.runs.find((run) => run.runId === codingRunId)?.status).toBe("error");
    expect(instance.state.reviewRounds ?? []).toHaveLength(0);
    expect(mocks.execute).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it("marks the round failed when the reviewer harness errors (failReviewRound)", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    mocks.harnessMode = "review-error";
    wireFakeHarness();

    const instance = agent();
    const { codingRunId } = await seedApprovedHistoricalPull(instance);

    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));

    const round = (instance.state.reviewRounds ?? [])[0];
    expect(round?.status).toBe("failed");
    expect(round?.codingRunId).toBe(codingRunId);
    expect(round?.error).toBeTruthy();
    expect(github.postedReviews).toHaveLength(0);

    const stuck = (instance.state.reviewRounds ?? []).filter(
      (item) => item.status === "queued" || item.status === "running",
    );
    expect(stuck).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it("fails malformed reviewer output before posting or merging", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    mocks.harnessMode = "review-invalid";
    wireFakeHarness();
    const instance = agent();
    await seedApprovedHistoricalPull(instance);
    await vi.waitFor(() => expect((instance.state.reviewRounds ?? [])[0]?.error).toBe("review_findings_invalid"));
    expect(instance.state.reviewRounds?.[0]?.status).toBe("failed");
    expect(github.postedReviews).toHaveLength(0);
    expect((instance.state.pendingApprovals ?? []).some((approval) => approval.kind === "pr_merge")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("retries posting a failed round idempotently", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness();
    github.setPostReviewFails(true);

    const instance = agent();
    const { codingRunId } = await seedApprovedHistoricalPull(instance);

    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    let round = (instance.state.reviewRounds ?? [])[0];
    expect(round?.status).toBe("failed");

    github.setPostReviewFails(false);
    const retry = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review/retry`, {
        method: "POST",
      }),
    );
    expect(retry.status).toBe(200);
    const retried = (await retry.json()) as { round?: { status: string; githubReviewId?: number } };
    expect(retried.round?.status).toBe("posted");
    expect(retried.round?.githubReviewId).toBe(1);

    const retryAgain = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review/retry`, {
        method: "POST",
      }),
    );
    expect(retryAgain.status).toBe(200);
    expect(github.postedReviews).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("re-runs the reviewer agent when retry follows a reviewer failure", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    mocks.harnessMode = "review-error";
    wireFakeHarness();

    const instance = agent();
    const { codingRunId } = await seedApprovedHistoricalPull(instance);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));
    expect((instance.state.reviewRounds ?? [])[0]?.status).toBe("failed");

    mocks.harnessMode = "happy";
  mocks.specialist.mockResolvedValue({ agent: "reviewer", status: "completed", summary: "Captured diff reviewed.", report: "The frozen task and captured diff were inspected.", findings: [] });
    const retry = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review/retry`, { method: "POST" }),
    );
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { action?: string }).action).toBe("rerun");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect((instance.state.reviewRounds ?? [])[0]?.status).toBe("posted"));
    expect(github.postedReviews).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("does not queue a duplicate reviewer for the same PR head (idempotent chain)", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness();

    const instance = agent();
    const { codingRunId } = await seedApprovedHistoricalPull(instance);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1));

    const wake = await instance.onRequest(
      new Request("https://internal/internal/pr-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubEvent: "pull_request",
          mapped: {
            event: "pull_request",
            action: "synchronize",
            repo: "o/r",
            pullNumber: 7,
            headSha: HEAD_SHA,
          },
        }),
      }),
    );
    expect(wake.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(instance.state.reviewRounds ?? []).toHaveLength(1);

    const reviewGet = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review`),
    );
    expect(((await reviewGet.json()) as { round?: { status: string } }).round?.status).toBe("posted");

    vi.unstubAllGlobals();
  });

  it("refuses a CI wake for a run whose env was discarded instead of queueing it without env", async () => {
    const instance = agent();
    const coding = {
      ...createRun({
        runId: "agent-tool:env-wake",
        sandboxId: "sb-env-wake",
        repoUrl: REPO,
        task: "Add a README",
        baseBranch: "main",
        publishPullRequest: true,
        envNames: ["API_TOKEN"],
        envDigest: "a".repeat(64),
      }),
      status: "completed" as const,
      pullUrl: PULL_URL,
    };
    instance.setState({ runs: [coding] });
    const wake = await instance.onRequest(
      new Request("https://internal/internal/pr-lifecycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          githubEvent: "check_run",
          mapped: { event: "check_run", action: "completed", repo: "o/r", pullNumber: 7 },
        }),
      }),
    );
    expect(wake.status).toBe(200);
    expect(await wake.json()).toMatchObject({ wake: "ci_completed", skipped: "environment_discarded" });
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("stores a review loop and queues a merge approval for a clean posted round", async () => {
    const head = "c".repeat(40);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/7")) {
        return Response.json({ number: 7, html_url: PULL_URL, head: { sha: head, ref: "shiba/run" } });
      }
      return Response.json({ message: "not found" }, { status: 404 });
    }));
    const instance = agent();
    const coding = {
      ...createRun({
        runId: "agent-tool:loop",
        sandboxId: "sb-loop",
        repoUrl: REPO,
        task: "Add a README",
        baseBranch: "main",
        publishPullRequest: true,
        reviewAfterPublish: true,
      }),
      status: "completed" as const,
      pullUrl: PULL_URL,
    };
    instance.setState({
      runs: [coding],
      reviewRounds: [{
        roundId: `agent-tool:loop:${head}`,
        codingRunId: coding.runId,
        reviewRunId: "rev-1",
        pull: { owner: "o", repo: "r", number: 7, headSha: head, url: PULL_URL },
        status: "posted",
        findings: [],
        summary: "Looks good.",
        generation: 1,
        githubReviewId: 9,
      }],
    });
    const response = await instance.onRequest(
      new Request(`https://internal/api/runs/${coding.runId}/review-loop`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, autoMerge: true }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reviewLoop?: { enabled: boolean; autoMerge: boolean } };
    expect(body.reviewLoop).toMatchObject({ enabled: true, autoMerge: true });
    expect(instance.state.pendingApprovals?.some((approval) => approval.kind === "pr_merge")).toBe(true);
    expect(mocks.execute).not.toHaveBeenCalled();
    const again = await instance.onRequest(new Request(`https://internal/api/runs/${coding.runId}/review-loop`));
    expect(((await again.json()) as { reviewLoop?: { enabled: boolean } }).reviewLoop?.enabled).toBe(true);
    vi.unstubAllGlobals();
  });
});
