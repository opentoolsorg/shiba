import { describe, expect, it, vi } from "vitest";
import { dispatchQueueBatch, registerQueueHandler } from "../src/platform/queues.js";
import type { Env } from "../src/env.js";

describe("queue dispatch", () => {
  it("acks messages when no handlers are registered", async () => {
    const ack = vi.fn();
    const batch = {
      queue: "shiba-ingest-dogfood",
      messages: [{ ack, retry: vi.fn(), body: {} }],
    } as unknown as MessageBatch<unknown>;
    await dispatchQueueBatch(batch, {} as Env, {} as ExecutionContext);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("invokes a registered handler", async () => {
    const handler = vi.fn(async () => {});
    registerQueueHandler("shiba-email-dogfood", handler);
    const ack = vi.fn();
    const batch = {
      queue: "shiba-email-dogfood",
      messages: [{ ack, retry: vi.fn(), body: { hello: true } }],
    } as unknown as MessageBatch<unknown>;
    await dispatchQueueBatch(batch, {} as Env, {} as ExecutionContext);
    expect(handler).toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();
  });
});