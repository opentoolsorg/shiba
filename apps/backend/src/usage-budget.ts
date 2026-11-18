import { isActiveStatus, type DelegatedRun, type SandboxMeter, type UsageBudgetPolicy } from "@shiba/shared";
import { meterSandboxRun } from "./sandbox-metering.js";

export type BudgetMeter = (run: DelegatedRun, now: number) => SandboxMeter;

export function computePeriodFraction(meter: SandboxMeter, start: number, end: number): number {
  const from = meter.provenance?.startedAt;
  const to = meter.provenance?.endedAt;
  if (from == null || to == null || to <= from) return 0;
  return Math.max(0, Math.min(to, end) - Math.max(from, start)) / (to - from);
}

export function evaluateUsageBudget(policy: UsageBudgetPolicy, runs: DelegatedRun[], now: number, meter: BudgetMeter = meterSandboxRun) {
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const spend = (start: number, end: number, limitUsd: number | null) => {
    let llmUsd = 0;
    let computeUsd = 0;
    for (const run of runs) {
      const stamp = isActiveStatus(run.status) ? now : (run.sandboxMeter?.provenance?.endedAt ?? run.updatedAt);
      if (stamp >= start && stamp < end) llmUsd += run.usage?.costUsd ?? 0;
      const estimate = meter(run, now);
      computeUsd += estimate.costUsd * computePeriodFraction(estimate, start, end);
    }
    const totalUsd = llmUsd + computeUsd;
    return { llmUsd, computeUsd, totalUsd, limitUsd, remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - totalUsd),
      reached: limitUsd !== null && totalUsd >= limitUsd, startsAt: start, resetsAt: end };
  };
  const today = spend(dayStart, dayStart + 86_400_000, policy.dailyLimitUsd);
  const month = spend(monthStart, monthEnd, policy.monthlyLimitUsd);
  const blockedPeriods = [ ...(today.reached ? ["daily" as const] : []), ...(month.reached ? ["monthly" as const] : []) ];
  return { policy, today, month, blocked: blockedPeriods.length > 0, blockedPeriods };
}

export function canStart(policy: UsageBudgetPolicy, runs: DelegatedRun[], now: number, meter?: BudgetMeter) {
  const budget = evaluateUsageBudget(policy, runs, now, meter);
  return { allowed: !budget.blocked, blockedPeriods: budget.blockedPeriods };
}

export function runOverLimit(policy: UsageBudgetPolicy, run: DelegatedRun, now: number, meter: BudgetMeter = meterSandboxRun): boolean {
  return policy.perRunLimitUsd !== null && (run.usage?.costUsd ?? 0) + meter(run, now).costUsd > policy.perRunLimitUsd;
}
