import type { Env } from "./env.js";
import { resolveOrgForApiRequest, type ResolvedOrgAuth } from "./org-request-auth.js";
import { rejectCrossOriginMutation } from "./dashboard-mutation.js";

import type { TeamSkillGrant } from "./team-skill-grant.js";

export function skillTeamGrant(auth: ResolvedOrgAuth | null): TeamSkillGrant | undefined {
  const team = auth?.workspace;
  return team && team.role !== "member"
    ? { workspaceId: team.workspaceId, userId: team.userId, version: team.version, role: team.role } : undefined;
}

/** Never return a stored body or stale permissions after the grant changes. */
export async function withCurrentSkillAuthority(request: Request, env: Env, auth: ResolvedOrgAuth | null, operation: () => Promise<Response | null>, options: { allowMemberWrite?: boolean } = {}): Promise<Response | null> {
  if (auth?.orgId.startsWith("team:") && !auth.workspace) {
    return Response.json({ error: "Team skills require an authenticated workspace membership." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (auth?.workspace && !["GET", "HEAD"].includes(request.method)) {
    const blocked = rejectCrossOriginMutation(request);
    if (blocked) return blocked;
  }
  let response: Response | null = null, failure: unknown;
  try { response = await operation(); } catch (error) { failure = error; }
  if (auth?.workspace) {
    const latest = await resolveOrgForApiRequest(request, env, options);
    if (latest instanceof Response) return latest;
    const previous = auth.workspace, current = latest.workspace;
    if (!current || latest.orgId !== auth.orgId || current.workspaceId !== previous.workspaceId ||
      current.userId !== previous.userId || current.role !== previous.role || current.version !== previous.version) {
      return Response.json({ error: "Workspace authority changed. Refresh before continuing." }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
  }
  if (failure instanceof Error && failure.message === "workspace_authority_changed") {
    return Response.json({ error: "Workspace authority changed. Refresh before continuing." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (failure !== undefined) throw failure;
  return response;
}
