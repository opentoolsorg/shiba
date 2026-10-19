import { describe, expect, it, vi } from "vitest";
import { createRun } from "../src/runs.js";
import { backoffDelayMs, fetchWithBackoff } from "../src/http-retry.js";
import { logStructured } from "../src/log.js";
import { publicRunMessage, runTimedOut, stripStack } from "../src/public-error.js";
import { reviewRetryPlan, shouldQueueAutoMerge } from "../src/review/retry-plan.js";
import { restartDisposition } from "../src/run-resume.js";
import { applySetupFix, attachDoctorFixes, setupWizardCatalog } from "../src/setup-fixes.js";
import type { Env } from "../src/env.js";
import { runErrorWire, type DelegatedRun, type ReviewFinding, type ReviewRound } from "@shiba/shared";

function pending(patch: Partial<DelegatedRun> = {}): DelegatedRun {
  return {
    ...createRun({
      runId: "run-1",
      sandboxId: "sb-1",
      repoUrl: "https://github.com/o/r",
      task: "fix",
      baseBranch: "main",
      publishPullRequest: false,
    }),
    ...patch,
  };
}

function finding(severity: ReviewFinding["severity"]): ReviewFinding {
  return {
    id: "f1",
    path: "a.ts",
    line: 1,
    category: "bug",
    severity,
    confidence: "confirmed",
    title: "n",
    failureScenario: "breaks the build",
    triage: "open",
  };
}

function round(patch: Partial<ReviewRound> = {}): ReviewRound {
  return {
    roundId: "run-1:abc",
    codingRunId: "run-1",
    reviewRunId: "rev-1",
    pull: { owner: "o", repo: "r", number: 1, headSha: "a".repeat(40), url: "https://github.com/o/r/pull/1" },
    status: "failed",
    findings: [],
    summary: "",
    generation: 0,
    ...patch,
  };
}

describe("restartDisposition", () => {
  it("resumes only a pre-sandbox checkpoint that has not been retried", () => {
    expect(restartDisposition(pending({ checkpoint: "queued" }))).toBe("resume");
    expect(restartDisposition(pending({ checkpoint: "dispatching" }))).toBe("resume");
    expect(restartDisposition(pending())).toBe("unknown");
    expect(restartDisposition(pending({ checkpoint: "executing" }))).toBe("unknown");
    expect(restartDisposition(pending({ checkpoint: "settling" }))).toBe("unknown");
    expect(restartDisposition(pending({ status: "running", checkpoint: "dispatching" }))).toBe("resume");
    expect(restartDisposition(pending({ checkpoint: "dispatching", resumeAttemptedAt: 1 }))).toBe("unknown");
    expect(restartDisposition(pending({ checkpoint: "dispatching", pullUrl: "https://github.com/o/r/pull/1" }))).toBe("unknown");
    expect(
      restartDisposition(pending({ checkpoint: "dispatching", signals: [{ kind: "sandbox.ready", at: 1 }] })),
    ).toBe("unknown");
    expect(restartDisposition(pending({ status: "completed", checkpoint: "dispatching" }))).toBe("unknown");
  });
});

describe("public run errors", () => {
  it("hides stacks and raw executor text when an error code is set", () => {
    const raw = "secret-token\n    at execute (runtime.ts:1:1)";
    expect(stripStack(raw)).toBe("secret-token");
    expect(publicRunMessage({ errorCode: "internal_error", error: raw })).toBe(runErrorWire("internal_error").userMessage);
    expect(publicRunMessage({ errorCode: "internal_error", error: raw })).not.toContain("secret-token");
    expect(publicRunMessage({ error: "    at onlyStack (x.js:1:1)" })).toBe(
      "Something went wrong. The run log has the error code.",
    );
  });

  it("surfaces timeouts without relabeling an unknown outcome", () => {
    expect(runTimedOut({ errorCode: "timeout_scope" })).toBe(true);
    expect(runTimedOut({ errorCode: "request_timeout" })).toBe(true);
    expect(runTimedOut({ error: "GitHub API request timed out (status 408)" })).toBe(true);
    expect(runTimedOut({ errorCode: "outcome_unknown", error: "side effects are unverified" })).toBe(false);
  });
});

describe("fetchWithBackoff", () => {
  it("retries a GET 503 and does not retry a POST 500", async () => {
    let gets = 0;
    const get = await fetchWithBackoff("https://example.test/list", { method: "GET" }, {
      attempts: 3,
      baseDelayMs: 0,
      fetchImpl: async () => new Response("no", { status: ++gets < 3 ? 503 : 200 }),
    });
    expect(get.status).toBe(200);
    expect(gets).toBe(3);

    let posts = 0;
    const post = await fetchWithBackoff("https://example.test/reviews", { method: "POST" }, {
      attempts: 3,
      baseDelayMs: 0,
      fetchImpl: async () => {
        posts += 1;
        return new Response("no", { status: 500 });
      },
    });
    expect(post.status).toBe(500);
    expect(posts).toBe(1);
  });

  it("retries POST 503, refuses an abort, and names a timeout", async () => {
    let posts = 0;
    const post = await fetchWithBackoff("https://example.test/reviews", { method: "POST" }, {
      attempts: 2,
      baseDelayMs: 0,
      fetchImpl: async () => new Response("later", { status: ++posts === 1 ? 503 : 201 }),
    });
    expect(post.status).toBe(201);

    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    await expect(
      fetchWithBackoff("https://example.test", { method: "GET" }, { fetchImpl, signal: controller.signal, attempts: 3 }),
    ).rejects.toMatchObject({ name: "AbortError", message: "Run cancelled." });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      fetchWithBackoff("https://example.test", { method: "GET" }, {
        attempts: 1,
        fetchImpl: async () => {
          const error = new Error("The operation was aborted due to timeout");
          error.name = "TimeoutError";
          throw error;
        },
      }),
    ).rejects.toThrow(/request timed out \(status 408\)/);
    expect(backoffDelayMs(1, 0, 0)).toBe(0);
  });
});

describe("review retry plan", () => {
  it("reposts only a finished review whose GitHub post failed", () => {
    expect(reviewRetryPlan(round({ status: "posted", summary: "done" }), { status: "completed" })).toBe("noop");
    expect(reviewRetryPlan(round({ summary: "done" }), { status: "completed" })).toBe("repost");
    expect(reviewRetryPlan(round({ findings: [finding("low")] }), { status: "completed" })).toBe("repost");
    expect(reviewRetryPlan(round(), { status: "error" })).toBe("rerun");
    expect(reviewRetryPlan(round({ summary: "done" }), { status: "error" })).toBe("rerun");
    expect(reviewRetryPlan(round({ status: "queued" }), null)).toBe("rerun");
  });

  it("queues auto-merge only for a clean posted round", () => {
    const posted = round({ status: "posted", summary: "clean" });
    expect(shouldQueueAutoMerge({ enabled: true, autoMerge: true }, posted)).toBe(true);
    expect(shouldQueueAutoMerge({ enabled: true, autoMerge: false }, posted)).toBe(false);
    expect(shouldQueueAutoMerge({ enabled: false, autoMerge: true }, posted)).toBe(false);
    expect(
      shouldQueueAutoMerge(
        { enabled: true, autoMerge: true },
        round({ status: "posted", findings: [finding("high")] }),
      ),
    ).toBe(false);
  });
});

describe("structured logs", () => {
  it("writes one JSON line with run and thread ids", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logStructured("info", {
      event: "run.settled",
      runId: "run-1",
      threadId: "thread-1",
      usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.01 },
    });
    const line = String(spy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as { service: string; runId: string; threadId: string; usage: { costUsd: number } };
    expect(parsed.service).toBe("shiba");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.threadId).toBe("thread-1");
    expect(parsed.usage.costUsd).toBe(0.01);
    spy.mockRestore();
  });
});

function mockAudit(): D1Database {
  const settings = new Map<string, Record<string, unknown>>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    async run() {
      if (sql.includes("INSERT INTO org_sandbox_settings")) {
        settings.set(String(args[0]), { provider_id: args[1] });
      }
      return { success: true };
    },
    async first() {
      return settings.get(String(args[0])) ?? null;
    },
  });
  return {
    prepare(sql: string) {
      return { ...stmt(sql), bind(...args: unknown[]) { return stmt(sql, args); } };
    },
  } as unknown as D1Database;
}

describe("setup fixes", () => {
  it("returns a next command for guides and persists a provider when D1 exists", async () => {
    const guide = await applySetupFix({} as Env, "guide.github");
    expect(guide.status).toBe(200);
    expect(guide.body.applied).toBe(false);
    expect(guide.body.command).toContain("pnpm shiba setup");

    const missing = await applySetupFix({} as Env, "sandbox.use-cloudflare");
    expect(missing.status).toBe(200);
    expect(missing.body.applied).toBe(false);
    expect(missing.body.userMessage).toContain("SHIBA_SANDBOX_PROVIDER=cloudflare");

    const stored = await applySetupFix({ AGENT_AUDIT: mockAudit() } as Env, "sandbox.use-e2b");
    expect(stored.body.applied).toBe(true);
    expect(stored.body.providerId).toBe("e2b");

    const unknown = await applySetupFix({} as Env, "nope");
    expect(unknown.status).toBe(400);

    const wizard = setupWizardCatalog();
    expect(wizard.steps.map((step) => step.id)).toEqual(["github", "model", "sandbox", "testRepo"]);
    const withFix = attachDoctorFixes([{ id: "github.credentials", severity: "warn" }]);
    expect(withFix[0]?.fixAction?.id).toBe("guide.github");
  });
});
