/**
 * Container concurrency and cost guardrails (Phase 2b).
 * Elevated parallelism requires an explicit operator opt-in; wrangler
 * `max_instances` must stay in sync with WRANGLER_MAX_INSTANCES.
 */
import type { DelegatedRun } from "./runs.js";
import { countActiveRuns, MAX_CONCURRENT_RUNS } from "./runs.js";

/** Default policy cap — unchanged from Phase 1 unless elevated. */
export const DEFAULT_MAX_CONCURRENT_RUNS = MAX_CONCURRENT_RUNS;

/** Raised ceiling when guardrails pass (must match wrangler max_instances). */
export const WRANGLER_MAX_INSTANCES = 10;

export const ELEVATED_MAX_CONCURRENT_RUNS = WRANGLER_MAX_INSTANCES;

export interface ContainerBudgetConfig {
  /** When true, allow up to ELEVATED_MAX_CONCURRENT_RUNS. */
  elevatedConcurrency?: boolean;
  /** Optional daily USD budget for container-time (sum of run.usage.costUsd). */
  dailyBudgetUsd?: number;
  /** Rolling spend for the current UTC day (caller supplies from DO state). */
  spentTodayUsd?: number;
}

export function resolveMaxConcurrentRuns(config?: ContainerBudgetConfig): number {
  if (config?.elevatedConcurrency === true) {
    return ELEVATED_MAX_CONCURRENT_RUNS;
  }
  return DEFAULT_MAX_CONCURRENT_RUNS;
}

export function sumRunCostUsd(runs: DelegatedRun[]): number {
  let total = 0;
  for (const run of runs) {
    if (run.usage?.costUsd !== undefined) total += run.usage.costUsd;
  }
  return total;
}

/** Spend attributed to the current UTC calendar day. */
export function spentTodayUsd(runs: DelegatedRun[], nowMs = Date.now()): number {
  const dayStart = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  let total = 0;
  for (const run of runs) {
    if (run.updatedAt < dayStart) continue;
    if (run.usage?.costUsd !== undefined) total += run.usage.costUsd;
  }
  return total;
}

/** A bounded, honest dashboard snapshot: values come only from harness reports. */
export function summarizeReportedUsage(runs: DelegatedRun[], nowMs = Date.now()) {
  const dayStart = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  const today = runs.filter((run) => run.updatedAt >= dayStart);
  const costRuns = today.filter((run) => run.usage?.costUsd !== undefined);
  const spentUsd = costRuns.reduce((sum, run) => sum + Math.max(0, run.usage!.costUsd!), 0);
  return {
    accounting: "harness_reported" as const,
    spentUsd,
    reportedRuns: costRuns.length,
    unreportedRuns: today.filter((run) => run.usage?.costUsd === undefined).length,
    dailyLimitUsd: undefined as number | undefined,
    limitReached: false,
  };
}

/** Attach configured dispatch policy; reaching the boundary blocks new starts. */
export function executionBudgetSnapshot(
  runs: DelegatedRun[],
  config: ContainerBudgetConfig,
  nowMs = Date.now(),
) {
  const usage = summarizeReportedUsage(runs, nowMs);
  const dailyLimitUsd = config.dailyBudgetUsd;
  const limitReached = dailyLimitUsd !== undefined && usage.spentUsd >= dailyLimitUsd;
  const activeRuns = countActiveRuns(runs);
  const maxConcurrentRuns = resolveMaxConcurrentRuns(config);
  return {
    ...usage,
    dailyLimitUsd,
    limitReached,
    activeRuns,
    maxConcurrentRuns,
    dispatchAvailable: canStartRunWithBudget(runs, config, nowMs),
  };
}

export function isWithinDailyBudget(config: ContainerBudgetConfig, nowMs = Date.now()): boolean {
  const budget = config.dailyBudgetUsd;
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return true;
  const spent = config.spentTodayUsd ?? spentTodayUsd([], nowMs);
  return spent < budget;
}

export function canStartRunWithBudget(
  runs: DelegatedRun[],
  config?: ContainerBudgetConfig,
  nowMs = Date.now(),
): boolean {
  const limit = resolveMaxConcurrentRuns(config);
  if (countActiveRuns(runs) >= limit) return false;
  if (!isWithinDailyBudget({ ...config, spentTodayUsd: config?.spentTodayUsd ?? spentTodayUsd(runs, nowMs) }, nowMs)) {
    return false;
  }
  return true;
}

export function parseElevatedConcurrencyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

export function parseDailyBudgetUsd(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}
