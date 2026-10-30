import type { CustomAgentConfig, CustomAgentRecord } from "@shiba/shared";
import { sanitizeCustomAgentSlug } from "@shiba/shared";
import { randomHex } from "./mailbox-store.js";
import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";

const AGENT_TABLE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS org_custom_agents (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL,
     slug TEXT NOT NULL,
     version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER,
     archived_at INTEGER
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS org_custom_agents_org_slug ON org_custom_agents(org_id, slug)`,
  `CREATE TABLE IF NOT EXISTS org_custom_agent_versions (
     agent_id TEXT NOT NULL,
     org_id TEXT NOT NULL,
     version INTEGER NOT NULL,
     config_json TEXT NOT NULL,
     saved_at INTEGER NOT NULL,
     PRIMARY KEY (agent_id, version)
   )`,
];

const initialized = new WeakSet<D1Database>();

async function ensureTables(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  for (const statement of AGENT_TABLE_STATEMENTS) {
    await env.AGENT_AUDIT.prepare(statement).run();
  }
  // Existing installations initialized this table before archive existed.
  // D1 serializes the additive ALTER; only an already-present column is benign.
  try {
    await env.AGENT_AUDIT.prepare(`ALTER TABLE org_custom_agents ADD COLUMN archived_at INTEGER`).run();
  } catch (error) {
    if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  initialized.add(env.AGENT_AUDIT);
}

function rowToRecord(row: Record<string, unknown>): CustomAgentRecord | null {
  try {
    const config = JSON.parse(String(row.config_json)) as CustomAgentConfig;
    return {
      id: String(row.id),
      orgId: String(row.org_id),
      slug: String(row.slug),
      version: Number(row.version),
      config,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      ...(row.archived_at != null ? { archivedAt: Number(row.archived_at) } : {}),
      ...(row.deleted_at != null ? { deletedAt: Number(row.deleted_at) } : {}),
    };
  } catch {
    return null;
  }
}

export async function listCustomAgents(
  env: AuditEnv,
  orgId: string,
  options?: { archived?: boolean },
): Promise<CustomAgentRecord[]> {
  await ensureTables(env);
  const result = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM org_custom_agents WHERE org_id = ? AND deleted_at IS NULL AND archived_at IS ${options?.archived ? "NOT " : ""}NULL ORDER BY updated_at DESC`,
  )
    .bind(orgId)
    .all();
  return (result.results ?? [])
    .map((row) => rowToRecord(row as Record<string, unknown>))
    .filter((r): r is CustomAgentRecord => r !== null);
}

export async function getCustomAgentById(
  env: AuditEnv,
  orgId: string,
  id: string,
  options?: { includeArchived?: boolean },
): Promise<CustomAgentRecord | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM org_custom_agents WHERE org_id = ? AND id = ? AND deleted_at IS NULL${options?.includeArchived ? "" : " AND archived_at IS NULL"}`,
  )
    .bind(orgId, id)
    .first();
  return row ? rowToRecord(row as Record<string, unknown>) : null;
}

/** Resolve a saved, immutable profile version while the profile is available. */
export async function getCustomAgentVersion(
  env: AuditEnv,
  orgId: string,
  id: string,
  version: number,
): Promise<CustomAgentRecord | null> {
  const current = await getCustomAgentById(env, orgId, id);
  if (!current || !Number.isSafeInteger(version) || version < 1) return null;
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT config_json,saved_at FROM org_custom_agent_versions WHERE org_id=? AND agent_id=? AND version=?`,
  ).bind(orgId, id, version).first<Record<string, unknown>>();
  if (!row) return null;
  try {
    return {
      ...current,
      version,
      config: JSON.parse(String(row.config_json)) as CustomAgentRecord["config"],
      updatedAt: Number(row.saved_at),
    };
  } catch {
    return null;
  }
}

export async function getCustomAgentBySlug(
  env: AuditEnv,
  orgId: string,
  slug: string,
): Promise<CustomAgentRecord | null> {
  const clean = sanitizeCustomAgentSlug(slug);
  if (!clean) return null;
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM org_custom_agents WHERE org_id = ? AND slug = ? AND deleted_at IS NULL AND archived_at IS NULL`,
  )
    .bind(orgId, clean)
    .first();
  return row ? rowToRecord(row as Record<string, unknown>) : null;
}

export async function createCustomAgent(
  env: AuditEnv,
  orgId: string,
  slug: string,
  config: CustomAgentConfig,
): Promise<CustomAgentRecord> {
  const cleanSlug = sanitizeCustomAgentSlug(slug);
  if (!cleanSlug) throw new Error("Invalid slug.");
  await ensureTables(env);
  const existing = await getCustomAgentBySlug(env, orgId, cleanSlug);
  if (existing) throw new Error("An agent with this slug already exists.");
  const now = Date.now();
  const id = `cag-${randomHex(12)}`;
  const configJson = JSON.stringify(config);
  await env.AGENT_AUDIT.batch([env.AGENT_AUDIT.prepare(
    `INSERT INTO org_custom_agents (id, org_id, slug, version, config_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
  )
    .bind(id, orgId, cleanSlug, configJson, now, now),
  env.AGENT_AUDIT.prepare(
    `INSERT INTO org_custom_agent_versions (agent_id, org_id, version, config_json, saved_at)
     VALUES (?, ?, 1, ?, ?)`,
  )
    .bind(id, orgId, configJson, now)]);
  return {
    id,
    orgId,
    slug: cleanSlug,
    version: 1,
    config,
    createdAt: now,
    updatedAt: now,
  };
}

export async function updateCustomAgent(
  env: AuditEnv,
  orgId: string,
  id: string,
  config: CustomAgentConfig,
  expectedVersion?: number,
): Promise<CustomAgentRecord> {
  const current = await getCustomAgentById(env, orgId, id);
  if (!current) throw new Error("Agent not found.");
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new Error("Version conflict — reload and retry.");
  }
  const nextVersion = current.version + 1;
  const now = Date.now();
  const configJson = JSON.stringify(config);
  const result = await env.AGENT_AUDIT.batch([env.AGENT_AUDIT.prepare(
    `UPDATE org_custom_agents SET version = ?, config_json = ?, updated_at = ?
     WHERE id = ? AND org_id = ? AND version = ? AND deleted_at IS NULL AND archived_at IS NULL`,
  ).bind(nextVersion, configJson, now, id, orgId, current.version),
  env.AGENT_AUDIT.prepare(
    `INSERT INTO org_custom_agent_versions (agent_id, org_id, version, config_json, saved_at)
     SELECT id, org_id, version, config_json, updated_at FROM org_custom_agents
     WHERE id = ? AND org_id = ? AND version = ? AND changes() = 1`,
  ).bind(id, orgId, nextVersion)]);
  if (result[0]?.meta.changes !== 1) throw new Error("Version conflict — reload and retry.");
  return { ...current, version: nextVersion, config, updatedAt: now };
}

export async function deleteCustomAgent(env: AuditEnv, orgId: string, id: string): Promise<void> {
  const current = await getCustomAgentById(env, orgId, id, { includeArchived: true });
  if (!current) throw new Error("Agent not found.");
  const now = Date.now();
  await env.AGENT_AUDIT.prepare(
    `UPDATE org_custom_agents SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
  )
    .bind(now, now, id, orgId)
    .run();
}

/** Archive is reversible and never deletes configuration or version history. */
export async function setCustomAgentArchived(
  env: AuditEnv,
  orgId: string,
  id: string,
  archived: boolean,
): Promise<CustomAgentRecord> {
  const current = await getCustomAgentById(env, orgId, id, { includeArchived: true });
  if (!current) throw new Error("Agent not found.");
  const now = Date.now();
  await env.AGENT_AUDIT.prepare(
    `UPDATE org_custom_agents SET archived_at = ?, updated_at = ?
     WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
  ).bind(archived ? current.archivedAt ?? now : null, now, id, orgId).run();
  const updated = await getCustomAgentById(env, orgId, id, { includeArchived: true });
  if (!updated) throw new Error("Agent not found.");
  return updated;
}
