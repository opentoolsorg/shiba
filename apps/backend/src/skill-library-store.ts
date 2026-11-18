import type { AuditEnv } from "./audit.js";
import { teamSkillWriteGuard, type SkillMutationOptions } from "./team-skill-grant.js";

export interface SkillInstallRow {
  orgId: string;
  librarySlug: string;
  libraryVersion: string;
  skillId: string;
  installedBy: string;
  installedAt: number;
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
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT org_id, library_slug, library_version, skill_id, installed_by, installed_at FROM skill_installs WHERE org_id = ? AND installed_by = ? AND library_slug = ?",
  ).bind(orgId, ownerId, slug).first();
  return row ? rowFromRecord(row as Record<string, unknown>) : null;
}

export async function listSkillInstalls(env: AuditEnv, orgId: string, ownerId: string): Promise<SkillInstallRow[]> {
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
  options: SkillMutationOptions = {},
): Promise<boolean> {
  const guard = teamSkillWriteGuard(row.orgId, row.installedBy, options.teamGrant);
  const result = previousSkillId === undefined
    ? await env.AGENT_AUDIT.prepare(
      `INSERT INTO skill_installs (org_id, library_slug, library_version, skill_id, installed_by, installed_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE 1 = 1${guard.sql}
       ON CONFLICT(org_id, installed_by, library_slug) DO NOTHING`,
    ).bind(row.orgId, row.librarySlug, row.libraryVersion, row.skillId, row.installedBy, row.installedAt, ...guard.values).run()
    : await env.AGENT_AUDIT.prepare(
      `UPDATE skill_installs SET library_version = ?, skill_id = ?, installed_at = ?
       WHERE org_id = ? AND installed_by = ? AND library_slug = ? AND skill_id = ?${guard.sql}`,
    ).bind(row.libraryVersion, row.skillId, row.installedAt, row.orgId, row.installedBy, row.librarySlug, previousSkillId, ...guard.values).run();
  return result.meta.changes === 1;
}

export async function deleteSkillInstall(env: AuditEnv, orgId: string, ownerId: string, slug: string, options: SkillMutationOptions = {}): Promise<boolean> {
  const guard = teamSkillWriteGuard(orgId, ownerId, options.teamGrant);
  const result = await env.AGENT_AUDIT.prepare(
    `DELETE FROM skill_installs WHERE org_id = ? AND installed_by = ? AND library_slug = ?${guard.sql}`,
  ).bind(orgId, ownerId, slug, ...guard.values).run();
  return result.meta.changes === 1;
}
