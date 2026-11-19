/**
 * Workspace credits: money in through Stripe, money out through an
 * append-only debit ledger. A balance is read only from these rows, so
 * clearing run history cannot refund spent credits, and every run debit is
 * keyed to its run so a repeated settle is a no-op.
 *
 * Stripe keys stay in the Worker: the dashboard sees balances and legit
 * Stripe-hosted URLs, never a key, a customer id or a Checkout Session id.
 */
import { WORKSPACE_TOP_UP_MAX_USD, WORKSPACE_TOP_UP_MIN_USD, type DelegatedRun, type WorkspaceBilling, type WorkspaceTopUp } from "@shiba/shared";
import type { Env } from "./env.js";
import type { BudgetMeter } from "./usage-budget.js";

export type BillingEnv = Pick<Env, "AGENT_AUDIT" | "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "STRIPE_PORTAL_CONFIGURATION_ID"
  | "SHIBA_CREDITS_GATE_USER_FUNDED_RUNS">;

const STRIPE_API = "https://api.stripe.com/v1";
const MICRO = 1_000_000;
/** How long a published in-flight cost stays believable without a sweep. */
export const PENDING_TTL_MS = 7_200_000;
export const CREDITS_EXHAUSTED_MESSAGE = "Stopped because this workspace is out of prepaid credits. Add credits in Analytics → Workspace credits.";

export function missingBillingConfig(env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET">): string[] {
  return (["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const).filter((name) => !env[name]?.trim());
}

export function isWorkspaceBillingEnabled(env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET">): boolean {
  return missingBillingConfig(env).length === 0;
}

/**
 * One switch for the product question SHIB-20 left open: whether a run paid
 * for by a plan subscription or a paired local daemon also stops at zero
 * credits. Default on (every lane stops); "0" exempts user-funded lanes.
 */
export function creditsGateRun(env: Pick<Env, "SHIBA_CREDITS_GATE_USER_FUNDED_RUNS">, run: Pick<DelegatedRun, "authAccount" | "runtime">): boolean {
  if (env.SHIBA_CREDITS_GATE_USER_FUNDED_RUNS?.trim() === "0") {
    return run.authAccount === undefined && run.runtime !== "local";
  }
  return true;
}

export function stripeMode(env: Pick<Env, "STRIPE_SECRET_KEY">): "test" | "live" | null {
  const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  return null;
}

export class StripeRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`stripe_${code}`); }
}

function appendForm(form: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendForm(form, `${key}[${index}]`, item));
  } else if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendForm(form, `${key}[${child}]`, item);
  } else {
    form.append(key, String(value));
  }
}

/** One form-encoded POST to the Stripe API. Errors carry Stripe's code only, never the request. */
export async function stripePost<T>(env: Pick<Env, "STRIPE_SECRET_KEY">, path: string, params: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) appendForm(form, key, value);
  const headers = new Headers({ authorization: `Bearer ${env.STRIPE_SECRET_KEY?.trim() ?? ""}`, "content-type": "application/x-www-form-urlencoded" });
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  let response: Response;
  try {
    response = await fetch(`${STRIPE_API}/${path}`, { method: "POST", headers, body: form });
  } catch {
    throw new StripeRequestError(502, "unreachable");
  }
  const body = await response.json().catch(() => null) as { error?: { code?: string; type?: string } } | null;
  if (!response.ok) throw new StripeRequestError(response.status, body?.error?.code ?? body?.error?.type ?? "request_failed");
  return body as T;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe-Signature: `t=<unix>,v1=<hex hmac-sha256 of "t.payload">`, within a five-minute window. */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, now = Date.now(), toleranceSeconds = 300): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key, value]) => key === "v1" && value).map(([, value]) => value!);
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`)));
  return signatures.some((signature) => constantTimeEqual(signature, expected));
}

// ---------------------------------------------------------------------------
// Accounts and top-ups
// ---------------------------------------------------------------------------

interface AccountRow { owner: string; stripe_customer_id: string | null; created_at: number }
interface TopUpRow { public_id: string; amount_micro_usd: number; status: WorkspaceTopUp["status"]; created_at: number; settled_at: number | null }
export interface TopUpRecord { publicId: string; subject: string; amountMicroUsd: number; status: WorkspaceTopUp["status"]; paymentIntentId: string | null }

export async function readBillingAccount(db: D1Database, subject: string): Promise<AccountRow | null> {
  return db.prepare("SELECT owner, stripe_customer_id, created_at FROM workspace_billing_accounts WHERE owner=?").bind(subject).first<AccountRow>();
}

/** Billing starts counting spend from the moment the account first exists. */
export async function ensureBillingAccount(db: D1Database, subject: string, now = Date.now()): Promise<AccountRow> {
  await db.prepare("INSERT OR IGNORE INTO workspace_billing_accounts (owner, stripe_customer_id, created_at) VALUES (?, NULL, ?)").bind(subject, now).run();
  return (await readBillingAccount(db, subject))!;
}

export async function saveStripeCustomer(db: D1Database, subject: string, customerId: string): Promise<void> {
  await db.prepare("UPDATE workspace_billing_accounts SET stripe_customer_id=? WHERE owner=? AND stripe_customer_id IS NULL").bind(customerId, subject).run();
}

export async function recordPendingTopUp(db: D1Database, input: { publicId: string; sessionId: string; subject: string; amountMicroUsd: number; now?: number }): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO workspace_billing_topups (id, owner, amount_micro_usd, status, created_at, public_id, stripe_session_id) VALUES (?, ?, ?, 'pending', ?, ?, ?)")
    .bind(input.sessionId, input.subject, input.amountMicroUsd, input.now ?? Date.now(), input.publicId, input.sessionId).run();
}

/** Settles exactly the Checkout Session the Worker created, for the amount it priced. Redelivery is a no-op. */
export async function settleTopUp(db: D1Database, input: { sessionId: string; subject: string; amountMicroUsd: number; paymentIntentId: string | null; now?: number }): Promise<boolean> {
  const result = await db.prepare("UPDATE workspace_billing_topups SET status='succeeded', settled_at=?, stripe_payment_intent_id=? WHERE stripe_session_id=? AND owner=? AND amount_micro_usd=? AND status='pending'")
    .bind(input.now ?? Date.now(), input.paymentIntentId, input.sessionId, input.subject, input.amountMicroUsd).run();
  return result.meta.changes === 1;
}

export async function closeTopUp(db: D1Database, input: { sessionId: string; subject: string; status: "failed" | "expired"; now?: number }): Promise<void> {
  await db.prepare("UPDATE workspace_billing_topups SET status=?, settled_at=? WHERE stripe_session_id=? AND owner=? AND status='pending'")
    .bind(input.status, input.now ?? Date.now(), input.sessionId, input.subject).run();
}

interface TopUpMatchRow { public_id: string | null; owner: string; amount_micro_usd: number; status: WorkspaceTopUp["status"]; stripe_payment_intent_id: string | null }

/** The recorded top-up for a Checkout Session or PaymentIntent, for reconciliation and refunds. */
export async function findTopUp(db: D1Database, by: { sessionId: string } | { paymentIntentId: string }): Promise<TopUpRecord | null> {
  const sql = "SELECT public_id, owner, amount_micro_usd, status, stripe_payment_intent_id FROM workspace_billing_topups WHERE ";
  const row = "sessionId" in by
    ? await db.prepare(`${sql}stripe_session_id=?`).bind(by.sessionId).first<TopUpMatchRow>()
    : await db.prepare(`${sql}stripe_payment_intent_id=? AND status='succeeded'`).bind(by.paymentIntentId).first<TopUpMatchRow>();
  return row === null || row.public_id === null ? null
    : { publicId: row.public_id, subject: row.owner, amountMicroUsd: row.amount_micro_usd, status: row.status, paymentIntentId: row.stripe_payment_intent_id };
}

/**
 * A refund removes the credits it reverses. Stripe reports `amount_refunded`
 * as the running total for a payment, so each event records only the
 * difference from what the ledger already holds for that payment. Two partial
 * refunds in either order therefore total the same, and a redelivery is a
 * no-op. Returns the amount newly removed.
 */
export async function recordRefund(db: D1Database, input: { subject: string; paymentIntentId: string; refundedSoFarMicroUsd: number; now?: number }): Promise<number> {
  const now = input.now ?? Date.now();
  const ledgerRunId = `${input.paymentIntentId}:${input.refundedSoFarMicroUsd}`;
  // The difference is computed inside the insert, so two events racing on the
  // same payment cannot both subtract the same credits.
  const inserted = await db.prepare(`INSERT OR IGNORE INTO workspace_billing_debits (entry_id, subject, run_id, amount_micro_usd, kind, recorded_at)
    SELECT ?, ?, ?, delta, 'refund', ?
    FROM (SELECT ? - COALESCE((SELECT SUM(amount_micro_usd) FROM workspace_billing_debits WHERE subject=? AND kind='refund' AND run_id LIKE ? ESCAPE '\\'), 0) AS delta)
    WHERE delta > 0`)
    .bind(`refund_${ledgerRunId}`, input.subject, ledgerRunId, now,
      input.refundedSoFarMicroUsd, input.subject, `${escapeLike(input.paymentIntentId)}:%`).run();
  if (inserted.meta.changes !== 1) return 0;
  const removed = await db.prepare("SELECT amount_micro_usd AS amount FROM workspace_billing_debits WHERE entry_id=?")
    .bind(`refund_${ledgerRunId}`).first<{ amount: number }>();
  await db.prepare("UPDATE workspace_billing_topups SET refunded_micro_usd = ? WHERE owner=? AND stripe_payment_intent_id=? AND status='succeeded'")
    .bind(input.refundedSoFarMicroUsd, input.subject, input.paymentIntentId).run();
  return removed?.amount ?? 0;
}

/** `_` and `%` are LIKE wildcards; a Stripe id must be matched literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// ---------------------------------------------------------------------------
// The debit ledger
// ---------------------------------------------------------------------------

/** Debits one settled run. Returns true only for the insert that recorded it. */
export async function recordRunDebit(db: D1Database, input: { subject: string; runId: string; amountMicroUsd: number; now?: number }): Promise<boolean> {
  if (input.amountMicroUsd <= 0) return false;
  const result = await db.prepare("INSERT OR IGNORE INTO workspace_billing_debits (entry_id, subject, run_id, amount_micro_usd, kind, recorded_at) VALUES (?, ?, ?, ?, 'run', ?)")
    .bind(`run_${input.subject}_${input.runId}`, input.subject, input.runId, input.amountMicroUsd, input.now ?? Date.now()).run();
  return result.meta.changes === 1;
}

/** Paid credits less what refunds took back. */
export async function creditedMicroUsd(db: D1Database, subject: string): Promise<number> {
  const row = await db.prepare(`SELECT (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM workspace_billing_topups WHERE owner=? AND status='succeeded')
    - (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM workspace_billing_debits WHERE subject=? AND kind='refund') AS total`)
    .bind(subject, subject).first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Live cost of runs still executing, per account rather than per thread. Rows
 * past the time limit are ignored here as well as swept, so a store that dies
 * mid-run cannot hold its account at zero forever.
 */
export async function pendingMicroUsd(db: D1Database, subject: string, now = Date.now(), ttlMs = PENDING_TTL_MS): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount_micro_usd), 0) AS total FROM workspace_billing_pending WHERE subject=? AND updated_at>=?")
    .bind(subject, now - ttlMs).first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * Publishes the live cost of this store's executing runs for its account.
 * Rows expire so a store that dies mid-run cannot hold a balance down forever.
 */
export async function syncPendingSpend(db: D1Database, subject: string, entries: { runId: string; amountMicroUsd: number }[], now = Date.now(), ttlMs = PENDING_TTL_MS): Promise<void> {
  await db.prepare("DELETE FROM workspace_billing_pending WHERE subject=? AND updated_at<?").bind(subject, now - ttlMs).run();
  for (const entry of entries) {
    await db.prepare("INSERT OR REPLACE INTO workspace_billing_pending (subject, run_id, amount_micro_usd, updated_at) VALUES (?, ?, ?, ?)")
      .bind(subject, entry.runId, entry.amountMicroUsd, now).run();
  }
}

export async function clearPendingSpend(db: D1Database, subject: string, runId: string): Promise<void> {
  await db.prepare("DELETE FROM workspace_billing_pending WHERE subject=? AND run_id=?").bind(subject, runId).run();
}

export async function debitedMicroUsd(db: D1Database, subject: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount_micro_usd), 0) AS total FROM workspace_billing_debits WHERE subject=? AND kind='run'").bind(subject).first<{ total: number }>();
  return row?.total ?? 0;
}

/** Every ledger entry for one subject, newest first, for reconciliation and tests. */
export async function listLedgerEntries(db: D1Database, subject: string): Promise<{ entryId: string; runId: string | null; amountMicroUsd: number; kind: "run" | "refund"; recordedAt: number }[]> {
  const { results } = await db.prepare("SELECT entry_id, run_id, amount_micro_usd, kind, recorded_at FROM workspace_billing_debits WHERE subject=? ORDER BY recorded_at DESC")
    .bind(subject).all<{ entry_id: string; run_id: string | null; amount_micro_usd: number; kind: "run" | "refund"; recorded_at: number }>();
  return results.map((row) => ({ entryId: row.entry_id, runId: row.run_id, amountMicroUsd: row.amount_micro_usd, kind: row.kind, recordedAt: row.recorded_at }));
}

export async function recordedRunDebits(db: D1Database, subject: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT run_id FROM workspace_billing_debits WHERE subject=? AND kind='run'").bind(subject).all<{ run_id: string | null }>();
  return new Set(results.map((row) => row.run_id).filter((id): id is string => id !== null));
}

async function listTopUps(db: D1Database, subject: string): Promise<WorkspaceTopUp[]> {
  const { results } = await db.prepare("SELECT public_id, amount_micro_usd, status, created_at, settled_at FROM workspace_billing_topups WHERE owner=? ORDER BY created_at DESC LIMIT 10").bind(subject).all<TopUpRow>();
  return results.map((row) => ({ id: row.public_id, amountUsd: row.amount_micro_usd / MICRO, status: row.status, createdAt: row.created_at, settledAt: row.settled_at }));
}

/**
 * When a run actually started working: the latest point a sandbox was ready or
 * a harness started, falling back to when it was queued. Billing compares this
 * to its own start, so work queued before billing but dispatched after is
 * charged.
 */
export function runStartedAt(run: Pick<DelegatedRun, "createdAt" | "signals">): number {
  let started = run.createdAt;
  for (const signal of run.signals ?? []) {
    if ((signal.kind === "sandbox.ready" || signal.kind === "harness.started") && signal.at > started) started = signal.at;
  }
  return started;
}

/**
 * What one run costs the deployment: metered compute always, and model spend
 * unless a plan subscription or a paired local daemon carried it.
 */
export function runCreditCostUsd(run: DelegatedRun, now: number, meter: BudgetMeter): number {
  const userFunded = run.authAccount !== undefined || run.runtime === "local";
  return (userFunded ? 0 : run.usage?.costUsd ?? 0) + meter(run, now).costUsd;
}

export interface CreditState {
  creditedUsd: number;
  spentUsd: number;
  pendingUsd: number;
  balanceUsd: number;
  exhausted: boolean;
  since: number;
}

/**
 * `pendingUsd` is the live cost of executing runs across the whole account, so
 * a long run cannot outspend the balance between sweeps.
 */
export async function readCreditState(env: BillingEnv, subject: string, now: number, storeName = ""): Promise<CreditState> {
  const account = await ensureBillingAccount(env.AGENT_AUDIT, subject, now);
  void storeName;
  const creditedUsd = await creditedMicroUsd(env.AGENT_AUDIT, subject) / MICRO;
  const spentUsd = await debitedMicroUsd(env.AGENT_AUDIT, subject) / MICRO;
  const pending = await pendingMicroUsd(env.AGENT_AUDIT, subject, now) / MICRO;
  const balanceUsd = creditedUsd - spentUsd - pending;
  return { creditedUsd, spentUsd, pendingUsd: pending, balanceUsd, exhausted: balanceUsd <= 0, since: account.created_at };
}

export async function readWorkspaceBilling(env: BillingEnv, subject: string, now: number): Promise<WorkspaceBilling> {
  const limits = { minUsd: WORKSPACE_TOP_UP_MIN_USD, maxUsd: WORKSPACE_TOP_UP_MAX_USD };
  const missing = missingBillingConfig(env);
  if (missing.length > 0) {
    return { enabled: false, missing, mode: stripeMode(env), creditedUsd: 0, spentUsd: 0, pendingUsd: 0, balanceUsd: 0, exhausted: false, hasCustomer: false, since: null, topUps: [], limits };
  }
  const credit = await readCreditState(env, subject, now);
  const account = await readBillingAccount(env.AGENT_AUDIT, subject);
  return { enabled: true, missing, mode: stripeMode(env), ...credit, hasCustomer: Boolean(account?.stripe_customer_id), topUps: await listTopUps(env.AGENT_AUDIT, subject), limits };
}
