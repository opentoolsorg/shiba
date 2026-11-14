import { resolveBetterAuthSessionAccount } from "@shiba/auth/better-auth";
import { operatorEnrollmentDecisionSchema } from "@shiba/shared";
import { boundedBody } from "@shiba/openconnector-read-gateway";
import type { Env } from "./env.js";
import { rejectCrossOriginMutation } from "./dashboard-mutation.js";
import { requireJsonContentType } from "./request-auth.js";
import { redactSecrets } from "./security.js";
import { decideOperatorEnrollment, listOperatorEnrollments, OperatorEnrollmentError, type OperatorEnrollmentOwner } from "./operator-enrollment-store.js";

const BASE = "/api/operator-enrollment-reviews";
const json = (body: unknown, status = 200) => Response.json(body, { status,
  headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });

/** Owner metadata review only. There is no proposal upload, grant or execute endpoint. */
export async function handleOperatorEnrollmentReviews(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
  if (url.search || request.headers.has("X-Shiba-Workspace") || request.headers.has("Authorization") || !request.headers.has("Cookie"))
    return json({ error: "operator_review_native_personal_owner_required" }, 403);
  if (request.method !== "GET") {
    const denied = rejectCrossOriginMutation(request) ?? requireJsonContentType(request);
    if (denied) return denied;
  }
  const session = await resolveBetterAuthSessionAccount(request, env, redactSecrets);
  if (!session?.sessionId || !session.sessionExpiresAt || session.sessionExpiresAt <= Date.now()) {
    return json({ error: "operator_review_native_personal_owner_required" }, 403);
  }
  if (session.policy.kind !== "bootstrap") {
    return json({ error: "operator_review_native_personal_owner_required" }, 403);
  }
  if (!session.emailVerified) {
    return json({ error: "email_not_verified", code: "email_not_verified" }, 403);
  }
  const owner: OperatorEnrollmentOwner = { ownerId: session.policy.email, accountId: session.policy.accountId,
    sessionId: session.sessionId, sessionExpiresAt: session.sessionExpiresAt };
  const suffix = url.pathname.slice(BASE.length);
  const decision = /^\/(oe_[a-f0-9]{32})\/decision$/.exec(suffix);
  const enabled = env.OPEN_CONNECTOR_OPERATOR_REVIEW_ENABLED === "true";
  try {
    if (request.method === "GET" && suffix === "") {
      // A disabled deployment does not require the optional review migration.
      return json({ actorId: owner.ownerId, ownerAccountId: owner.accountId, enabled, executionAvailable: false, proposals: enabled ? await listOperatorEnrollments(env, owner) : [] });
    }
    if (request.method !== "POST" || !decision?.[1]) return json({ error: "operator_review_route_unavailable" }, 404);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await boundedBody(request.body, 2048))); }
    catch { return json({ error: "operator_review_request_invalid" }, 400); }
    const parsed = operatorEnrollmentDecisionSchema.safeParse(input);
    if (!parsed.success) return json({ error: "operator_review_request_invalid" }, 400);
    await decideOperatorEnrollment(env, owner, decision[1], parsed.data);
    return json({ actorId: owner.ownerId, ownerAccountId: owner.accountId, enabled, executionAvailable: false, proposals: await listOperatorEnrollments(env, owner) });
  } catch (error) {
    if (error instanceof OperatorEnrollmentError) return json({ error: error.code }, error.status);
    return json({ error: "operator_review_unavailable" }, 503);
  }
}
