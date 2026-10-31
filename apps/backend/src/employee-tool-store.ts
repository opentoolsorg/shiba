import { randomHex } from "./mailbox-store.js";
import type { AuditEnv } from "./audit.js";
import { initAudit } from "./audit.js";
import { expireUnusedEmployeeActionApproval } from "./capability-invocations.js";
import type { EmployeeRole } from "./employee-tool-policy.js";
import type { EmployeeActionApproval } from "./employee-tool-policy.js";
import type { CapabilityRef, ConnectionGrant } from "./connection-policy.js";

export type EmployeeGrantSubjectType = "workspace" | "actor" | "role";
export interface EmployeeToolGrantRecord {
  orgId: string;
  employeeId: string;
  employeeVersion: number;
  subjectType: EmployeeGrantSubjectType;
  subjectId: string;
  capabilityId: string;
  connectionId: string;
  resourceId: string;
  lifecycle: "active" | "revoked" | "expired";
  providerScopes: string[];
  accountId?: string;
  policyVersion: string;
  generation: number;
  createdBy: string;
  updatedAt: number;
};

export interface EmployeeApprovalRecord {
  approvalId: string;
  orgId: string;
  employeeId: string;
  employeeVersion: number;
  actorId: string;
  /** Worker-side run/session; external MCP approvals omit this value. */
  executionContextId?: string;
  /** Durable one-shot claim, retained after the capability receipt is pruned. */
  consumedAt?: number;
  consumedInvocationId?: string;
  connectionId: string;
  connectionGeneration: number;
  capability: CapabilityRef;
  action: string;
  resourceId?: string;
  accountId?: string;
  argumentDigest: string;
  payload: Record<string, unknown>;
  policyVersion: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: number;
  expiresAt: number;
  decidedBy?: string;
  decidedAt?: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS employee_tool_memberships (
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer')),
    employee_version INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT NOT NULL,
    PRIMARY KEY(org_id, employee_id, actor_id)
  )`,
  `CREATE TABLE IF NOT EXISTS employee_tool_grants (
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_version INTEGER NOT NULL,
    subject_type TEXT NOT NULL CHECK(subject_type IN ('workspace','actor','role')),
    subject_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','revoked','expired')),
    provider_scopes_json TEXT NOT NULL,
    account_id TEXT,
    policy_version TEXT NOT NULL,
    generation INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(org_id, employee_id, employee_version, subject_type, subject_id, capability_id, resource_id)
  )`,
  `CREATE INDEX IF NOT EXISTS employee_tool_grants_lookup
    ON employee_tool_grants(org_id, employee_id, employee_version, lifecycle, capability_id)`,
  `CREATE TABLE IF NOT EXISTS employee_tool_approvals (
    approval_id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    employee_version INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    execution_context_id TEXT,
    consumed_at INTEGER,
    consumed_invocation_id TEXT,
    connection_id TEXT NOT NULL,
    connection_generation INTEGER NOT NULL,
    capability_kind TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    action TEXT NOT NULL,
    resource_id TEXT,
    account_id TEXT,
    argument_digest TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','expired')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_by TEXT,
    decided_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS employee_tool_approvals_pending
    ON employee_tool_approvals(org_id, status, created_at DESC)`,
] as const;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
}

const initialized = new WeakSet<D1Database>();

async function ensureTables(env: AuditEnv): Promise<void> {
  if (initialized.has(env.AGENT_AUDIT)) return;
  await initAudit(env);
  for (const sql of SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  const approvalColumns = await env.AGENT_AUDIT.prepare("PRAGMA table_info(employee_tool_approvals)").all<{ name: string }>();
  if (!(approvalColumns.results ?? []).some((column) => column.name === "execution_context_id")) {
    await env.AGENT_AUDIT.prepare("ALTER TABLE employee_tool_approvals ADD COLUMN execution_context_id TEXT").run();
  }
  if (!(approvalColumns.results ?? []).some((column) => column.name === "consumed_at")) {
    await env.AGENT_AUDIT.prepare("ALTER TABLE employee_tool_approvals ADD COLUMN consumed_at INTEGER").run();
  }
  if (!(approvalColumns.results ?? []).some((column) => column.name === "consumed_invocation_id")) {
    await env.AGENT_AUDIT.prepare("ALTER TABLE employee_tool_approvals ADD COLUMN consumed_invocation_id TEXT").run();
  }
  // Migrate the prior uniqueness key so identical payloads in separate run
  // contexts receive separate approval records.
  await env.AGENT_AUDIT.prepare("DROP INDEX IF EXISTS employee_tool_approval_active_payload").run();
  await env.AGENT_AUDIT.prepare(`CREATE UNIQUE INDEX employee_tool_approval_active_payload
    ON employee_tool_approvals(org_id, employee_id, employee_version, actor_id, IFNULL(execution_context_id, ''), capability_id, action,
      argument_digest, IFNULL(resource_id, ''), connection_generation)
    WHERE status IN ('pending','approved')`).run();
  initialized.add(env.AGENT_AUDIT);
}

export async function replaceEmployeeToolGrants(
  env: AuditEnv,
  input: {
    orgId: string; employeeId: string; employeeVersion: number; actorId: string; role: EmployeeRole;
    capabilityIds: readonly string[]; resourcesByCapability: Readonly<Record<string, readonly string[]>>;
    resourceConnectionsByCapability?: Readonly<Record<string, Readonly<Record<string, string>>>>;
    resourceAccountsByCapability?: Readonly<Record<string, Readonly<Record<string, string>>>>; now?: number;
  },
): Promise<void> {
  await ensureTables(env);
  if (!input.orgId || !input.employeeId || !input.actorId || !Number.isSafeInteger(input.employeeVersion) || input.employeeVersion < 1) throw new Error("Invalid employee grant owner.");
  if (!Array.isArray(input.capabilityIds) || input.capabilityIds.length > 50) throw new Error("Employee tool grant limit exceeded.");
  const now = input.now ?? Date.now();
  const capabilityIds = [...new Set(input.capabilityIds)];
  const statements: D1PreparedStatement[] = [
    env.AGENT_AUDIT.prepare(`INSERT INTO employee_tool_memberships
      (org_id, employee_id, actor_id, role, employee_version, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(org_id, employee_id, actor_id) DO UPDATE SET role=excluded.role,
        employee_version=excluded.employee_version, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .bind(input.orgId, input.employeeId, input.actorId, input.role, input.employeeVersion, now, input.actorId),
    env.AGENT_AUDIT.prepare(`DELETE FROM employee_tool_grants WHERE org_id = ? AND employee_id = ? AND subject_id IN (?, ?, ?)`)
      .bind(input.orgId, input.employeeId, input.orgId, input.actorId, input.role),
  ];
  for (const capabilityId of capabilityIds) {
    if (!/^mcp:shiba:[a-z][a-z0-9_]{0,63}$/.test(capabilityId)) throw new Error("Unsupported employee capability id.");
    const resources = input.resourcesByCapability[capabilityId];
    if (!Array.isArray(resources) || resources.length < 1 || resources.length > 100) throw new Error("At least one bounded resource grant is required for every capability.");
    for (const resourceId of [...new Set(resources)]) {
      if (typeof resourceId !== "string" || !resourceId.trim() || resourceId.length > 200) throw new Error("Invalid employee resource grant.");
      const connectionId = input.resourceConnectionsByCapability?.[capabilityId]?.[resourceId] ?? `shiba:${input.employeeId}:${capabilityId}`;
      const accountId = input.resourceAccountsByCapability?.[capabilityId]?.[resourceId] ?? null;
      if (!connectionId || connectionId.length > 200 || (accountId !== null && (!accountId || accountId.length > 254))) throw new Error("Invalid employee connection grant.");
      for (const [subjectType, subjectId] of [["workspace", input.orgId], ["actor", input.actorId], ["role", input.role]] as const) {
        statements.push(env.AGENT_AUDIT.prepare(`INSERT INTO employee_tool_grants
          (org_id, employee_id, employee_version, subject_type, subject_id, capability_id, connection_id, resource_id,
           lifecycle, provider_scopes_json, account_id, policy_version, generation, created_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', ?, ?, 1, ?, ?)`)
          .bind(input.orgId, input.employeeId, input.employeeVersion, subjectType, subjectId, capabilityId,
            connectionId, resourceId, accountId, "employee-policy-current", input.actorId, now));
      }
    }
  }
  await env.AGENT_AUDIT.batch(statements);
}

interface MembershipRow { role: string; employee_version: number; }
interface GrantRow extends Record<string, unknown> {
  org_id: string; employee_id: string; employee_version: number; subject_type: string; subject_id: string;
  capability_id: string; connection_id: string; resource_id: string; lifecycle: string;
  provider_scopes_json: string; account_id: string | null; policy_version: string; generation: number;
  created_by: string; updated_at: number;
}

export async function resolveEmployeeToolPolicy(
  env: AuditEnv,
  input: { orgId: string; employeeId: string; employeeVersion: number; actorId: string },
): Promise<{ role: EmployeeRole; workspaceCapabilityIds: string[]; actorCapabilityIds: string[]; roleCapabilityIds: string[]; employeeGrants: EmployeeToolGrantRecord[] } | null> {
  await ensureTables(env);
  const membership = await env.AGENT_AUDIT.prepare(`SELECT role, employee_version FROM employee_tool_memberships
    WHERE org_id = ? AND employee_id = ? AND actor_id = ?`).bind(input.orgId, input.employeeId, input.actorId).first<MembershipRow>();
  if (!membership || membership.employee_version !== input.employeeVersion || !isEmployeeRole(membership.role)) return null;
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM employee_tool_grants
    WHERE org_id = ? AND employee_id = ? AND employee_version = ? AND lifecycle = 'active'
      AND (subject_type = 'workspace' OR (subject_type = 'actor' AND subject_id = ?) OR (subject_type = 'role' AND subject_id = ?))`)
    .bind(input.orgId, input.employeeId, input.employeeVersion, input.actorId, membership.role).all<GrantRow>();
  const grants = (rows.results ?? []).map(grantFromRow).filter((row): row is EmployeeToolGrantRecord => row !== null);
  return {
    role: membership.role,
    workspaceCapabilityIds: [...new Set(grants.filter((grant) => grant.subjectType === "workspace").map((grant) => grant.capabilityId))],
    actorCapabilityIds: [...new Set(grants.filter((grant) => grant.subjectType === "actor").map((grant) => grant.capabilityId))],
    roleCapabilityIds: [...new Set(grants.filter((grant) => grant.subjectType === "role").map((grant) => grant.capabilityId))],
    employeeGrants: grants,
  };
}

/** Resolve the one current membership frozen by a policy write, if unique. */
export async function resolveCurrentEmployeeToolMembership(
  env: AuditEnv,
  input: { orgId: string; employeeId: string; employeeVersion: number },
): Promise<{ actorId: string; role: EmployeeRole } | null> {
  await ensureTables(env);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT actor_id, role FROM employee_tool_memberships
    WHERE org_id = ? AND employee_id = ? AND employee_version = ? LIMIT 2`)
    .bind(input.orgId, input.employeeId, input.employeeVersion).all<{ actor_id: string; role: string }>();
  if (rows.results?.length !== 1) return null;
  const row = rows.results[0]!;
  if (typeof row.actor_id !== "string" || !row.actor_id || !isEmployeeRole(row.role)) return null;
  return { actorId: row.actor_id, role: row.role };
}

export async function listEmployeeToolGrantRecords(
  env: AuditEnv,
  input: { orgId: string; employeeId: string; employeeVersion?: number },
): Promise<EmployeeToolGrantRecord[]> {
  await ensureTables(env);
  const query = input.employeeVersion === undefined
    ? `SELECT * FROM employee_tool_grants WHERE org_id = ? AND employee_id = ? ORDER BY employee_version DESC, subject_type, subject_id, capability_id, resource_id LIMIT 500`
    : `SELECT * FROM employee_tool_grants WHERE org_id = ? AND employee_id = ? AND employee_version = ? ORDER BY subject_type, subject_id, capability_id, resource_id LIMIT 500`;
  const rows = input.employeeVersion === undefined
    ? await env.AGENT_AUDIT.prepare(query).bind(input.orgId, input.employeeId).all<GrantRow>()
    : await env.AGENT_AUDIT.prepare(query).bind(input.orgId, input.employeeId, input.employeeVersion).all<GrantRow>();
  return (rows.results ?? []).map(grantFromRow).filter((item): item is EmployeeToolGrantRecord => item !== null);
}

export async function resolveEmployeeConnectionGrant(
  env: AuditEnv,
  input: { orgId: string; employeeId: string; employeeVersion: number; actorId: string; capabilityId: string; resourceId: string },
): Promise<ConnectionGrant | null> {
  await ensureTables(env);
  const policy = await resolveEmployeeToolPolicy(env, input);
  if (!policy) return null;
  for (const subjectType of ["workspace", "actor", "role"] as const) {
    if (!policy.employeeGrants.some((grant) => grant.subjectType === subjectType &&
      grant.capabilityId === input.capabilityId && grant.resourceId === input.resourceId && grant.lifecycle === "active")) return null;
  }
  const consistent = policy.employeeGrants.filter((grant) => grant.capabilityId === input.capabilityId && grant.resourceId === input.resourceId && grant.lifecycle === "active");
  if (consistent.length !== 3 || new Set(consistent.map((grant) => `${grant.connectionId}\u0000${grant.accountId ?? ""}\u0000${grant.policyVersion}\u0000${grant.generation}`)).size !== 1) return null;
  const row = await env.AGENT_AUDIT.prepare(`SELECT * FROM employee_tool_grants
    WHERE org_id = ? AND employee_id = ? AND employee_version = ? AND subject_type = 'actor' AND subject_id = ?
      AND capability_id = ? AND resource_id = ? AND lifecycle = 'active' LIMIT 1`)
    .bind(input.orgId, input.employeeId, input.employeeVersion, input.actorId, input.capabilityId, input.resourceId).first<GrantRow>();
  if (!row) return null;
  const grant = grantFromRow(row);
  if (!grant) return null;
  if (grant.providerScopes.length !== 0) return null;
  return {
    connectionId: grant.connectionId,
    owner: { type: "user", userId: input.actorId, workspaceId: input.orgId },
    lifecycle: grant.lifecycle,
    verification: "configured",
    capability: { kind: "mcp", id: grant.capabilityId },
    providerScopes: [], allowedResources: [grant.resourceId],
    ...(grant.accountId ? { accountId: grant.accountId } : {}),
    policyVersion: grant.policyVersion, generation: grant.generation,
  };
}

function grantFromRow(row: GrantRow): EmployeeToolGrantRecord | null {
  let providerScopes: unknown;
  try { providerScopes = JSON.parse(row.provider_scopes_json); } catch { return null; }
  if (
    typeof row.org_id !== "string" || typeof row.employee_id !== "string" || !Number.isSafeInteger(row.employee_version) ||
    (row.subject_type !== "workspace" && row.subject_type !== "actor" && row.subject_type !== "role") ||
    typeof row.subject_id !== "string" || typeof row.capability_id !== "string" ||
    typeof row.connection_id !== "string" || typeof row.resource_id !== "string" ||
    (row.lifecycle !== "active" && row.lifecycle !== "revoked" && row.lifecycle !== "expired") ||
    !Array.isArray(providerScopes) || !providerScopes.every((value) => typeof value === "string") ||
    typeof row.policy_version !== "string" || !Number.isSafeInteger(row.generation) ||
    typeof row.created_by !== "string" || !Number.isSafeInteger(row.updated_at)
  ) return null;
  return {
    orgId: row.org_id, employeeId: row.employee_id, employeeVersion: row.employee_version,
    subjectType: row.subject_type, subjectId: row.subject_id, capabilityId: row.capability_id,
    connectionId: row.connection_id, resourceId: row.resource_id, lifecycle: row.lifecycle,
    providerScopes, ...(row.account_id ? { accountId: row.account_id } : {}),
    policyVersion: row.policy_version, generation: row.generation, createdBy: row.created_by, updatedAt: row.updated_at,
  };
}

function isEmployeeRole(value: unknown): value is EmployeeRole {
  return value === "owner" || value === "admin" || value === "operator" || value === "member" || value === "viewer";
}

function approvalFromRow(row: Record<string, unknown>): EmployeeApprovalRecord | null {
  let capabilityKind: CapabilityRef["kind"];
  let payload: unknown;
  try { payload = JSON.parse(String(row.payload_json)); } catch { return null; }
  const kind = row.capability_kind;
  if (kind !== "connector" && kind !== "skill" && kind !== "mcp") return null;
  capabilityKind = kind;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const status = row.status;
  if (status !== "pending" && status !== "approved" && status !== "denied" && status !== "expired") return null;
  const executionContextId = row.execution_context_id;
  if (executionContextId !== null && executionContextId !== undefined &&
      (typeof executionContextId !== "string" || !executionContextId || executionContextId.length > 200 || hasControlCharacters(executionContextId))) return null;
  return {
    approvalId: String(row.approval_id), orgId: String(row.org_id), employeeId: String(row.employee_id),
    employeeVersion: Number(row.employee_version), actorId: String(row.actor_id),
    ...(typeof executionContextId === "string" ? { executionContextId } : {}),
    ...(typeof row.consumed_at === "number" ? { consumedAt: row.consumed_at } : {}),
    ...(typeof row.consumed_invocation_id === "string" ? { consumedInvocationId: row.consumed_invocation_id } : {}),
    connectionId: String(row.connection_id),
    connectionGeneration: Number(row.connection_generation), capability: { kind: capabilityKind, id: String(row.capability_id) },
    action: String(row.action), ...(typeof row.resource_id === "string" ? { resourceId: row.resource_id } : {}),
    ...(typeof row.account_id === "string" ? { accountId: row.account_id } : {}), argumentDigest: String(row.argument_digest),
    payload: payload as Record<string, unknown>, policyVersion: String(row.policy_version), status,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    ...(typeof row.decided_by === "string" ? { decidedBy: row.decided_by } : {}),
    ...(typeof row.decided_at === "number" ? { decidedAt: row.decided_at } : {}),
  };
}

const APPROVAL_SELECT = `SELECT * FROM employee_tool_approvals`;

export async function requestEmployeeActionApproval(
  env: AuditEnv,
  input: Omit<EmployeeApprovalRecord, "approvalId" | "status" | "createdAt" | "decidedBy" | "decidedAt"> & { now?: number },
): Promise<EmployeeApprovalRecord> {
  await ensureTables(env);
  const now = input.now ?? Date.now();
  const approvalId = `eap-${randomHex(16)}`;
  await env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO employee_tool_approvals
    (approval_id, org_id, employee_id, employee_version, actor_id, execution_context_id, connection_id, connection_generation,
     capability_kind, capability_id, action, resource_id, account_id, argument_digest, payload_json,
     policy_version, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .bind(approvalId, input.orgId, input.employeeId, input.employeeVersion, input.actorId, input.executionContextId ?? null, input.connectionId,
      input.connectionGeneration, input.capability.kind, input.capability.id, input.action, input.resourceId ?? null,
      input.accountId ?? null, input.argumentDigest, JSON.stringify(input.payload), input.policyVersion, now, input.expiresAt).run();
  const row = await env.AGENT_AUDIT.prepare(`${APPROVAL_SELECT}
    WHERE org_id = ? AND employee_id = ? AND employee_version = ? AND actor_id = ? AND execution_context_id IS ? AND capability_id = ? AND action = ?
      AND argument_digest = ? AND resource_id IS ? AND connection_generation = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .bind(input.orgId, input.employeeId, input.employeeVersion, input.actorId, input.executionContextId ?? null, input.capability.id,
      input.action, input.argumentDigest, input.resourceId ?? null, input.connectionGeneration).first<Record<string, unknown>>();
  const result = row && approvalFromRow(row);
  if (!result) throw new Error("Could not persist employee action approval.");
  return result;
}

export async function getEmployeeActionApproval(
  env: AuditEnv,
  input: { orgId: string; employeeId: string; approvalId: string; actorId?: string; now?: number },
): Promise<EmployeeApprovalRecord | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(`${APPROVAL_SELECT} WHERE org_id = ? AND employee_id = ? AND approval_id = ?${input.actorId ? " AND actor_id = ?" : ""} LIMIT 1`)
    .bind(input.orgId, input.employeeId, input.approvalId, ...(input.actorId ? [input.actorId] : [])).first<Record<string, unknown>>();
  const approval = row && approvalFromRow(row);
  if (!approval) return null;
  const now = input.now ?? Date.now();
  if (approval.status === "pending" && now >= approval.expiresAt) {
    await env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals SET status = 'expired' WHERE approval_id = ? AND status = 'pending'`).bind(approval.approvalId).run();
    return { ...approval, status: "expired" };
  }
  if (approval.status === "approved" && now >= approval.expiresAt) {
    const expired = await expireUnusedEmployeeActionApproval(env, {
      approvalId: approval.approvalId, orgId: approval.orgId, principal: approval.actorId,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (expired) return { ...approval, status: "expired" };
    // If the atomic expiration lost to a concurrent dispatch, the durable
    // idempotency receipt owns the outcome. Keep approved so the caller can
    // retrieve that receipt; never create a fresh approval and new write key.
    const current = await env.AGENT_AUDIT.prepare(`${APPROVAL_SELECT} WHERE approval_id = ? LIMIT 1`)
      .bind(approval.approvalId).first<Record<string, unknown>>();
    return current ? approvalFromRow(current) : approval;
  }
  return approval;
}

export async function findEmployeeActionApproval(
  env: AuditEnv,
  input: {
    orgId: string; employeeId: string; employeeVersion: number; actorId: string;
    capabilityId: string; action: string; argumentDigest: string; resourceId: string;
    connectionGeneration: number; executionContextId?: string; now?: number;
  },
): Promise<EmployeeApprovalRecord | null> {
  await ensureTables(env);
  const row = await env.AGENT_AUDIT.prepare(`${APPROVAL_SELECT}
    WHERE org_id = ? AND employee_id = ? AND employee_version = ? AND actor_id = ? AND IFNULL(execution_context_id, '') = ? AND capability_id = ?
      AND action = ? AND argument_digest = ? AND resource_id = ? AND connection_generation = ?
    ORDER BY created_at DESC LIMIT 1`)
    .bind(input.orgId, input.employeeId, input.employeeVersion, input.actorId, input.executionContextId ?? "", input.capabilityId,
      input.action, input.argumentDigest, input.resourceId, input.connectionGeneration).first<Record<string, unknown>>();
  if (!row) return null;
  const approval = approvalFromRow(row);
  if (!approval) return null;
  const now = input.now ?? Date.now();
  if (approval.status === "pending" && now >= approval.expiresAt) {
    await env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals SET status = 'expired' WHERE approval_id = ? AND status = 'pending'`).bind(approval.approvalId).run();
    return { ...approval, status: "expired" };
  }
  if (approval.status === "approved" && now >= approval.expiresAt) {
    const expired = await expireUnusedEmployeeActionApproval(env, {
      approvalId: approval.approvalId, orgId: approval.orgId, principal: approval.actorId,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (expired) return { ...approval, status: "expired" };
    const current = await env.AGENT_AUDIT.prepare(`${APPROVAL_SELECT} WHERE approval_id = ? LIMIT 1`)
      .bind(approval.approvalId).first<Record<string, unknown>>();
    return current ? approvalFromRow(current) : approval;
  }
  return approval;
}

export async function listEmployeeActionApprovals(
  env: AuditEnv,
  input: { orgId: string; status?: EmployeeApprovalRecord["status"]; limit?: number },
): Promise<EmployeeApprovalRecord[]> {
  await ensureTables(env);
  const limit = Math.max(1, Math.min(50, input.limit ?? 20));
  const rows = input.status
    ? await env.AGENT_AUDIT.prepare(`${APPROVAL_SELECT} WHERE org_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(input.orgId, input.status, limit).all<Record<string, unknown>>()
    : await env.AGENT_AUDIT.prepare(`${APPROVAL_SELECT} WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(input.orgId, limit).all<Record<string, unknown>>();
  return (rows.results ?? []).map(approvalFromRow).filter((item): item is EmployeeApprovalRecord => item !== null);
}

export async function decideEmployeeActionApproval(
  env: AuditEnv,
  input: { orgId: string; employeeId: string; approvalId: string; approved: boolean; decidedBy: string; now?: number; requirePendingTransition?: boolean },
): Promise<EmployeeApprovalRecord | null> {
  await ensureTables(env);
  const now = input.now ?? Date.now();
  const updated = await env.AGENT_AUDIT.prepare(`UPDATE employee_tool_approvals SET status = ?, decided_by = ?, decided_at = ?
    WHERE org_id = ? AND employee_id = ? AND approval_id = ? AND status = 'pending' AND expires_at > ?`)
    .bind(input.approved ? "approved" : "denied", input.decidedBy, now, input.orgId, input.employeeId, input.approvalId, now).run();
  if (input.requirePendingTransition && updated.meta.changes !== 1) return null;
  return getEmployeeActionApproval(env, { orgId: input.orgId, employeeId: input.employeeId, approvalId: input.approvalId, now });
}

export function asEmployeeActionApproval(record: EmployeeApprovalRecord): EmployeeActionApproval | null {
  if (record.status !== "approved") return null;
  return {
    approvalId: record.approvalId, approved: true, approvedAt: record.decidedAt ?? record.createdAt,
    principalUserId: record.actorId, workspaceId: record.orgId, connectionId: record.connectionId,
    connectionGeneration: record.connectionGeneration, capability: record.capability, action: record.action,
    ...(record.resourceId ? { resourceId: record.resourceId } : {}), ...(record.accountId ? { accountId: record.accountId } : {}),
    argumentDigest: record.argumentDigest, policyVersion: record.policyVersion, expiresAt: record.expiresAt,
    employeeId: record.employeeId, employeeVersion: record.employeeVersion,
    ...(record.executionContextId ? { executionContextId: record.executionContextId } : {}),
  };
}
