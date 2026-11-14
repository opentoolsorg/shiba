import { audit, listAuditEntries } from "../audit.js";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import type { Env } from "../env.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";
import { GovernanceError, newAuditExportId } from "./governance-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT" | "ARTIFACTS" | "ARTIFACT_SIGNING_KEY" | "WORKER_HOSTNAME">;

const EXPORT_TTL_MS = 15 * 60 * 1000;

export async function createWorkspaceAuditExport(
  env: StoreEnv,
  workspaceId: string,
  ownerId: string,
  now = Date.now(),
): Promise<{ exportId: string; downloadPath: string; rowCount: number; expiresAt: number }> {
  if (!/^ws_[a-f0-9]{24}$/.test(workspaceId))
    throw new GovernanceError("Workspace not found.", 404);
  const membership = await getTeamWorkspaceMembership(env, workspaceId, ownerId);
  if (!membership || membership.role !== "owner")
    throw new GovernanceError("Workspace owner required.", 403);
  if (!env.ARTIFACTS) throw new GovernanceError("Audit export storage is unavailable.", 503);
  const entries = await listAuditEntries(env, { limit: 10_000, principal: workspaceId });
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  const bytes = new TextEncoder().encode(lines);
  const exportId = newAuditExportId();
  const objectKey = `audit-exports/${workspaceId}/${exportId}.ndjson`;
  await env.ARTIFACTS.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  const sha256 = await crypto.subtle
    .digest("SHA-256", bytes)
    .then((d) => Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join(""));
  const expiresAt = now + EXPORT_TTL_MS;
  await env
    .AGENT_AUDIT!.prepare(
      `INSERT INTO workspace_audit_exports(tenant_id,workspace_id,export_id,requested_by,object_key,row_count,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      COLLAB_TENANT_ID,
      workspaceId,
      exportId,
      ownerId,
      objectKey,
      entries.length,
      now,
      expiresAt,
    )
    .run();
  void audit(env, {
    principal: ownerId,
    tool: "governance.audit_export",
    argsHash: sha256,
    outcome: "ok",
    detail: workspaceId,
    ts: now,
  });
  return {
    exportId,
    downloadPath: `/api/governance/${workspaceId}/audit-export/${exportId}/download`,
    rowCount: entries.length,
    expiresAt,
  };
}

export async function streamWorkspaceAuditExport(
  env: StoreEnv,
  workspaceId: string,
  ownerId: string,
  exportId: string,
  now = Date.now(),
): Promise<Response> {
  if (!/^ws_[a-f0-9]{24}$/.test(workspaceId))
    throw new GovernanceError("Workspace not found.", 404);
  const membership = await getTeamWorkspaceMembership(env, workspaceId, ownerId);
  if (!membership || membership.role !== "owner")
    throw new GovernanceError("Workspace owner required.", 403);
  const row = await env
    .AGENT_AUDIT!.prepare(
      `SELECT object_key AS objectKey, expires_at AS expiresAt FROM workspace_audit_exports
     WHERE tenant_id=? AND workspace_id=? AND export_id=?`,
    )
    .bind(COLLAB_TENANT_ID, workspaceId, exportId)
    .first<{ objectKey: string; expiresAt: number }>();
  if (!row || row.expiresAt <= now) throw new GovernanceError("Export not found or expired.", 404);
  if (!env.ARTIFACTS) throw new GovernanceError("Audit export storage is unavailable.", 503);
  const object = await env.ARTIFACTS.get(row.objectKey);
  if (!object) throw new GovernanceError("Export not found or expired.", 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="audit-${exportId}.ndjson"`,
    },
  });
}
