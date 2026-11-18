import { isActiveStatus, type DelegatedRun, type UsageBudgetPolicy } from "@shiba/shared";
import { defaultUsageBudgetPolicy } from "../usage.js";
import { meterSandboxRun } from "../sandbox-metering.js";
import { resolveInstanceType, type InstanceType } from "../instance-type.js";
import { evaluateUsageBudget } from "../usage-budget.js";
import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

const DAY_MS = 86_400_000;
const micros = (usd: number | undefined) => Math.round((usd ?? 0) * 1_000_000);

export function threadUsage(run: DelegatedRun, policy?: UsageBudgetPolicy, now = Date.now(), instanceType?: InstanceType) {
  const harness = run.route?.harness ?? "";
  const subscription = run.authAccount !== undefined;
  const started = run.signals?.find((signal) => signal.kind === "harness.started")?.at ?? run.createdAt;
  const cost = micros(run.usage?.costUsd);
  const meter = meterSandboxRun(run, now, instanceType);
  return { totalCostMicros: cost + micros(meter.costUsd), spendLimitMicros: policy?.perRunLimitUsd == null ? null : micros(policy.perRunLimitUsd), threadVersion: run.generation, llmCostMicros: cost,
    vmCostMicros: micros(meter.costUsd), vmCostSource: meter.provenance?.source ?? null, vmCostStatus: meter.status,
    vmCostProvenance: meter.provenance, vmCostUpdatedAt: meter.provenance?.endedAt ?? null,
    vmCpuSeconds: meter.cpuSeconds, vmRamGbSeconds: meter.ramGbSeconds, vmDiskGbSeconds: meter.diskGbSeconds, runCount: 1,
    usesCodexSubscription: subscription && harness.startsWith("codex"),
    usesGrokSubscription: subscription && harness.startsWith("grok"),
    usesClaudeCodeSubscription: subscription && harness.startsWith("claude"),
    usesByok: !subscription && (run.route?.connectionId ?? null) !== null, usesGateway: false,
    inputTokens: run.usage?.inputTokens ?? 0, outputTokens: run.usage?.outputTokens ?? 0,
    latestContextTokens: 0, latestContextSource: null, topModel: run.route?.modelId ?? null,
    runtimeMs: isActiveStatus(run.status) ? 0 : Math.max(0, run.updatedAt - started) };
}

async function listRuns(ctx: V1Context): Promise<DelegatedRun[] | Response> {
  const response = await ctx.forward("GET", "/api/runs");
  if (!response.ok) return response;
  const { runs } = await response.json() as { runs?: DelegatedRun[] };
  return Array.isArray(runs) ? runs : [];
}

export async function handleBilling(ctx: V1Context): Promise<Response | null> {
  const path = ctx.url.pathname;
  const thread = path.match(/^\/api\/v1\/threads\/([^/]+)\/usage$/);
  if (!thread && path !== "/api/v1/billing/plan" && path !== "/api/v1/billing/summary" && path !== "/api/v1/usage") return null;
  if (ctx.request.method !== "GET") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  if (thread) {
    let id: string;
    try { id = decodeURIComponent(thread[1]!); } catch { return Response.json({ ok: false, error: "invalid_thread" }, { status: 400 }); }
    const run = await readRun(ctx, id);
    if (run instanceof Response) return run;
    const response = await ctx.forward("GET", "/api/usage/budget");
    if (!response.ok) return response;
    const { policy } = await response.json() as { policy: UsageBudgetPolicy };
    return Response.json({ ok: true, usage: threadUsage(run, policy, Date.now(), resolveInstanceType(ctx.env.INSTANCE_TYPE)) });
  }
  // Single-tenant, no Stripe: one fixed self-hosted plan. Sandbox sleepAfter is 1m; the schema floor is 5.
  if (path === "/api/v1/billing/plan") {
    return Response.json({ ok: true, plan: { plan: "scale", billingInterval: "monthly", sandboxIdleMinutes: 5, seatCount: 1 } });
  }
  const runs = await listRuns(ctx);
  if (runs instanceof Response) return runs;
  const reported = runs.filter((run) => run.usage !== undefined);
  if (path === "/api/v1/usage") {
    return Response.json({ ok: true, usage: { orgId: "self-hosted",
      totalCostMicros: runs.reduce((n, run) => n + micros(run.usage?.costUsd) + micros(meterSandboxRun(run, Date.now(), resolveInstanceType(ctx.env.INSTANCE_TYPE)).costUsd), 0),
      inputTokens: reported.reduce((n, run) => n + (run.usage?.inputTokens ?? 0), 0),
      outputTokens: reported.reduce((n, run) => n + (run.usage?.outputTokens ?? 0), 0),
      events: reported.length } });
  }
  // Credits are USD; policy periods are UTC and include live compute estimates.
  const now = Date.now();
  const response = await ctx.forward("GET", "/api/usage/budget");
  if (!response.ok) return response;
  const { policy = defaultUsageBudgetPolicy(ctx.env) } = await response.json() as { policy?: UsageBudgetPolicy };
  const meter = (run: DelegatedRun) => meterSandboxRun(run, now, resolveInstanceType(ctx.env.INSTANCE_TYPE));
  const state = evaluateUsageBudget(policy, runs, now, meter);
  const budget = policy.dailyLimitUsd;
  const usedUsd = state.today.totalUsd;
  const todayUsd = state.today.totalUsd;
  const heldUsd = runs.filter((run) => isActiveStatus(run.status)).reduce((sum, run) => sum + (run.usage?.costUsd ?? 0) + meter(run).costUsd, 0);
  const todayStart = now - (now % DAY_MS);
  const remainingToday = budget === null ? null : Math.max(0, budget - todayUsd);
  return Response.json({ ok: true, billing: { customerId: "self-hosted", featureId: "self-hosted",
    grantedCredits: budget ?? 0, remainingCredits: remainingToday ?? 0, usedCredits: usedUsd, heldCredits: heldUsd,
    available: !state.blocked,
    nextResetAt: budget === null ? null : new Date(todayStart + DAY_MS).toISOString(),
    includedPeriodStart: budget === null ? null : new Date(todayStart).toISOString(),
    includedCredits: budget ?? 0, remainingIncludedCredits: remainingToday ?? 0, prepaidCredits: 0,
    dailyIncludedCredits: budget, remainingDailyIncludedCredits: remainingToday, creditsNeededToStartRun: 0 } });
}
