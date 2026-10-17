import { describe, expect, it, vi } from "vitest";
import type { DelegatedRun, SpineEvent } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleBilling } from "../src/v1/billing.js";
import type { V1Context } from "../src/v1/context.js";
import { handleEvents } from "../src/v1/events.js";

const now = Date.now();
const run: DelegatedRun = { runId: "r1", sandboxId: "s1", repoUrl: "https://github.com/acme/repo", task: "Fix",
  baseBranch: "main", publishPullRequest: true, generation: 3, status: "completed", createdAt: now - 5000, updatedAt: now - 1000,
  route: { purpose: "coding", connectionId: null, modelId: "claude-opus-5-5", harness: "claude", policyVersion: 1 }, authAccount: "me",
  signals: [{ kind: "harness.started", at: now - 4000 }], usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.25 } };
const other: DelegatedRun = { ...run, runId: "r2", repoUrl: "https://github.com/acme/other", authAccount: undefined, route: undefined,
  usage: { costUsd: 0.5, inputTokens: 1 } };
const bare: DelegatedRun = { ...run, runId: "r3", usage: undefined };

const spineEvents: SpineEvent[] = [
  { seq: 5, at: 1000, commandId: "c1", kind: "run.proposed", runId: "r1" },
  { seq: 6, at: 2000, commandId: "c2", kind: "side_effect.requested", runId: "r1" },
  { seq: 7, at: 3000, commandId: "c3", kind: "run.started", runId: "r2" },
  { seq: 8, at: 4000, commandId: "c4", kind: "approval.answered", approvalId: "a1", runId: "r1",
    payload: { approvalId: "a1", result: "approved" } },
];

function fixture(path: string, opts: { method?: string; env?: Partial<Env>; headers?: Record<string, string>; events?: SpineEvent[]; earliestSeq?: number } = {}) {
  const request = new Request(`https://worker.test/api/v1${path}`, { method: opts.method ?? "GET", headers: opts.headers });
  const events = opts.events ?? spineEvents;
  const forward = vi.fn(async (_verb: string, route: string) => {
    const url = new URL(route, "https://internal");
    if (url.pathname === "/api/spine") {
      const since = url.searchParams.get("since");
      return Response.json({ events: since === null ? events : events.filter((event) => event.seq > Number(since)), outbox: [],
        earliestSeq: opts.earliestSeq ?? events[0]?.seq ?? 0, latestSeq: events.at(-1)?.seq ?? 0, totalEvents: events.length });
    }
    if (url.pathname === "/api/runs") return Response.json({ runs: [run, other, bare] });
    if (url.pathname === "/api/runs/r1") return Response.json({ run });
    return Response.json({ error: "Run not found." }, { status: 404 });
  });
  const ctx: V1Context = { request, url: new URL(request.url), env: (opts.env ?? {}) as Env, forward };
  return { ctx, forward };
}

describe("v1 billing and usage", () => {
  it("ignores unrelated paths and refuses non-GET", async () => {
    expect(await handleBilling(fixture("/threads/r1/runs").ctx)).toBeNull();
    expect(await handleBilling(fixture("/events").ctx)).toBeNull();
    expect((await handleBilling(fixture("/usage", { method: "POST" }).ctx))!.status).toBe(405);
  });

  it("serves the fixed self-hosted plan without touching the run store", async () => {
    const { ctx, forward } = fixture("/billing/plan");
    expect(await (await handleBilling(ctx))!.json()).toEqual({ ok: true,
      plan: { plan: "scale", billingInterval: "monthly", sandboxIdleMinutes: 5, seatCount: 1 } });
    expect(forward).not.toHaveBeenCalled();
  });

  it("derives thread usage from the run's reported usage", async () => {
    const { ctx, forward } = fixture("/threads/r1/usage");
    const body = await (await handleBilling(ctx))!.json() as { usage: Record<string, unknown> };
    expect(forward).toHaveBeenCalledWith("GET", "/api/runs/r1");
    expect(body.usage).toMatchObject({ totalCostMicros: 250_000, llmCostMicros: 250_000, vmCostStatus: "unavailable", runCount: 1,
      threadVersion: 3, inputTokens: 100, outputTokens: 20, topModel: "claude-opus-5-5", usesClaudeCodeSubscription: true,
      usesCodexSubscription: false, usesByok: false, runtimeMs: 3000, spendLimitMicros: null });
  });

  it("passes through a missing thread", async () => {
    expect((await handleBilling(fixture("/threads/nope/usage").ctx))!.status).toBe(404);
    expect((await handleBilling(fixture("/threads/%E0%A4%A/usage").ctx))!.status).toBe(400);
  });

  it("sums org usage over runs that reported it", async () => {
    const body = await (await handleBilling(fixture("/usage").ctx))!.json();
    expect(body).toEqual({ ok: true, usage: { orgId: "self-hosted", totalCostMicros: 750_000, inputTokens: 101, outputTokens: 20, events: 2 } });
  });

  it("reports USD credits against the advisory daily budget", async () => {
    const withBudget = await (await handleBilling(fixture("/billing/summary", { env: { USAGE_BUDGET_USD: "2" } }).ctx))!.json() as { billing: Record<string, unknown> };
    expect(withBudget.billing).toMatchObject({ customerId: "self-hosted", available: true, usedCredits: 0.75,
      dailyIncludedCredits: 2, remainingDailyIncludedCredits: 1.25, creditsNeededToStartRun: 0 });
    expect(typeof withBudget.billing.nextResetAt).toBe("string");
    const none = await (await handleBilling(fixture("/billing/summary").ctx))!.json() as { billing: Record<string, unknown> };
    expect(none.billing).toMatchObject({ available: true, dailyIncludedCredits: null, remainingDailyIncludedCredits: null, nextResetAt: null });
  });
});

describe("v1 events", () => {
  it("ignores unrelated paths and refuses non-GET", async () => {
    expect(await handleEvents(fixture("/events/other").ctx)).toBeNull();
    expect(await handleEvents(fixture("/usage").ctx)).toBeNull();
    expect((await handleEvents(fixture("/events", { method: "POST" }).ctx))!.status).toBe(405);
  });

  it("returns the spine head as the cursor", async () => {
    const { ctx, forward } = fixture("/events/head");
    expect(await (await handleEvents(ctx))!.json()).toEqual({ ok: true, cursor: "8" });
    expect(forward).toHaveBeenCalledWith("GET", `/api/spine?since=${Number.MAX_SAFE_INTEGER}`);
  });

  it("lists public events in order, hiding outbox kinds", async () => {
    const body = await (await handleEvents(fixture("/events").ctx))!.json() as { events: Record<string, unknown>[]; hasMore: boolean; nextCursor: string };
    expect(body.events.map((event) => event.type)).toEqual(["run.proposed", "run.started", "approval.answered"]);
    expect(body.events[0]).toEqual({ id: "evt_5", orgId: "self-hosted", projectId: "https://github.com/acme/repo", threadId: "r1", runId: "r1",
      sequence: "5", type: "run.proposed", data: { id: "r1", status: "waiting" }, occurredAt: new Date(1000).toISOString(),
      publishedAt: new Date(1000).toISOString(), cursor: "5" });
    expect(body.events[2]!.data).toEqual({ id: "r1", status: "approved" });
    expect(body).toMatchObject({ hasMore: false, nextCursor: "8" });
  });

  it("filters and paginates by cursor", async () => {
    const page = await (await handleEvents(fixture("/events?limit=1&types=run.proposed,run.started").ctx))!.json() as { events: { cursor: string }[]; hasMore: boolean; nextCursor: string };
    expect(page.events.map((event) => event.cursor)).toEqual(["5"]);
    expect(page).toMatchObject({ hasMore: true, nextCursor: "5" });
    const { ctx, forward } = fixture("/events?cursor=5&projectId=https://github.com/acme/other");
    const next = await (await handleEvents(ctx))!.json() as { events: { runId: string }[]; nextCursor: string };
    expect(forward).toHaveBeenCalledWith("GET", "/api/spine?since=5");
    expect(next.events.map((event) => event.runId)).toEqual(["r2"]);
    expect(next.nextCursor).toBe("8");
    const byThread = await (await handleEvents(fixture("/events?threadId=r2").ctx))!.json() as { events: unknown[] };
    expect(byThread.events).toHaveLength(1);
  });

  it("rejects bad input and expired cursors", async () => {
    expect((await handleEvents(fixture("/events?limit=501").ctx))!.status).toBe(400);
    expect((await handleEvents(fixture("/events?cursor=abc").ctx))!.status).toBe(400);
    const expired = await handleEvents(fixture("/events?cursor=2", { earliestSeq: 5 }).ctx);
    expect(expired!.status).toBe(410);
    expect(await expired!.json()).toEqual({ ok: false, error: "cursor_expired" });
    expect((await handleEvents(fixture("/events?cursor=4", { earliestSeq: 5 }).ctx))!.status).toBe(200);
  });

  it("streams SSE frames keyed by cursor and resumes from Last-Event-ID", async () => {
    const { ctx, forward } = fixture("/events/stream?cursor=0", { headers: { "Last-Event-ID": "6" } });
    const response = (await handleEvents(ctx))!;
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(forward).toHaveBeenCalledWith("GET", "/api/spine?since=6");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes("id: 8")) text += decoder.decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain("id: 7\ndata: ");
    expect(text).not.toContain("id: 5");
    expect(JSON.parse(text.split("\n").find((line) => line.startsWith("data: "))!.slice(6))).toMatchObject({ id: "evt_7", type: "run.started" });
  });

  it("refuses a stream whose cursor expired before opening it", async () => {
    const response = (await handleEvents(fixture("/events/stream?cursor=1", { earliestSeq: 5 }).ctx))!;
    expect(response.status).toBe(410);
  });
});
