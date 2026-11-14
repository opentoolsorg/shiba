import type { Env } from "../env.js";
import { isAuthorizedRequest } from "../request-auth.js";
import { InputError } from "../security.js";
import { emitWebhookEvent } from "./producer.js";
import {
  createWebhookSubscription,
  listDeliveries,
  listWebhookSubscriptions,
  rotateWebhookSecret,
  updateWebhookSubscription,
  getSubscription,
  insertDelivery,
} from "./store.js";
import { parseEvents } from "./store.js";
import { WEBHOOK_EVENT_KINDS, type WebhookEventKind } from "./types.js";
import { validateWebhookDestination } from "./ssrf.js";

const WORKSPACE = "self-hosted";

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function handleOutboundWebhooks(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/webhooks")) return null;
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (url.pathname === "/api/webhooks/subscriptions" && request.method === "GET") {
    const subs = await listWebhookSubscriptions(env, WORKSPACE);
    return Response.json({
      ok: true,
      subscriptions: subs.map((sub) => ({
        id: sub.id,
        url: sub.url,
        events: JSON.parse(sub.events_json) as string[],
        active: Boolean(sub.active),
        createdAt: sub.created_at,
      })),
    });
  }

  if (url.pathname === "/api/webhooks/subscriptions" && request.method === "POST") {
    const body = await readJson(request);
    if (!body) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
    try {
      const events = parseEvents(body.events);
      const created = await createWebhookSubscription(env, {
        workspaceId: WORKSPACE,
        url: String(body.url ?? ""),
        events,
      });
      return Response.json({
        ok: true,
        subscription: {
          id: created.subscription.id,
          url: created.subscription.url,
          events,
          active: true,
        },
        secret: created.secret,
      }, { status: 201 });
    } catch (error) {
      if (error instanceof InputError) {
        return Response.json({ ok: false, error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  const subMatch = url.pathname.match(/^\/api\/webhooks\/subscriptions\/([^/]+)(?:\/(test|rotate-secret|deliveries(?:\/([^/]+)\/redeliver)?))?$/);
  if (subMatch) {
    const subId = decodeURIComponent(subMatch[1]!);
    const action = subMatch[2];
    if (request.method === "PATCH" && !action) {
      const body = await readJson(request);
      if (!body) return Response.json({ ok: false, error: "invalid_request" }, { status: 400 });
      try {
        const updated = await updateWebhookSubscription(env, WORKSPACE, subId, {
          ...(body.url !== undefined ? { url: String(body.url) } : {}),
          ...(body.events !== undefined ? { events: parseEvents(body.events) } : {}),
          ...(body.active !== undefined ? { active: Boolean(body.active) } : {}),
        });
        if (!updated) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
        return Response.json({ ok: true, subscription: { id: updated.id, url: updated.url, events: JSON.parse(updated.events_json), active: Boolean(updated.active) } });
      } catch (error) {
        if (error instanceof InputError) return Response.json({ ok: false, error: error.message }, { status: 400 });
        throw error;
      }
    }
    if (action === "rotate-secret" && request.method === "POST") {
      const rotated = await rotateWebhookSecret(env, WORKSPACE, subId);
      if (!rotated) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      return Response.json({ ok: true, secret: rotated.secret });
    }
    if (action === "test" && request.method === "POST") {
      const sub = await getSubscription(env, WORKSPACE, subId);
      if (!sub) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      const ids = await emitWebhookEvent(env, WORKSPACE, "run.completed", { test: true, subscriptionId: subId });
      return Response.json({ ok: true, deliveryIds: ids });
    }
    if (action?.startsWith("deliveries") && request.method === "GET") {
      const deliveries = await listDeliveries(env, subId);
      return Response.json({
        ok: true,
        deliveries: deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          attempt: d.attempt,
          status: d.status,
          responseCode: d.response_code,
          nextAttemptAt: d.next_attempt_at,
          createdAt: d.created_at,
        })),
      });
    }
    const redeliverId = subMatch[3];
    if (redeliverId && action?.includes("redeliver") && request.method === "POST") {
      const delivery = await insertDelivery(env, {
        subscriptionId: subId,
        event: "run.completed" as WebhookEventKind,
        payload: { redeliveryOf: redeliverId, at: new Date().toISOString() },
      });
      try {
        const { enqueue } = await import("../platform/queues.js");
        await enqueue("WEBHOOK_QUEUE", { deliveryId: delivery.id, subscriptionId: subId, attempt: 0 }, env);
      } catch {
        const { executeWebhookDelivery } = await import("./deliver.js");
        await executeWebhookDelivery(env, { deliveryId: delivery.id, subscriptionId: subId, attempt: 0 });
      }
      return Response.json({ ok: true, deliveryId: delivery.id });
    }
  }

  if (url.pathname === "/api/webhooks/validate-url" && request.method === "POST") {
    const body = await readJson(request);
    const raw = typeof body?.url === "string" ? body.url : "";
    const validated = validateWebhookDestination(raw);
    if (!validated.ok) return Response.json({ ok: false, error: validated.reason }, { status: 400 });
    return Response.json({ ok: true });
  }

  if (url.pathname === "/api/webhooks/events" && request.method === "GET") {
    return Response.json({ ok: true, events: WEBHOOK_EVENT_KINDS });
  }

  return Response.json({ ok: false, error: "not_found" }, { status: 404 });
}