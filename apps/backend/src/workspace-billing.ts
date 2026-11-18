/**
 * Workspace prepaid credits backed by Stripe. Stripe keys stay in the Worker:
 * the dashboard only sees balances and Checkout/Portal URLs, and containers
 * never see any of it. With STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET set,
 * a workspace whose credits are spent cannot start or keep running work.
 */
import { WORKSPACE_TOP_UP_MAX_USD, WORKSPACE_TOP_UP_MIN_USD, type DelegatedRun, type WorkspaceBilling, type WorkspaceTopUp } from "@shiba/shared";
import type { Env } from "./env.js";
import type { BudgetMeter } from "./usage-budget.js";

export type BillingEnv = Pick<Env, "AGENT_AUDIT" | "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET" | "STRIPE_PORTAL_CONFIGURATION_ID">;

const STRIPE_API = "https://api.stripe.com/v1";
const MICRO = 1_000_000;
export const CREDITS_EXHAUSTED_MESSAGE = "Stopped because this workspace is out of prepaid credits. Add credits in Analytics → Billing.";

export function missingBillingConfig(env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET">): string[] {
  return (["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const).filter((name) => !env[name]?.trim());
}

export function isWorkspaceBillingEnabled(env: Pick<Env, "STRIPE_SECRET_KEY" | "STRIPE_WEBHOOK_SECRET">): boolean {
  return missingBillingConfig(env).length === 0;
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

interface AccountRow { owner: string; stripe_customer_id: string | null; created_at: number }
interface TopUpRow { id: string; amount_micro_usd: number; status: WorkspaceTopUp["status"]; created_at: number; settled_at: number | null }

export async function readBillingAccount(db: D1Database, owner: string): Promise<AccountRow | null> {
  return db.prepare("SELECT owner, stripe_customer_id, created_at FROM workspace_billing_accounts WHERE owner=?").bind(owner).first<AccountRow>();
}

/** Billing starts counting spend from the moment the account first exists. */
export async function ensureBillingAccount(db: D1Database, owner: string, now = Date.now()): Promise<AccountRow> {
  await db.prepare("INSERT OR IGNORE INTO workspace_billing_accounts (owner, stripe_customer_id, created_at) VALUES (?, NULL, ?)").bind(owner, now).run();
  return (await readBillingAccount(db, owner))!;
}

export async function saveStripeCustomer(db: D1Database, owner: string, customerId: string): Promise<void> {
  await db.prepare("UPDATE workspace_billing_accounts SET stripe_customer_id=? WHERE owner=? AND stripe_customer_id IS NULL").bind(customerId, owner).run();
}

export async function recordPendingTopUp(db: D1Database, input: { id: string; owner: string; amountMicroUsd: number; now?: number }): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO workspace_billing_topups (id, owner, amount_micro_usd, status, created_at) VALUES (?, ?, ?, 'pending', ?)")
    .bind(input.id, input.owner, input.amountMicroUsd, input.now ?? Date.now()).run();
}

/** Settles exactly the Checkout Session we created, for the amount we priced. Redelivery is a no-op. */
export async function settleTopUp(db: D1Database, input: { id: string; owner: string; amountMicroUsd: number; paymentIntentId: string | null; now?: number }): Promise<boolean> {
  const result = await db.prepare("UPDATE workspace_billing_topups SET status='succeeded', settled_at=?, stripe_payment_intent_id=? WHERE id=? AND owner=? AND amount_micro_usd=? AND status='pending'")
    .bind(input.now ?? Date.now(), input.paymentIntentId, input.id, input.owner, input.amountMicroUsd).run();
  return result.meta.changes === 1;
}

export async function closeTopUp(db: D1Database, input: { id: string; owner: string; status: "failed" | "expired"; now?: number }): Promise<void> {
  await db.prepare("UPDATE workspace_billing_topups SET status=?, settled_at=? WHERE id=? AND owner=? AND status='pending'")
    .bind(input.status, input.now ?? Date.now(), input.id, input.owner).run();
}

export async function creditedMicroUsd(db: D1Database, owner: string): Promise<number> {
  const row = await db.prepare("SELECT COALESCE(SUM(amount_micro_usd), 0) AS total FROM workspace_billing_topups WHERE owner=? AND status='succeeded'").bind(owner).first<{ total: number }>();
  return row?.total ?? 0;
}

async function listTopUps(db: D1Database, owner: string): Promise<WorkspaceTopUp[]> {
  const { results } = await db.prepare("SELECT id, amount_micro_usd, status, created_at, settled_at FROM workspace_billing_topups WHERE owner=? ORDER BY created_at DESC LIMIT 10").bind(owner).all<TopUpRow>();
  return results.map((row) => ({ id: row.id, amountUsd: row.amount_micro_usd / MICRO, status: row.status, createdAt: row.created_at, settledAt: row.settled_at }));
}

/**
 * What runs started since billing began cost the deployment: metered compute
 * always, and model spend unless a plan subscription or a paired local
 * daemon carried it.
 */
export function workspaceCreditSpendUsd(runs: DelegatedRun[], since: number, now: number, meter: BudgetMeter): number {
  let total = 0;
  for (const run of runs) {
    if (run.createdAt < since) continue;
    const userFunded = run.authAccount !== undefined || run.runtime === "local";
    total += (userFunded ? 0 : run.usage?.costUsd ?? 0) + meter(run, now).costUsd;
  }
  return total;
}

export interface CreditState { creditedUsd: number; spentUsd: number; balanceUsd: number; exhausted: boolean; since: number }

export async function readCreditState(env: BillingEnv, owner: string, runs: DelegatedRun[], now: number, meter: BudgetMeter): Promise<CreditState> {
  const account = await ensureBillingAccount(env.AGENT_AUDIT, owner, now);
  const creditedUsd = await creditedMicroUsd(env.AGENT_AUDIT, owner) / MICRO;
  const spentUsd = workspaceCreditSpendUsd(runs, account.created_at, now, meter);
  const balanceUsd = creditedUsd - spentUsd;
  return { creditedUsd, spentUsd, balanceUsd, exhausted: balanceUsd <= 0, since: account.created_at };
}

export async function readWorkspaceBilling(env: BillingEnv, owner: string, runs: DelegatedRun[], now: number, meter: BudgetMeter): Promise<WorkspaceBilling> {
  const limits = { minUsd: WORKSPACE_TOP_UP_MIN_USD, maxUsd: WORKSPACE_TOP_UP_MAX_USD };
  const missing = missingBillingConfig(env);
  if (missing.length > 0) {
    return { enabled: false, missing, mode: stripeMode(env), creditedUsd: 0, spentUsd: 0, balanceUsd: 0, exhausted: false, hasCustomer: false, since: null, topUps: [], limits };
  }
  const credit = await readCreditState(env, owner, runs, now, meter);
  const account = await readBillingAccount(env.AGENT_AUDIT, owner);
  return { enabled: true, missing, mode: stripeMode(env), ...credit, hasCustomer: Boolean(account?.stripe_customer_id), topUps: await listTopUps(env.AGENT_AUDIT, owner), limits };
}
