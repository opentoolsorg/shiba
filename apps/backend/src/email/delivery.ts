import type { Env } from "../env.js";
import { nativeEnrollmentEmailConfiguration } from "../native-enrollment-email.js";
import { registerQueueHandler, type QueuePayload } from "../platform/queues.js";
import {
  markEmailDeliverySent,
  recordEmailDeliveryFailure,
  type EmailQueueBody,
} from "./outbox.js";
import { renderEmailTemplate, type EmailTemplateKind } from "./templates/index.js";

interface OutboxRow {
  outbox_id: string;
  template_kind: string;
  to_address: string;
  status: string;
  meta_json: string;
}

function parseOutboxId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const payload = body as QueuePayload | EmailQueueBody;
  if ("kind" in payload && payload.kind === "EMAIL_QUEUE" && payload.v === 1) {
    const id = payload.body?.outboxId;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  if ("outboxId" in payload && typeof payload.outboxId === "string") return payload.outboxId;
  return null;
}

async function loadOutboxRow(env: Env, outboxId: string): Promise<OutboxRow | null> {
  if (!env.AGENT_AUDIT) return null;
  return env.AGENT_AUDIT.prepare(
    "SELECT outbox_id, template_kind, to_address, status, meta_json FROM email_outbox WHERE outbox_id = ?",
  )
    .bind(outboxId)
    .first<OutboxRow>();
}

/** Queue consumer and inline test path. Delivery failures never propagate to auth. */
export async function deliverEmailOutboxMessage(env: Env, message: EmailQueueBody): Promise<void> {
  const row = await loadOutboxRow(env, message.outboxId);
  if (!row || row.status === "sent" || row.status === "dead") return;
  const config = nativeEnrollmentEmailConfiguration(env);
  if (!config) {
    await recordEmailDeliveryFailure(env, message.outboxId, "Transactional email sender is not configured.");
    throw new Error("Transactional email sender is not configured.");
  }
  let meta: Record<string, string>;
  try {
    const parsed: unknown = JSON.parse(row.meta_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad meta");
    meta = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    await recordEmailDeliveryFailure(env, message.outboxId, "Outbox metadata is invalid.");
    throw new Error("Outbox metadata is invalid.");
  }
  const rendered = renderEmailTemplate(row.template_kind as EmailTemplateKind, meta);
  try {
    if (!env.SEND_EMAIL) throw new Error("SEND_EMAIL binding is not configured.");
    await env.SEND_EMAIL.send({
      from: config.from,
      to: row.to_address,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    await markEmailDeliverySent(env, message.outboxId);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    const outcome = await recordEmailDeliveryFailure(env, message.outboxId, messageText);
    if (outcome === "retry") throw error instanceof Error ? error : new Error(messageText);
  }
}

for (const queueName of ["shiba-email", "shiba-email-dlq", "shiba-email-dogfood", "shiba-email-dlq-dogfood"]) {
  registerQueueHandler(queueName, async (message, env) => {
    const outboxId = parseOutboxId(message.body);
    if (!outboxId) return;
    await deliverEmailOutboxMessage(env, { outboxId });
  });
}