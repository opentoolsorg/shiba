/**
 * Workspace credits: `GET /api/billing` (balance and recent top-ups),
 * `POST /api/billing/checkout` (Stripe Checkout for a top-up),
 * `POST /api/billing/portal` (Stripe Billing Portal) and the signed
 * `POST /api/billing/stripe/webhook`. The account is the same run store the
 * spending limits govern, so `?session=` scopes both identically.
 */
import { getAgentByName } from "agents/routing";
import { isValidWorkspaceTopUpUsd, WORKSPACE_TOP_UP_MAX_USD, WORKSPACE_TOP_UP_MIN_USD } from "@shiba/shared";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { resolveRunStoreTarget } from "./runs-routes.js";
import { readStoreRuns } from "./usage-routes.js";
import { rejectCrossOriginMutation, rejectNonJsonMutation } from "./dashboard-mutation.js";
import { meterSandboxRun } from "./sandbox-metering.js";
import { resolveInstanceType } from "./instance-type.js";
import {
  closeTopUp, ensureBillingAccount, isWorkspaceBillingEnabled, readWorkspaceBilling, recordPendingTopUp, saveStripeCustomer, settleTopUp,
  stripePost, StripeRequestError, verifyStripeSignature,
} from "./workspace-billing.js";

export const STRIPE_WEBHOOK_PATH = "/api/billing/stripe/webhook";
const TOP_UP_KIND = "shiba_workspace_credits";

function billingError(error: unknown): Response {
  if (error instanceof StripeRequestError) {
    return Response.json({ error: "Stripe rejected the request.", code: error.code }, { status: 502 });
  }
  throw error;
}

async function ownerFor(request: Request, env: Env, url: URL): Promise<string | Response> {
  const resolved = await resolveRunStoreTarget(request, env, url);
  return "error" in resolved ? resolved.error : resolved.agentName;
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
  const owner = await ownerFor(request, env, url);
  if (owner instanceof Response) return owner;

  if (route === "status") {
    const runs = await readStoreRuns(request, env, await getAgentByName(env.CodingOrchestrator, owner));
    if (runs instanceof Response) return runs;
    const now = Date.now();
    const instanceType = resolveInstanceType(env.INSTANCE_TYPE);
    return Response.json({ billing: await readWorkspaceBilling(env, owner, runs, now, (run, at) => meterSandboxRun(run, at, instanceType)) });
  }
  if (!isWorkspaceBillingEnabled(env)) return Response.json({ error: "Billing is not configured on this deployment." }, { status: 503 });
  const returnUrl = `${url.origin}/analytics`;
  const account = await ensureBillingAccount(env.AGENT_AUDIT, owner);

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
  try {
    let customer = account.stripe_customer_id;
    if (!customer) {
      const created = await stripePost<{ id: string }>(env, "customers", { metadata: { shiba_owner: owner } }, `shiba-customer-${account.created_at}-${owner}`.slice(0, 255));
      await saveStripeCustomer(env.AGENT_AUDIT, owner, created.id);
      customer = (await ensureBillingAccount(env.AGENT_AUDIT, owner)).stripe_customer_id ?? created.id;
    }
    const metadata = { kind: TOP_UP_KIND, shiba_owner: owner };
    const session = await stripePost<{ id: string; url: string }>(env, "checkout/sessions", {
      mode: "payment",
      customer,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amountUsd * 100, product_data: { name: "Shiba workspace credits" } } }],
      metadata,
      payment_intent_data: { metadata },
      success_url: `${returnUrl}?billing=success`,
      cancel_url: `${returnUrl}?billing=cancelled`,
    });
    await recordPendingTopUp(env.AGENT_AUDIT, { id: session.id, owner, amountMicroUsd: amountUsd * 1_000_000 });
    return Response.json({ url: session.url });
  } catch (error) {
    return billingError(error);
  }
}

interface CheckoutSessionObject {
  id?: unknown;
  amount_total?: unknown;
  payment_status?: unknown;
  payment_intent?: unknown;
  metadata?: { kind?: unknown; shiba_owner?: unknown } | null;
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (!isWorkspaceBillingEnabled(env)) return Response.json({ error: "Billing is not configured on this deployment." }, { status: 503 });
  const payload = await request.text();
  if (!(await verifyStripeSignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET!.trim()))) {
    return Response.json({ error: "Invalid Stripe signature." }, { status: 400 });
  }
  const event = JSON.parse(payload) as { type?: string; data?: { object?: CheckoutSessionObject } };
  const session = event.data?.object;
  if (!session || typeof session.id !== "string" || session.metadata?.kind !== TOP_UP_KIND || typeof session.metadata.shiba_owner !== "string") {
    return Response.json({ received: true, ignored: true });
  }
  const owner = session.metadata.shiba_owner;
  const paid = event.type === "checkout.session.async_payment_succeeded" ||
    (event.type === "checkout.session.completed" && session.payment_status === "paid");
  if (paid && typeof session.amount_total === "number") {
    const settled = await settleTopUp(env.AGENT_AUDIT, {
      id: session.id, owner, amountMicroUsd: session.amount_total * 10_000,
      paymentIntentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
    });
    return Response.json({ received: true, settled });
  }
  if (event.type === "checkout.session.async_payment_failed" || event.type === "checkout.session.expired") {
    await closeTopUp(env.AGENT_AUDIT, { id: session.id, owner, status: event.type === "checkout.session.expired" ? "expired" : "failed" });
  }
  return Response.json({ received: true });
}
