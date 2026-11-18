import { employeeAccessLevelSchema, type EmployeeAccessGrant, type EmployeeAccessLevel } from "@shiba/shared";
import type { Env } from "../env.js";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";
import { getCustomAgentById } from "../custom-agents-store.js";
import { randomHex } from "../mailbox-store.js";
import { GovernanceError, hashOpaqueToken, listActiveGroupIdsForUser } from "./governance-store.js";

type AccessEnv = Pick<Env, "AGENT_AUDIT">;
const rank: Record<EmployeeAccessLevel, number> = { none: 0, view: 1, chat: 2, manage: 3 };

export function employeeAccessDenial(level: EmployeeAccessLevel, required: EmployeeAccessLevel): Response | null {
  if (level === "none") return Response.json({ error: "Not found." }, { status: 404 });
  if (rank[level] < rank[required]) return Response.json({ error: "Employee access denied." }, { status: 403 });
  return null;
}

export async function listEmployeeAccess(env: AccessEnv, workspaceId: string, employeeId: string): Promise<EmployeeAccessGrant[]> {
  if (!env.AGENT_AUDIT) throw new GovernanceError("Workspace storage unavailable.", 503);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT principal_kind AS principalKind, principal_id AS principalId,
    principal_name AS name, level FROM employee_access WHERE tenant_id=? AND workspace_id=? AND employee_id=?
    ORDER BY principal_kind, principal_id`).bind(COLLAB_TENANT_ID, workspaceId, employeeId).all<EmployeeAccessGrant>();
  return rows.results ?? [];
}

export async function resolveEmployeeAccess(env: AccessEnv, workspaceId: string, employeeId: string, userId: string): Promise<EmployeeAccessLevel> {
  const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
  if (!membership) return "none";
  if (membership.role === "owner" || membership.role === "admin") return "manage";
  const profile = await env.AGENT_AUDIT!.prepare(`SELECT id FROM org_custom_agents WHERE org_id=? AND (id=? OR slug=?) AND deleted_at IS NULL`)
    .bind(`team:${workspaceId}`, employeeId, employeeId).first<{ id: string }>();
  employeeId = profile?.id ?? employeeId;
  const grants = await listEmployeeAccess(env, workspaceId, employeeId);
  const direct = grants.find((grant) => grant.principalKind === "user" && grant.principalId === membership.userId);
  if (direct) return direct.level;
  const groups = grants.some((grant) => grant.principalKind === "group")
    ? await listActiveGroupIdsForUser(env, workspaceId, membership.userId) : [];
  const matching = grants.filter((grant) => grant.principalKind === "group" && groups.includes(grant.principalId));
  if (matching.length) return matching.reduce((best, grant) => rank[grant.level] > rank[best] ? grant.level : best, "none" as EmployeeAccessLevel);
  return grants.find((grant) => grant.principalKind === "everyone")?.level ?? "manage";
}

export async function visibleEmployees<T extends { id: string }>(env: AccessEnv, workspaceId: string, userId: string, employees: T[]): Promise<T[]> {
  return filterEmployeesByAccess(env, { workspaceId, userId }, employees, "view", (employee) => employee.id);
}

export async function filterEmployeesByAccess<T>(
  env: AccessEnv,
  scope: { workspaceId: string; userId: string },
  items: T[],
  required: EmployeeAccessLevel,
  reference: (item: T) => string | null,
): Promise<T[]> {
  if (!scope.workspaceId.startsWith("ws_")) return items;
  const allowed = await Promise.all(items.map(async (item) => {
    const ref = reference(item);
    if (ref === null) return true;
    const key = ref.startsWith("agent:") ? ref.slice(6) : ref;
    const profile = await env.AGENT_AUDIT!.prepare(`SELECT id FROM org_custom_agents WHERE org_id=? AND (id=? OR slug=?) AND deleted_at IS NULL`)
      .bind(`team:${scope.workspaceId}`, key, key).first<{ id: string }>();
    if (!profile) return false;
    return rank[await resolveEmployeeAccess(env, scope.workspaceId, profile.id, scope.userId)] >= rank[required];
  }));
  return items.filter((_, index) => allowed[index]);
}

export async function setEmployeeAccess(env: AccessEnv, workspaceId: string, employeeId: string, actorId: string, input: Record<string, unknown>): Promise<void> {
  const denied = employeeAccessDenial(await resolveEmployeeAccess(env, workspaceId, employeeId, actorId), "manage");
  if (denied) throw new GovernanceError(denied.status === 404 ? "Not found." : "Employee manage access required.", denied.status);
  if (!env.AGENT_AUDIT) throw new GovernanceError("Workspace storage unavailable.", 503);
  const employee = await getCustomAgentById({ AGENT_AUDIT: env.AGENT_AUDIT }, `team:${workspaceId}`, employeeId);
  if (!employee) throw new GovernanceError("Employee not found.", 404);
  const level = employeeAccessLevelSchema.safeParse(input.level);
  const inherit = input.level === "inherit";
  if (!level.success && !inherit) throw new GovernanceError("Invalid employee access level.");
  const kind = input.principalKind;
  if (kind !== "everyone" && kind !== "user" && kind !== "group") throw new GovernanceError("Invalid principal kind.");
  if (inherit && kind === "everyone") throw new GovernanceError("Everyone requires an explicit level.");
  let principalId = typeof input.principalId === "string" ? input.principalId.trim() : "";
  let name = "Everyone";
  if (kind === "everyone") principalId = "*";
  if (kind === "user") {
    principalId = principalId.toLowerCase();
    const member = await getTeamWorkspaceMembership(env, workspaceId, principalId);
    if (!member) throw new GovernanceError("Member not found.", 404);
    name = member.userId;
  }
  if (kind === "group") {
    const group = await env.AGENT_AUDIT.prepare(`SELECT name FROM workspace_groups WHERE tenant_id=? AND workspace_id=? AND group_id=?`)
      .bind(COLLAB_TENANT_ID, workspaceId, principalId).first<{ name: string }>();
    if (!group) throw new GovernanceError("Group not found.", 404);
    name = group.name;
  }
  const before = (await listEmployeeAccess(env, workspaceId, employeeId)).find((grant) => grant.principalKind === kind && grant.principalId === principalId)?.level ?? null;
  const after = level.success ? level.data : null;
  if (before === after) return;
  const detail = JSON.stringify({ workspaceId, employeeId, employeeName: employee.config.name, actorName: actorId, principalKind: kind, principalId, principalName: name, before, after });
  await env.AGENT_AUDIT.batch([
    inherit ? env.AGENT_AUDIT.prepare(`DELETE FROM employee_access WHERE tenant_id=? AND workspace_id=? AND employee_id=? AND principal_kind=? AND principal_id=?`)
      .bind(COLLAB_TENANT_ID, workspaceId, employeeId, kind, principalId) : env.AGENT_AUDIT.prepare(`INSERT INTO employee_access (tenant_id,workspace_id,employee_id,principal_kind,principal_id,principal_name,level)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id,workspace_id,employee_id,principal_kind,principal_id)
      DO UPDATE SET principal_name=excluded.principal_name, level=excluded.level`)
      .bind(COLLAB_TENANT_ID, workspaceId, employeeId, kind, principalId, name, after),
    env.AGENT_AUDIT.prepare(`INSERT INTO audit_log (id,ts,principal,tool,args_hash,outcome,detail) VALUES (?,?,?,?,?,?,?)`)
      .bind(`aud-${randomHex(16)}`, Date.now(), actorId, "employee.access.changed", await hashOpaqueToken(detail), "ok", detail),
  ]);
}
