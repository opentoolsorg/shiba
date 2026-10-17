import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";

vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import { CodingOrchestrator } from "../src/agents/orchestrator.js";

const run: DelegatedRun = {
  runId: "run-1", sandboxId: "sb-1", repoUrl: "https://github.com/o/r", task: "fix",
  baseBranch: "main", publishPullRequest: false, generation: 1, status: "completed",
  createdAt: 1, updatedAt: 2, diff: "+".repeat(20_000),
  receipts: [{ kind: "submit", message: "ok", at: 2 }],
  signals: [{ kind: "harness.idle", at: 2 }],
};

function host(runs: DelegatedRun[]): CodingOrchestrator {
  return Object.assign(Object.create(CodingOrchestrator.prototype), {
    state: { runs }, env: {}, reclaimRunsForRead: async () => {},
  });
}

describe("opt-in lean run listing", () => {
  it("preserves default list and individual detail contracts", async () => {
    const agent = host([run]);
    expect(await (await agent.onRequest(new Request("https://internal/api/runs"))).json()).toEqual({ runs: [run] });
    expect(await (await agent.onRequest(new Request("https://internal/api/runs/run-1?view=summary"))).json()).toEqual({ run });
  });

  it("omits heavy details only for summary lists without mutating persisted rows", async () => {
    const agent = host([run]);
    const response = await agent.onRequest(new Request("https://internal/api/runs?view=summary"));
    const body = await response.json() as { runs: Array<DelegatedRun & { hasDiff: boolean }> };
    expect(body.runs[0]).toMatchObject({ runId: run.runId, status: run.status, hasDiff: true });
    expect(body.runs[0]).not.toHaveProperty("diff");
    expect(body.runs[0]).not.toHaveProperty("receipts");
    expect(body.runs[0]).not.toHaveProperty("signals");
    expect(JSON.stringify(body).length).toBeLessThan(JSON.stringify(run).length / 10);
    expect(agent.state.runs[0]).toBe(run);
    expect(run.diff).toHaveLength(20_000);
  });

  it("applies principal scope and newest-first limit before summary projection", async () => {
    const agent = host([
      { ...run, runId: "mine-old", queuedBy: "alpha" },
      { ...run, runId: "theirs", queuedBy: "beta" },
      { ...run, runId: "mine-new", queuedBy: "alpha", diff: undefined },
    ]);
    const response = await agent.onRequest(new Request("https://internal/api/runs?view=summary&limit=1", {
      headers: { "X-Agent-Principal": "alpha" },
    }));
    expect(await response.json()).toMatchObject({ runs: [{ runId: "mine-new", hasDiff: false }] });
    const body = await (await agent.onRequest(new Request("https://internal/api/runs?view=summary&limit=0"))).json();
    expect(body).toMatchObject({ error: "limit must be a positive integer." });
  });
});

describe("approval diff indexing compatibility", () => {
  it("keeps thread identity and first-match behavior for duplicate legacy pointers", () => {
    const pending = {
      threadKey: "a", approvalId: "same", repoUrl: run.repoUrl, task: run.task,
      status: "pending" as const, createdAt: 1,
    };
    const agent = host([]);
    Object.assign(agent, { state: { runs: [], pendingApprovals: [pending, { ...pending, status: "approved" }, { ...pending, threadKey: "b", status: "approved" }] } });
    const next = { runs: [], pendingApprovals: [{ ...pending, status: "approved" as const, decidedAt: 2 }, { ...pending, threadKey: "b", status: "approved" as const }] };
    const internals = agent as unknown as { applySpine(next: typeof agent.state): void };
    internals.applySpine(next);
    const events = (next as typeof agent.state).events ?? [];
    expect(events.filter((event) => event.kind === "approval.answered")).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "approval.answered", approvalId: "same", payload: { result: "approved" } });
  });
});
