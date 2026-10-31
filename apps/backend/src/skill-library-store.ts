import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";

export interface SkillInstallRow {
  orgId: string;
  librarySlug: string;
  libraryVersion: string;
  skillId: string;
  installedBy: string;
  installedAt: number;
}

const TABLE = `CREATE TABLE IF NOT EXISTS skill_installs (
  org_id TEXT NOT NULL,
  library_slug TEXT NOT NULL,
  library_version TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, installed_by, library_slug)
)`;

const initialized = new WeakSet<D1Database>();

async function ensureTables(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  await env.AGENT_AUDIT.prepare(TABLE).run();
  initialized.add(env.AGENT_AUDIT);
}

function rowFromRecord(row: Record<string, unknown>): SkillInstallRow | null {
  if (
    typeof row.org_id !== "string" ||
    typeof row.library_slug !== "string" ||
    typeof row.library_version !== "string" ||
    typeof row.skill_id !== "string" ||
    typeof row.installed_by !== "string" ||
    !Number.isFinite(Number(row.installed_at))
  ) return null;
  return {
    orgId: row.org_id,
    librarySlug: row.library_slug,
    libraryVersion: row.library_version,
    skillId: row.skill_id,
    installedBy: row.installed_by,
    installedAt: Number(row.installed_at),
  };
}

export async function getSkillInstall(env: AuditEnv, orgId: string, ownerId: string, slug: string): Promise<SkillInstallRow | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT org_id, library_slug, library_version, skill_id, installed_by, installed_at FROM skill_installs WHERE org_id = ? AND installed_by = ? AND library_slug = ?",
  ).bind(orgId, ownerId, slug).first();
  return row ? rowFromRecord(row as Record<string, unknown>) : null;
}

export async function listSkillInstalls(env: AuditEnv, orgId: string, ownerId: string): Promise<SkillInstallRow[]> {
  await ensureTables(env);
  const rows = await env.AGENT_AUDIT.prepare(
    "SELECT org_id, library_slug, library_version, skill_id, installed_by, installed_at FROM skill_installs WHERE org_id = ? AND installed_by = ? ORDER BY installed_at DESC",
  ).bind(orgId, ownerId).all();
  return (rows.results ?? [])
    .map((row) => rowFromRecord(row as Record<string, unknown>))
    .filter((row): row is SkillInstallRow => row !== null);
}

/** Claim an install once, or replace only the missing/disabled skill observed by the caller. */
export async function recordSkillInstall(
  env: AuditEnv,
  row: SkillInstallRow,
  previousSkillId?: string,
): Promise<boolean> {
  await ensureTables(env);
  const result = previousSkillId === undefined
    ? await env.AGENT_AUDIT.prepare(
      `INSERT INTO skill_installs (org_id, library_slug, library_version, skill_id, installed_by, installed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, installed_by, library_slug) DO NOTHING`,
    ).bind(row.orgId, row.librarySlug, row.libraryVersion, row.skillId, row.installedBy, row.installedAt).run()
    : await env.AGENT_AUDIT.prepare(
      `UPDATE skill_installs SET library_version = ?, skill_id = ?, installed_at = ?
       WHERE org_id = ? AND installed_by = ? AND library_slug = ? AND skill_id = ?`,
    ).bind(row.libraryVersion, row.skillId, row.installedAt, row.orgId, row.installedBy, row.librarySlug, previousSkillId).run();
  return result.meta.changes === 1;
}

export async function deleteSkillInstall(env: AuditEnv, orgId: string, ownerId: string, slug: string): Promise<boolean> {
  await ensureTables(env);
  const result = await env.AGENT_AUDIT.prepare(
    "DELETE FROM skill_installs WHERE org_id = ? AND installed_by = ? AND library_slug = ?",
  ).bind(orgId, ownerId, slug).run();
  return result.meta.changes === 1;
}
