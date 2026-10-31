import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";

export interface SpaceIndexRow {
  id: string;
  orgId: string;
  name: string;
  template: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

const TABLE = `CREATE TABLE IF NOT EXISTS spaces_index (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const initialized = new WeakSet<D1Database>();

async function ensureTables(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  await env.AGENT_AUDIT.prepare(TABLE).run();
  initialized.add(env.AGENT_AUDIT);
}

function fromRow(row: Record<string, unknown>): SpaceIndexRow | null {
  if (
    typeof row.id !== "string" ||
    typeof row.org_id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.template !== "string" ||
    typeof row.created_by !== "string" ||
    !Number.isFinite(Number(row.created_at)) ||
    !Number.isFinite(Number(row.updated_at))
  ) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    template: row.template,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function insertSpaceIndex(env: AuditEnv, row: SpaceIndexRow): Promise<void> {
  await ensureTables(env);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO spaces_index (id, org_id, name, template, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.id, row.orgId, row.name, row.template, row.createdBy, row.createdAt, row.updatedAt).run();
}

export async function listSpacesIndex(env: AuditEnv, orgId: string): Promise<SpaceIndexRow[]> {
  await ensureTables(env);
  const rows = await env.AGENT_AUDIT.prepare(
    "SELECT id, org_id, name, template, created_by, created_at, updated_at FROM spaces_index WHERE org_id = ? ORDER BY updated_at DESC",
  ).bind(orgId).all();
  return (rows.results ?? []).map((row) => fromRow(row as Record<string, unknown>)).filter((row): row is SpaceIndexRow => row !== null);
}

export async function getSpaceIndex(env: AuditEnv, orgId: string, id: string): Promise<SpaceIndexRow | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT id, org_id, name, template, created_by, created_at, updated_at FROM spaces_index WHERE org_id = ? AND id = ?",
  ).bind(orgId, id).first();
  return row ? fromRow(row as Record<string, unknown>) : null;
}

export async function updateSpaceIndexName(env: AuditEnv, orgId: string, id: string, name: string, updatedAt: number): Promise<boolean> {
  await ensureTables(env);
  const result = await env.AGENT_AUDIT.prepare(
    "UPDATE spaces_index SET name = ?, updated_at = ? WHERE org_id = ? AND id = ?",
  ).bind(name, updatedAt, orgId, id).run();
  return result.meta.changes === 1;
}

export async function deleteSpaceIndex(env: AuditEnv, orgId: string, id: string): Promise<boolean> {
  await ensureTables(env);
  const result = await env.AGENT_AUDIT.prepare(
    "DELETE FROM spaces_index WHERE org_id = ? AND id = ?",
  ).bind(orgId, id).run();
  return result.meta.changes === 1;
}
