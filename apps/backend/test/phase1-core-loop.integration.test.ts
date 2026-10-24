/**
 * Phase 1 core loop — orchestrator integration with a fake harness (mocked
 * agent-tool execute) and mock GitHub (GITHUB_API_BASE + in-memory fetch).
 *
 * Happy path: queue → approve → coding run edits + publishes PR → chained
 * reviewer → findings stored → round posted.
 *
 * Failure paths: coding harness error (no review round), reviewer error
 * (failReviewRound, terminal failed), review POST retry idempotency.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { createRun } from "../src/runs.js";
import { publishFilesAsPullRequest } from "../src/github.js";
import {
  RESULT_MARKER,
  formatAgentResult,
  parseAgentToolInput,
} from "../src/opencode-input.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const REPO = "https://github.com/o/r";
const TOKEN = "ghp_testtoken12345678";
const API_BASE = "http://127.0.0.1:8799";
const HEAD_SHA = "new-commit";
const PULL_URL = "https://github.com/o/r/pull/7";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
  harnessMode: "happy" as "happy" | "coding-error" | "review-error",
}));

vi.mock("@cloudflare/think", () => ({
  Think: class {
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
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
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

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: "base-sha" } });
    }
    if (url.endsWith("/git/commits/base-sha")) {
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
        return new Response("upstream down", { status: 502 });
      }
      const body = JSON.parse(String(init.body)) as { body: string };
      const review = {
        id: postedReviews.length + 1,
        html_url: `${PULL_URL}#pullrequestreview-${postedReviews.length + 1}`,
        body: body.body,
      };
      postedReviews.push(review);
      return json(review);
    }
    if (url.endsWith("/pulls/7/reviews")) {
      return json(
        postedReviews.map((review) => ({
          id: review.id,
          html_url: review.html_url,
          body: review.body,
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

function env(overrides: Partial<Env> = {}): Env {
  return {
    ...productionEnvStubs(),
    Sandbox: {},
    GITHUB_TOKEN: TOKEN,
    GITHUB_API_BASE: API_BASE,
    ...overrides,
  } as Env;
}

function agent(overrides: Partial<Env> = {}) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: env(overrides),
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
        repoUrl: REPO,
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

function wireFakeHarness(github: ReturnType<typeof createMockGitHubFetch>) {
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
      let pullUrl = PULL_URL;
      if (input.publishPullRequest) {
        const published = await publishFilesAsPullRequest(
          {
            repoUrl: input.repoUrl,
            baseBranch: input.baseBranch,
            newBranch: `shiba/${input.sandboxId}`,
            title: "Shiba: Add a README",
            body: "Automated change.",
            files,
            token: TOKEN,
            message: "Shiba: Add a README",
          },
          { fetchImpl: github.fetchImpl },
        );
        pullUrl = published.pullUrl;
      }
      return formatAgentResult({
        status: "completed",
        exitCode: 0,
        stderrTail: "",
        changedFiles: ["README.md"],
        diff: "+# edited",
        files,
        summary: "Edited README.",
        pullUrl,
      });
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
    return reviewerEnvelope("One high finding on README.");
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
  mocks.harnessMode = "happy";
});

describe("Phase 1 core loop (integration)", () => {
  it("does not start work before approval, then records a diff and a stub pull request", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness(github);
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
    const coding = instance.state.runs.find((run) => run.runId === `agent-tool:${approvalId}`);
    expect(coding?.status).toBe("completed");
    expect(coding?.pullUrl).toBe(PULL_URL);
    expect(coding?.diff ?? "").not.toBe("");
    expect(github.calls.some((call) => call.url.includes("/pulls") && call.init?.method === "POST")).toBe(true);
    expect(github.calls.some((call) => /api\.openai\.com|generativelanguage|api\.anthropic\.com/.test(call.url))).toBe(
      false,
    );
    vi.unstubAllGlobals();
  });

  it("queues, approves, publishes a PR, chains review, stores findings, and posts the round", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness(github);

    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);

    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));

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
    expect(github.calls.some((call) => call.url.endsWith("/pulls") && call.init?.method === "POST")).toBe(true);

    const reviewGet = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review`),
    );
    expect(reviewGet.status).toBe(200);
    const body = (await reviewGet.json()) as { round?: { status: string } };
    expect(body.round?.status).toBe("posted");

    vi.unstubAllGlobals();
  });

  it("does not leave a review round when the coding harness fails", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    mocks.harnessMode = "coding-error";
    wireFakeHarness(github);

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
    wireFakeHarness(github);

    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);

    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));

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

  it("retries posting a failed round idempotently", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness(github);
    github.setPostReviewFails(true);

    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);

    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
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
    wireFakeHarness(github);

    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));
    expect((instance.state.reviewRounds ?? [])[0]?.status).toBe("failed");

    mocks.harnessMode = "happy";
    const retry = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review/retry`, { method: "POST" }),
    );
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { action?: string }).action).toBe("rerun");
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect((instance.state.reviewRounds ?? [])[0]?.status).toBe("posted"));
    expect(github.postedReviews).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("does not queue a duplicate reviewer for the same PR head (idempotent chain)", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    wireFakeHarness(github);

    const instance = agent();
    const { codingRunId } = await queueAndApprove(instance);
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(2));

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
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(instance.state.reviewRounds ?? []).toHaveLength(1);

    const reviewGet = await instance.onRequest(
      new Request(`https://internal/api/runs/${encodeURIComponent(codingRunId)}/review`),
    );
    expect(((await reviewGet.json()) as { round?: { status: string } }).round?.status).toBe("posted");

    vi.unstubAllGlobals();
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
