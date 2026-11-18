import { describe, expect, it } from "vitest";
import { usageBudgetPolicySchema, type DelegatedRun } from "@shiba/shared";
import { createRun } from "../src/runs.js";
import { INSTANCE_TYPES } from "../src/instance-type.js";
import { meterSandboxRun, SANDBOX_RESOURCES, SANDBOX_PRICING_VERSION } from "../src/sandbox-metering.js";
import { canStart, evaluateUsageBudget, runOverLimit } from "../src/usage-budget.js";
import { buildUsageReport, defaultUsageBudgetPolicy } from "../src/usage.js";

const now = Date.UTC(2026, 10, 2, 0, 0, 1);
const policy = defaultUsageBudgetPolicy({});
const run = (patch: Partial<DelegatedRun> = {}): DelegatedRun => ({
  ...createRun({ runId: "cost-run", sandboxId: "cost-sandbox", repoUrl: "https://github.com/o/r", task: "fix", baseBranch: "main", publishPullRequest: false, now: now - 2000 }),
  status: "running", signals: [{ kind: "sandbox.ready", at: now - 2000 }], ...patch,
});

describe("sandbox estimates", () => {
  it.each(INSTANCE_TYPES)("uses the published provisioned resources for %s", (instance) => {
    const sizes = { lite: [1 / 16, .25, 2], basic: [.25, 1, 4], "standard-1": [.5, 4, 8], "standard-2": [1, 6, 12], "standard-3": [2, 8, 16], "standard-4": [4, 12, 20] };
    const [cpu, ram, disk] = sizes[instance] as [number, number, number];
    expect(SANDBOX_RESOURCES[instance]).toEqual({ cpu, ram, disk });
    const estimate = meterSandboxRun(run(), now, instance);
    expect(estimate).toMatchObject({ status: "estimated", cpuSeconds: cpu * 2, ramGbSeconds: ram * 2, diskGbSeconds: disk * 2,
      provenance: { source: "instance-type-rates", instanceType: instance, pricingVersion: SANDBOX_PRICING_VERSION, startedAt: now - 2000, endedAt: now } });
    expect(estimate.costUsd).toBeCloseTo(2 * (cpu * .000020 + ram * .0000025 + disk * .00000007), 12);
  });

  it("distinguishes no sandbox, local execution, and old terminal records", () => {
    expect(meterSandboxRun(run({ signals: [] }), now).status).toBe("not_started");
    expect(meterSandboxRun(run({ runtime: "local" }), now).status).toBe("not_applicable");
    expect(meterSandboxRun(run({ status: "completed" }), now).status).toBe("unavailable");
    expect(meterSandboxRun(run({ status: "error", signals: [] }), now, "lite", true).status).toBe("not_started");
    expect(meterSandboxRun(run(), now - 5000).costUsd).toBe(0);
  });

  it("freezes terminal usage independently of subsequent stamps and pricing", () => {
    const terminal = run({ status: "completed", updatedAt: now });
    const frozen = meterSandboxRun(terminal, now, "basic", true);
    expect(meterSandboxRun({ ...terminal, sandboxMeter: frozen, updatedAt: now + 100000 }, now + 100000, "standard-4")).toEqual(frozen);
  });
});

describe("budget policy and decisions", () => {
  it("validates strict non-negative finite limits and the action", () => {
    expect(usageBudgetPolicySchema.parse(policy)).toEqual(policy);
    expect(defaultUsageBudgetPolicy({ USAGE_BUDGET_USD: "5" })).toMatchObject({ dailyLimitUsd: 5, monthlyLimitUsd: null, perRunLimitUsd: null, onExceed: "ask" });
    for (const patch of [{ dailyLimitUsd: -1 }, { monthlyLimitUsd: Infinity }, { perRunLimitUsd: NaN }, { onExceed: "ignore" }, { extra: 1 }, { updatedBy: "" }]) {
      expect(usageBudgetPolicySchema.safeParse({ ...policy, ...patch }).success).toBe(false);
    }
  });

  it("allows empty unlimited history, and blocks zero limits at equality", () => {
    expect(canStart(policy, [], now)).toEqual({ allowed: true, blockedPeriods: [] });
    expect(canStart({ ...policy, dailyLimitUsd: 0, monthlyLimitUsd: 0 }, [], now)).toEqual({ allowed: false, blockedPeriods: ["daily", "monthly"] });
  });

  it("counts live usage and splits compute across UTC boundaries", () => {
    const active = run({ usage: { costUsd: 1 } });
    const budget = evaluateUsageBudget({ ...policy, dailyLimitUsd: 1, monthlyLimitUsd: 1 }, [active], now);
    expect(budget.today.llmUsd).toBe(1);
    expect(budget.today.computeUsd).toBeCloseTo(meterSandboxRun(active, now).costUsd / 2, 12);
    expect(budget.month.computeUsd).toBeCloseTo(meterSandboxRun(active, now).costUsd, 12);
    expect(budget.blockedPeriods).toEqual(["daily", "monthly"]);
    expect(budget.today.remainingUsd).toBe(0);
    const daily = buildUsageReport([active], {}, { now, days: 2 });
    expect(daily.days).toHaveLength(2);
    expect(daily.days[0]?.computeCpuSeconds).toBe(.5);
    expect(daily.days[1]?.computeCpuSeconds).toBe(.5);
  });

  it("excludes prior months, honors UTC month resets, and uses frozen end time", () => {
    const old = run({ status: "completed", usage: { costUsd: 50 }, updatedAt: Date.UTC(2026, 9, 31) });
    const budget = evaluateUsageBudget(policy, [old], now);
    expect(budget.month.totalUsd).toBe(0);
    expect(budget.month.resetsAt).toBe(Date.UTC(2026, 11, 1));
    const frozen = meterSandboxRun(run({ status: "completed", updatedAt: now }), now, "basic", true);
    const terminal = run({ status: "completed", sandboxMeter: frozen, usage: { costUsd: 1 }, updatedAt: now + 86_400_000 });
    expect(evaluateUsageBudget(policy, [terminal], now).today.llmUsd).toBe(1);
  });

  it("only exceeds per-run limits strictly above them, including compute", () => {
    const local = run({ runtime: "local", usage: { costUsd: 1 } });
    expect(runOverLimit(policy, local, now)).toBe(false);
    expect(runOverLimit({ ...policy, perRunLimitUsd: 1 }, local, now)).toBe(false);
    expect(runOverLimit({ ...policy, perRunLimitUsd: 1 }, run({ usage: { costUsd: 1 } }), now)).toBe(true);
  });
});
