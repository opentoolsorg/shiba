import { randomHex } from "./mailbox-store.js";
import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";

export type SkillStatus = "draft" | "review" | "active" | "disabled";

export interface SkillVersion {
  skillId: string;
  orgId: string;
  ownerId: string;
  version: number;
  name: string;
  instructions: string;
  sourceUrl?: string;
  createdAt: number;
}

export interface SkillRecord {
  id: string;
  orgId: string;
  ownerId: string;
  version: number;
  status: SkillStatus;
  activeVersion?: number;
  reviewedVersion?: number;
  reviewedInstructions?: string;
  createdAt: number;
  updatedAt: number;
  content: SkillVersion;
}

export interface SkillPin {
  skillId: string;
  version: number;
  name: string;
  sourceUrl?: string;
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft','review','active','disabled')),
    active_version INTEGER,
    reviewed_version INTEGER,
    reviewed_instructions TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS skills_org_status_updated ON skills(org_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS skills_owner_updated ON skills(org_id, owner_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS skill_versions (
    skill_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    source_url TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (skill_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS skill_installs (
    org_id TEXT NOT NULL,
    library_slug TEXT NOT NULL,
    library_version TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    installed_by TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    PRIMARY KEY (org_id, installed_by, library_slug)
  )`,
];

const initialized = new WeakSet<D1Database>();

async function ensureTables(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  for (const sql of TABLES) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}

function versionFromRow(row: Record<string, unknown>): SkillVersion | null {
  const version = Number(row.content_version ?? row.version);
  if (
    typeof row.skill_id !== "string" && typeof row.id !== "string" ||
    !Number.isSafeInteger(version) || version < 1 ||
    typeof (row.name ?? row.content_name) !== "string" ||
    typeof (row.instructions ?? row.content_instructions) !== "string"
  ) return null;
  const result: SkillVersion = {
    skillId: String(row.skill_id ?? row.id),
    orgId: String(row.org_id),
    ownerId: String(row.owner_id),
    version,
    name: String(row.name ?? row.content_name),
    instructions: String(row.instructions ?? row.content_instructions),
    createdAt: Number(row.content_created_at ?? row.created_at),
  };
  const sourceUrl = row.source_url ?? row.content_source_url;
  if (typeof sourceUrl === "string" && sourceUrl) result.sourceUrl = sourceUrl;
  return result;
}

function skillFromRow(row: Record<string, unknown>): SkillRecord | null {
  const content = versionFromRow(row);
  if (!content) return null;
  const status = row.status;
  if (status !== "draft" && status !== "review" && status !== "active" && status !== "disabled") return null;
  return {
    id: String(row.id ?? row.skill_id),
    orgId: String(row.org_id),
    ownerId: String(row.owner_id),
    version: Number(row.version),
    status,
    ...(row.active_version != null ? { activeVersion: Number(row.active_version) } : {}),
    ...(row.reviewed_version != null ? { reviewedVersion: Number(row.reviewed_version) } : {}),
    ...(typeof row.reviewed_instructions === "string" ? { reviewedInstructions: row.reviewed_instructions } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    content,
  };
}

const CONTENT_COLUMNS = `v.skill_id, v.org_id, v.owner_id, v.version AS content_version,
  v.name, v.instructions, v.source_url, v.created_at AS content_created_at`;
const SKILL_COLUMNS = `s.id, s.org_id, s.owner_id, s.version, s.status, s.active_version,
  s.reviewed_version, s.reviewed_instructions, s.created_at, s.updated_at`;

export async function getSkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  id: string,
  options: { includeSharedActive?: boolean } = {},
): Promise<SkillRecord | null> {
  await ensureTables(env);
  const shared = options.includeSharedActive ? " OR s.status = 'active'" : "";
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT ${SKILL_COLUMNS}, ${CONTENT_COLUMNS}
     FROM skills s JOIN skill_versions v ON v.skill_id = s.id AND v.version =
       CASE WHEN s.status = 'active' AND s.owner_id <> ? THEN s.active_version ELSE s.version END
     WHERE s.org_id = ? AND s.id = ? AND (s.owner_id = ?${shared})`,
  ).bind(ownerId, orgId, id, ownerId).first();
  return row ? skillFromRow(row as Record<string, unknown>) : null;
}

export async function listSkills(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  options: { limit: number; offset: number },
): Promise<{ skills: SkillRecord[]; nextOffset?: number }> {
  await ensureTables(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT ${SKILL_COLUMNS}, ${CONTENT_COLUMNS}
     FROM skills s JOIN skill_versions v ON v.skill_id = s.id AND v.version =
       CASE WHEN s.status = 'active' AND s.owner_id <> ? THEN s.active_version ELSE s.version END
     WHERE s.org_id = ? AND (s.status = 'active' OR s.owner_id = ?)
     ORDER BY s.updated_at DESC, s.id ASC LIMIT ? OFFSET ?`,
  ).bind(ownerId, orgId, ownerId, options.limit + 1, options.offset).all();
  const all = (rows.results ?? []).map((row) => skillFromRow(row as Record<string, unknown>)).filter((row): row is SkillRecord => row !== null);
  const hasMore = all.length > options.limit;
  return {
    skills: all.slice(0, options.limit),
    ...(hasMore ? { nextOffset: options.offset + options.limit } : {}),
  };
}

export async function listSkillVersions(
  env: AuditEnv,
  orgId: string,
  id: string,
  limit: number,
  offset: number,
): Promise<{ versions: SkillVersion[]; nextOffset?: number }> {
  await ensureTables(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT skill_id, org_id, owner_id, version, name, instructions, source_url, created_at
     FROM skill_versions WHERE org_id = ? AND skill_id = ? ORDER BY version DESC LIMIT ? OFFSET ?`,
  ).bind(orgId, id, limit + 1, offset).all();
  const all = (rows.results ?? []).map((row) => versionFromRow(row as Record<string, unknown>)).filter((row): row is SkillVersion => row !== null);
  return {
    versions: all.slice(0, limit),
    ...(all.length > limit ? { nextOffset: offset + limit } : {}),
  };
}

export async function createSkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  input: { name: string; instructions: string; sourceUrl?: string },
  now = Date.now(),
): Promise<SkillRecord> {
  await ensureTables(env);
  const id = `skill-${randomHex(12)}`;
  await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(
      `INSERT INTO skills (id, org_id, owner_id, version, status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'draft', ?, ?)`,
    ).bind(id, orgId, ownerId, now, now),
    env.AGENT_AUDIT.prepare(
      `INSERT INTO skill_versions (skill_id, org_id, owner_id, version, name, instructions, source_url, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    ).bind(id, orgId, ownerId, input.name, input.instructions, input.sourceUrl ?? null, now),
  ]);
  const skill = await getSkill(env, orgId, ownerId, id);
  if (!skill) throw new Error("Skill create failed.");
  return skill;
}

export async function updateSkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  id: string,
  expectedVersion: number,
  input: { name: string; instructions: string; sourceUrl?: string },
  now = Date.now(),
): Promise<SkillRecord | null> {
  await ensureTables(env);
  const current = await getSkill(env, orgId, ownerId, id);
  if (!current) return null;
  if (current.version !== expectedVersion) throw new Error("version_conflict");
  const next = current.version + 1;
  const changes = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(
      `UPDATE skills SET version = ?, status = 'draft', reviewed_version = NULL,
       reviewed_instructions = NULL, updated_at = ?
       WHERE id = ? AND org_id = ? AND owner_id = ? AND version = ?`,
    ).bind(next, now, id, orgId, ownerId, current.version),
    env.AGENT_AUDIT.prepare(
      `INSERT INTO skill_versions (skill_id, org_id, owner_id, version, name, instructions, source_url, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(id, orgId, ownerId, next, input.name, input.instructions, input.sourceUrl ?? null, now),
  ]);
  if (changes[0]?.meta.changes !== 1) throw new Error("version_conflict");
  return getSkill(env, orgId, ownerId, id);
}

export async function reviewSkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  id: string,
  version: number,
  reviewedInstructions: string,
  now = Date.now(),
): Promise<SkillRecord | null> {
  const current = await getSkill(env, orgId, ownerId, id);
  if (!current) return null;
  if (current.version !== version || current.content.instructions !== reviewedInstructions || !reviewedInstructions.trim()) {
    throw new Error("review_mismatch");
  }
  await env.AGENT_AUDIT.prepare(
    `UPDATE skills SET status = 'review', reviewed_version = ?, reviewed_instructions = ?, updated_at = ?
     WHERE id = ? AND org_id = ? AND owner_id = ? AND version = ?`,
  ).bind(version, reviewedInstructions, now, id, orgId, ownerId, version).run();
  return getSkill(env, orgId, ownerId, id);
}

export async function activateSkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  id: string,
  version: number,
  reviewedInstructions: string,
  now = Date.now(),
): Promise<SkillRecord | null> {
  const current = await getSkill(env, orgId, ownerId, id);
  if (!current) return null;
  if (
    current.status !== "review" || current.version !== version || current.reviewedVersion !== version ||
    current.reviewedInstructions !== reviewedInstructions || current.content.instructions !== reviewedInstructions
  ) throw new Error("review_required");
  await env.AGENT_AUDIT.prepare(
    `UPDATE skills SET status = 'active', active_version = ?, updated_at = ?
     WHERE id = ? AND org_id = ? AND owner_id = ? AND status = 'review' AND reviewed_version = ? AND version = ?`,
  ).bind(version, now, id, orgId, ownerId, version, version).run();
  return getSkill(env, orgId, ownerId, id);
}

export async function disableSkill(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  id: string,
  now = Date.now(),
): Promise<SkillRecord | null> {
  await ensureTables(env);
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE skills SET status = 'disabled', active_version = NULL, updated_at = ?
     WHERE id = ? AND org_id = ? AND owner_id = ?`,
  ).bind(now, id, orgId, ownerId).run();
  if (result.meta.changes !== 1) return null;
  return getSkill(env, orgId, ownerId, id);
}

/** Resolve exact active versions for execution; no downloaded code is ever loaded. */
export async function resolveSkillPins(
  env: AuditEnv,
  orgId: string,
  ownerId: string,
  requested: readonly { skillId: string; version: number }[],
): Promise<{ pins: SkillPin[]; instructions: string } | null> {
  if (requested.length > 5 || new Set(requested.map((item) => item.skillId)).size !== requested.length) return null;
  const pins: SkillPin[] = [];
  const sections: string[] = [];
  for (const ref of requested) {
    const skill = await getSkill(env, orgId, ownerId, ref.skillId, { includeSharedActive: true });
    if (!skill || skill.status !== "active" || skill.activeVersion !== ref.version || skill.version !== ref.version) return null;
    const pin: SkillPin = {
      skillId: skill.id,
      version: skill.version,
      name: skill.content.name,
      ...(skill.content.sourceUrl ? { sourceUrl: skill.content.sourceUrl } : {}),
    };
    pins.push(pin);
    sections.push([
      `Skill: ${pin.name} (${pin.skillId}@${pin.version})`,
      ...(pin.sourceUrl ? [`Source: ${pin.sourceUrl}`] : []),
      "Reviewed instructions:",
      skill.content.instructions,
    ].join("\n"));
  }
  return { pins, instructions: sections.length ? `Skills:\n${sections.join("\n\n")}` : "" };
}

/** Revalidate approved pins immediately before a queued run starts execution. */
export async function areSkillPinsActive(
  env: AuditEnv,
  orgId: string,
  pins: readonly { skillId: string; version: number }[],
): Promise<boolean> {
  if (pins.length > 5 || new Set(pins.map((pin) => pin.skillId)).size !== pins.length) return false;
  if (pins.length === 0) return true;
  await ensureTables(env);
  for (const pin of pins) {
    const row = await env.AGENT_AUDIT.prepare(
      `SELECT 1 AS active FROM skills
       WHERE id = ? AND org_id = ? AND status = 'active' AND version = ? AND active_version = ?`,
    ).bind(pin.skillId, orgId, pin.version, pin.version).first();
    if (!row) return false;
  }
  return true;
}
