import type { Env } from "../env.js";
import { enqueue } from "../platform/queues.js";
import { redactSecrets } from "../security.js";
import { buildDeliveryHeaders, signWebhookPayload } from "./signing.js";
import { getDelivery, subscriptionSecret, updateDeliveryAttempt } from "./store.js";
import type { WebhookQueueMessage } from "./types.js";

export const WEBHOOK_MAX_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 3_600_000;

export function webhookBackoffMs(attempt: number): number {
  const exp = Math.min(attempt, 10);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exp);
}

export async function executeWebhookDelivery(env: Env, message: WebhookQueueMessage): Promise<"ok" | "retry" | "dead"> {
  const delivery = await getDelivery(env, message.deliveryId);
  if (!delivery) return "ok";
  const sub = await env.AGENT_AUDIT.prepare(`SELECT * FROM webhook_subscriptions WHERE id=?`).bind(message.subscriptionId)
    .first<{ workspace_id: string; url: string; secret_key_id: string; secret_cipher: string; active: number }>();
  if (!sub || !sub.active) {
    await updateDeliveryAttempt(env, delivery.id, { status: "failed", response_body: "subscription_inactive" });
    return "ok";
  }
  const secret = await subscriptionSecret(env, {
    id: message.subscriptionId,
    workspace_id: sub.workspace_id,
    url: sub.url,
    events_json: "[]",
    secret_key_id: sub.secret_key_id,
    secret_cipher: sub.secret_cipher,
    active: sub.active,
    created_at: 0,
    updated_at: 0,
  });
  const body = delivery.payload_json;
  const ts = Math.floor(Date.now() / 1000);
  const signature = await signWebhookPayload(secret, body, ts);
  const headers = buildDeliveryHeaders(signature, delivery.id, delivery.event);
  let response: Response;
  try {
    response = await fetch(sub.url, { method: "POST", headers, body });
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    return handleFailure(env, delivery.id, message.attempt, null, detail);
  }
  const responseText = (await response.text()).slice(0, 2048);
  if (response.ok) {
    await updateDeliveryAttempt(env, delivery.id, {
      status: "delivered",
      attempt: message.attempt,
      response_code: response.status,
      response_body: responseText,
      next_attempt_at: null,
    });
    return "ok";
  }
  return handleFailure(env, delivery.id, message.attempt, response.status, responseText);
}

async function handleFailure(
  env: Env,
  deliveryId: string,
  attempt: number,
  code: number | null,
  body: string,
): Promise<"retry" | "dead"> {
  const nextAttempt = attempt + 1;
  if (nextAttempt >= WEBHOOK_MAX_ATTEMPTS) {
    await updateDeliveryAttempt(env, deliveryId, {
      status: "dead_letter",
      attempt: nextAttempt,
      response_code: code,
      response_body: body,
      next_attempt_at: null,
    });
    return "dead";
  }
  const nextAt = Date.now() + webhookBackoffMs(nextAttempt);
  await updateDeliveryAttempt(env, deliveryId, {
    status: "pending",
    attempt: nextAttempt,
    response_code: code,
    response_body: body,
    next_attempt_at: nextAt,
  });
  const subscriptionId = (await getDelivery(env, deliveryId))?.subscription_id;
  if (subscriptionId) {
    try {
      await enqueue("WEBHOOK_QUEUE", { deliveryId, subscriptionId, attempt: nextAttempt }, env);
    } catch {
      // Retry scheduling is best-effort; the row records next_attempt_at for observability.
    }
  }
  return "retry";
}