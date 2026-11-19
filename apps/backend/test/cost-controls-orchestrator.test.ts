import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun, PendingApproval } from "@shiba/shared";

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

  it("persists a zero-limit policy on a fresh orchestrator with no prior state", async () => {
    const instance = host();
    instance.state = undefined as unknown as OrchestratorState;
    const policy = { ...defaultUsageBudgetPolicy({}), dailyLimitUsd: 0, monthlyLimitUsd: 0, perRunLimitUsd: 0,
      onExceed: "stop" as const, updatedBy: "owner@example.test", updatedAt: 1000 };
    const response = await instance.onRequest(new Request("https://internal/api/usage/budget", {
      method: "PUT", body: JSON.stringify(policy),
    }));
    expect(response.status).toBe(200);
    expect(instance.state?.usageBudgetPolicy).toEqual(policy);
    expect(instance.state?.runs).toEqual([]);
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
    expect(run.errorCode).toBe("budget_exceeded");
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
  it("meters an executing run before the sandbox.ready signal lands", async () => {
    const live = running("live", { signals: undefined, checkpoint: "executing" });
    const instance = budgetHost({ dailyLimitUsd: null, monthlyLimitUsd: null, perRunLimitUsd: 0.00001, onExceed: "stop" }, [live]);
    await (instance as unknown as { enforceUsageBudget(now: number): Promise<void> }).enforceUsageBudget(10_000);
    expect(instance.state.runs[0]!.status).toBe("cancelled");
    expect(instance.state.runs[0]!.errorCode).toBe("budget_exceeded");
  });

  it("fences the generation when a run is held so the aborted execution cannot terminalize it", async () => {
    const live = running("held", { signals: undefined, checkpoint: "executing" });
    const instance = budgetHost({ dailyLimitUsd: null, monthlyLimitUsd: null, perRunLimitUsd: 0.00001, onExceed: "ask" }, [live]);
    const before = instance.state.runs[0]!.generation;
    await (instance as unknown as { holdRunForBudget(run: DelegatedRun, blockedPeriods: ("daily" | "monthly" | "run")[], now: number): Promise<void> })
      .holdRunForBudget(instance.state.runs[0]!, ["run"], 10_000);
    const after = instance.state.runs[0]!;
    expect(after.status).toBe("pending");
    expect(after.budgetHold?.blockedPeriods).toContain("run");
    expect(after.generation).toBe(before + 1);
  });

  it("stops a held run when its budget override has expired", async () => {
    const held = running("expired", {
      status: "pending",
      checkpoint: "dispatching",
      signals: undefined,
      budgetHold: { approvalId: "budget-override:expired:1", blockedPeriods: ["run"], at: 1000 },
    });
    const approval = {
      threadKey: "owner@example.test",
      approvalId: "budget-override:expired:1",
      repoUrl: "https://github.com/o/r",
      task: "fix",
      kind: "budget_override",
      budgetHoldRunId: "expired",
      status: "pending",
      createdAt: 1000,
    } as PendingApproval;
    const instance = budgetHost({ dailyLimitUsd: null, monthlyLimitUsd: null, perRunLimitUsd: null, onExceed: "ask" }, [held]);
    instance.state.pendingApprovals = [approval];
    await (instance as unknown as { enforceUsageBudget(now: number): Promise<void> })
      .enforceUsageBudget(1000 + 31 * 60 * 1000);
    expect(instance.state.runs[0]!.status).toBe("cancelled");
    expect(instance.state.runs[0]!.budgetHold).toBeUndefined();
  });

  it("redispatches an approved override under the held run's original tool call id", async () => {
    const approval = {
      approvalId: "orig",
      decidedBy: "owner@example.test",
      decidedAt: 1,
      inputHash: "hash",
    } as NonNullable<DelegatedRun["approval"]>;
    const held = {
      ...running("agent-tool:orig", { status: "pending", checkpoint: "dispatching", signals: undefined }),
      approval,
      budgetHold: { approvalId: "budget-override:orig:1", blockedPeriods: ["run"], at: 1 },
    };
    const override = {
      threadKey: "owner@example.test",
      approvalId: "budget-override:orig:1",
      repoUrl: "https://github.com/o/r",
      task: "fix",
      kind: "budget_override",
      budgetHoldRunId: "agent-tool:orig",
      status: "approved",
      createdAt: 1,
      decidedBy: "owner@example.test",
      decidedAt: 2,
    } as PendingApproval;
    const execute = vi.fn(async (_input: unknown, _options?: { toolCallId?: string }) => "ok");
    const instance = host({ runs: [held], pendingApprovals: [override] } as OrchestratorState);
    const internals = instance as unknown as {
      dispatchApprovedRun(run: DelegatedRun, record: PendingApproval | undefined, approvalId: string): void;
      approvedRunDelegate(): { execute: typeof execute };
      gateRunOnUsageBudget(run: DelegatedRun, record: PendingApproval | undefined): Promise<boolean>;
      keepAliveWhile(work: () => Promise<void>): Promise<void>;
    };
    internals.gateRunOnUsageBudget = async () => false;
    internals.approvedRunDelegate = () => ({ execute });
    internals.keepAliveWhile = (work) => work();
    internals.dispatchApprovedRun(instance.state.runs[0]!, override, override.approvalId);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]?.[1]).toEqual({ toolCallId: "orig" });
  });

});

describe("orchestrator credit ledger", () => {
  /** The minimum D1 surface the credit path touches, so a sweep can be observed. */
  function creditDb(initial: { creditedMicroUsd?: number; failFirstReads?: number } = {}) {
    const state = { debits: new Map<string, number>(), creditedMicroUsd: initial.creditedMicroUsd ?? 0, failures: initial.failFirstReads ?? 0 };
    const submit = (sql: string, params: unknown[]) => {
      if (sql.includes("INSERT OR IGNORE INTO workspace_billing_accounts")) return { changes: 0 };
      if (sql.includes("INSERT OR IGNORE INTO workspace_billing_debits")) {
        const [entryId, subject, runId, amount] = params as [string, string, string, number];
        if (state.debits.has(entryId)) return { changes: 0 };
        state.debits.set(entryId, amount);
        void subject; void runId;
        return { changes: 1 };
      }
      return { changes: 0 };
    };
    const first = (sql: string, params: unknown[]) => {
      if (sql.includes("kind='refund') AS total")) return { total: state.creditedMicroUsd };
      if (sql.includes("FROM workspace_billing_debits WHERE subject=? AND kind='run'")) return { total: [...state.debits.values()].reduce((sum, value) => sum + value, 0) };
      if (sql.includes("FROM workspace_billing_accounts")) return { owner: String(params[0]), stripe_customer_id: null, created_at: 0 };
      return null;
    };
    const db = {
      state,
      prepare: (sql: string) => {
        const bound: unknown[] = [];
        const call = {
          bind: (...params: unknown[]) => { bound.push(...params); return call; },
          run: async () => {
            if (state.failures > 0) { state.failures -= 1; throw new Error("D1 transient"); }
            return { meta: submit(sql, bound) };
          },
          first: async () => {
            if (state.failures > 0) { state.failures -= 1; throw new Error("D1 transient"); }
            return first(sql, bound);
          },
          all: async () => {
            if (state.failures > 0) { state.failures -= 1; throw new Error("D1 transient"); }
            if (sql.includes("SELECT run_id FROM workspace_billing_debits")) return { results: [] };
            return { results: [] };
          },
        };
        return call;
      },
    };
    return db;
  }
  function ledgerHost(runs: DelegatedRun[], db: ReturnType<typeof creditDb>) {
    const instance = host({ runs });
    instance.env = { INSTANCE_TYPE: "basic", STRIPE_SECRET_KEY: "sk_test_1", STRIPE_WEBHOOK_SECRET: "whsec_1", AGENT_AUDIT: db } as unknown as typeof instance.env;
    return instance as unknown as {
      state: OrchestratorState;
      env: Record<string, unknown>;
      enforceUsageBudget(now: number): Promise<void>;
      settleCreditDebits(now: number): Promise<void>;
      gateRunOnUsageBudget(run: DelegatedRun, record: unknown): Promise<boolean>;
    };
  }
  const settled = (runId: string, costUsd: number, extra: Partial<DelegatedRun> = {}): DelegatedRun => ({
    ...createRun({ runId, sandboxId: "s-" + runId, repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false, now: 1000 }),
    status: "completed", queuedBy: "owner@example.test", usage: { costUsd }, ...extra,
  });

  it("debits a settled run once, so a repeated sweep cannot bill it twice", async () => {
    const db = creditDb({ creditedMicroUsd: 5_000_000 });
    const instance = ledgerHost([settled("r1", 2)], db);
    await instance.settleCreditDebits(10_000);
    expect([...db.state.debits.values()]).toEqual([2_000_000]);
    await instance.settleCreditDebits(11_000);
    expect(db.state.debits.size).toBe(1);
  });

  it("stops refusing work once the ledger proves the balance is spent", async () => {
    const db = creditDb({ creditedMicroUsd: 0 });
    const running: DelegatedRun = { ...settled("r2", 0), status: "running" };
    const instance = ledgerHost([running], db);
    await instance.enforceUsageBudget(10_000);
    expect(instance.state.runs[0]).toMatchObject({ status: "cancelled", errorCode: "budget_exceeded" });
  });

  it("refuses a new dispatch but leaves running work alone when the ledger read fails", async () => {
    // Two failed reads for the gate, then one for the sweep: both retried once, then unavailable.
    const db = creditDb({ creditedMicroUsd: 5_000_000, failFirstReads: 2 });
    const queuedRun: DelegatedRun = { ...settled("r3", 0), status: "pending" };
    const running: DelegatedRun = { ...settled("r4", 0), status: "running" };
    const instance = ledgerHost([queuedRun, running], db);
    expect(await instance.gateRunOnUsageBudget(queuedRun, undefined)).toBe(true);
    expect(instance.state.runs.find((run) => run.runId === "r3")).toMatchObject({ status: "cancelled" });
    db.state.failures = 2;
    await instance.enforceUsageBudget(10_000);
    expect(instance.state.runs.find((run) => run.runId === "r4")?.status).toBe("running");
  });

  it("exempts plan and paired-computer runs only when the switch is off", async () => {
    const db = creditDb({ creditedMicroUsd: 0 });
    const subscription: DelegatedRun = { ...settled("r5", 0), status: "pending", authAccount: "plan" };
    const strict = ledgerHost([subscription], db);
    expect(await strict.gateRunOnUsageBudget(subscription, undefined)).toBe(true);
    const lenient = ledgerHost([subscription], creditDb({ creditedMicroUsd: 0 }));
    lenient.env = { ...lenient.env, SHIBA_CREDITS_GATE_USER_FUNDED_RUNS: "0" } as typeof lenient.env;
    expect(await lenient.gateRunOnUsageBudget(subscription, undefined)).toBe(false);
    expect(lenient.state.runs[0]?.status).toBe("pending");
  });

  it("bills a team run to its workspace, not to the person running it", async () => {
    const db = creditDb({ creditedMicroUsd: 0 });
    const team = settled("r6", 1, { orgId: "team:ws_0123456789abcdef01234567" });
    const instance = ledgerHost([team], db);
    await instance.settleCreditDebits(10_000);
    const entries = [...db.state.debits.keys()];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("team:ws_0123456789abcdef01234567");
  });
});

