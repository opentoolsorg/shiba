import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { scheduledJobs } from "../src/scheduled-jobs.js";

vi.mock("@cloudflare/sandbox", () => ({ Sandbox: class {}, ContainerProxy: class {}, proxyToSandbox: vi.fn(), getSandbox: vi.fn() }));
vi.mock("agents/routing", () => ({ getAgentByName: vi.fn(), routeAgentRequest: vi.fn() }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

const names = [
  "founder.stripe", "founder.meta", "founder.hubspot", "founder.reconcile", "founder.reads",
  "founder.slack", "founder.stripe-slack", "founder.reconcile-slack", "slack.private-status",
  "founder.reviews", "founder.connectors", "automations.tick", "drafts.sweep", "audit.prune",
] as const;
const queuedNames = names.filter((name) => name !== "automations.tick");
const scheduledAt = 1_800_000_000_000;
const controller = { scheduledTime: scheduledAt } as ScheduledController;
const ctx = () => {
  const pending: Promise<unknown>[] = [];
  return { pending, context: { waitUntil: (promise: Promise<unknown>) => pending.push(promise) } as unknown as ExecutionContext };
};
const message = (body: unknown) => ({ body, ack: vi.fn(), retry: vi.fn() });
const batch = (messages: ReturnType<typeof message>[], queue = "shiba-jobs") => ({ queue, messages } as unknown as MessageBatch<unknown>);

beforeEach(() => {
  for (const name of names) vi.spyOn(scheduledJobs, name).mockImplementation(async () => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("scheduled jobs", () => {
  it("covers every existing cron task, including both retention sweeps", () => {
    expect(Object.keys(scheduledJobs)).toEqual(names);
  });

  it("only enqueues one message per job when the binding exists", async () => {
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = { JOBS_QUEUE: { sendBatch } } as unknown as Env;
    const { pending, context } = ctx();
    await worker.scheduled(controller, env, context);
    await Promise.all(pending);
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith(queuedNames.map((job) => ({ body: { job, scheduledAt } })));
    for (const name of queuedNames) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(scheduledJobs["automations.tick"]).toHaveBeenCalledExactlyOnceWith(env, scheduledAt);
  });

  it("still enqueues safe jobs when the inline-only tick fails", async () => {
    vi.mocked(scheduledJobs["automations.tick"]).mockRejectedValue(new Error("tick failed"));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = { JOBS_QUEUE: { sendBatch } } as unknown as Env;
    const { pending, context } = ctx();
    await worker.scheduled(controller, env, context);
    await Promise.all(pending);
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith(queuedNames.map((job) => ({ body: { job, scheduledAt } })));
    for (const name of queuedNames) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("runs all jobs inline without the binding despite one failure", async () => {
    vi.mocked(scheduledJobs["founder.stripe"]).mockRejectedValue(new Error("failed"));
    const env = {} as Env;
    const { pending, context } = ctx();
    await worker.scheduled(controller, env, context);
    await Promise.all(pending);
    for (const name of names) expect(scheduledJobs[name]).toHaveBeenCalledExactlyOnceWith(env, scheduledAt);
    expect(console.error).toHaveBeenCalledTimes(1);
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
    for (const name of queuedNames) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(scheduledJobs["automations.tick"]).toHaveBeenCalledOnce();
  });

  it.each(["shiba-jobs", "shiba-jobs-dogfood", "shiba-jobs-pr-277"])("dispatches and acks the right handler on %s", async (queue) => {
    const env = {} as Env;
    const item = message({ job: "founder.meta", scheduledAt });
    await worker.queue(batch([item], queue), env, ctx().context);
    expect(scheduledJobs["founder.meta"]).toHaveBeenCalledExactlyOnceWith(env, scheduledAt);
    for (const name of names.filter((name) => name !== "founder.meta")) expect(scheduledJobs[name]).not.toHaveBeenCalled();
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
  });

  it.each([{ job: "future.job", scheduledAt }, { job: "constructor", scheduledAt }, { job: "automations.tick", scheduledAt }, { job: "founder.meta" }, null])("acks unknown or malformed messages %j", async (body) => {
    const item = message(body);
    await worker.queue(batch([item]), {} as Env, ctx().context);
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledOnce();
    for (const name of names) expect(scheduledJobs[name]).not.toHaveBeenCalled();
  });

  it("retries a throwing job without acking it or blocking another message", async () => {
    vi.mocked(scheduledJobs["founder.meta"]).mockRejectedValue(new Error("provider down"));
    const failed = message({ job: "founder.meta", scheduledAt });
    const success = message({ job: "slack.private-status", scheduledAt });
    await worker.queue(batch([failed, success]), {} as Env, ctx().context);
    expect(failed.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(failed.ack).not.toHaveBeenCalled();
    expect(success.ack).toHaveBeenCalledOnce();
    expect(success.retry).not.toHaveBeenCalled();
  });

  it("starts independent handlers concurrently", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(scheduledJobs["founder.meta"]).mockImplementation(async () => {
      await held;
      return { created: 0, unavailable: false };
    });
    const items = [message({ job: "founder.meta", scheduledAt }), message({ job: "slack.private-status", scheduledAt })];
    const running = worker.queue(batch(items), {} as Env, ctx().context);
    await Promise.resolve();
    expect(scheduledJobs["slack.private-status"]).toHaveBeenCalledOnce();
    release();
    await running;
    for (const item of items) expect(item.ack).toHaveBeenCalledOnce();
  });

  it("keeps queue binding, DLQ and per-job consumer settings in both deploy paths", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const wrangler = read("../wrangler.jsonc"), alchemy = read("../../../alchemy.run.ts");
    expect(wrangler).toContain('{ "binding": "JOBS_QUEUE", "queue": "shiba-jobs" }');
    expect(wrangler).toContain('{ "queue": "shiba-jobs", "dead_letter_queue": "shiba-jobs-dlq", "max_batch_size": 1, "max_retries": 5 }');
    expect(alchemy).toContain('Cloudflare.Queues.Queue("JOBS_QUEUE", { name: `shiba-jobs${resSuffix}` })');
    expect(alchemy).toContain('Cloudflare.Queues.Queue("JOBS_DLQ", { name: `shiba-jobs-dlq${resSuffix}` })');
    expect(alchemy).toContain("JOBS_QUEUE: JobsQueue");
    expect(alchemy).toContain('Cloudflare.Queues.Consumer("JobsConsumer", {');
    expect(alchemy).toContain("queueId: jobs.queueId");
    expect(alchemy).toContain("scriptName: worker.workerName");
    expect(alchemy).toContain("deadLetterQueue: jobsDlq.queueName");
    expect(alchemy).toContain("settings: { batchSize: 1, maxRetries: 5 }");
  });
});
