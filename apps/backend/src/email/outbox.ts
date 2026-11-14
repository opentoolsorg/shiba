import type { Env } from "../env.js";
import type { QueuePayload } from "../platform/queues.js";
import { renderEmailTemplate, type EmailTemplateKind, type EmailTemplateMeta } from "./templates/index.js";

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];

export interface EmailQueueBody {
  outboxId: string;
}

export interface EmailOutboxStatusRow {
  outbox_id: string;
  to_address: string;
  template_kind: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  updated_at: number;
}

function now(): number {
  return Date.now();
}

function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}

function emailJobPayload(outboxId: string): QueuePayload {
  return { kind: "EMAIL_QUEUE", v: 1, body: { outboxId } };
}

async function isSuppressed(env: Env, to: string): Promise<boolean> {
  if (!env.AGENT_AUDIT) return false;
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT to_address FROM email_suppressions WHERE to_address = ?",
  )
    .bind(normalizeRecipient(to))
    .first<{ to_address: string }>();
  return row !== null;
}

async function scheduleDelivery(env: Env, outboxId: string, delaySeconds?: number): Promise<void> {
  if (env.EMAIL_QUEUE) {
    await env.EMAIL_QUEUE.send(emailJobPayload(outboxId), delaySeconds ? { delaySeconds } : undefined);
    return;
  }
  const { deliverEmailOutboxMessage } = await import("./delivery.js");
  await deliverEmailOutboxMessage(env, { outboxId });
}

/** Enqueue transactional mail. Never throws to auth callers — failures are recorded in D1. */
export async function enqueueTransactionalEmail(
  env: Env,
  input: { kind: EmailTemplateKind; to: string; meta: EmailTemplateMeta },
): Promise<string | null> {
  if (!env.AGENT_AUDIT) return null;
  const to = normalizeRecipient(input.to);
  if (await isSuppressed(env, to)) return null;
  const rendered = renderEmailTemplate(input.kind, input.meta);
  const outboxId = `eml_${crypto.randomUUID().replaceAll("-", "")}`;
  const stamp = now();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO email_outbox(outbox_id, template_kind, to_address, subject, status, attempt_count, created_at, updated_at, meta_json)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
  )
    .bind(outboxId, input.kind, to, rendered.subject, stamp, stamp, JSON.stringify(input.meta))
    .run();
  try {
    await scheduleDelivery(env, outboxId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.AGENT_AUDIT.prepare(
      `UPDATE email_outbox SET status = 'failed', last_error = ?, updated_at = ?, next_attempt_at = ?
       WHERE outbox_id = ?`,
    )
      .bind(message.slice(0, 500), now(), now() + BACKOFF_MS[0]!, outboxId)
      .run();
  }
  return outboxId;
}

export async function recordEmailDeliveryFailure(
  env: Env,
  outboxId: string,
  errorMessage: string,
): Promise<"retry" | "dead" | "missing"> {
  if (!env.AGENT_AUDIT) return "missing";
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT attempt_count, to_address FROM email_outbox WHERE outbox_id = ?",
  )
    .bind(outboxId)
    .first<{ attempt_count: number; to_address: string }>();
  if (!row) return "missing";
  const attempt = row.attempt_count + 1;
  const stamp = now();
  if (attempt >= MAX_ATTEMPTS) {
    await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(
        `UPDATE email_outbox SET status = 'dead', attempt_count = ?, last_error = ?, updated_at = ?, next_attempt_at = NULL
         WHERE outbox_id = ?`,
      ).bind(attempt, errorMessage.slice(0, 500), stamp, outboxId),
      env.AGENT_AUDIT.prepare(
        `INSERT INTO email_suppressions(to_address, reason, last_error, created_at, updated_at)
         VALUES (?, 'delivery_exhausted', ?, ?, ?)
         ON CONFLICT(to_address) DO UPDATE SET reason = excluded.reason, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      ).bind(row.to_address, errorMessage.slice(0, 500), stamp, stamp),
    ]);
    return "dead";
  }
  const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]!;
  await env.AGENT_AUDIT.prepare(
    `UPDATE email_outbox SET status = 'failed', attempt_count = ?, last_error = ?, updated_at = ?, next_attempt_at = ?
     WHERE outbox_id = ?`,
  )
    .bind(attempt, errorMessage.slice(0, 500), stamp, stamp + delay, outboxId)
    .run();
  if (env.EMAIL_QUEUE) {
    await env.EMAIL_QUEUE.send(emailJobPayload(outboxId), { delaySeconds: Math.ceil(delay / 1000) }).catch(() => {});
  }
  return "retry";
}

export async function markEmailDeliverySent(env: Env, outboxId: string): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  const stamp = now();
  await env.AGENT_AUDIT.prepare(
    `UPDATE email_outbox SET status = 'sent', updated_at = ?, sent_at = ?, last_error = NULL, next_attempt_at = NULL
     WHERE outbox_id = ?`,
  )
    .bind(stamp, stamp, outboxId)
    .run();
}

/** Operator visibility — suppression and last error only, never message content. */
export async function listEmailDeliveryStatus(
  env: Env,
  limit = 50,
): Promise<{ suppressions: { to: string; reason: string; lastError: string | null; updatedAt: number }[];
  recent: { outboxId: string; to: string; kind: string; status: string; attempts: number; lastError: string | null; updatedAt: number }[] }> {
  if (!env.AGENT_AUDIT) return { suppressions: [], recent: [] };
  const [suppressions, recent] = await Promise.all([
    env.AGENT_AUDIT.prepare(
      `SELECT to_address, reason, last_error, updated_at FROM email_suppressions ORDER BY updated_at DESC LIMIT ?`,
    )
      .bind(limit)
      .all<{ to_address: string; reason: string; last_error: string | null; updated_at: number }>(),
    env.AGENT_AUDIT.prepare(
      `SELECT outbox_id, to_address, template_kind, status, attempt_count, last_error, updated_at
       FROM email_outbox ORDER BY updated_at DESC LIMIT ?`,
    )
      .bind(limit)
      .all<EmailOutboxStatusRow>(),
  ]);
  return {
    suppressions: suppressions.results.map((row) => ({
      to: row.to_address,
      reason: row.reason,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    })),
    recent: recent.results.map((row) => ({
      outboxId: row.outbox_id,
      to: row.to_address,
      kind: row.template_kind,
      status: row.status,
      attempts: row.attempt_count,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    })),
  };
}

export async function isEmailAddressSuppressed(env: Env, email: string): Promise<boolean> {
  return isSuppressed(env, email);
}