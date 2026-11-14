/**
 * D1-backed grants for inbound MCP clients (connected apps).
 * KV still holds bearer material; grants gate /mcp access and refresh replay.
 */
import { audit, type AuditEnv } from "./audit.js";
import { sha256Hex } from "./agent-tokens.js";

export type McpGrantAccess = "read" | "write" | "full";
export type McpGrantKind = "oauth" | "token";

export interface McpGrantRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  access: McpGrantAccess;
  kind: McpGrantKind;
  clientName: string;
  clientId: string;
  codeId: string | null;
  refreshVersion: number;
  rotatedRefreshHash: string | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const MCP_GRANTS_SCHEMA_MARKER = "ws04_mcp_grants_v1";
const initialized = new WeakSet<D1Database>();

async function d1TableExists(db: D1Database, table: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  ).bind(table).first<{ ok: number }>();
  return row?.ok === 1;
}

async function d1SchemaMarkerApplied(db: D1Database, markerId: string): Promise<boolean> {
  if (!(await d1TableExists(db, "shiba_schema_markers"))) return false;
  const marker = await db.prepare(
    `SELECT 1 AS ok FROM shiba_schema_markers WHERE marker_id = ? LIMIT 1`,
  ).bind(markerId).first<{ ok: number }>();
  return marker?.ok === 1;
}

async function ensureSchema(env: AuditEnv): Promise<void> {
  if (!env.AGENT_AUDIT) throw new Error("MCP grants store unavailable.");
  if (initialized.has(env.AGENT_AUDIT)) return;
  const ready = (await d1SchemaMarkerApplied(env.AGENT_AUDIT, MCP_GRANTS_SCHEMA_MARKER))
    || (await d1TableExists(env.AGENT_AUDIT, "mcp_grants"));
  if (!ready) throw new Error("mcp_grants_schema_missing");
  initialized.add(env.AGENT_AUDIT);
}

function rowToGrant(row: Record<string, unknown> | null): McpGrantRow | null {
  if (!row || typeof row.id !== "string" || typeof row.user_id !== "string" || typeof row.client_id !== "string") return null;
  if (!["read", "write", "full"].includes(String(row.access)) || !["oauth", "token"].includes(String(row.kind))) return null;
  return {
    id: row.id as string,
    userId: row.user_id as string,
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : null,
    access: row.access as McpGrantAccess,
    kind: row.kind as McpGrantKind,
    clientName: String(row.client_name ?? ""),
    clientId: row.client_id as string,
    codeId: typeof row.code_id === "string" ? row.code_id : null,
    refreshVersion: Number(row.refresh_version ?? 0),
    rotatedRefreshHash: typeof row.rotated_refresh_hash === "string" ? row.rotated_refresh_hash : null,
    lastUsedAt: typeof row.last_used_at === "number" ? row.last_used_at : null,
    revokedAt: typeof row.revoked_at === "number" ? row.revoked_at : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export async function listMcpGrants(env: AuditEnv, userId: string): Promise<McpGrantRow[]> {
  await ensureSchema(env);
  const result = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM mcp_grants WHERE user_id = ? AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 100`,
  ).bind(userId).all<Record<string, unknown>>();
  return (result.results ?? []).map(rowToGrant).filter((row): row is McpGrantRow => row !== null);
}

export async function revokeMcpGrant(env: AuditEnv, input: { userId: string; grantId: string }): Promise<boolean> {
  await ensureSchema(env);
  const now = Date.now();
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE mcp_grants SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  ).bind(now, now, input.grantId, input.userId).run();
  if (result.meta?.changes === 1) {
    await audit(env, {
      principal: input.userId,
      tool: "mcp.grant.revoke",
      argsHash: await sha256Hex(input.grantId),
      outcome: "ok",
    });
    return true;
  }
  return false;
}

export async function upsertOAuthMcpGrant(
  env: AuditEnv,
  input: {
    userId: string;
    workspaceId?: string | null;
    clientId: string;
    clientName: string;
    access?: McpGrantAccess;
    codeId?: string | null;
  },
): Promise<McpGrantRow> {
  await ensureSchema(env);
  const existing = await activeMcpGrantForClient(env, { userId: input.userId, clientId: input.clientId });
  if (existing) return existing;
  const now = Date.now();
  const id = crypto.randomUUID().replaceAll("-", "");
  const access = input.access ?? "full";
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO mcp_grants (id, user_id, workspace_id, access, kind, client_name, client_id, code_id,
      refresh_version, last_used_at, revoked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'oauth', ?, ?, ?, 0, NULL, NULL, ?, ?)`,
  ).bind(
    id, input.userId, input.workspaceId ?? null, access, input.clientName, input.clientId,
    input.codeId ?? null, now, now,
  ).run();
  const grant = rowToGrant(await env.AGENT_AUDIT.prepare(
    `SELECT * FROM mcp_grants WHERE id = ?`,
  ).bind(id).first<Record<string, unknown>>());
  if (!grant) throw new Error("mcp_grant_upsert_failed");
  return grant;
}

/** Returns the next refresh version on success; null when replay detected and grant revoked. */
export async function noteRotatedRefreshHash(
  env: AuditEnv,
  input: { grantId: string; refreshHash: string },
): Promise<void> {
  await ensureSchema(env);
  await env.AGENT_AUDIT.prepare(
    `UPDATE mcp_grants SET rotated_refresh_hash = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`,
  ).bind(input.refreshHash, Date.now(), input.grantId).run();
}

export async function detectMcpGrantRefreshReplay(
  env: AuditEnv,
  input: { refreshHash: string },
): Promise<boolean> {
  await ensureSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT id, user_id FROM mcp_grants WHERE rotated_refresh_hash = ? AND revoked_at IS NULL`,
  ).bind(input.refreshHash).first<{ id: string; user_id: string }>();
  if (!row) return false;
  await env.AGENT_AUDIT.prepare(
    `UPDATE mcp_grants SET revoked_at = ?, updated_at = ? WHERE id = ?`,
  ).bind(Date.now(), Date.now(), row.id).run();
  await audit(env, {
    principal: row.user_id,
    tool: "mcp.grant.refresh_replay",
    argsHash: input.refreshHash,
    outcome: "denied",
  });
  return true;
}

export async function consumeMcpGrantRefresh(
  env: AuditEnv,
  input: { userId: string; clientId: string; expectedVersion: number },
): Promise<number | null> {
  await ensureSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM mcp_grants WHERE user_id = ? AND client_id = ? AND kind = 'oauth' AND revoked_at IS NULL`,
  ).bind(input.userId, input.clientId).first<Record<string, unknown>>();
  const grant = rowToGrant(row);
  if (!grant) return null;
  if (grant.refreshVersion !== input.expectedVersion) {
    await env.AGENT_AUDIT.prepare(
      `UPDATE mcp_grants SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL`,
    ).bind(Date.now(), Date.now(), grant.id).run();
    await audit(env, {
      principal: input.userId,
      tool: "mcp.grant.refresh_replay",
      argsHash: await sha256Hex(`${input.clientId}:${input.expectedVersion}`),
      outcome: "denied",
    });
    return null;
  }
  const next = grant.refreshVersion + 1;
  const updated = await env.AGENT_AUDIT.prepare(
    `UPDATE mcp_grants SET refresh_version = ?, updated_at = ?, last_used_at = ?
     WHERE id = ? AND refresh_version = ? AND revoked_at IS NULL`,
  ).bind(next, Date.now(), Date.now(), grant.id, input.expectedVersion).run();
  return updated.meta?.changes === 1 ? next : null;
}

export async function touchMcpGrantUsage(env: AuditEnv, input: { userId: string; clientId: string }): Promise<void> {
  await ensureSchema(env);
  await env.AGENT_AUDIT.prepare(
    `UPDATE mcp_grants SET last_used_at = ?, updated_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`,
  ).bind(Date.now(), Date.now(), input.userId, input.clientId).run();
}

export async function activeMcpGrantForClient(
  env: AuditEnv,
  input: { userId: string; clientId: string },
): Promise<McpGrantRow | null> {
  await ensureSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM mcp_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL`,
  ).bind(input.userId, input.clientId).first<Record<string, unknown>>();
  return rowToGrant(row);
}