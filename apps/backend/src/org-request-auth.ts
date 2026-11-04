import type { Env } from "./env.js";
import { isAuthorizedRequest, resolveUserId } from "./request-auth.js";
import { isTeamWorkspaceId, type TeamWorkspaceMembership } from "@shiba/shared";
import { getTeamWorkspaceMembership } from "./team-workspaces-store.js";
import { isRestrictedTeamMember } from "./team-member-auth.js";
import { authorizeV1Request, type V1Principal, v1Unauthorized } from "./v1-auth.js";
import { isDashboardAgentName } from "./web-sessions.js";

export const DASHBOARD_ORG_ID = "self-hosted";

export interface ResolvedOrgAuth {
  orgId: string;
  principal: V1Principal | null;
  workspace?: TeamWorkspaceMembership;
}

/**
 * Org scope for dashboard session and /api/v1 bearer keys — same rule as
 * `/api/custom-agents` and `/api/org/sandbox`.
 */
export async function resolveOrgForApiRequest(
  request: Request,
  env: Env,
  options: { allowMemberWrite?: boolean } = {},
): Promise<ResolvedOrgAuth | Response> {
  // An explicit credential must keep its own org and scopes even when an
  // ambient dashboard session (or loopback development) is also authorized.
  if (!request.headers.has("authorization") && await isAuthorizedRequest(request, env)) {
    const workspaceId = request.headers.get("X-Shiba-Workspace");
    if (workspaceId !== null) {
      if (!isTeamWorkspaceId(workspaceId)) return Response.json({ error: "Workspace not found." }, { status: 404 });
      const userId = await resolveUserId(request, env);
      if (!userId) return Response.json({ error: "Authentication required." }, { status: 401 });
      if (!env.AGENT_AUDIT) return Response.json({ error: "Workspace storage is unavailable." }, { status: 503 });
      let membership: TeamWorkspaceMembership | null;
      try { membership = await getTeamWorkspaceMembership(env, workspaceId, userId); }
      catch { return Response.json({ error: "Workspace access is unavailable." }, { status: 404 }); }
      if (!membership) return Response.json({ error: "Workspace access is unavailable." }, { status: 404 });
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !options.allowMemberWrite && membership.role === "member")
        return Response.json({ error: "Workspace owner or admin permission is required." }, { status: 403 });
      return { orgId: `team:${workspaceId}`, principal: null, workspace: membership };
    }
    if (env.BETTER_AUTH_SECRET && await isRestrictedTeamMember(request, env))
      return Response.json({ error: "Select an active team workspace." }, { status: 403 });
    return { orgId: DASHBOARD_ORG_ID, principal: null };
  }
  const principal = await authorizeV1Request(request, env);
  if (!principal) return v1Unauthorized();
  if (request.headers.has("X-Shiba-Workspace"))
    return Response.json({ error: "Workspace selectors cannot override an API credential." }, { status: 403 });
  return { orgId: principal.orgId, principal };
}

export function orgIdFromIntake(input: Record<string, unknown>): string {
  const raw = typeof input.orgId === "string" ? input.orgId.trim() : "";
  if (!raw || raw.length > 128) return DASHBOARD_ORG_ID;
  return raw;
}

/** Dashboard resources use the dashboard API org; ownership stays on the verified initiator. */
export function intakeOrgIdForOrchestrator(
  orchestratorName: string | null | undefined,
  input: Record<string, unknown>,
): string {
  if (isDashboardAgentName(orchestratorName ?? undefined)) return DASHBOARD_ORG_ID;
  return orgIdFromIntake(input);
}

/** Dashboard orchestrators ignore client org overrides; other lanes keep intake orgId. */
export function trustedIntakeOrgId(
  orchestratorName: string | undefined,
  input: Record<string, unknown>,
): string {
  if (isDashboardAgentName(orchestratorName)) return DASHBOARD_ORG_ID;
  return orgIdFromIntake(input);
}
