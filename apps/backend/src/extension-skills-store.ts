import type {
  ExtensionSkillDirectoryEntry,
  ExtensionSkillInstructions,
  ExtensionSkillRecord,
  ExtensionSkillScope,
  ExtensionSkillView,
} from "@shiba/shared";
import { randomHex } from "./mailbox-store.js";
import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";

export interface ExtensionSkillsEnv extends AuditEnv {}

export interface ExtensionSkillRow extends ExtensionSkillRecord {
  orgId: string;
}

const TABLES = [
  `CREATE TABLE IF NOT EXISTS extension_skills (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    workspace_id TEXT,
    scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','workspace')),
    archived_at INTEGER,
    archived_by TEXT,
    archived_from_scope TEXT CHECK (archived_from_scope IS NULL OR archived_from_scope IN ('personal','workspace')),
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    enabled INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS extension_skills_org_scope_updated
    ON extension_skills(org_id, scope, archived_at, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS extension_skills_owner_updated
    ON extension_skills(org_id, owner_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS extension_skills_workspace_scope
    ON extension_skills(workspace_id, scope, archived_at)`,
];

const initialized = new WeakSet<D1Database>();

async function ensureTables(env: ExtensionSkillsEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  for (const sql of TABLES) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}

function skillFromRow(row: Record<string, unknown>): ExtensionSkillRow | null {
  if (
    typeof row.id !== "string" || typeof row.org_id !== "string" || typeof row.owner_id !== "string" ||
    typeof row.name !== "string" || typeof row.description !== "string" || typeof row.instructions !== "string"
  ) return null;
  const scope = row.scope === "workspace" ? "workspace" : "personal";
  const archivedFromScope = row.archived_from_scope === "workspace" || row.archived_from_scope === "personal"
    ? row.archived_from_scope
    : undefined;
  return {
    _id: row.id,
    orgId: row.org_id,
    userId: row.owner_id,
    ...(typeof row.workspace_id === "string" ? { workspaceId: row.workspace_id } : {}),
    scope,
    ...(typeof row.archived_at === "number" ? { archivedAt: row.archived_at } : {}),
    ...(typeof row.archived_by === "string" ? { archivedBy: row.archived_by } : {}),
    ...(archivedFromScope ? { archivedFromScope } : {}),
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    enabled: row.enabled !== 0,
    version: Number.isSafeInteger(Number(row.version)) && Number(row.version) > 0 ? Number(row.version) : 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const COLUMNS = `id, org_id, owner_id, workspace_id, scope, archived_at, archived_by,
  archived_from_scope, name, description, instructions, enabled, version, created_at, updated_at`;

function effectiveScope(skill: ExtensionSkillRow): ExtensionSkillScope {
  return skill.archivedAt !== undefined ? skill.archivedFromScope ?? skill.scope ?? "personal" : skill.scope ?? "personal";
}

function canEditSkill(skill: ExtensionSkillRow, userId: string, canManageWorkspace: boolean): boolean {
  return skill.userId === userId || (canManageWorkspace && effectiveScope(skill) === "workspace");
}

function readableBy(skill: ExtensionSkillRow, userId: string): boolean {
  if (!skill.workspaceId) return skill.userId === userId;
  return effectiveScope(skill) === "workspace" || skill.userId === userId;
}

function visibleInView(skill: ExtensionSkillRow, userId: string, view?: ExtensionSkillView): boolean {
  const archived = skill.archivedAt !== undefined;
  if (view === "archived") return archived && readableBy(skill, userId);
  if (archived || !readableBy(skill, userId)) return false;
  if (view === "personal") return skill.userId === userId && effectiveScope(skill) === "personal";
  if (view === "workspace") return effectiveScope(skill) === "workspace";
  return true;
}

async function readById(
  env: ExtensionSkillsEnv,
  orgId: string,
  id: string,
): Promise<ExtensionSkillRow | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(`SELECT ${COLUMNS} FROM extension_skills WHERE org_id = ? AND id = ?`)
    .bind(orgId, id).first();
  return row ? skillFromRow(row as Record<string, unknown>) : null;
}

export async function listExtensionSkills(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  options: { workspaceId?: string; view?: ExtensionSkillView } = {},
): Promise<ExtensionSkillRecord[]> {
  await ensureTables(env);
  const results = await env.AGENT_AUDIT.prepare(`SELECT ${COLUMNS} FROM extension_skills WHERE org_id = ? ORDER BY updated_at DESC, id ASC`)
    .bind(orgId).all();
  const rows = (results.results ?? [])
    .map((row) => skillFromRow(row as Record<string, unknown>))
    .filter((row): row is ExtensionSkillRow => row !== null)
    .filter((row) => options.workspaceId === undefined
      ? row.userId === userId && (options.view === "archived" ? row.archivedAt !== undefined : row.archivedAt === undefined)
      : row.workspaceId === options.workspaceId && visibleInView(row, userId, options.view));
  return rows.map(({ orgId: _orgId, ...row }) => row);
}

/** Lightweight directory; full instructions are fetched separately on demand. */
export async function listExtensionSkillDirectory(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  options: { workspaceId?: string; workspaceOnly?: boolean; scope?: ExtensionSkillScope } = {},
): Promise<ExtensionSkillDirectoryEntry[]> {
  await ensureTables(env);
  const results = await env.AGENT_AUDIT.prepare(`SELECT ${COLUMNS} FROM extension_skills WHERE org_id = ? ORDER BY updated_at DESC, id ASC`)
    .bind(orgId).all();
  return (results.results ?? [])
    .map((row) => skillFromRow(row as Record<string, unknown>))
    .filter((row): row is ExtensionSkillRow => row !== null)
    .filter((row) => row.archivedAt === undefined)
    .filter((row) => options.workspaceId === undefined
      ? row.userId === userId
      : (row.workspaceId === options.workspaceId || (!row.workspaceId && row.userId === userId)) && readableBy(row, userId))
    .filter((row) => !options.workspaceOnly || effectiveScope(row) === "workspace")
    .filter((row) => options.scope === undefined || (effectiveScope(row) === options.scope && (options.scope !== "personal" || row.userId === userId)))
    .map((row) => ({ _id: row._id, name: row.name, description: row.description, enabled: row.enabled }));
}

export async function getExtensionSkill(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  id: string,
  options: { workspaceId?: string } = {},
): Promise<ExtensionSkillRecord | null> {
  const skill = await readById(env, orgId, id);
  if (!skill || (options.workspaceId !== undefined && skill.workspaceId !== options.workspaceId) || !readableBy(skill, userId)) return null;
  const { orgId: _orgId, ...publicSkill } = skill;
  return publicSkill;
}

export async function getExtensionSkillInstructions(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  id: string,
): Promise<ExtensionSkillInstructions | null> {
  const skill = await readById(env, orgId, id);
  if (!skill || !readableBy(skill, userId)) return null;
  return { _id: skill._id, name: skill.name, instructions: skill.instructions };
}

export async function createExtensionSkill(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  input: { name: string; description: string; instructions: string; enabled?: boolean; workspaceId?: string; scope?: ExtensionSkillScope },
  now = Date.now(),
): Promise<string> {
  await ensureTables(env);
  if (input.scope === "workspace" && !input.workspaceId) throw new Error("workspace_required");
  const id = `skill_${randomHex(12)}`;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO extension_skills
      (id, org_id, owner_id, workspace_id, scope, name, description, instructions, enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(
    id, orgId, userId, input.workspaceId ?? null, input.scope ?? "personal", input.name, input.description,
    input.instructions, input.enabled === undefined ? null : input.enabled ? 1 : 0, now, now,
  ).run();
  return id;
}

export async function updateExtensionSkill(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  id: string,
  updates: { name?: string; description?: string; instructions?: string; enabled?: boolean },
  now = Date.now(),
  options: { canManageWorkspace?: boolean } = {},
): Promise<"updated" | "not_found" | "forbidden"> {
  const current = await readById(env, orgId, id);
  if (!current || !readableBy(current, userId)) return "not_found";
  const canManageWorkspace = options.canManageWorkspace === true;
  if (!canEditSkill(current, userId, canManageWorkspace)) return "forbidden";
  const textChanged = updates.name !== undefined || updates.description !== undefined || updates.instructions !== undefined;
  const assignments = ["updated_at = ?"];
  const values: unknown[] = [now];
  if (updates.name !== undefined) { assignments.push("name = ?"); values.push(updates.name); }
  if (updates.description !== undefined) { assignments.push("description = ?"); values.push(updates.description); }
  if (updates.instructions !== undefined) { assignments.push("instructions = ?"); values.push(updates.instructions); }
  if (updates.enabled !== undefined) { assignments.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
  if (textChanged) { assignments.push("version = ?"); values.push(current.version + 1); }
  values.push(orgId, id, userId, canManageWorkspace ? 1 : 0);
  await env.AGENT_AUDIT.prepare(
    `UPDATE extension_skills SET ${assignments.join(", ")} WHERE org_id = ? AND id = ? AND (owner_id = ? OR (? = 1 AND scope = 'workspace'))`,
  ).bind(...values).run();
  return "updated";
}

export async function removeExtensionSkill(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  id: string,
  options: { canManageWorkspace?: boolean } = {},
): Promise<"removed" | "not_found" | "forbidden"> {
  const current = await readById(env, orgId, id);
  if (!current || !readableBy(current, userId)) return "not_found";
  const canManageWorkspace = options.canManageWorkspace === true;
  if (!canEditSkill(current, userId, canManageWorkspace)) return "forbidden";
  await env.AGENT_AUDIT.prepare("DELETE FROM extension_skills WHERE org_id = ? AND id = ? AND (owner_id = ? OR (? = 1 AND scope = 'workspace'))")
    .bind(orgId, id, userId, canManageWorkspace ? 1 : 0).run();
  return "removed";
}

export type ExtensionSkillScopeAction =
  | { ok: true }
  | { ok: false; reason: "not_found" | "forbidden" | "archived" | "same_scope" | "workspace_required" | "already_archived" | "not_archived" };

export async function setExtensionSkillScope(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  id: string,
  to: ExtensionSkillScope,
): Promise<ExtensionSkillScopeAction> {
  const current = await readById(env, orgId, id);
  if (!current || !readableBy(current, userId)) return { ok: false, reason: "not_found" };
  if (current.userId !== userId) return { ok: false, reason: "forbidden" };
  if (current.archivedAt !== undefined) return { ok: false, reason: "archived" };
  if (effectiveScope(current) === to) return { ok: false, reason: "same_scope" };
  if (to === "workspace" && !current.workspaceId) return { ok: false, reason: "workspace_required" };
  await env.AGENT_AUDIT.prepare("UPDATE extension_skills SET scope = ? WHERE org_id = ? AND id = ? AND owner_id = ?")
    .bind(to, orgId, id, userId).run();
  return { ok: true };
}

export async function archiveExtensionSkill(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  id: string,
  now = Date.now(),
  options: { canManageWorkspace?: boolean } = {},
): Promise<ExtensionSkillScopeAction> {
  const current = await readById(env, orgId, id);
  if (!current || !readableBy(current, userId)) return { ok: false, reason: "not_found" };
  const canManageWorkspace = options.canManageWorkspace === true;
  if (!canEditSkill(current, userId, canManageWorkspace)) return { ok: false, reason: "forbidden" };
  if (current.archivedAt !== undefined) return { ok: false, reason: "already_archived" };
  await env.AGENT_AUDIT.prepare(
    `UPDATE extension_skills SET archived_at = ?, archived_by = ?, archived_from_scope = ?
     WHERE org_id = ? AND id = ? AND (owner_id = ? OR (? = 1 AND scope = 'workspace'))`,
  ).bind(now, userId, effectiveScope(current), orgId, id, userId, canManageWorkspace ? 1 : 0).run();
  return { ok: true };
}

export async function restoreExtensionSkill(
  env: ExtensionSkillsEnv,
  orgId: string,
  userId: string,
  id: string,
  options: { canManageWorkspace?: boolean } = {},
): Promise<ExtensionSkillScopeAction> {
  const current = await readById(env, orgId, id);
  if (!current || !readableBy(current, userId)) return { ok: false, reason: "not_found" };
  const canManageWorkspace = options.canManageWorkspace === true;
  if (!canEditSkill(current, userId, canManageWorkspace)) return { ok: false, reason: "forbidden" };
  if (current.archivedAt === undefined) return { ok: false, reason: "not_archived" };
  await env.AGENT_AUDIT.prepare(
    `UPDATE extension_skills SET scope = ?, archived_at = NULL, archived_by = NULL, archived_from_scope = NULL
     WHERE org_id = ? AND id = ? AND (owner_id = ? OR (? = 1 AND scope = 'workspace'))`,
  ).bind(current.archivedFromScope ?? current.scope ?? "personal", orgId, id, userId, canManageWorkspace ? 1 : 0).run();
  return { ok: true };
}
