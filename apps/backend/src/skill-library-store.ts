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
  PRIMARY KEY (org_id, library_slug)
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

export async function getSkillInstall(env: AuditEnv, orgId: string, slug: string): Promise<SkillInstallRow | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT org_id, library_slug, library_version, skill_id, installed_by, installed_at FROM skill_installs WHERE org_id = ? AND library_slug = ?",
  ).bind(orgId, slug).first();
  return row ? rowFromRecord(row as Record<string, unknown>) : null;
}

export async function listSkillInstalls(env: AuditEnv, orgId: string): Promise<SkillInstallRow[]> {
  await ensureTables(env);
  const rows = await env.AGENT_AUDIT.prepare(
    "SELECT org_id, library_slug, library_version, skill_id, installed_by, installed_at FROM skill_installs WHERE org_id = ? ORDER BY installed_at DESC",
  ).bind(orgId).all();
  return (rows.results ?? [])
    .map((row) => rowFromRecord(row as Record<string, unknown>))
    .filter((row): row is SkillInstallRow => row !== null);
}

export async function recordSkillInstall(
  env: AuditEnv,
  row: SkillInstallRow,
): Promise<void> {
  await ensureTables(env);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO skill_installs (org_id, library_slug, library_version, skill_id, installed_by, installed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, library_slug) DO UPDATE SET
       library_version = excluded.library_version,
       skill_id = excluded.skill_id,
       installed_by = excluded.installed_by,
       installed_at = excluded.installed_at`,
  ).bind(row.orgId, row.librarySlug, row.libraryVersion, row.skillId, row.installedBy, row.installedAt).run();
}

export async function deleteSkillInstall(env: AuditEnv, orgId: string, slug: string): Promise<boolean> {
  await ensureTables(env);
  const result = await env.AGENT_AUDIT.prepare(
    "DELETE FROM skill_installs WHERE org_id = ? AND library_slug = ?",
  ).bind(orgId, slug).run();
  return result.meta.changes === 1;
}
