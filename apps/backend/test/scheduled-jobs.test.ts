import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { reportError } from "../src/observability.js";
import { dispatchQueueBatch } from "../src/platform/queues.js";
import { scheduledJobRegistry, scheduledJobs } from "../src/scheduled-jobs.js";

vi.mock("@cloudflare/sandbox", () => ({ Sandbox: class {}, ContainerProxy: class {}, proxyToSandbox: vi.fn(), getSandbox: vi.fn() }));
vi.mock("agents/routing", () => ({ getAgentByName: vi.fn(), routeAgentRequest: vi.fn() }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));
vi.mock("../src/observability.js", () => ({ reportError: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/platform/queues.js", () => ({ dispatchQueueBatch: vi.fn().mockResolvedValue(undefined) }));

const names = [
  "founder.stripe", "founder.meta", "founder.hubspot", "founder.reconcile", "founder.reads",
  "founder.slack", "founder.stripe-slack", "founder.reconcile-slack", "slack.private-status",
  "founder.reviews", "founder.connectors", "automations.tick", "drafts.sweep", "audit.prune",
] as const;
const queuedNames = names;
const scheduledAt = 1_800_000_000_000;
const slot = Math.floor(scheduledAt / (5 * 60_000));
const controller = { scheduledTime: scheduledAt } as ScheduledController;
const ctx = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext };
};
const message = (body: unknown) => ({ body, ack: vi.fn(), retry: vi.fn() });
const batch = (messages: ReturnType<typeof message>[], queue = "shiba-jobs") => ({ queue, messages } as unknown as MessageBatch<unknown>);
function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE scheduled_job_slots (job_name TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, PRIMARY KEY (job_name, slot))");
  return { prepare(sql: string) {
    let params: SQLInputValue[] = [];
    return {
      bind(...values: SQLInputValue[]) { params = values; return this; },
      async run() { sqlite.prepare(sql).run(...params); return { meta: { changes: Number((sqlite.prepare("SELECT changes() AS count").get() as { count: number }).count) } }; },
      async first<T>() { return sqlite.prepare(sql).get(...params) as T | undefined; },
    };
  } } as unknown as D1Database;
}

beforeEach(() => {
  vi.mocked(reportError).mockClear();
  vi.mocked(dispatchQueueBatch).mockClear();
  for (const name of names) vi.spyOn(scheduledJobs, name).mockImplementation(async () => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("scheduled jobs", () => {
  it("covers every existing cron task, including both retention sweeps", () => {
    expect(Object.keys(scheduledJobs)).toEqual(names);
    expect(Object.keys(scheduledJobRegistry)).toEqual(names);
    expect(Object.values(scheduledJobRegistry).every(({ everyMinutes }) => everyMinutes === 5)).toBe(true);
  });

  it("only enqueues one message per job when the binding exists", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = { JOBS_QUEUE: { sendBatch } } as unknown as Env;
    const { pending, context } = ctx();
    await worker.scheduled(controller, env, context);
    await Promise.all(pending);
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith(queuedNames.map((job) => ({ body: { job, slot } })));
    for (const name of queuedNames) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(scheduledJobs["automations.tick"]).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("enqueues every registered job without running handlers inline", async () => {
    vi.mocked(scheduledJobs["automations.tick"]).mockRejectedValue(new Error("tick failed"));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = { JOBS_QUEUE: { sendBatch } } as unknown as Env;
    const { pending, context } = ctx();
    await worker.scheduled(controller, env, context);
    await Promise.all(pending);
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith(queuedNames.map((job) => ({ body: { job, slot } })));
    for (const name of queuedNames) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("runs all jobs inline without the binding despite one failure", async () => {
    vi.mocked(scheduledJobs["founder.stripe"]).mockRejectedValue(new Error("failed"));
    const env = {} as Env;
    const { pending, context } = ctx();
    await worker.scheduled(controller, env, context);
    await Promise.all(pending);
    for (const name of names) expect(scheduledJobs[name]).toHaveBeenCalledExactlyOnceWith(env, scheduledAt);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(env, "scheduled", expect.objectContaining({ message: "failed" }));
  });

  it("starts later inline jobs without waiting for a hanging founder tick", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(scheduledJobs["founder.stripe"]).mockImplementation(async () => {
      await held;
      return { created: 0, unavailable: false };
    });
    const { pending, context } = ctx();
    await worker.scheduled(controller, {} as Env, context);
    try {
      expect(scheduledJobs["automations.tick"]).toHaveBeenCalledOnce();
      expect(scheduledJobs["drafts.sweep"]).toHaveBeenCalledOnce();
      expect(scheduledJobs["audit.prune"]).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.all(pending);
    }
  });

  it("propagates enqueue failure without silently running jobs twice", async () => {
    const env = { JOBS_QUEUE: { sendBatch: vi.fn().mockRejectedValue(new Error("queue down")) } } as unknown as Env;
    const { pending, context } = ctx();
    await worker.scheduled(controller, env, context);
    await expect(Promise.all(pending)).rejects.toThrow("queue down");
    expect(reportError).toHaveBeenCalledExactlyOnceWith(env, "scheduled", expect.objectContaining({ message: "queue down" }));
    for (const name of queuedNames) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    for (const name of names) expect(scheduledJobs[name]).not.toHaveBeenCalled();
  });

  it.each(["shiba-jobs", "shiba-jobs-dogfood", "shiba-jobs-pr-277"])("dispatches and acks the right handler on %s", async (queue) => {
    const env = {} as Env;
    const item = message({ job: "founder.meta", slot });
    await worker.queue(batch([item], queue), env, ctx().context);
    expect(scheduledJobs["founder.meta"]).toHaveBeenCalledExactlyOnceWith(env, slot * 5 * 60_000);
    for (const name of names.filter((name) => name !== "founder.meta")) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
    expect(dispatchQueueBatch).not.toHaveBeenCalled();
  });

  it("ignores an empty scheduled batch without reporting errors", async () => {
    await worker.queue(batch([]), {} as Env, ctx().context);
    for (const name of names) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(dispatchQueueBatch).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("routes non-scheduled batches through the queue dispatcher", async () => {
    const env = {} as Env;
    const { context } = ctx();
    const incoming = batch([], "knowledge-ingest");
    await worker.queue(incoming, env, context);
    expect(dispatchQueueBatch).toHaveBeenCalledExactlyOnceWith(incoming, env, context);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports non-scheduled queue failures while preserving redelivery", async () => {
    const env = {} as Env;
    const failure = new Error("dispatcher failed");
    vi.mocked(dispatchQueueBatch).mockRejectedValueOnce(failure);
    const { pending, context } = ctx();
    await expect(worker.queue(batch([], "knowledge-ingest"), env, context)).rejects.toBe(failure);
    await Promise.all(pending);
    expect(reportError).toHaveBeenCalledExactlyOnceWith(env, "queue", failure);
  });

  it.each([{ job: "future.job", slot }, { job: "constructor", slot }, { job: "founder.meta", slot: -1 }, { job: "founder.meta" }, null])("acks unknown or malformed messages %j", async (body) => {
    const item = message(body);
    await worker.queue(batch([item]), {} as Env, ctx().context);
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
    for (const name of names) expect(scheduledJobs[name]).not.toHaveBeenCalled();
  });

  it("retries a throwing job without acking it or blocking another message", async () => {
    vi.mocked(scheduledJobs["founder.meta"]).mockRejectedValue(new Error("provider down"));
    const failed = message({ job: "founder.meta", slot });
    const success = message({ job: "slack.private-status", slot: slot + 1 });
    await worker.queue(batch([failed, success]), {} as Env, ctx().context);
    expect(failed.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(failed.ack).not.toHaveBeenCalled();
    expect(success.ack).toHaveBeenCalledOnce();
    expect(success.retry).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledExactlyOnceWith({}, "scheduled", expect.objectContaining({ message: "provider down" }));
  });

  it("starts independent handlers concurrently", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(scheduledJobs["founder.meta"]).mockImplementation(async () => {
      await held;
      return { created: 0, unavailable: false };
    });
    const items = [message({ job: "founder.meta", slot }), message({ job: "slack.private-status", slot: slot + 1 })];
    const running = worker.queue(batch(items), {} as Env, ctx().context);
    await Promise.resolve();
    expect(scheduledJobs["slack.private-status"]).toHaveBeenCalledOnce();
    release();
    await running;
    for (const item of items) expect(item.ack).toHaveBeenCalledOnce();
  });

  it("skips a duplicate job slot after its first delivery completes", async () => {
    const env = { AGENT_AUDIT: database() } as unknown as Env;
    const first = message({ job: "founder.meta", slot });
    const duplicate = message({ job: "founder.meta", slot });
    await worker.queue(batch([first]), env, ctx().context);
    await worker.queue(batch([duplicate]), env, ctx().context);
    expect(scheduledJobs["founder.meta"]).toHaveBeenCalledOnce();
    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(duplicate.retry).not.toHaveBeenCalled();
  });

  it("keeps queue binding, DLQ and per-job consumer settings in both deploy paths", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const wrangler = read("../wrangler.jsonc"), alchemy = read("../../../alchemy.run.ts");
    expect(wrangler).toContain('{ "binding": "JOBS_QUEUE", "queue": "shiba-jobs" }');
    expect(wrangler).toContain('{ "queue": "shiba-jobs", "dead_letter_queue": "shiba-jobs-dlq", "max_batch_size": 10, "max_retries": 3 }');
    expect(alchemy).toContain('Cloudflare.Queues.Queue("JOBS_QUEUE", { name: `shiba-jobs${resSuffix}` })');
    expect(alchemy).toContain('Cloudflare.Queues.Queue("JOBS_DLQ", { name: `shiba-jobs-dlq${resSuffix}` })');
    expect(alchemy).toContain("JOBS_QUEUE: JobsQueue");
    expect(alchemy).toContain('Cloudflare.Queues.Consumer("JobsConsumer", {');
    expect(alchemy).toContain("queueId: jobs.queueId");
    expect(alchemy).toContain("scriptName: worker.workerName");
    expect(alchemy).toContain("deadLetterQueue: jobsDlq.queueName");
    expect(alchemy).toContain("settings: { batchSize: 10, maxRetries: 3 }");
  });
});
