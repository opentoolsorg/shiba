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
import { runInputHash } from "@shiba/shared";
import { deliverableStorageKey, persistRunDeliverables, verifyExpectedDeliverables } from "../src/run-deliverables.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";
import { handleSlackEvent, type SlackMentionDeps } from "../src/slack-mention.js";
import { buildApprovalValue, handleSlackInteract, parseApprovalValue } from "../src/slack-approval.js";

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
  harnessMode: "happy" as "happy" | "coding-error" | "review-error" | "review-invalid",
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

    if (url.endsWith("/user")) {
      return json({ login: "shiba-bot" });
    }
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
        user: { login: "shiba-bot" },
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
    DASHBOARD_APPROVERS: "tester",
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
});

describe("Phase 1 core loop (integration)", () => {
  it("runs a mocked same-thread Slack mention, approval, PR result, follow-up, and denial", async () => {
    const github = createMockGitHubFetch();
    const messages: Array<{ channel: string; thread_ts: string; text: string; blocks?: unknown[] }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://slack.com/api/chat.postMessage") {
        const message = JSON.parse(String(init?.body));
        messages.push(message);
        return Response.json({ ok: true, channel: message.channel, ts: "1758217492.000300" });
      }
      return github.fetchImpl(input, init);
    }));
    wireFakeHarness(github);
    const threadKey = "slack:T1:C1:1758217392.000100";
    const slackEnv = env({
      AI_GATEWAY_TOKEN: undefined,
      SHIBA_VERIFY_STANDIN: "1",
      SLACK_BOT_TOKEN: "xoxb-fixture",
      SLACK_SIGNING_SECRET: "fixture-signing-secret",
      SLACK_APPROVERS: "U1",
      SLACK_AGENT_HARNESS: "codex",
    });
    const instance = Object.assign(agent(slackEnv), { name: threadKey });
    const queueRun: NonNullable<SlackMentionDeps["queueRun"]> = async (input) => {
      const response = await instance.onRequest(new Request("https://internal/api/runs", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, source: "slack", publishPullRequest: true }),
      }));
      expect(response.status).toBe(200);
      return response.json() as Promise<{ approvalId: string }>;
    };
    const mention = (text: string, ts: string) => ({
      type: "event_callback" as const, event_id: `event:${ts}`, team_id: "T1",
      event: { type: "app_mention", user: "U1", channel: "C1", thread_ts: "1758217392.000100", ts, text },
    });
    const mentionDeps: SlackMentionDeps = {
      queueRun,
      postMessage: async ({ threadTs, ...message }) => { messages.push({ ...message, thread_ts: threadTs }); },
      fetchThread: async () => [{ user: "U1", text: `Add a README ${REPO}`, ts: 1758217392.000100 }],
    };
    const decide = async (card: typeof messages[number], approved: boolean) => {
      const blocks = card.blocks as Array<{ type: string; elements?: Array<{ value: string }> }>;
      const value = blocks.find((block) => block.type === "actions")?.elements?.[0]?.value;
      expect(value).toBeDefined();
      if (!value) throw new Error("Expected an actionable Slack approval card.");
      const pointer = parseApprovalValue(value);
      const payload = {
        type: "block_actions", user: { id: "U1" },
        actions: [{ action_id: approved ? "approve" : "reject", value: buildApprovalValue(pointer) }],
        response_url: "https://hooks.slack.com/actions/T1/B1/fixture",
        message: { blocks: card.blocks },
      };
      const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(slackEnv.SLACK_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
      const signature = `v0=${Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const replaceCard = vi.fn(async (_url: string, _body: Record<string, unknown>) => {});
      const response = await handleSlackInteract(new Request("https://internal/api/slack/interact", {
        method: "POST", headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature }, body,
      }), slackEnv, {
        orchestratorStub: { fetch: (request) => instance.onRequest(request) },
        respond: async (_url, text) => { throw new Error(`Unexpected interaction failure: ${text}`); },
        replaceCard,
      });
      expect(response?.status).toBe(200);
      expect(replaceCard).toHaveBeenCalledOnce();
      const replacement = replaceCard.mock.calls[0]?.[1];
      expect(JSON.stringify(replacement)).toContain(approved ? "Approved" : "Rejected");
      expect(JSON.stringify(replacement)).not.toContain('"type":"actions"');
      return pointer;
    };
    try {
      await handleSlackEvent(mention(`<@U0> Add a README ${REPO}`, "1758217392.000100"), slackEnv, mentionDeps);
      expect(messages).toHaveLength(1);
      expect(mocks.execute).not.toHaveBeenCalled();
      const firstCard = messages[0];
      if (!firstCard) throw new Error("Expected an initial Slack approval card.");
      const first = await decide(firstCard, true);
      await vi.waitFor(() => expect(instance.state.runs.find((run) => run.runId === `agent-tool:${first.approvalId}`)?.status).toBe("completed"));
      await vi.waitFor(() => expect(messages.some((message) => message.text.includes(PULL_URL))).toBe(true));
      expect(messages.some((message) => message.text.includes("is starting"))).toBe(true);
      expect(mocks.execute).toHaveBeenCalledOnce();

      await handleSlackEvent(mention("<@U0> Now add a regression test", "1758217592.000100"), slackEnv, mentionDeps);
      const followup = messages.at(-1);
      if (!followup) throw new Error("Expected a follow-up Slack approval card.");
      expect(JSON.stringify(followup.blocks)).toContain("Now add a regression test");
      expect(JSON.stringify(followup.blocks)).toContain("Add a README");
      const denied = await decide(followup, false);
      expect(instance.state.pendingApprovals?.find((approval) => approval.approvalId === denied.approvalId)?.status).toBe("rejected");
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(messages.every((message) => message.channel === "C1" && message.thread_ts === "1758217392.000100")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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
      { executionTarget: target, runtime: "local" },
      { executionTarget: target, runSetup: true },
    ];
    for (const body of invalidRequests) {
      const response = await postRun(body);
      expect(response.status).toBe(400);
      expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
    }

    const payload = { executionTarget: target, commandId: "artifact-command-1" };
    const first = await postRun(payload);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { approvalId: string };
    const approval = instance.state.pendingApprovals?.find((item) => item.approvalId === firstBody.approvalId);
    expect(approval?.executionTarget).toEqual(target);
    expect(approval?.expectedDeliverables).toEqual(target.expectedDeliverables);
    expect(approval?.repoUrl).toBe("");

    const replay = await postRun(payload);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, approvalId: firstBody.approvalId, deduped: true });
    expect(instance.state.pendingApprovals).toHaveLength(1);
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

  it("fails malformed reviewer output before posting or merging", async () => {
    const github = createMockGitHubFetch();
    vi.stubGlobal("fetch", github.fetchImpl);
    mocks.harnessMode = "review-invalid";
    wireFakeHarness(github);
    const instance = agent();
    await queueAndApprove(instance);
    await vi.waitFor(() => expect((instance.state.reviewRounds ?? [])[0]?.error).toBe("review_findings_invalid"));
    expect(instance.state.reviewRounds?.[0]?.status).toBe("failed");
    expect(github.postedReviews).toHaveLength(0);
    expect(instance.state.pendingApprovals?.some((approval) => approval.kind === "pr_merge")).toBe(false);
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
