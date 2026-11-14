import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import type { Env } from "../src/env.js";
import { createWebhookSubscription, getDelivery, insertDelivery } from "../src/webhooks/store.js";
import { executeWebhookDelivery, WEBHOOK_MAX_ATTEMPTS } from "../src/webhooks/deliver.js";

describe("webhook retry and DLQ", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("dead-letters after max attempts on repeated 500 responses", async () => {
    const db = customAgentD1();
    db.sqlite.exec(readFileSync(new URL("../migrations/0054_webhooks.sql", import.meta.url), "utf8"));
    const env = {
      AGENT_AUDIT: db.database,
      MODEL_CREDENTIAL_KEY: "a".repeat(64),
    } as unknown as Env;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fail", { status: 500 })));
    const sub = await createWebhookSubscription(env, {
      url: "https://public.example.com/hook",
      events: ["run.completed"],
    });
    const row = await insertDelivery(env, {
      subscriptionId: sub.subscription.id,
      event: "run.completed",
      payload: { sample: true },
    });
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS + 2; i++) {
      const current = await getDelivery(env, row.id);
      if (!current || current.status === "dead_letter") break;
      await executeWebhookDelivery(env, {
        deliveryId: row.id,
        subscriptionId: sub.subscription.id,
        attempt: current.attempt,
      });
    }
    const terminal = await getDelivery(env, row.id);
    expect(terminal?.status).toBe("dead_letter");
  });
});