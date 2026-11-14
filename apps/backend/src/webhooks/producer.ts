import type { Env } from "../env.js";
import { enqueue } from "../platform/queues.js";
import { insertDelivery, subscriptionsForEvent } from "./store.js";
import type { WebhookEventKind } from "./types.js";

export async function emitWebhookEvent(
  env: Env,
  workspaceId: string,
  event: WebhookEventKind,
  payload: Record<string, unknown>,
): Promise<string[]> {
  if (!env.AGENT_AUDIT) return [];
  const subs = await subscriptionsForEvent(env, workspaceId, event);
  const deliveryIds: string[] = [];
  for (const sub of subs) {
    const delivery = await insertDelivery(env, {
      subscriptionId: sub.id,
      event,
      payload: { event, workspaceId, createdAt: new Date().toISOString(), data: payload },
    });
    deliveryIds.push(delivery.id);
    try {
      await enqueue("WEBHOOK_QUEUE", {
        deliveryId: delivery.id,
        subscriptionId: sub.id,
        attempt: 0,
      }, env);
    } catch {
      // Tests and local dev without WS01 queue binding deliver inline.
      const { executeWebhookDelivery } = await import("./deliver.js");
      await executeWebhookDelivery(env, { deliveryId: delivery.id, subscriptionId: sub.id, attempt: 0 });
    }
  }
  return deliveryIds;
}