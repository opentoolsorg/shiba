import type { Env } from "../env.js";
import { registerQueueHandler, type QueuePayload } from "../platform/queues.js";
import { executeWebhookDelivery } from "./deliver.js";
import type { WebhookQueueMessage } from "./types.js";

const WEBHOOK_QUEUE_NAMES = ["shiba-webhooks", "shiba-webhooks-dogfood"] as const;

function parseWebhookBody(body: unknown): WebhookQueueMessage | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.kind === "WEBHOOK_QUEUE" && record.v === 1 && record.body && typeof record.body === "object") {
    const inner = record.body as Record<string, unknown>;
    if (typeof inner.deliveryId === "string" && typeof inner.subscriptionId === "string") {
      return {
        deliveryId: inner.deliveryId,
        subscriptionId: inner.subscriptionId,
        attempt: typeof inner.attempt === "number" ? inner.attempt : 0,
      };
    }
    return null;
  }
  if (typeof record.deliveryId === "string" && typeof record.subscriptionId === "string") {
    return {
      deliveryId: record.deliveryId,
      subscriptionId: record.subscriptionId,
      attempt: typeof record.attempt === "number" ? record.attempt : 0,
    };
  }
  return null;
}

async function handleWebhookQueueMessage(message: Message<unknown>, env: Env): Promise<void> {
  const payload = parseWebhookBody(message.body as QueuePayload | WebhookQueueMessage);
  if (!payload) {
    message.ack();
    return;
  }
  const outcome = await executeWebhookDelivery(env, payload);
  if (outcome === "retry") {
    throw new Error("webhook_delivery_retry");
  }
}

/** WS09 — register against WS01 queue names (append-only; safe to call once at boot). */
export function registerWebhookQueueConsumers(): void {
  for (const queueName of WEBHOOK_QUEUE_NAMES) {
    registerQueueHandler(queueName, async (message, env) => {
      await handleWebhookQueueMessage(message, env);
    });
  }
}