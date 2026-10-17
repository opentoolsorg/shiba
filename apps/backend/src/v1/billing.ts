import { isActiveStatus, type DelegatedRun } from "@shiba/shared";
import { aggregateUsageByDay, parseUsageBudget } from "../usage.js";
import type { V1Context } from "./context.js";
import { readRun } from "./runs.js";

const DAY_MS = 86_400_000;
const micros = (usd: number | undefined) => Math.round((usd ?? 0) * 1_000_000);

export function threadUsage(run: DelegatedRun) {
  const harness = run.route?.harness ?? "";
  const subscription = run.authAccount !== undefined;
  const started = run.signals?.find((signal) => signal.kind === "harness.started")?.at ?? run.createdAt;
  const cost = micros(run.usage?.costUsd);
  return { totalCostMicros: cost, spendLimitMicros: null, threadVersion: run.generation, llmCostMicros: cost,
    // Sandbox metering is not recorded per run.
    vmCostMicros: 0, vmCostSource: null, vmCostStatus: "unavailable" as const, vmCostProvenance: null, vmCostUpdatedAt: null,
    vmCpuSeconds: 0, vmRamGbSeconds: 0, vmDiskGbSeconds: 0, runCount: 1,
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
    return Response.json({ ok: true, usage: threadUsage(run) });
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
      totalCostMicros: reported.reduce((n, run) => n + micros(run.usage?.costUsd), 0),
      inputTokens: reported.reduce((n, run) => n + (run.usage?.inputTokens ?? 0), 0),
      outputTokens: reported.reduce((n, run) => n + (run.usage?.outputTokens ?? 0), 0),
      events: reported.length } });
  }
  // Credits are USD; USAGE_BUDGET_USD is the only allowance, daily (UTC) and advisory: nothing gates runs on it.
  const now = Date.now();
  const budget = parseUsageBudget(ctx.env);
  const usedUsd = reported.reduce((n, run) => n + (run.usage?.costUsd ?? 0), 0);
  const todayUsd = aggregateUsageByDay(runs, { days: 1, now })[0]?.costUsd ?? 0;
  const todayStart = now - (now % DAY_MS);
  const remainingToday = budget === null ? null : Math.max(0, budget - todayUsd);
  return Response.json({ ok: true, billing: { customerId: "self-hosted", featureId: "self-hosted",
    grantedCredits: budget ?? 0, remainingCredits: remainingToday ?? 0, usedCredits: usedUsd, heldCredits: 0,
    available: true,
    nextResetAt: budget === null ? null : new Date(todayStart + DAY_MS).toISOString(),
    includedPeriodStart: budget === null ? null : new Date(todayStart).toISOString(),
    includedCredits: budget ?? 0, remainingIncludedCredits: remainingToday ?? 0, prepaidCredits: 0,
    dailyIncludedCredits: budget, remainingDailyIncludedCredits: remainingToday, creditsNeededToStartRun: 0 } });
}
