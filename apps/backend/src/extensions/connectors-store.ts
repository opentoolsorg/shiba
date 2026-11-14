import type { ExtensionScope, ExtensionView, IntegrationProviderConnection } from "@shiba/shared";
import { randomHex } from "../mailbox-store.js";
import type { Env } from "../env.js";
import { DASHBOARD_ORG_ID } from "../org-request-auth.js";
import { getIntegrationProvider } from "../integrations/runtime.js";

export interface WorkspaceConnectorRecord {
  id: string;
  provider: "openconnector";
  providerKey: string;
  connectedAccountId: string;
  scope: ExtensionScope;
  identityLabel?: string | null;
  archivedAt?: number;
  archivedFromScope?: ExtensionScope;
  workspaceAppConnectionId?: string;
  userId: string;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
}

type ConnectorRow = WorkspaceConnectorRecord & {
  archivedBy?: string;
};

const COLUMNS = `id, workspace_id, user_id, provider, provider_key, connected_account_id, scope,
  archived_at, archived_by, archived_from_scope, workspace_app_connection_id, identity_label, created_at, updated_at`;

function effectiveScope(row: ConnectorRow): ExtensionScope {
  return row.archivedAt !== undefined ? row.archivedFromScope ?? row.scope : row.scope;
}

function rowFromDb(raw: Record<string, unknown>): ConnectorRow | null {
  if (
    typeof raw.id !== "string" || typeof raw.workspace_id !== "string" || typeof raw.user_id !== "string" ||
    typeof raw.provider_key !== "string" || typeof raw.connected_account_id !== "string"
  ) return null;
  const scope = raw.scope === "workspace" ? "workspace" : "personal";
  const archivedFromScope = raw.archived_from_scope === "workspace" || raw.archived_from_scope === "personal"
    ? raw.archived_from_scope
    : undefined;
  return {
    id: raw.id,
    workspaceId: raw.workspace_id,
    userId: raw.user_id,
    provider: "openconnector",
    providerKey: raw.provider_key,
    connectedAccountId: raw.connected_account_id,
    scope,
    ...(typeof raw.archived_at === "number" ? { archivedAt: raw.archived_at } : {}),
    ...(typeof raw.archived_by === "string" ? { archivedBy: raw.archived_by } : {}),
    ...(archivedFromScope ? { archivedFromScope } : {}),
    ...(typeof raw.workspace_app_connection_id === "string" ? { workspaceAppConnectionId: raw.workspace_app_connection_id } : {}),
    ...(typeof raw.identity_label === "string" || raw.identity_label === null ? { identityLabel: raw.identity_label as string | null } : {}),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

function publicRecord(row: ConnectorRow, viewerUserId: string): WorkspaceConnectorRecord {
  const archived = row.archivedAt !== undefined;
  return {
    id: row.id,
    provider: "openconnector",
    providerKey: row.providerKey,
    ...(row.userId === viewerUserId ? { connectedAccountId: row.connectedAccountId } : {}),
    scope: archived ? row.archivedFromScope ?? row.scope : row.scope,
    identityLabel: row.identityLabel ?? null,
    ...(archived ? { archivedAt: row.archivedAt, archivedFromScope: row.archivedFromScope ?? row.scope } : {}),
    ...(row.workspaceAppConnectionId ? { workspaceAppConnectionId: row.workspaceAppConnectionId } : {}),
    userId: row.userId,
    workspaceId: row.workspaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  } as WorkspaceConnectorRecord;
}

function visibleInView(row: ConnectorRow, userId: string, view: ExtensionView): boolean {
  const archived = row.archivedAt !== undefined;
  if (view === "archived") return archived && (row.userId === userId || effectiveScope(row) === "workspace");
  if (archived) return false;
  if (view === "personal") return row.userId === userId && effectiveScope(row) === "personal";
  if (view === "workspace") return effectiveScope(row) === "workspace";
  return row.userId === userId || effectiveScope(row) === "workspace";
}

export function resolveConnectorWorkspaceId(orgId: string): string {
  return orgId.startsWith("team:") ? orgId.slice("team:".length) : DASHBOARD_ORG_ID;
}

async function readById(env: Env, workspaceId: string, id: string): Promise<ConnectorRow | null> {
  if (!env.AGENT_AUDIT) return null;
  const row = await env.AGENT_AUDIT.prepare(`SELECT ${COLUMNS} FROM workspace_connectors WHERE workspace_id = ? AND id = ?`)
    .bind(workspaceId, id).first();
  return row ? rowFromDb(row as Record<string, unknown>) : null;
}

export async function listWorkspaceConnectors(
  env: Env,
  workspaceId: string,
  userId: string,
  view: ExtensionView,
): Promise<WorkspaceConnectorRecord[]> {
  if (!env.AGENT_AUDIT) return [];
  const results = await env.AGENT_AUDIT.prepare(
    `SELECT ${COLUMNS} FROM workspace_connectors WHERE workspace_id = ? ORDER BY updated_at DESC, id ASC`,
  ).bind(workspaceId).all();
  return (results.results ?? [])
    .map((row) => rowFromDb(row as Record<string, unknown>))
    .filter((row): row is ConnectorRow => row !== null)
    .filter((row) => visibleInView(row, userId, view))
    .map((row) => publicRecord(row, userId));
}

export async function getWorkspaceConnector(
  env: Env,
  workspaceId: string,
  userId: string,
  id: string,
): Promise<WorkspaceConnectorRecord | null> {
  const row = await readById(env, workspaceId, id);
  if (!row || (row.userId !== userId && effectiveScope(row) !== "workspace")) return null;
  return publicRecord(row, userId);
}

async function verifyOwnedConnection(
  env: Env,
  userId: string,
  workspaceId: string | undefined,
  providerKey: string,
  connectedAccountId: string,
): Promise<IntegrationProviderConnection | null> {
  const provider = getIntegrationProvider(env);
  const connections = await provider.listConnections({
    userId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    includeUnavailable: true,
  });
  return connections.find((row) => row.providerKey === providerKey && row.id === connectedAccountId) ?? null;
}

export async function upsertPersonalConnectorFromProvider(
  env: Env,
  workspaceId: string,
  userId: string,
  connection: IntegrationProviderConnection,
  now = Date.now(),
): Promise<string | null> {
  if (!env.AGENT_AUDIT || connection.executionReady === false) return null;
  const existing = await env.AGENT_AUDIT.prepare(
    `SELECT id FROM workspace_connectors
     WHERE workspace_id = ? AND user_id = ? AND connected_account_id = ? AND archived_at IS NULL`,
  ).bind(workspaceId, userId, connection.id).first<{ id: string }>();
  if (existing?.id) {
    await env.AGENT_AUDIT.prepare(
      `UPDATE workspace_connectors SET identity_label = ?, updated_at = ?, provider_key = ?
       WHERE id = ? AND workspace_id = ? AND user_id = ?`,
    ).bind(connection.identityLabel ?? null, now, connection.providerKey, existing.id, workspaceId, userId).run();
    return existing.id;
  }
  const id = `wcon_${randomHex(12)}`;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO workspace_connectors
      (id, workspace_id, user_id, provider, provider_key, connected_account_id, scope,
       identity_label, created_at, updated_at)
     VALUES (?, ?, ?, 'openconnector', ?, ?, 'personal', ?, ?, ?)`,
  ).bind(id, workspaceId, userId, connection.providerKey, connection.id, connection.identityLabel ?? null, now, now).run();
  return id;
}

export async function syncPersonalConnectorsFromProvider(
  env: Env,
  workspaceId: string,
  userId: string,
  teamWorkspaceId?: string,
): Promise<void> {
  const provider = getIntegrationProvider(env);
  let connections: IntegrationProviderConnection[] = [];
  try {
    connections = await provider.listConnections({
      userId,
      ...(teamWorkspaceId ? { workspaceId: teamWorkspaceId } : {}),
      includeUnavailable: false,
    });
  } catch {
    return;
  }
  const now = Date.now();
  for (const connection of connections) {
    if (connection.executionReady !== true) continue;
    await upsertPersonalConnectorFromProvider(env, workspaceId, userId, connection, now);
  }
}

export async function createWorkspaceConnector(
  env: Env,
  workspaceId: string,
  userId: string,
  input: { providerKey: string; connectedAccountId: string; scope: ExtensionScope },
  teamWorkspaceId?: string,
): Promise<WorkspaceConnectorRecord> {
  if (!env.AGENT_AUDIT) throw new Error("connector_storage_unavailable");
  const verified = await verifyOwnedConnection(env, userId, teamWorkspaceId, input.providerKey, input.connectedAccountId);
  if (!verified?.executionReady) throw new Error("connection_not_verified");
  const now = Date.now();
  const id = await upsertPersonalConnectorFromProvider(env, workspaceId, userId, verified, now)
    ?? `wcon_${randomHex(12)}`;
  if (input.scope === "workspace") {
    throw new Error("workspace_scope_requires_consent");
  }
  const row = await readById(env, workspaceId, id);
  if (!row) throw new Error("connector_not_found");
  return publicRecord(row, userId);
}

export type ConnectorMutationResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "forbidden" | "already_archived" | "not_archived" | "archived" };

export async function archiveWorkspaceConnector(
  env: Env,
  workspaceId: string,
  userId: string,
  id: string,
  canManageWorkspace: boolean,
  now = Date.now(),
): Promise<ConnectorMutationResult> {
  const current = await readById(env, workspaceId, id);
  if (!current) return { ok: false, reason: "not_found" };
  const editable = current.userId === userId || (canManageWorkspace && effectiveScope(current) === "workspace");
  if (!editable) return { ok: false, reason: "forbidden" };
  if (current.archivedAt !== undefined) return { ok: false, reason: "already_archived" };
  const result = await env.AGENT_AUDIT!.prepare(
    `UPDATE workspace_connectors
     SET archived_at = ?, archived_by = ?, archived_from_scope = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
  ).bind(now, userId, effectiveScope(current), now, id, workspaceId).run();
  return result.meta?.changes === 1 ? { ok: true } : { ok: false, reason: "forbidden" };
}

export async function restoreWorkspaceConnector(
  env: Env,
  workspaceId: string,
  userId: string,
  id: string,
  canManageWorkspace: boolean,
): Promise<ConnectorMutationResult> {
  const current = await readById(env, workspaceId, id);
  if (!current) return { ok: false, reason: "not_found" };
  const editable = current.userId === userId || (canManageWorkspace && effectiveScope(current) === "workspace");
  if (!editable) return { ok: false, reason: "forbidden" };
  if (current.archivedAt === undefined) return { ok: false, reason: "not_archived" };
  const scope = current.archivedFromScope ?? current.scope;
  const result = await env.AGENT_AUDIT!.prepare(
    `UPDATE workspace_connectors
     SET scope = ?, archived_at = NULL, archived_by = NULL, archived_from_scope = NULL, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND archived_at IS NOT NULL`,
  ).bind(scope, Date.now(), id, workspaceId).run();
  return result.meta?.changes === 1 ? { ok: true } : { ok: false, reason: "forbidden" };
}

export async function removeWorkspaceConnector(
  env: Env,
  workspaceId: string,
  userId: string,
  id: string,
  canManageWorkspace: boolean,
): Promise<ConnectorMutationResult> {
  const current = await readById(env, workspaceId, id);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.userId !== userId && !(canManageWorkspace && effectiveScope(current) === "workspace")) {
    return { ok: false, reason: "forbidden" };
  }
  const result = await env.AGENT_AUDIT!.prepare(
    `DELETE FROM workspace_connectors WHERE id = ? AND workspace_id = ?`,
  ).bind(id, workspaceId).run();
  return result.meta?.changes === 1 ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function promoteConnectorToWorkspaceScope(
  env: Env,
  workspaceId: string,
  userId: string,
  input: {
    providerKey: string;
    connectedAccountId: string;
    workspaceAppConnectionId: string;
  },
): Promise<ConnectorMutationResult> {
  if (!env.AGENT_AUDIT) return { ok: false, reason: "not_found" };
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT id FROM workspace_connectors
     WHERE workspace_id = ? AND user_id = ? AND provider_key = ? AND connected_account_id = ? AND archived_at IS NULL`,
  ).bind(workspaceId, userId, input.providerKey, input.connectedAccountId).first<{ id: string }>();
  const now = Date.now();
  if (row?.id) {
    const result = await env.AGENT_AUDIT.prepare(
      `UPDATE workspace_connectors
       SET scope = 'workspace', workspace_app_connection_id = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ? AND user_id = ? AND archived_at IS NULL`,
    ).bind(input.workspaceAppConnectionId, now, row.id, workspaceId, userId).run();
    return result.meta?.changes === 1 ? { ok: true } : { ok: false, reason: "forbidden" };
  }
  const id = `wcon_${randomHex(12)}`;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO workspace_connectors
      (id, workspace_id, user_id, provider, provider_key, connected_account_id, scope,
       workspace_app_connection_id, created_at, updated_at)
     VALUES (?, ?, ?, 'openconnector', ?, ?, 'workspace', ?, ?, ?)`,
  ).bind(id, workspaceId, userId, input.providerKey, input.connectedAccountId, input.workspaceAppConnectionId, now, now).run();
  return { ok: true };
}

export async function assertConnectorRegistryAllowsRuntime(
  env: Env,
  workspaceAppConnectionId: string,
): Promise<void> {
  if (!env.AGENT_AUDIT) return;
  const archived = await env.AGENT_AUDIT.prepare(
    `SELECT id FROM workspace_connectors
     WHERE workspace_app_connection_id = ? AND archived_at IS NOT NULL LIMIT 1`,
  ).bind(workspaceAppConnectionId).first();
  if (archived) throw new Error("workspace_connector_archived");
}