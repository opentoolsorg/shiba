import { describe, expect, it, vi } from "vitest";
import {
  automationThreadKey,
  fireAutomation,
  fireMatchingAutomations,
  githubWebhookToEvent,
  slackEventToAutomation,
  summarizeAutomationEvent,
  type FireAutomationDeps,
} from "../src/automation-runner.js";
import { createAutomation, type Automation, type RunWhenAi } from "../src/automations.js";

const REPO = "https://github.com/owner/repo";
const MODEL = "@cf/zai-org/glm-4.7-flash";

function stubAi(response: string | null, throwError = false): RunWhenAi {
  return {
    async run() {
      if (throwError) throw new Error("model down");
      return response === null ? {} : { response };
    },
  };
}

function scheduleAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    ...createAutomation({
      id: "nightly",
      prompt: "Audit deps",
      repoUrl: REPO,
      triggers: [{ kind: "schedule", cron: "0 2 * * *" }],
    }).automation,
    ...overrides,
  };
}

function githubAutomation(runWhen?: string): Automation {
  return createAutomation({
    id: "pr-bot",
    prompt: "Triage the PR",
    repoUrl: REPO,
    triggers: [
      {
        kind: "github",
        events: ["pull_request:opened"],
        repos: ["owner/repo"],
        ...(runWhen ? { runWhen } : {}),
      },
    ],
  }).automation;
}

function deps(overrides: Partial<FireAutomationDeps> = {}): FireAutomationDeps & {
  queueRun: ReturnType<typeof vi.fn>;
  resolveApproval: ReturnType<typeof vi.fn>;
} {
  const queueRun = overrides.queueRun ?? vi.fn(async () => ({ approvalId: "appr_1" }));
  const resolveApproval = overrides.resolveApproval ?? vi.fn(async () => {});
  return {
    ai: stubAi("YES"),
    model: MODEL,
    globalEnabled: true,
    nowMs: Date.UTC(2026, 0, 1, 2, 0, 0),
    ...overrides,
    queueRun,
    resolveApproval,
  } as FireAutomationDeps & {
    queueRun: ReturnType<typeof vi.fn>;
    resolveApproval: ReturnType<typeof vi.fn>;
  };
}

describe("automation fire path", () => {
  it("queues an approval-gated run for a due schedule and does not auto-approve", async () => {
    const d = deps();
    const result = await fireAutomation(
      scheduleAutomation(),
      { kind: "schedule", nowMs: d.nowMs! },
      d,
    );
    expect(result.fired).toBe(true);
    expect(result.approvalId).toBe("appr_1");
    expect(d.queueRun).toHaveBeenCalledOnce();
    expect(d.queueRun.mock.calls[0]![0]).toMatchObject({
      repoUrl: REPO,
      task: "Audit deps",
      threadKey: automationThreadKey("nightly"),
      publishPullRequest: true,
    });
    expect(d.resolveApproval).not.toHaveBeenCalled();
    expect(result.automation.runCount).toBe(1);
  });

  it("skips a non-matching event without queueing", async () => {
    const d = deps();
    const result = await fireAutomation(githubAutomation(), { kind: "manual" }, d);
    expect(result.fired).toBe(false);
    expect(d.queueRun).not.toHaveBeenCalled();
  });

  it("records a TypeSafe run_when skip and starts no run", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ answers: { match: { noul: 0.1 } } }), { status: 200 }),
    );
    const d = deps({ typeSafeApiKey: "ts-key", fetchImpl });
    const result = await fireAutomation(
      githubAutomation("it is a bug report"),
      {
        kind: "github",
        event: "pull_request",
        action: "opened",
        repo: "owner/repo",
      },
      d,
    );
    expect(result.fired).toBe(false);
    expect(d.queueRun).not.toHaveBeenCalled();
    expect(result.automation.lastSkip?.reason).toMatch(/did not match/i);
  });

  it("uses TypeSafe Noul to allow a matching run_when", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ answers: { match: { noul: 0.91 } } }), { status: 200 }),
    );
    const d = deps({ typeSafeApiKey: "ts-key", fetchImpl });
    const result = await fireAutomation(
      githubAutomation("it is a bug report"),
      {
        kind: "github",
        event: "pull_request",
        action: "opened",
        repo: "owner/repo",
      },
      d,
    );
    expect(result.fired).toBe(true);
    expect(d.queueRun).toHaveBeenCalledOnce();
  });

  it("auto-approves only when unattended is granted", async () => {
    const automation = scheduleAutomation({
      unattended: true,
      unattendedRepos: ["owner/repo"],
    });
    const d = deps();
    const result = await fireAutomation(automation, { kind: "schedule", nowMs: d.nowMs! }, d);
    expect(result.fired).toBe(true);
    expect(d.resolveApproval).toHaveBeenCalledOnce();
    expect(d.resolveApproval.mock.calls[0]![0]).toMatchObject({
      threadKey: "automation:nightly",
      approvalId: "appr_1",
      approved: true,
      decidedBy: "automation:nightly",
    });
  });

  it("records a queue failure instead of throwing", async () => {
    const d = deps({
      queueRun: vi.fn(async () => {
        throw new Error("orchestrator down");
      }),
    });
    const result = await fireAutomation(scheduleAutomation(), { kind: "schedule", nowMs: d.nowMs! }, d);
    expect(result.fired).toBe(false);
    expect(result.automation.lastSkip?.reason).toMatch(/orchestrator down/);
  });

  it("honors the global kill switch", async () => {
    const d = deps({ globalEnabled: false });
    const result = await fireAutomation(scheduleAutomation(), { kind: "schedule", nowMs: d.nowMs! }, d);
    expect(result.fired).toBe(false);
    expect(d.queueRun).not.toHaveBeenCalled();
    expect(result.reason).toMatch(/disabled globally/i);
  });
});

describe("github webhook mapping", () => {
  it("maps a pull_request payload into a matchable event", () => {
    const event = githubWebhookToEvent("pull_request", {
      action: "opened",
      repository: { full_name: "owner/repo" },
      pull_request: {
        user: { login: "alice" },
        head: { ref: "feat" },
        labels: [{ name: "bug" }],
      },
    });
    expect(event).toEqual({
      event: "pull_request",
      action: "opened",
      repo: "owner/repo",
      branch: "feat",
      author: "alice",
      labels: ["bug"],
    });
    expect(summarizeAutomationEvent({ kind: "github", ...event })).toContain("owner/repo");
  });
});

describe("slack event mapping", () => {
  it("maps a Slack event_callback into a matchable event", () => {
    const event = slackEventToAutomation({
      type: "event_callback",
      event: { channel: "C123", user: "U456", text: "please triage this" },
    });
    expect(event).toEqual({
      channel: "C123",
      author: "U456",
      text: "please triage this",
    });
    expect(summarizeAutomationEvent({ kind: "slack", ...event })).toContain("C123");
  });
});

describe("slack burst suppression", () => {
  const NOW = Date.UTC(2026, 0, 1, 2, 0, 0);
  const slackEvent = { kind: "slack" as const, channel: "C1", author: "U1", text: "cpu on fire" };

  function slackAutomation(burstWindowSeconds?: number, lastTriggeredAt?: number): Automation {
    const base = createAutomation({
      id: "on-call",
      prompt: "Triage the incident",
      repoUrl: REPO,
      triggers: [
        {
          kind: "slack",
          channels: ["C1"],
          ...(burstWindowSeconds === undefined ? {} : { burstWindowSeconds }),
        },
      ],
    }).automation;
    return lastTriggeredAt === undefined ? base : { ...base, lastTriggeredAt };
  }

  it("fires the first matching slack event", async () => {
    const d = deps({ nowMs: NOW });
    const result = await fireAutomation(slackAutomation(), slackEvent, d);
    expect(result.fired).toBe(true);
    expect(d.queueRun).toHaveBeenCalledOnce();
  });

  it("suppresses a second match inside the burst window without a model call", async () => {
    const ai = { run: vi.fn(async () => ({ response: "YES" })) };
    const d = deps({ nowMs: NOW, ai });
    const result = await fireAutomation(
      slackAutomation(undefined, NOW - 5_000),
      slackEvent,
      d,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/burst/i);
    expect(d.queueRun).not.toHaveBeenCalled();
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("fires again once the burst window has elapsed", async () => {
    const d = deps({ nowMs: NOW });
    const result = await fireAutomation(
      slackAutomation(undefined, NOW - 60_000),
      slackEvent,
      d,
    );
    expect(result.fired).toBe(true);
    expect(d.queueRun).toHaveBeenCalledOnce();
  });

  it("honors a custom burstWindowSeconds", async () => {
    const d = deps({ nowMs: NOW });
    const result = await fireAutomation(
      slackAutomation(120, NOW - 60_000),
      slackEvent,
      d,
    );
    expect(result.fired).toBe(false);
    expect(result.reason).toMatch(/burst/i);
  });
});

describe("fan-out", () => {
  it("updates only the automations that fired", async () => {
    const idle = scheduleAutomation({ id: "idle", lastTriggeredAt: Date.UTC(2026, 0, 1, 2, 0, 0) });
    const due = scheduleAutomation({ id: "due" });
    const d = deps();
    const { results, automations } = await fireMatchingAutomations(
      [idle, due],
      { kind: "schedule", nowMs: d.nowMs! },
      d,
    );
    expect(results.filter((r) => r.fired).map((r) => r.automation.id)).toEqual(["due"]);
    expect(automations.find((a) => a.id === "due")?.runCount).toBe(1);
    expect(automations.find((a) => a.id === "idle")?.runCount).toBe(0);
  });
});

describe("run_when predicate fan-out", () => {
  const githubEvent = {
    kind: "github" as const,
    event: "pull_request",
    action: "opened",
    repo: "owner/repo",
  };

  function gatedAutomation(id: string, runWhen = "it is a bug report"): Automation {
    return createAutomation({
      id,
      prompt: `Triage ${id}`,
      repoUrl: REPO,
      triggers: [
        {
          kind: "github",
          events: ["pull_request:opened"],
          repos: ["owner/repo"],
          runWhen,
        },
      ],
    }).automation;
  }

  function deferredAi() {
    const pending: { resolve: (value: unknown) => void }[] = [];
    const ai = {
      run: vi.fn(() => new Promise<unknown>((resolve) => pending.push({ resolve }))),
    };
    return { ai, pending };
  }

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("evaluates run_when predicates concurrently but queues commits in input order", async () => {
    const { ai, pending } = deferredAi();
    const d = deps({ ai });
    const automations = [gatedAutomation("a1"), gatedAutomation("a2"), gatedAutomation("a3")];
    const promise = fireMatchingAutomations(automations, githubEvent, d);
    // All three predicate calls must be in flight before any verdict resolves.
    await flush();
    expect(ai.run).toHaveBeenCalledTimes(3);
    // Resolve out of order — commits must still follow input order.
    pending[2]!.resolve({ response: "YES" });
    pending[0]!.resolve({ response: "YES" });
    pending[1]!.resolve({ response: "YES" });
    const { results } = await promise;
    expect(results.every((r) => r.fired)).toBe(true);
    expect(d.queueRun).toHaveBeenCalledTimes(3);
    expect(d.queueRun.mock.calls.map((call) => call[0]!.task)).toEqual([
      "Triage a1",
      "Triage a2",
      "Triage a3",
    ]);
    expect(d.queueRun.mock.calls.map((call) => call[0]!.threadKey)).toEqual([
      "automation:a1",
      "automation:a2",
      "automation:a3",
    ]);
  });

  it("bounds run_when predicate concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const ai = {
      run: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { response: "YES" };
      }),
    };
    const d = deps({ ai });
    const automations = Array.from({ length: 8 }, (_, i) => gatedAutomation(`b${i}`));
    const { results } = await fireMatchingAutomations(automations, githubEvent, d);
    expect(results.every((r) => r.fired)).toBe(true);
    expect(ai.run).toHaveBeenCalledTimes(8);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("keeps per-item skip semantics when verdicts resolve out of order", async () => {
    const { ai, pending } = deferredAi();
    const d = deps({ ai });
    const automations = [gatedAutomation("c1"), gatedAutomation("c2"), gatedAutomation("c3")];
    const promise = fireMatchingAutomations(automations, githubEvent, d);
    await flush();
    expect(ai.run).toHaveBeenCalledTimes(3);
    pending[1]!.resolve({ response: "NO" });
    pending[0]!.resolve({ response: "YES" });
    pending[2]!.resolve({ response: "YES" });
    const { results } = await promise;
    expect(results.map((r) => r.fired)).toEqual([true, false, true]);
    expect(results[1]!.automation.id).toBe("c2");
    expect(results[1]!.reason).toMatch(/did not match/i);
    // Only the YES verdicts queued, and in input order.
    expect(d.queueRun).toHaveBeenCalledTimes(2);
    expect(d.queueRun.mock.calls.map((call) => call[0]!.threadKey)).toEqual([
      "automation:c1",
      "automation:c3",
    ]);
  });

  it("fails closed on a predicate error without dropping later commits", async () => {
    const { ai, pending } = deferredAi();
    const d = deps({ ai });
    const automations = [gatedAutomation("d1"), gatedAutomation("d2")];
    const promise = fireMatchingAutomations(automations, githubEvent, d);
    await flush();
    expect(ai.run).toHaveBeenCalledTimes(2);
    pending[0]!.resolve(Promise.reject(new Error("model down")));
    pending[1]!.resolve({ response: "YES" });
    const { results } = await promise;
    expect(results[0]!.fired).toBe(false);
    expect(results[0]!.reason).toMatch(/model down/);
    expect(results[1]!.fired).toBe(true);
    expect(d.queueRun).toHaveBeenCalledTimes(1);
  });
});
