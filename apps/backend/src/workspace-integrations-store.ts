import type { TeamWorkspaceMembership, WorkspaceIntegrationConnection, WorkspaceIntegrationGrant } from "@shiba/shared";
import type { Env } from "./env.js";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import { ensureTeamWorkspacesSchema, getTeamWorkspaceMembership } from "./team-workspaces-store.js";
import { getCustomAgentById, listCustomAgents } from "./custom-agents-store.js";
import { getIntegrationProvider } from "./integrations/runtime.js";
import { isWorkspaceNativeAccountCurrent, nativeWorkspaceAccountSql, resolveWorkspaceNativeGrantTarget, type WorkspaceNativeMember } from "./workspace-native-authority.js";

export class WorkspaceIntegrationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export interface WorkspaceConnectionRow {
  id: string; workspace_id: string; provider_key: string; version: number; generation: number;
  state: WorkspaceIntegrationConnection["state"]; issuer_id: string; issuer_account_id: string; issuer_version: number; issuer_role: string;
  pending_id: string; pending_expires_at: number; fingerprint: string | null; provider_connection_id: string | null;
  identity_label: string | null; created_at: number; updated_at: number;
}
export interface WorkspaceGrantRow {
  id: string; workspace_id: string; connection_id: string; connection_version: number; generation: number; fingerprint: string;
  employee_id: string; employee_version: number; actor_id: string; actor_account_id: string; actor_version: number; actor_role: string;
  permissions_json: string; state: "active" | "revoked"; version: number;
  manager_id: string; manager_account_id: string; manager_version: number; manager_role: string; updated_at: number;
}
export const WORKSPACE_INTEGRATION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workspace_app_connections (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider_key TEXT NOT NULL, version INTEGER NOT NULL,
    generation INTEGER NOT NULL, state TEXT NOT NULL, issuer_id TEXT NOT NULL, issuer_account_id TEXT NOT NULL, issuer_version INTEGER NOT NULL,
    issuer_role TEXT NOT NULL, pending_id TEXT NOT NULL, pending_expires_at INTEGER NOT NULL, fingerprint TEXT,
    provider_connection_id TEXT, identity_label TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS workspace_app_connection_active ON workspace_app_connections(workspace_id,provider_key) WHERE state<>'revoked'`,
  `CREATE TABLE IF NOT EXISTS workspace_app_grants (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL, connection_version INTEGER NOT NULL,
    generation INTEGER NOT NULL, fingerprint TEXT NOT NULL, employee_id TEXT NOT NULL, employee_version INTEGER NOT NULL,
    actor_id TEXT NOT NULL, actor_account_id TEXT NOT NULL, actor_version INTEGER NOT NULL, actor_role TEXT NOT NULL, permissions_json TEXT NOT NULL,
    state TEXT NOT NULL, version INTEGER NOT NULL, manager_id TEXT NOT NULL, manager_account_id TEXT NOT NULL, manager_version INTEGER NOT NULL,
    manager_role TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(connection_id,employee_id,actor_id))`,
  `CREATE TABLE IF NOT EXISTS workspace_app_approvals (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, requester_id TEXT NOT NULL,
    binding_json TEXT NOT NULL, employee_id TEXT NOT NULL, employee_version INTEGER NOT NULL, employee_name TEXT NOT NULL,
    connection_id TEXT NOT NULL, connection_version INTEGER NOT NULL, action_id TEXT NOT NULL, arguments_json TEXT NOT NULL,
    input_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, decision_id TEXT, decision_account_id TEXT, decision_version INTEGER,
    decision_role TEXT, decided_at INTEGER, result_json TEXT, error_code TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(workspace_id,requester_id,request_id))`,
] as const;
const initialized = new WeakSet<D1Database>();
export async function ensureWorkspaceIntegrationSchema(env: Env): Promise<void> {
  if (!env.AGENT_AUDIT) throw new WorkspaceIntegrationError("workspace_storage_unavailable", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  await ensureTeamWorkspacesSchema(env);
  await listCustomAgents(env, "__workspace_schema_only__");
  for (const sql of WORKSPACE_INTEGRATION_SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
export function membershipSql(member: WorkspaceNativeMember, manager = false) {
  const native = nativeWorkspaceAccountSql(member);
  return {
    sql: `EXISTS(SELECT 1 FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=? AND user_id=? AND status='active' AND role=? AND version=?${manager ? " AND role IN ('owner','admin')" : ""}) AND ${native.sql}`,
    values: [COLLAB_TENANT_ID, member.workspaceId, member.userId, member.role, member.version, ...native.values],
  };
}
export async function assertWorkspaceMemberCurrent(env: Env, member: WorkspaceNativeMember, manager = false): Promise<void> {
  const current = await getTeamWorkspaceMembership(env, member.workspaceId, member.userId);
  if (!current || current.version !== member.version || current.role !== member.role || (manager && current.role === "member") || !await isWorkspaceNativeAccountCurrent(env, member)) {
    throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
  }
}
function membership(row: { workspace_id: string; issuer_id: string; issuer_account_id: string; issuer_version: number; issuer_role: string }): WorkspaceNativeMember {
  return { workspaceId: row.workspace_id, userId: row.issuer_id, version: row.issuer_version,
    role: row.issuer_role as TeamWorkspaceMembership["role"], joinedAt: 0, accountId: row.issuer_account_id };
}
export function connectionIssuer(row: WorkspaceConnectionRow) { return membership(row); }
export async function assertConnectionIssuerCurrent(env: Env, row: WorkspaceConnectionRow): Promise<void> {
  await assertWorkspaceMemberCurrent(env, membership(row), true);
}
export async function readWorkspaceConnection(env: Env, space: string, id: string): Promise<WorkspaceConnectionRow | null> {
  await ensureWorkspaceIntegrationSchema(env);
  return env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_connections WHERE workspace_id=? AND id=?").bind(space, id).first<WorkspaceConnectionRow>();
}
export async function requireWorkspaceConnection(env: Env, space: string, id: string, version?: number): Promise<WorkspaceConnectionRow> {
  const row = await readWorkspaceConnection(env, space, id);
  if (!row) throw new WorkspaceIntegrationError("workspace_connection_unavailable", 404);
  if (version !== undefined && row.version !== version) throw new WorkspaceIntegrationError("workspace_connection_changed");
  return row;
}
export function insertGuarded(env: Env, table: string, data: Record<string, unknown>, guard: { sql: string; values: unknown[] }) {
  const keys = Object.keys(data);
  return env.AGENT_AUDIT.prepare(`INSERT INTO ${table} (${keys.join(",")}) SELECT ${keys.map(() => "?").join(",")} WHERE ${guard.sql}`)
    .bind(...Object.values(data), ...guard.values);
}
export function updateGuarded(env: Env, table: string, data: Record<string, unknown>, where: string, values: unknown[]) {
  return env.AGENT_AUDIT.prepare(`UPDATE ${table} SET ${Object.keys(data).map((key) => `${key}=?`).join(",")} WHERE ${where}`)
    .bind(...Object.values(data), ...values);
}
export function requireChanged(result: D1Result, code = "workspace_authority_changed") {
  if (result.meta.changes !== 1) throw new WorkspaceIntegrationError(code);
}
function id(prefix: string) { return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`; }
export async function createWorkspaceConnection(env: Env, member: WorkspaceNativeMember, providerKey: string, origin: string) {
  await ensureWorkspaceIntegrationSchema(env);
  await assertWorkspaceMemberCurrent(env, member, true);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(providerKey)) throw new WorkspaceIntegrationError("invalid_provider", 400);
  const existing = await env.AGENT_AUDIT.prepare("SELECT id FROM workspace_app_connections WHERE workspace_id=? AND provider_key=? AND state<>'revoked'")
    .bind(member.workspaceId, providerKey).first();
  if (existing) throw new WorkspaceIntegrationError("disconnect_before_new_consent");
  const provider = getIntegrationProvider(env);
  const catalog = await provider.listCatalog({ userId: member.userId, workspaceId: member.workspaceId, query: providerKey, limit: 50 });
  await assertWorkspaceMemberCurrent(env, member, true);
  const available = catalog.items.find((item) => item.providerKey === providerKey);
  if (!available?.connectable) throw new WorkspaceIntegrationError("workspace_provider_setup_unavailable", 503);
  if (available.isConnected) throw new WorkspaceIntegrationError("workspace_existing_account_requires_inspection");
  const now = Date.now(), connectionId = id("wci"), pendingId = id("wcp"), authority = membershipSql(member, true);
  const guard = { sql: `${authority.sql} AND (SELECT COUNT(*) FROM workspace_app_connections WHERE workspace_id=? AND state<>'revoked')<20`, values: [...authority.values, member.workspaceId] };
  const data = { id: connectionId, workspace_id: member.workspaceId, provider_key: providerKey, version: 1, generation: 1,
    state: "pending", issuer_id: member.userId, issuer_account_id: member.accountId, issuer_version: member.version, issuer_role: member.role,
    pending_id: pendingId, pending_expires_at: now + 10 * 60_000, fingerprint: null, provider_connection_id: null,
    identity_label: null, created_at: now, updated_at: now };
  try { requireChanged(await insertGuarded(env, "workspace_app_connections", data, guard).run()); }
  catch (error) { if (error instanceof WorkspaceIntegrationError) throw error; throw new WorkspaceIntegrationError("workspace_connection_conflict"); }
  let consent: Awaited<ReturnType<typeof provider.beginConnect>>;
  try { consent = await provider.beginConnect({ userId: member.userId, workspaceId: member.workspaceId, providerKey, callbackOrigin: origin }); }
  catch { consent = { ok: false, provider: "openconnector" }; }
  await assertWorkspaceMemberCurrent(env, member, true);
  if (!consent.ok || !consent.redirectUrl || !consent.authorizationFingerprint) {
    requireChanged(await updateGuarded(env, "workspace_app_connections", { state: "unknown", version: 2, updated_at: Date.now() },
      `id=? AND version=1 AND ${guard.sql}`, [connectionId, ...guard.values]).run());
    throw new WorkspaceIntegrationError("workspace_consent_unconfirmed", 503);
  }
  requireChanged(await updateGuarded(env, "workspace_app_connections", { fingerprint: consent.authorizationFingerprint, version: 2, updated_at: Date.now() },
    `id=? AND state='pending' AND version=1 AND ${guard.sql}`, [connectionId, ...guard.values]).run());
  return { row: await requireWorkspaceConnection(env, member.workspaceId, connectionId), pendingId, redirectUrl: consent.redirectUrl, authorizationFingerprint: consent.authorizationFingerprint };
}
export async function reconcileWorkspaceConnection(env: Env, member: WorkspaceNativeMember, id: string, expectedVersion: number, pendingId: string, fingerprint: string) {
  const row = await requireWorkspaceConnection(env, member.workspaceId, id);
  await assertWorkspaceMemberCurrent(env, member, true);
  if (row.issuer_id !== member.userId || row.issuer_account_id !== member.accountId || row.issuer_version !== member.version || row.issuer_role !== member.role || row.pending_id !== pendingId || row.fingerprint !== fingerprint) {
    throw new WorkspaceIntegrationError("workspace_consent_mismatch", 403);
  }
  if (row.state === "active") return row;
  if (row.version !== expectedVersion || row.state !== "pending" || Date.now() >= row.pending_expires_at) throw new WorkspaceIntegrationError("workspace_consent_expired_or_changed");
  const connections = await getIntegrationProvider(env).listConnections({ userId: member.userId, workspaceId: member.workspaceId });
  await assertWorkspaceMemberCurrent(env, member, true);
  const selected = connections.filter((connection) => connection.providerKey === row.provider_key && connection.authorizationFingerprint === row.fingerprint && connection.executionReady === true);
  if (selected.length !== 1) throw new WorkspaceIntegrationError("workspace_consent_not_observed");
  const guard = membershipSql(member, true);
  requireChanged(await updateGuarded(env, "workspace_app_connections", { state: "active", provider_connection_id: selected[0]!.id,
    identity_label: selected[0]!.identityLabel ?? null, version: row.version + 1, updated_at: Date.now() },
    `id=? AND workspace_id=? AND version=? AND state='pending' AND pending_id=? AND fingerprint=? AND pending_expires_at>? AND ${guard.sql}`,
    [id, member.workspaceId, row.version, pendingId, fingerprint, Date.now(), ...guard.values]).run());
  return requireWorkspaceConnection(env, member.workspaceId, id);
}
export async function disconnectWorkspaceConnection(env: Env, member: WorkspaceNativeMember, id: string, expectedVersion: number) {
  const row = await requireWorkspaceConnection(env, member.workspaceId, id, expectedVersion);
  await assertWorkspaceMemberCurrent(env, member, true);
  if (!["active", "pending", "error"].includes(row.state)) throw new WorkspaceIntegrationError("workspace_disconnect_requires_inspection");
  const guard = membershipSql(member, true);
  requireChanged(await updateGuarded(env, "workspace_app_connections", { state: "revoking", version: row.version + 1, updated_at: Date.now() },
    `id=? AND workspace_id=? AND version=? AND ${guard.sql}`, [id, member.workspaceId, row.version, ...guard.values]).run());
  let confirmed = false;
  try { await getIntegrationProvider(env).disconnect({ userId: member.userId, workspaceId: member.workspaceId, providerKey: row.provider_key, callbackOrigin: "" }); confirmed = true; } catch { /* The write may have reached the sibling; never repeat it automatically. */ }
  await assertWorkspaceMemberCurrent(env, member, true);
  requireChanged(await updateGuarded(env, "workspace_app_connections", { state: confirmed ? "revoked" : "unknown", version: row.version + 2, updated_at: Date.now() },
    `id=? AND version=? AND state='revoking' AND ${guard.sql}`, [id, row.version + 1, ...guard.values]).run());
  return requireWorkspaceConnection(env, member.workspaceId, id);
}
export function grantDto(row: WorkspaceGrantRow): WorkspaceIntegrationGrant {
  return { id: row.id, version: row.version, employeeId: row.employee_id, employeeVersion: row.employee_version, actorId: row.actor_id,
    actorMembershipVersion: row.actor_version, permissions: JSON.parse(row.permissions_json) as WorkspaceIntegrationGrant["permissions"], state: row.state };
}
export async function currentWorkspaceGrant(env: Env, row: WorkspaceGrantRow) {
  const connection = await requireWorkspaceConnection(env, row.workspace_id, row.connection_id, row.connection_version);
  if (connection.state !== "active" || connection.fingerprint !== row.fingerprint || connection.generation !== row.generation || !connection.provider_connection_id) throw new WorkspaceIntegrationError("workspace_connection_changed");
  await assertConnectionIssuerCurrent(env, connection);
  const membership = await getTeamWorkspaceMembership(env, row.workspace_id, row.actor_id);
  if (!membership || membership.version !== row.actor_version || membership.role !== row.actor_role) throw new WorkspaceIntegrationError("workspace_actor_changed", 403);
  const actor = { ...membership, accountId: row.actor_account_id };
  await assertWorkspaceMemberCurrent(env, actor);
  await assertWorkspaceMemberCurrent(env, { workspaceId: row.workspace_id, userId: row.manager_id, accountId: row.manager_account_id, role: row.manager_role as TeamWorkspaceMembership["role"], version: row.manager_version, joinedAt: 0 }, true);
  const employee = await getCustomAgentById(env, `team:${row.workspace_id}`, row.employee_id);
  if (!employee || employee.version !== row.employee_version || employee.archivedAt || row.state !== "active") throw new WorkspaceIntegrationError("workspace_employee_or_grant_changed", 403);
  return { connection, actor, employee, grant: row };
}
export async function assertWorkspaceIntegrationGrant(env: Env, input: { workspaceId: string; actorId: string; employeeId: string; employeeVersion: number; connectionId: string; permission: "discover" | "execute" }) {
  await ensureWorkspaceIntegrationSchema(env);
  const row = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_grants WHERE workspace_id=? AND connection_id=? AND employee_id=? AND actor_id=? AND state='active'")
    .bind(input.workspaceId, input.connectionId, input.employeeId, input.actorId).first<WorkspaceGrantRow>();
  if (!row || row.employee_version !== input.employeeVersion || !(JSON.parse(row.permissions_json) as string[]).includes(input.permission)) throw new WorkspaceIntegrationError("workspace_connection_grant_missing", 403);
  return currentWorkspaceGrant(env, row);
}
export async function workspaceGrantDirectory(env: Env, member: WorkspaceNativeMember, connectionId: string) {
  await assertWorkspaceMemberCurrent(env, member, true);
  const connection = await requireWorkspaceConnection(env, member.workspaceId, connectionId);
  const employees = await listCustomAgents(env, `team:${member.workspaceId}`);
  const actors = await env.AGENT_AUDIT.prepare("SELECT user_id,role,version FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=? AND status='active' ORDER BY user_id LIMIT 100").bind(COLLAB_TENANT_ID, member.workspaceId).all<{ user_id: string; role: TeamWorkspaceMembership["role"]; version: number }>();
  const grants = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_grants WHERE workspace_id=? AND connection_id=? ORDER BY actor_id,employee_id LIMIT 100").bind(member.workspaceId, connectionId).all<WorkspaceGrantRow>();
  await assertWorkspaceMemberCurrent(env, member, true);
  return { ok: true as const, workspaceId: member.workspaceId, connectionId, connectionVersion: connection.version,
    employees: employees.map((employee) => ({ id: employee.id, name: employee.config.name || employee.slug, version: employee.version })),
    actors: actors.results.map((actor) => ({ userId: actor.user_id, role: actor.role, version: actor.version })), grants: grants.results.map(grantDto) };
}
export async function saveWorkspaceGrant(env: Env, member: WorkspaceNativeMember, connectionId: string, input: { employeeId: string; employeeVersion: number; actorId: string; actorMembershipVersion: number; expectedConnectionVersion: number; expectedGrantVersion: number | null; permissions: Array<"discover" | "execute"> }) {
  await assertWorkspaceMemberCurrent(env, member, true);
  const connection = await requireWorkspaceConnection(env, member.workspaceId, connectionId, input.expectedConnectionVersion);
  if (connection.state !== "active" || !connection.fingerprint) throw new WorkspaceIntegrationError("workspace_connection_unavailable");
  await assertConnectionIssuerCurrent(env, connection);
  const target = await getTeamWorkspaceMembership(env, member.workspaceId, input.actorId);
  if (!target || target.version !== input.actorMembershipVersion) throw new WorkspaceIntegrationError("workspace_actor_changed", 403);
  const actor = await resolveWorkspaceNativeGrantTarget(env, target);
  if (!actor) throw new WorkspaceIntegrationError("workspace_native_actor_unavailable", 403);
  const employee = await getCustomAgentById(env, `team:${member.workspaceId}`, input.employeeId);
  if (!employee || employee.version !== input.employeeVersion || employee.archivedAt) throw new WorkspaceIntegrationError("workspace_employee_changed");
  const prior = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_grants WHERE connection_id=? AND employee_id=? AND actor_id=?")
    .bind(connectionId, input.employeeId, actor.userId).first<WorkspaceGrantRow>();
  if ((prior?.version ?? null) !== input.expectedGrantVersion) throw new WorkspaceIntegrationError("workspace_grant_changed");
  const manager = membershipSql(member, true), audience = membershipSql(actor), issuer = membershipSql(connectionIssuer(connection), true);
  const guard = { sql: `${manager.sql} AND ${audience.sql} AND ${issuer.sql} AND EXISTS(SELECT 1 FROM workspace_app_connections WHERE id=? AND workspace_id=? AND version=? AND state='active') AND EXISTS(SELECT 1 FROM org_custom_agents WHERE id=? AND org_id=? AND version=? AND deleted_at IS NULL AND archived_at IS NULL)`,
    values: [...manager.values, ...audience.values, ...issuer.values, connectionId, member.workspaceId, connection.version, employee.id, employee.orgId, employee.version] };
  const data = { workspace_id: member.workspaceId, connection_id: connectionId, connection_version: connection.version, generation: connection.generation, fingerprint: connection.fingerprint,
    employee_id: employee.id, employee_version: employee.version, actor_id: actor.userId, actor_account_id: actor.accountId, actor_version: actor.version, actor_role: actor.role,
    permissions_json: JSON.stringify([...new Set(input.permissions)].sort()), state: input.permissions.length ? "active" : "revoked", version: (prior?.version ?? 0) + 1,
    manager_id: member.userId, manager_account_id: member.accountId, manager_version: member.version, manager_role: member.role, updated_at: Date.now() };
  const result = prior ? await updateGuarded(env, "workspace_app_grants", data, `id=? AND version=? AND ${guard.sql}`, [prior.id, prior.version, ...guard.values]).run()
    : await insertGuarded(env, "workspace_app_grants", { id: id("wcg"), ...data }, guard).run();
  requireChanged(result);
  return workspaceGrantDirectory(env, member, connectionId);
}
export async function connectionDto(env: Env, row: WorkspaceConnectionRow, upstreamReady = false): Promise<WorkspaceIntegrationConnection> {
  let issuerCurrent = true;
  try { await assertConnectionIssuerCurrent(env, row); } catch { issuerCurrent = false; }
  const grants = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_grants WHERE connection_id=? AND state='active' LIMIT 100").bind(row.id).all<WorkspaceGrantRow>();
  let grantCount = 0;
  for (const grant of grants.results) try { await currentWorkspaceGrant(env, grant); grantCount += 1; } catch { /* Stale grants confer no authority. */ }
  const uncertain = await env.AGENT_AUDIT.prepare("SELECT id FROM workspace_app_approvals WHERE connection_id=? AND status IN ('executing','unknown') LIMIT 1").bind(row.id).first();
  return { id: row.id, scope: "workspace", workspaceId: row.workspace_id, providerKey: row.provider_key, version: row.version, generation: row.generation,
    state: !issuerCurrent && row.state === "active" ? "error" : row.state, identityLabel: issuerCurrent ? row.identity_label : null,
    authorizationFingerprint: row.fingerprint, upstreamReady: issuerCurrent && !uncertain && row.state === "active" && upstreamReady, health: issuerCurrent && !uncertain ? "unknown" : "error", grantCount };
}
export async function listWorkspaceConnections(env: Env, member: WorkspaceNativeMember) {
  await ensureWorkspaceIntegrationSchema(env);
  await assertWorkspaceMemberCurrent(env, member);
  const records = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_connections WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50").bind(member.workspaceId).all<WorkspaceConnectionRow>();
  const allowed: WorkspaceConnectionRow[] = [];
  for (const row of records.results) {
    if (member.role !== "member") { allowed.push(row); continue; }
    const grants = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_grants WHERE connection_id=? AND actor_id=? AND actor_version=? AND state='active'").bind(row.id, member.userId, member.version).all<WorkspaceGrantRow>();
    for (const grant of grants.results) try { await currentWorkspaceGrant(env, grant); allowed.push(row); break; } catch { /* No private or stale account discovery. */ }
  }
  let upstream: Awaited<ReturnType<ReturnType<typeof getIntegrationProvider>["listConnections"]>> = [];
  if (allowed.some((row) => row.state === "active")) {
    const eligible = [];
    for (const row of allowed) try { await assertConnectionIssuerCurrent(env, row); eligible.push(row); } catch { /* Do not use a removed manager's account. */ }
    if (eligible.length) try { upstream = await getIntegrationProvider(env).listConnections({ userId: member.userId, workspaceId: member.workspaceId }); } catch { /* Readiness stays unverified. */ }
  }
  await assertWorkspaceMemberCurrent(env, member);
  const connections: WorkspaceIntegrationConnection[] = [];
  const snapshots: WorkspaceConnectionRow[] = [];
  for (const initial of allowed) {
    const row = await requireWorkspaceConnection(env, member.workspaceId, initial.id);
    if (member.role === "member") {
      const grants = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_grants WHERE connection_id=? AND actor_id=? AND actor_version=? AND state='active'").bind(row.id, member.userId, member.version).all<WorkspaceGrantRow>();
      let permitted = false;
      for (const grant of grants.results) try { await currentWorkspaceGrant(env, grant); permitted = true; break; } catch { /* Revalidate after the upstream await. */ }
      if (!permitted) continue;
    }
    connections.push(await connectionDto(env, row, upstream.some((item) => item.id === row.provider_connection_id && item.authorizationFingerprint === row.fingerprint && item.executionReady === true)));
    snapshots.push(row);
  }
  const available = await finalConnectionSourceFilter(env, member, snapshots);
  return { ok: true as const, workspaceId: member.workspaceId, canManage: member.role !== "member", connections: connections.flatMap((connection) =>
    available.has(connection.id) ? [connection] : member.role === "member" ? [] : [{ ...connection, identityLabel: null, upstreamReady: false, health: "error" as const, grantCount: 0 }]) };
}

/** Check account visibility after every account/DTO await in one source snapshot. */
async function finalConnectionSourceFilter(env: Env, member: WorkspaceNativeMember, rows: WorkspaceConnectionRow[]): Promise<Set<string>> {
  const actor = membershipSql(member);
  const participant = (prefix: string, user: string, account: string, role: string, version: string) =>
    `EXISTS(SELECT 1 FROM team_workspace_memberships ${prefix}m
      JOIN shiba_auth_account_policy ${prefix}p ON ${prefix}p.account_id=${account} AND ${prefix}p.email=${user}
      JOIN "user" ${prefix}u ON ${prefix}u.id=${prefix}p.account_id AND lower(${prefix}u.email)=${user} AND ${prefix}u.emailVerified=1
      WHERE ${prefix}m.tenant_id=? AND ${prefix}m.workspace_id=c.workspace_id AND ${prefix}m.user_id=${user}
        AND ${prefix}m.role=${role} AND ${prefix}m.version=${version} AND ${prefix}m.status='active' AND ${prefix}m.role IN ('owner','admin'))`;
  const snapshot = (column: string) => `json_extract(f.value,'$.${column}')`;
  const result = await env.AGENT_AUDIT.prepare(`SELECT '' AS id,'member' AS kind WHERE ${actor.sql}
    UNION ALL SELECT c.id,'source' AS kind FROM workspace_app_connections c JOIN json_each(?) f ON c.id=${snapshot("id")}
    WHERE c.workspace_id=? AND c.version=${snapshot("version")} AND c.generation=${snapshot("generation")}
      AND c.state=${snapshot("state")} AND c.fingerprint IS ${snapshot("fingerprint")} AND c.provider_connection_id IS ${snapshot("provider_connection_id")}
      AND c.issuer_id=${snapshot("issuer_id")} AND c.issuer_account_id=${snapshot("issuer_account_id")}
      AND c.issuer_version=${snapshot("issuer_version")} AND c.issuer_role=${snapshot("issuer_role")}
      AND ${participant("i", "c.issuer_id", "c.issuer_account_id", "c.issuer_role", "c.issuer_version")}
      AND (?=1 OR EXISTS(SELECT 1 FROM workspace_app_grants g JOIN org_custom_agents e ON e.id=g.employee_id
        AND e.org_id='team:'||c.workspace_id AND e.version=g.employee_version AND e.deleted_at IS NULL AND e.archived_at IS NULL
        WHERE g.workspace_id=c.workspace_id AND g.connection_id=c.id AND c.state='active' AND g.state='active'
          AND g.connection_version=c.version AND g.generation=c.generation AND g.fingerprint=c.fingerprint
          AND g.actor_id=? AND g.actor_account_id=? AND g.actor_role=? AND g.actor_version=?
          AND (g.permissions_json LIKE '%"discover"%' OR g.permissions_json LIKE '%"execute"%')
          AND ${participant("g", "g.manager_id", "g.manager_account_id", "g.manager_role", "g.manager_version")}))
      AND ${actor.sql}`)
    .bind(...actor.values, JSON.stringify(rows), member.workspaceId, COLLAB_TENANT_ID, member.role === "member" ? 0 : 1,
      member.userId, member.accountId, member.role, member.version, COLLAB_TENANT_ID, ...actor.values).all<{ id: string; kind: "member" | "source" }>();
  if (!result.results.some((row) => row.kind === "member")) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
  return new Set(result.results.filter((row) => row.kind === "source").map((row) => row.id));
}
