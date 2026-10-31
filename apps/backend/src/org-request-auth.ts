import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { initiatorUserIdFromOrchestratorName } from "./subscription-routing.js";
import { authorizeV1Request, type V1Principal, v1Unauthorized } from "./v1-auth.js";

export const DASHBOARD_ORG_ID = "self-hosted";

export interface ResolvedOrgAuth {
  orgId: string;
  principal: V1Principal | null;
}

/**
 * Org scope for dashboard session and /api/v1 bearer keys — same rule as
 * `/api/custom-agents` and `/api/org/sandbox`.
 */
export async function resolveOrgForApiRequest(
  request: Request,
  env: Env,
): Promise<ResolvedOrgAuth | Response> {
  // An explicit credential must keep its own org and scopes even when an
  // ambient dashboard session (or loopback development) is also authorized.
  if (!request.headers.has("authorization") && await isAuthorizedRequest(request, env)) {
    return { orgId: DASHBOARD_ORG_ID, principal: null };
  }
  const principal = await authorizeV1Request(request, env);
  if (!principal) return v1Unauthorized();
  return { orgId: principal.orgId, principal };
}

export function orgIdFromIntake(input: Record<string, unknown>): string {
  const raw = typeof input.orgId === "string" ? input.orgId.trim() : "";
  if (!raw || raw.length > 128) return DASHBOARD_ORG_ID;
  return raw;
}

/** Dashboard/web sessions bind org scope to the authenticated owner, not composer metadata. */
export function intakeOrgIdForOrchestrator(
  orchestratorName: string | null | undefined,
  input: Record<string, unknown>,
): string {
  const initiator = initiatorUserIdFromOrchestratorName(orchestratorName ?? undefined);
  if (initiator) return initiator;
  return orgIdFromIntake(input);
}
