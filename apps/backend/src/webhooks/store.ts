import type { Env } from "../env.js";
import { WEBHOOK_EVENT_KINDS, type WebhookDeliveryRow, type WebhookEventKind, type WebhookSubscriptionRow } from "./types.js";
import { sealWebhookSecret, openWebhookSecret, generateWebhookSecret } from "./secrets.js";
import { validateWebhookDestination } from "./ssrf.js";
import { InputError } from "../security.js";

const DEFAULT_WORKSPACE = "self-hosted";

export function parseEvents(raw: unknown): WebhookEventKind[] {
  if (!Array.isArray(raw)) throw new InputError("events must be an array.");
  const events = raw.filter((e): e is string => typeof e === "string");
  const unique = [...new Set(events)];
  for (const e of unique) {
    if (!(WEBHOOK_EVENT_KINDS as readonly string[]).includes(e)) {
      throw new InputError(`Unsupported event: ${e}`);
    }
  }
  if (unique.length === 0) throw new InputError("Select at least one event.");
  return unique as WebhookEventKind[];
}

export async function createWebhookSubscription(
  env: Env,
  input: { workspaceId?: string; url: string; events: WebhookEventKind[]; secret?: string },
): Promise<{ subscription: WebhookSubscriptionRow; secret: string }> {
  const workspaceId = input.workspaceId?.trim() || DEFAULT_WORKSPACE;
  const validated = validateWebhookDestination(input.url);
  if (!validated.ok) throw new InputError(validated.reason);
  const secret = input.secret ?? generateWebhookSecret();
  const id = `whsub_${crypto.randomUUID()}`;
  const now = Date.now();
  const sealed = await sealWebhookSecret(env, workspaceId, id, secret);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO webhook_subscriptions(id,workspace_id,url,events_json,secret_key_id,secret_cipher,active,created_at,updated_at)
     VALUES(?,?,?,?,?,?,1,?,?)`,
  ).bind(id, workspaceId, validated.url.toString(), JSON.stringify(input.events), sealed.keyId, sealed.cipher, now, now).run();
  const subscription = await getSubscription(env, workspaceId, id);
  if (!subscription) throw new Error("subscription_missing");
  return { subscription, secret };
}

export async function listWebhookSubscriptions(env: Env, workspaceId = DEFAULT_WORKSPACE): Promise<WebhookSubscriptionRow[]> {
  const result = await env.AGENT_AUDIT.prepare(
    `SELECT id,workspace_id,url,events_json,secret_key_id,secret_cipher,active,created_at,updated_at
     FROM webhook_subscriptions WHERE workspace_id=? ORDER BY created_at DESC`,
  ).bind(workspaceId).all<WebhookSubscriptionRow>();
  return result.results ?? [];
}

export async function getSubscription(env: Env, workspaceId: string, id: string): Promise<WebhookSubscriptionRow | null> {
  return env.AGENT_AUDIT.prepare(
    `SELECT id,workspace_id,url,events_json,secret_key_id,secret_cipher,active,created_at,updated_at
     FROM webhook_subscriptions WHERE workspace_id=? AND id=?`,
  ).bind(workspaceId, id).first<WebhookSubscriptionRow>();
}

export async function updateWebhookSubscription(
  env: Env,
  workspaceId: string,
  id: string,
  patch: { url?: string; events?: WebhookEventKind[]; active?: boolean },
): Promise<WebhookSubscriptionRow | null> {
  const row = await getSubscription(env, workspaceId, id);
  if (!row) return null;
  let url = row.url;
  if (patch.url !== undefined) {
    const validated = validateWebhookDestination(patch.url);
    if (!validated.ok) throw new InputError(validated.reason);
    url = validated.url.toString();
  }
  const events = patch.events ? JSON.stringify(patch.events) : row.events_json;
  const active = patch.active === undefined ? row.active : patch.active ? 1 : 0;
  const now = Date.now();
  await env.AGENT_AUDIT.prepare(
    `UPDATE webhook_subscriptions SET url=?,events_json=?,active=?,updated_at=? WHERE workspace_id=? AND id=?`,
  ).bind(url, events, active, now, workspaceId, id).run();
  return getSubscription(env, workspaceId, id);
}

export async function rotateWebhookSecret(env: Env, workspaceId: string, id: string): Promise<{ secret: string } | null> {
  const row = await getSubscription(env, workspaceId, id);
  if (!row) return null;
  const secret = generateWebhookSecret();
  const sealed = await sealWebhookSecret(env, workspaceId, id, secret);
  await env.AGENT_AUDIT.prepare(
    `UPDATE webhook_subscriptions SET secret_key_id=?,secret_cipher=?,updated_at=? WHERE workspace_id=? AND id=?`,
  ).bind(sealed.keyId, sealed.cipher, Date.now(), workspaceId, id).run();
  return { secret };
}

export async function subscriptionSecret(env: Env, row: WebhookSubscriptionRow): Promise<string> {
  return openWebhookSecret(env, row.workspace_id, row.id, { keyId: row.secret_key_id, cipher: row.secret_cipher });
}

export async function insertDelivery(
  env: Env,
  input: {
    subscriptionId: string;
    event: WebhookEventKind;
    payload: Record<string, unknown>;
    status?: WebhookDeliveryRow["status"];
    attempt?: number;
    nextAttemptAt?: number | null;
  },
): Promise<WebhookDeliveryRow> {
  const id = `whdel_${crypto.randomUUID()}`;
  const now = Date.now();
  const status = input.status ?? "pending";
  const attempt = input.attempt ?? 0;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO webhook_deliveries(id,subscription_id,event,payload_json,attempt,status,response_code,response_body,next_attempt_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,NULL,NULL,?,?,?)`,
  ).bind(
    id,
    input.subscriptionId,
    input.event,
    JSON.stringify(input.payload),
    attempt,
    status,
    input.nextAttemptAt ?? null,
    now,
    now,
  ).run();
  const row = await getDelivery(env, id);
  if (!row) throw new Error("delivery_missing");
  return row;
}

export async function getDelivery(env: Env, id: string): Promise<WebhookDeliveryRow | null> {
  return env.AGENT_AUDIT.prepare(`SELECT * FROM webhook_deliveries WHERE id=?`).bind(id).first<WebhookDeliveryRow>();
}

export async function listDeliveries(
  env: Env,
  subscriptionId: string,
  limit = 50,
): Promise<WebhookDeliveryRow[]> {
  const result = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM webhook_deliveries WHERE subscription_id=? ORDER BY created_at DESC LIMIT ?`,
  ).bind(subscriptionId, limit).all<WebhookDeliveryRow>();
  return result.results ?? [];
}

export async function updateDeliveryAttempt(
  env: Env,
  id: string,
  patch: Partial<Pick<WebhookDeliveryRow, "status" | "attempt" | "response_code" | "response_body" | "next_attempt_at">>,
): Promise<void> {
  const row = await getDelivery(env, id);
  if (!row) return;
  await env.AGENT_AUDIT.prepare(
    `UPDATE webhook_deliveries SET status=?,attempt=?,response_code=?,response_body=?,next_attempt_at=?,updated_at=? WHERE id=?`,
  ).bind(
    patch.status ?? row.status,
    patch.attempt ?? row.attempt,
    patch.response_code ?? row.response_code,
    patch.response_body ?? row.response_body,
    patch.next_attempt_at === undefined ? row.next_attempt_at : patch.next_attempt_at,
    Date.now(),
    id,
  ).run();
}

export async function subscriptionsForEvent(env: Env, workspaceId: string, event: WebhookEventKind) {
  const subs = await listWebhookSubscriptions(env, workspaceId);
  return subs.filter((sub) => {
    if (!sub.active) return false;
    try {
      const events = JSON.parse(sub.events_json) as string[];
      return events.includes(event);
    } catch {
      return false;
    }
  });
}