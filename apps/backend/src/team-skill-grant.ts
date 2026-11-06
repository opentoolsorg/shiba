export interface TeamMembershipGrant {
  workspaceId: string;
  userId: string;
  version: number;
  role: "owner" | "admin" | "member";
}
export interface TeamSkillGrant extends TeamMembershipGrant { role: "owner" | "admin" }
export interface SkillMutationOptions { teamGrant?: TeamSkillGrant }

/** The grant and mutation must be checked in one database statement. */
export function teamSkillWriteGuard(orgId: string, userId: string, grant?: TeamSkillGrant): { sql: string; values: unknown[] } {
  return teamMembershipWriteGuard(orgId, userId, grant);
}

/** Member grants may update their own scoped planning draft, never team skills. */
export function teamMembershipWriteGuard(orgId: string, userId: string, grant?: TeamMembershipGrant, allowMember = false): { sql: string; values: unknown[] } {
  if (!grant) {
    if (orgId.startsWith("team:")) throw new Error("workspace_authority_changed");
    return { sql: "", values: [] };
  }
  if (orgId !== `team:${grant.workspaceId}` || userId !== grant.userId) throw new Error("workspace_authority_changed");
  return {
    sql: ` AND EXISTS (SELECT 1 FROM team_workspace_memberships WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND role IN (${allowMember ? "'owner','admin','member'" : "'owner','admin'"}) AND role = ? AND version = ?)`,
    values: [grant.workspaceId, grant.userId, grant.role, grant.version],
  };
}

