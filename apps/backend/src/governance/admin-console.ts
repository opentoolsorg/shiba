import { audit, listAuditEntries } from "../audit.js";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import type { Env } from "../env.js";
import { isTeamDeploymentOperator } from "../team-member-auth.js";
import { GovernanceError } from "./governance-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

export interface AdminWorkspaceRow {
  workspaceId: string;
  name: string;
  memberCount: number;
  lastActivity: number | null;
}

export async function assertAdminOperator(
  request: Request,
  env: Pick<Env, "AGENT_AUDIT">,
): Promise<void> {
  if (!(await isTeamDeploymentOperator(request, env as Env)))
    throw new GovernanceError("Deployment operator required.", 403);
}

export async function listAdminWorkspaces(env: StoreEnv): Promise<AdminWorkspaceRow[]> {
  const rows = await env
    .AGENT_AUDIT!.prepare(
      `SELECT w.workspace_id AS workspaceId, w.name,
      (SELECT COUNT(*) FROM team_workspace_memberships m WHERE m.tenant_id=w.tenant_id AND m.workspace_id=w.workspace_id AND m.status='active') AS memberCount,
      (SELECT MAX(ts) FROM audit_log WHERE principal=w.workspace_id) AS lastActivity
     FROM team_workspaces w WHERE w.tenant_id=? ORDER BY w.created_at DESC LIMIT 100`,
    )
    .bind(COLLAB_TENANT_ID)
    .all<AdminWorkspaceRow>();
  return rows.results.map((r) => ({ ...r, lastActivity: r.lastActivity ?? null }));
}

export async function listAdminTableSizes(
  env: StoreEnv,
): Promise<{ table: string; rows: number }[]> {
  const names = [
    "team_workspaces",
    "team_workspace_memberships",
    "workspace_groups",
    "workspace_resource_grants",
    "workspace_guests",
    "share_links",
    "audit_log",
  ];
  const out: { table: string; rows: number }[] = [];
  for (const table of names) {
    try {
      const sql =
        table === "audit_log"
          ? `SELECT COUNT(*) AS rows FROM ${table}`
          : `SELECT COUNT(*) AS rows FROM ${table} WHERE tenant_id=?`;
      const row =
        table === "audit_log"
          ? await env.AGENT_AUDIT!.prepare(sql).first<{ rows: number }>()
          : await env.AGENT_AUDIT!.prepare(sql).bind(COLLAB_TENANT_ID).first<{ rows: number }>();
      if (row) out.push({ table, rows: row.rows });
    } catch {
      // Table may be absent in partial fixtures.
    }
  }
  return out;
}

export async function breakGlassAuditRead(
  env: StoreEnv,
  request: Request,
  limit = 200,
): Promise<{ entries: unknown[] }> {
  await assertAdminOperator(request, env);
  const entries = await listAuditEntries(env, { limit });
  void audit(env, {
    principal: "deployment-operator",
    tool: "admin.break_glass_audit",
    argsHash: "0000000000000000000000000000000000000000000000000000000000000000",
    outcome: "ok",
    detail: `limit=${limit}`,
  });
  return { entries };
}
