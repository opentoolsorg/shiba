import { z } from "zod";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import { listCustomAgents } from "../custom-agents-store.js";
import { randomHex } from "../mailbox-store.js";
import { GovernanceError, hashOpaqueToken } from "./governance-store.js";

const updateSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  allowedEmployeeIds: z.array(z.string().regex(/^cag-[a-f0-9]{24}$/)).max(32),
});

export async function employeeDelegationAccess(
  db: D1Database,
  scope: { workspaceId: string; employeeId: string; actorId: string; membershipVersion: number },
  input?: unknown,
) {
  const { workspaceId, employeeId, actorId, membershipVersion } = scope;
  const orgId = `team:${workspaceId}`;
  const key = [COLLAB_TENANT_ID, workspaceId, employeeId] as const;
  const candidates = (await listCustomAgents({ AGENT_AUDIT: db }, orgId))
    .filter((agent) => agent.id !== employeeId)
    .map((agent) => ({ id: agent.id, name: agent.config.name }));
  const row = await db.prepare("SELECT revision, allowed_employee_ids_json FROM employee_delegation_access WHERE tenant_id=? AND workspace_id=? AND employee_id=?")
    .bind(...key).first<{ revision: number; allowed_employee_ids_json: string }>();
  const revision = row?.revision ?? 0;
  const current = row ? JSON.parse(row.allowed_employee_ids_json) as string[] : [];
  const validIds = new Set(candidates.map(({ id }) => id));
  if (input === undefined) return { revision, candidates, allowedEmployeeIds: current.filter((id) => validIds.has(id)) };

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new GovernanceError("Provide a revision and at most 32 employee IDs.");
  const allowedEmployeeIds = [...new Set(parsed.data.allowedEmployeeIds)].sort();
  if (allowedEmployeeIds.length !== parsed.data.allowedEmployeeIds.length || allowedEmployeeIds.some((id) => !validIds.has(id))) {
    throw new GovernanceError("Choose distinct, active employees from this workspace other than the recipient.");
  }
  if (parsed.data.expectedRevision !== revision) throw new GovernanceError("Incoming access changed. Reload the employee and try again.", 409);
  const next = revision + 1;
  const encoded = JSON.stringify(allowedEmployeeIds);
  const detail = JSON.stringify({ workspaceId, employeeId, revision: next, before: current, after: allowedEmployeeIds });
  const [write] = await db.batch([
    db.prepare(`INSERT INTO employee_delegation_access (tenant_id,workspace_id,employee_id,revision,allowed_employee_ids_json)
      SELECT ?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=? AND user_id=? AND version=? AND status='active' AND role IN ('owner','admin'))
        AND EXISTS (SELECT 1 FROM org_custom_agents WHERE org_id=? AND id=? AND archived_at IS NULL AND deleted_at IS NULL)
        AND (SELECT count(*) FROM org_custom_agents a JOIN json_each(?) j ON a.id=j.value WHERE a.org_id=? AND a.archived_at IS NULL AND a.deleted_at IS NULL)=?
      ON CONFLICT(tenant_id,workspace_id,employee_id) DO UPDATE SET revision=excluded.revision,allowed_employee_ids_json=excluded.allowed_employee_ids_json
      WHERE employee_delegation_access.revision=?`)
      .bind(...key, next, encoded, COLLAB_TENANT_ID, workspaceId, actorId, membershipVersion, orgId, employeeId,
        encoded, orgId, allowedEmployeeIds.length, revision),
    db.prepare(`INSERT INTO audit_log (id,ts,principal,tool,args_hash,outcome,detail)
      SELECT ?,?,?,'employee.delegation_access.changed',?,'ok',? WHERE changes()=1`)
      .bind(`aud-${randomHex(16)}`, Date.now(), actorId, await hashOpaqueToken(detail), detail),
  ]);
  if (write?.meta.changes !== 1) throw new GovernanceError("Incoming access changed. Reload the employee and try again.", 409);
  return { revision: next, candidates, allowedEmployeeIds };
}
