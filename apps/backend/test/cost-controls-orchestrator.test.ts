import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun } from "@shiba/shared";

vi.mock("@cloudflare/think", () => ({ Think: class {
  setState(next: unknown) { Object.assign(this, { state: next }); }
} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

import { CodingOrchestrator, type OrchestratorState } from "../src/agents/orchestrator.js";
import { createRun } from "../src/runs.js";
import { defaultUsageBudgetPolicy } from "../src/usage.js";

function host(state: OrchestratorState = { runs: [] }) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    state, env: { INSTANCE_TYPE: "basic", USAGE_BUDGET_USD: "5" }, name: "owner@example.test",
  });
}

describe("orchestrator cost policy persistence", () => {
  it("stamps only the first terminal transition and preserves it through later writes", () => {
    const run: DelegatedRun = { ...createRun({ runId: "r", sandboxId: "s", repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false, now: 1000 }),
      status: "running", signals: [{ kind: "sandbox.ready", at: 1000 }] };
    const instance = host({ runs: [run] });
    instance.setState({ runs: [{ ...run, status: "completed", updatedAt: 2000 }] });
    const frozen = instance.state.runs[0]?.sandboxMeter;
    expect(frozen).toMatchObject({ status: "estimated", cpuSeconds: .25, ramGbSeconds: 1, diskGbSeconds: 4,
      provenance: { instanceType: "basic", startedAt: 1000, endedAt: 2000 } });
    instance.setState({ runs: [{ ...instance.state.runs[0]!, updatedAt: 9000, sandboxMeter: undefined }] });
    expect(instance.state.runs[0]?.sandboxMeter).toEqual(frozen);
    const legacy = host({ runs: [{ ...run, status: "completed" }] });
    legacy.setState({ runs: [{ ...run, status: "completed", updatedAt: 9000 }] });
    expect(legacy.state.runs[0]?.sandboxMeter).toBeUndefined();
  });

  it("persists a validated policy in DO state and survives a new host", async () => {
    const instance = host();
    const read = () => new Request("https://internal/api/usage/budget");
    expect(await (await instance.onRequest(read())).json()).toMatchObject({ policy: { dailyLimitUsd: 5 } });
    const policy = { ...defaultUsageBudgetPolicy({}), dailyLimitUsd: 2, onExceed: "stop" as const, updatedBy: "owner@example.test", updatedAt: 1000 };
    const put = (body: unknown) => new Request("https://internal/api/usage/budget", { method: "PUT", body: JSON.stringify(body) });
    expect((await instance.onRequest(put({ ...policy, monthlyLimitUsd: -1 }))).status).toBe(400);
    expect((await instance.onRequest(put(policy))).status).toBe(200);
    expect(instance.state.usageBudgetPolicy).toEqual(policy);
    expect(await (await host(structuredClone(instance.state)).onRequest(read())).json()).toEqual({ policy });
    expect((await instance.onRequest(new Request(read(), { method: "POST" }))).status).toBe(405);
    expect((await instance.onRequest(new Request(read(), { headers: { "X-Agent-Principal": "agent" } }))).status).toBe(403);
  });
});

describe("orchestrator budget enforcement", () => {
  function budgetHost(
    policy: Parameters<typeof defaultUsageBudgetPolicy>[0] extends object ? Partial<ReturnType<typeof defaultUsageBudgetPolicy>> : never,
    runs: DelegatedRun[],
  ) {
    const instance = host({
      runs,
      usageBudgetPolicy: { ...defaultUsageBudgetPolicy({}), ...policy, updatedAt: 1, updatedBy: "owner@example.test" },
    } as OrchestratorState);
    return instance;
  }

  function running(runId: string, extra: Partial<DelegatedRun> = {}): DelegatedRun {
    return {
      ...createRun({ runId, sandboxId: `s-${runId}`, repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false, now: 1000 }),
      status: "running",
      signals: [{ kind: "sandbox.ready", at: 1000 }],
      ...extra,
    };
  }

  it("stops an active run when the per-run limit is crossed (onExceed=stop)", async () => {
    const instance = budgetHost({ dailyLimitUsd: null, monthlyLimitUsd: null, perRunLimitUsd: 0.00001, onExceed: "stop" }, [running("r1")]);
    await (instance as unknown as { enforceUsageBudget(now: number): Promise<void> }).enforceUsageBudget(10_000);
    const run = instance.state.runs[0]!;
    expect(run.status).toBe("cancelled");
    expect(run.error?.code ?? run.errorCode).toBe("budget_exceeded");
  });

  it("holds an active run behind a budget_override approval (onExceed=ask)", async () => {
    const instance = budgetHost({ dailyLimitUsd: null, monthlyLimitUsd: null, perRunLimitUsd: 0.00001, onExceed: "ask" }, [running("r1")]);
    await (instance as unknown as { enforceUsageBudget(now: number): Promise<void> }).enforceUsageBudget(10_000);
    const run = instance.state.runs[0]!;
    expect(run.status).toBe("pending");
    expect(run.budgetHold?.blockedPeriods).toContain("run");
    const override = instance.state.pendingApprovals?.find((approval) => approval.kind === "budget_override");
    expect(override?.budgetHoldRunId).toBe("r1");
    expect(override?.status).toBe("pending");
  });

  it("does not mint a second approval while a hold is already pending", async () => {
    const instance = budgetHost({ perRunLimitUsd: 0.00001, onExceed: "ask" }, [running("r1")]);
    const enforce = instance as unknown as { enforceUsageBudget(now: number): Promise<void> };
    await enforce.enforceUsageBudget(10_000);
    await enforce.enforceUsageBudget(11_000);
    expect(instance.state.pendingApprovals?.filter((approval) => approval.kind === "budget_override")).toHaveLength(1);
  });

  it("an approved override releases the held run on the next gate", async () => {
    const instance = budgetHost({ perRunLimitUsd: 0.00001, onExceed: "ask" }, [running("r1")]);
    const internals = instance as unknown as {
      enforceUsageBudget(now: number): Promise<void>;
      gateRunOnUsageBudget(run: DelegatedRun, record: unknown): Promise<boolean>;
    };
    await internals.enforceUsageBudget(10_000);
    const override = instance.state.pendingApprovals!.find((approval) => approval.kind === "budget_override")!;
    instance.state.pendingApprovals = [{ ...override, status: "approved" as const }];
    const held = instance.state.runs[0]!;
    expect(await internals.gateRunOnUsageBudget(held, { ...override, status: "approved" })).toBe(false);
    expect(instance.state.runs[0]!.budgetHold).toBeUndefined();
  });

  it("stops the held run when the budget override is denied", async () => {
    const instance = budgetHost({ perRunLimitUsd: 0.00001, onExceed: "ask" }, [running("r1")]);
    const internals = instance as unknown as {
      enforceUsageBudget(now: number): Promise<void>;
      stopRunForBudget(run: DelegatedRun): Promise<void>;
    };
    await internals.enforceUsageBudget(10_000);
    const held = instance.state.runs[0]!;
    await internals.stopRunForBudget(held);
    expect(instance.state.runs[0]!.status).toBe("cancelled");
    expect(instance.state.runs[0]!.budgetHold).toBeUndefined();
  });

  it("blocks a fresh dispatch while the daily limit is reached (onExceed=stop)", async () => {
    const big = running("old", { usage: { costUsd: 10 } });
    const fresh = running("new");
    const instance = budgetHost({ dailyLimitUsd: 1, onExceed: "stop" }, [big, fresh]);
    const blocked = await (instance as unknown as {
      gateRunOnUsageBudget(run: DelegatedRun, record: unknown): Promise<boolean>;
    }).gateRunOnUsageBudget(fresh, undefined);
    expect(blocked).toBe(true);
    expect(instance.state.runs.find((run) => run.runId === "new")!.status).toBe("cancelled");
  });
});
