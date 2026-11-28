/**
 * Workspace credits: `GET /api/billing` (balance and recent top-ups),
 * `POST /api/billing/checkout` (Stripe Checkout for a top-up),
 * `POST /api/billing/portal` (Stripe Billing Portal) and the signed
 * `POST /api/billing/stripe/webhook`.
 *
 * Credits belong to the paying user for personal work, or to a team
 * workspace when the request names one the caller belongs to. Both keys are
 * resolved server-side; nothing here trusts a client-supplied owner.
 */
import { isTeamWorkspaceId, isValidWorkspaceTopUpUsd, WORKSPACE_TOP_UP_MAX_USD, WORKSPACE_TOP_UP_MIN_USD } from "@shiba/shared";
import type { Env } from "./env.js";
import { audit } from "./audit.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { getTeamWorkspaceMembership } from "./team-workspaces-store.js";
import { COLLAB_WORKSPACE_ID } from "./collaboration-store.js";
import { logStructured } from "./log.js";
import { personalBillingSubject, teamBillingSubject, type BillingSubject } from "./billing-subject.js";
import {
  closeTopUp, ensureBillingAccount, findTopUp, isWorkspaceBillingEnabled, readBillingAccount, readWorkspaceBilling, recordPendingTopUp, recordRefund, saveStripeCustomer,
  settleTopUp, stripePost, StripeRequestError, verifyStripeSignature,
} from "./workspace-billing.js";

export const STRIPE_WEBHOOK_PATH = "/api/billing/stripe/webhook";
const TOP_UP_KIND = "shiba_workspace_credits";
const ROLES_WHO_BUY = new Set(["owner", "admin"]);

function billingError(error: unknown): Response {
  if (error instanceof StripeRequestError) {
    return Response.json({ error: "Stripe rejected the request.", code: error.code }, { status: 502 });
  }
  throw error;
}

/**
 * The subject this request bills to: a team workspace it must belong to (and
 * may pay for), otherwise the caller's own account.
 */
async function billingSubject(request: Request, env: Env, userId: string, purpose: "read" | "pay"): Promise<BillingSubject | Response> {
  const requested = new URL(request.url).searchParams.get("workspace") ?? request.headers.get("X-Shiba-Workspace");
  if (requested !== null && requested !== COLLAB_WORKSPACE_ID) {
    if (!isTeamWorkspaceId(requested)) return Response.json({ error: "Unknown workspace." }, { status: 404 });
    const membership = await getTeamWorkspaceMembership(env, requested, userId);
    if (membership === null) return Response.json({ error: "You are not a member of this workspace." }, { status: 403 });
    if (purpose === "pay" && !ROLES_WHO_BUY.has(membership.role)) {
      return Response.json({ error: "Only a workspace owner or admin can add credits for it." }, { status: 403 });
    }
    return teamBillingSubject(requested);
  }
  return personalBillingSubject(userId);
}

export async function handleWorkspaceBilling(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === STRIPE_WEBHOOK_PATH) return handleStripeWebhook(request, env);
  const route = url.pathname === "/api/billing" ? "status"
    : url.pathname === "/api/billing/checkout" ? "checkout"
    : url.pathname === "/api/billing/portal" ? "portal" : null;
  if (route === null) return null;
  if (!(await isAuthorizedRequest(request, env))) return Response.json({ error: "Authentication required." }, { status: 401 });
  if (request.method !== (route === "status" ? "GET" : "POST")) return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (route !== "status") {
    const rejected = rejectCrossOriginMutation(request) ?? rejectNonJsonMutation(request);
    if (rejected) return rejected;
  }
  const resolved = await resolveRunStoreTarget(request, env, url);
  if ("error" in resolved) return resolved.error;
  const subject = await billingSubject(request, env, resolved.userId, route === "status" ? "read" : "pay");
  if (subject instanceof Response) return subject;

  if (route === "status") {
    return Response.json({ billing: await readWorkspaceBilling(env, subject.key, Date.now()) });
  }
  if (!isWorkspaceBillingEnabled(env)) return Response.json({ error: "Billing is not configured on this deployment." }, { status: 503 });
  const returnUrl = subject.scope === "team" ? `${url.origin}/settings/?section=team&teamTab=settings` : `${url.origin}/analytics`;
  const account = await ensureBillingAccount(env.AGENT_AUDIT, subject.key, Date.now());

  if (route === "portal") {
    if (!account.stripe_customer_id) return Response.json({ error: "Add credits once before managing billing." }, { status: 409 });
    try {
      const portal = await stripePost<{ url: string }>(env, "billing_portal/sessions", {
        customer: account.stripe_customer_id, return_url: returnUrl,
        ...(env.STRIPE_PORTAL_CONFIGURATION_ID?.trim() ? { configuration: env.STRIPE_PORTAL_CONFIGURATION_ID.trim() } : {}),
      });
      return Response.json({ url: portal.url });
    } catch (error) {
      return billingError(error);
    }
  }

  const input = await request.json().catch(() => null) as { amountUsd?: unknown } | null;
  if (!isValidWorkspaceTopUpUsd(input?.amountUsd)) {
    return Response.json({ error: `Top-ups are whole dollars from $${WORKSPACE_TOP_UP_MIN_USD} to $${WORKSPACE_TOP_UP_MAX_USD}.` }, { status: 400 });
  }
  const amountUsd = input.amountUsd;
  const publicId = `top_${crypto.randomUUID().replaceAll("-", "")}`;
  try {
    let customer = account.stripe_customer_id;
    if (!customer) {
      const created = await stripePost<{ id: string }>(env, "customers", { metadata: { shiba_subject: subject.key } }, `shiba-customer-${account.created_at}-${subject.key}`.slice(0, 255));
      await saveStripeCustomer(env.AGENT_AUDIT, subject.key, created.id);
      customer = (await ensureBillingAccount(env.AGENT_AUDIT, subject.key, Date.now())).stripe_customer_id ?? created.id;
    }
    const metadata = { kind: TOP_UP_KIND, shiba_subject: subject.key, shiba_topup: publicId };
    const session = await stripePost<{ id: string; url: string }>(env, "checkout/sessions", {
      mode: "payment",
      customer,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amountUsd * 100, product_data: { name: "Shiba workspace credits" } } }],
      metadata,
      payment_intent_data: { metadata },
      success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=success`,
      cancel_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}billing=cancelled`,
    });
    await recordPendingTopUp(env.AGENT_AUDIT, { publicId, sessionId: session.id, subject: subject.key, amountMicroUsd: amountUsd * 1_000_000 });
    return Response.json({ url: session.url });
  } catch (error) {
    return billingError(error);
  }
}

interface CheckoutSessionObject {
  id?: unknown;
  customer?: unknown;
  amount_total?: unknown;
  payment_status?: unknown;
  payment_intent?: unknown;
  metadata?: { kind?: unknown; shiba_subject?: unknown; shiba_topup?: unknown } | null;
}

interface RefundChargeObject {
  payment_intent?: unknown;
  amount_refunded?: unknown;
  refunds?: { data?: { id?: unknown; amount?: unknown }[] } | null;
}

/**
 * A paid session with no matching row means the Worker's write was lost. The
 * credits still belong to someone, so record them from the signed event and
 * reconcile, as long as it names a subject the Worker itself wrote. Anything
 * else is logged and answered non-2xx so it reaches Stripe's retries.
 */
async function reconcilePaidSession(env: Env, session: CheckoutSessionObject, sessionId: string, amountMicroUsd: number, paymentIntentId: string | null): Promise<boolean> {
  const subject = session.metadata?.shiba_subject;
  if (typeof subject !== "string" || subject.trim() === "") {
    logStructured("error", { event: "billing.unmatched_paid_session", detail: `session=${sessionId} reason=missing_subject` });
    return false;
  }
  // Signed metadata alone proves nothing: the session must belong to the
  // customer this Worker already recorded for that subject, or it is not ours.
  const account = await readBillingAccount(env.AGENT_AUDIT, subject.slice(0, 256));
  if (account === null || account.stripe_customer_id === null || typeof session.customer !== "string" || session.customer !== account.stripe_customer_id) {
    logStructured("error", { event: "billing.unmatched_paid_session", detail: `session=${sessionId} reason=foreign_customer` });
    return false;
  }
  const publicId = typeof session.metadata?.shiba_topup === "string" ? session.metadata.shiba_topup : `top_${crypto.randomUUID().replaceAll("-", "")}`;
  await recordPendingTopUp(env.AGENT_AUDIT, { publicId, sessionId, subject: subject.slice(0, 256), amountMicroUsd });
  const settled = await settleTopUp(env.AGENT_AUDIT, { sessionId, subject, amountMicroUsd, paymentIntentId });
  logStructured("warn", { event: "billing.reconciled_paid_session", detail: `session=${sessionId} settled=${String(settled)}` });
  await audit(env, { principal: "stripe", tool: "billing.topup.reconciled", argsHash: await hashOf(sessionId), outcome: settled ? "ok" : "skipped" }).catch(() => undefined);
  return settled;
}

async function hashOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (!isWorkspaceBillingEnabled(env)) return Response.json({ error: "Billing is not configured on this deployment." }, { status: 503 });
  const payload = await request.text();
  if (!(await verifyStripeSignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET!.trim()))) {
    return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }
  const event = JSON.parse(payload) as { id?: string; type?: string; data?: { object?: CheckoutSessionObject & RefundChargeObject } };
  const object = event.data?.object ?? {};
  if (event.type === "charge.refunded") return handleRefund(env, object);

  const session = object as CheckoutSessionObject;
  if (typeof session.id !== "string") return Response.json({ received: true, ignored: true });
  // Any other Checkout traffic on this Stripe account is not ours: acknowledge
  // it so Stripe neither retries nor disables the endpoint.
  if (session.metadata?.kind !== TOP_UP_KIND) return Response.json({ received: true, ignored: true });
  const paid = event.type === "checkout.session.async_payment_succeeded" ||
    (event.type === "checkout.session.completed" && session.payment_status === "paid");
  if (!paid) {
    if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
      const known = await findTopUp(env.AGENT_AUDIT, { sessionId: session.id });
      if (known !== null) await closeTopUp(env.AGENT_AUDIT, { sessionId: session.id, subject: known.subject, status: event.type === "checkout.session.expired" ? "expired" : "failed" });
    }
    return Response.json({ received: true });
  }
  if (typeof session.amount_total !== "number") {
    logStructured("error", { event: "billing.unmatched_paid_session", detail: `session=${session.id} reason=missing_amount` });
    return Response.json({ error: "Paid session has no amount." }, { status: 500 });
  }
  const amountMicroUsd = session.amount_total * 10_000;
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
  const known = await findTopUp(env.AGENT_AUDIT, { sessionId: session.id });
  if (known !== null) {
    const settled = await settleTopUp(env.AGENT_AUDIT, { sessionId: session.id, subject: known.subject, amountMicroUsd: known.amountMicroUsd, paymentIntentId });
    return Response.json({ received: true, settled });
  }
  const reconciled = await reconcilePaidSession(env, session, session.id, amountMicroUsd, paymentIntentId);
  return reconciled ? Response.json({ received: true, settled: true, reconciled: true })
    : Response.json({ error: "Payment could not be matched to a workspace." }, { status: 500 });
}

/**
 * A refund removes the credits it reverses. Stripe's `amount_refunded` is the
 * running total for the payment, so partials in any order and redeliveries all
 * reconcile to the same total. A refund for a payment this Worker never
 * recorded is someone else's Stripe traffic: acknowledge it so Stripe neither
 * retries nor disables the endpoint.
 */
async function handleRefund(env: Env, charge: RefundChargeObject): Promise<Response> {
  const paymentIntentId = typeof charge.payment_intent === "string" ? charge.payment_intent : null;
  const topUp = paymentIntentId === null ? null : await findTopUp(env.AGENT_AUDIT, { paymentIntentId });
  if (topUp === null || paymentIntentId === null) return Response.json({ received: true, ignored: true });
  const refundedCents = typeof charge.amount_refunded === "number" ? charge.amount_refunded
    : typeof charge.refunds?.data?.[0]?.amount === "number" ? charge.refunds.data[0].amount : null;
  if (refundedCents === null || refundedCents <= 0) {
    logStructured("error", { event: "billing.unmatched_refund", detail: `payment=${paymentIntentId} reason=missing_amount` });
    return Response.json({ error: "Refund has no amount." }, { status: 500 });
  }
  const removedMicroUsd = await recordRefund(env.AGENT_AUDIT, { subject: topUp.subject, paymentIntentId, refundedSoFarMicroUsd: refundedCents * 10_000 });
  logStructured("info", { event: "billing.refund_recorded", detail: `payment=${paymentIntentId} removed=${String(removedMicroUsd)}` });
  return Response.json({ received: true, removedMicroUsd });
}
