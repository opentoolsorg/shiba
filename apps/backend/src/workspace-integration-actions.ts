import type { TeamWorkspaceMembership, WorkspaceIntegrationApproval } from "@shiba/shared";
import type { Env } from "./env.js";
import { hashToolArgs } from "./mcp-gateway.js";
import { getIntegrationProvider } from "./integrations/runtime.js";
import { redactSecrets } from "./security.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { COLLAB_TENANT_ID } from "./collaboration-store.js";
import { founderConnectorActionGuard, founderConnectorContextPredicate, founderConnectorRecipeHash, type FounderConnectorActionContext } from "./founder-connector-context.js";
import {
  WorkspaceIntegrationError, assertWorkspaceIntegrationGrant, assertWorkspaceMemberCurrent, connectionIssuer,
  ensureWorkspaceIntegrationSchema, insertGuarded, membershipSql, requireChanged, updateGuarded,
} from "./workspace-integrations-store.js";

export interface WorkspaceActionBinding {
  workspaceId: string; actorId: string; actorAccountId: string; actorVersion: number; actorRole: TeamWorkspaceMembership["role"];
  employeeId: string; employeeVersion: number; connectionId: string; connectionVersion: number; generation: number;
  fingerprint: string; providerConnectionId: string; providerKey: string; grantId: string; grantVersion: number;
  issuer: WorkspaceNativeMember; grantManager: WorkspaceNativeMember; actionSchemaHash: string;
  resultAudience?: "requester-private";
  founderContext?: FounderConnectorActionContext;
}
type ActionBinding = WorkspaceActionBinding;
interface ActionRow {
  id: string; workspace_id: string; request_id: string; requester_id: string; binding_json: string;
  employee_id: string; employee_version: number; employee_name: string; connection_id: string; connection_version: number;
  action_id: string; arguments_json: string; input_hash: string; status: WorkspaceIntegrationApproval["status"];
  expires_at: number; decision_id: string | null; decision_account_id: string | null; decision_version: number | null; decision_role: string | null;
  result_json: string | null; error_code: string | null; created_at: number; updated_at: number;
}
const ACTION_TTL_MS = 15 * 60_000;
function actorMembership(binding: ActionBinding): WorkspaceNativeMember {
  return { workspaceId: binding.workspaceId, userId: binding.actorId, accountId: binding.actorAccountId, version: binding.actorVersion, role: binding.actorRole, joinedAt: 0 };
}
export function workspaceActionSourceGuard(binding: ActionBinding, permission: "discover" | "execute" = "execute") {
  const actor = membershipSql(actorMembership(binding)), issuer = membershipSql(binding.issuer, true), manager = membershipSql(binding.grantManager, true);
  return { sql: `${actor.sql} AND ${issuer.sql} AND ${manager.sql}
    AND EXISTS(SELECT 1 FROM workspace_app_connections WHERE id=? AND workspace_id=? AND state='active' AND version=? AND generation=? AND fingerprint=? AND provider_connection_id=?)
    AND EXISTS(SELECT 1 FROM workspace_app_grants WHERE id=? AND workspace_id=? AND state='active' AND version=? AND connection_id=? AND connection_version=? AND actor_id=? AND actor_version=? AND employee_id=? AND employee_version=? AND permissions_json LIKE '%"${permission}"%')
    AND EXISTS(SELECT 1 FROM org_custom_agents WHERE id=? AND org_id=? AND version=? AND archived_at IS NULL AND deleted_at IS NULL)`,
    values: [...actor.values, ...issuer.values, ...manager.values, binding.connectionId, binding.workspaceId, binding.connectionVersion, binding.generation, binding.fingerprint, binding.providerConnectionId,
      binding.grantId, binding.workspaceId, binding.grantVersion, binding.connectionId, binding.connectionVersion, binding.actorId, binding.actorVersion, binding.employeeId, binding.employeeVersion,
      binding.employeeId, `team:${binding.workspaceId}`, binding.employeeVersion] };
}
const actionGuard = workspaceActionSourceGuard;
function captureBinding(current: Awaited<ReturnType<typeof assertWorkspaceIntegrationGrant>>, actionSchemaHash: string, resultAudience?: "requester-private", founderContext?: FounderConnectorActionContext): ActionBinding {
  const { connection, grant, actor } = current;
  return { workspaceId: connection.workspace_id, actorId: actor.userId, actorAccountId: actor.accountId, actorVersion: actor.version, actorRole: actor.role,
    employeeId: grant.employee_id, employeeVersion: grant.employee_version, connectionId: connection.id, connectionVersion: connection.version,
    generation: connection.generation, fingerprint: connection.fingerprint!, providerConnectionId: connection.provider_connection_id!, providerKey: connection.provider_key,
    grantId: grant.id, grantVersion: grant.version, issuer: connectionIssuer(connection),
      grantManager: { workspaceId: connection.workspace_id, userId: grant.manager_id, accountId: grant.manager_account_id, version: grant.manager_version, role: grant.manager_role as TeamWorkspaceMembership["role"], joinedAt: 0 }, actionSchemaHash,
      ...(resultAudience ? { resultAudience } : {}), ...(founderContext ? { founderContext } : {}) };
}
async function currentBinding(env: Env, binding: ActionBinding) {
  const current = await assertWorkspaceIntegrationGrant(env, { workspaceId: binding.workspaceId, actorId: binding.actorId, employeeId: binding.employeeId,
    employeeVersion: binding.employeeVersion, connectionId: binding.connectionId, permission: "execute" });
  if (JSON.stringify(captureBinding(current, binding.actionSchemaHash, binding.resultAudience, binding.founderContext)) !== JSON.stringify(binding)) throw new WorkspaceIntegrationError("workspace_action_context_changed", 403);
  return current;
}
async function row(env: Env, member: WorkspaceNativeMember, id: string): Promise<ActionRow> {
  await ensureWorkspaceIntegrationSchema(env);
  const found = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_approvals WHERE workspace_id=? AND id=?").bind(member.workspaceId, id).first<ActionRow>();
  if (!found) throw new WorkspaceIntegrationError("workspace_action_unavailable", 404);
  return found;
}
async function verifyAction(env: Env, binding: ActionBinding, actionId: string) {
  const provider = getIntegrationProvider(env);
  const actions = await provider.searchActions({ userId: binding.actorId, workspaceId: binding.workspaceId, toolkitSlug: binding.providerKey, actionId, limit: 1 });
  if (actions.length !== 1 || actions[0]!.id !== actionId || actions[0]!.service !== binding.providerKey || await hashToolArgs(actions[0]!.inputSchema ?? {}) !== binding.actionSchemaHash) {
    throw new WorkspaceIntegrationError("workspace_action_schema_changed");
  }
  await currentBinding(env, binding);
}
export async function discoverWorkspaceActions(env: Env, member: WorkspaceNativeMember, connectionId: string, employeeId: string, employeeVersion: number, query = "", beforeSourceReturn?: () => Promise<void>) {
  await assertWorkspaceMemberCurrent(env, member);
  const current = await assertWorkspaceIntegrationGrant(env, { workspaceId: member.workspaceId, actorId: member.userId, employeeId, employeeVersion, connectionId, permission: "discover" });
  const actions = await getIntegrationProvider(env).searchActions({ userId: member.userId, workspaceId: member.workspaceId, toolkitSlug: current.connection.provider_key, query, limit: 25 });
  await beforeSourceReturn?.();
  const source = actionGuard(captureBinding(current, ""), "discover"), actor = membershipSql(member);
  if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${source.sql} AND ${actor.sql}`).bind(...source.values, ...actor.values).first()) {
    throw new WorkspaceIntegrationError("workspace_action_context_changed", 403);
  }
  return { ok: true as const, workspaceId: member.workspaceId, connectionId, actions };
}
export async function previewWorkspaceAction(env: Env, member: WorkspaceNativeMember, connectionId: string, input: { employeeId: string; employeeVersion: number; actionId: string; arguments: Record<string, unknown> }, options: { resultAudience?: "requester-private" } = {}) {
  await assertWorkspaceMemberCurrent(env, member);
  const current = await assertWorkspaceIntegrationGrant(env, { workspaceId: member.workspaceId, actorId: member.userId, employeeId: input.employeeId,
    employeeVersion: input.employeeVersion, connectionId, permission: "execute" });
  const actions = await getIntegrationProvider(env).searchActions({ userId: member.userId, workspaceId: member.workspaceId, toolkitSlug: current.connection.provider_key, actionId: input.actionId, limit: 1 });
  if (actions.length !== 1 || actions[0]!.service !== current.connection.provider_key || actions[0]!.id !== input.actionId) throw new WorkspaceIntegrationError("workspace_action_unavailable", 404);
  const binding = captureBinding(current, await hashToolArgs(actions[0]!.inputSchema ?? {}), options.resultAudience);
  await currentBinding(env, binding);
  await assertWorkspaceMemberCurrent(env, member);
  return { binding, inputHash: await hashToolArgs({ binding, actionId: input.actionId, arguments: input.arguments }), action: actions[0]!, employee: current.employee, connection: current.connection };
}

/** Trusted server options are never accepted by the public HTTP action schema. */
export async function requestWorkspaceAction(env: Env, member: WorkspaceNativeMember, connectionId: string, input: { employeeId: string; employeeVersion: number; actionId: string; arguments: Record<string, unknown>; requestId: string }, options: {
  expectedBindingDigest?: string; founderContext?: FounderConnectorActionContext; resultAudience?: "requester-private"; expiresAt?: number;
} = {}) {
  const preview = await previewWorkspaceAction(env, member, connectionId, input, options);
  if (options.expectedBindingDigest && await hashToolArgs(preview.binding) !== options.expectedBindingDigest) throw new WorkspaceIntegrationError("workspace_action_context_changed", 403);
  const binding: ActionBinding = { ...preview.binding, ...(options.founderContext ? { founderContext: options.founderContext } : {}) };
  const inputHash = await hashToolArgs({ binding, actionId: input.actionId, arguments: input.arguments });
  if (options.founderContext && (options.founderContext.requestId !== input.requestId || options.resultAudience !== "requester-private" || !options.expiresAt || options.expiresAt > options.founderContext.expiresAt)) throw new WorkspaceIntegrationError("workspace_action_context_changed", 403);
  const previous = await env.AGENT_AUDIT.prepare("SELECT * FROM workspace_app_approvals WHERE workspace_id=? AND requester_id=? AND request_id=?")
    .bind(member.workspaceId, member.userId, input.requestId).first<ActionRow>();
  if (previous) {
    if (previous.input_hash !== inputHash) throw new WorkspaceIntegrationError("workspace_action_request_conflict");
    const context = await founderConnectorActionGuard(binding, previous.id), source = actionGuard(binding);
    if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${source.sql} AND ${context.sql}`).bind(...source.values, ...context.values).first()) throw new WorkspaceIntegrationError("workspace_action_context_changed", 403);
    return previous.id;
  }
  const busy = await env.AGENT_AUDIT.prepare("SELECT id FROM workspace_app_approvals WHERE connection_id=? AND status IN ('executing','unknown') LIMIT 1").bind(connectionId).first();
  if (busy) throw new WorkspaceIntegrationError("workspace_account_requires_inspection");
  const now = Date.now(), approvalId = `wca_${crypto.randomUUID().replaceAll("-", "")}`;
  const source = actionGuard(binding), context = await founderConnectorActionGuard(binding, approvalId);
  const expiresAt = Math.min(now + ACTION_TTL_MS, options.expiresAt ?? Number.MAX_SAFE_INTEGER);
  if (expiresAt <= Date.now()) throw new WorkspaceIntegrationError("workspace_action_expired", 403);
  const insert = insertGuarded(env, "workspace_app_approvals", { id: approvalId, workspace_id: member.workspaceId,
    request_id: input.requestId, requester_id: member.userId, binding_json: JSON.stringify(binding), employee_id: input.employeeId,
    employee_version: input.employeeVersion, employee_name: preview.employee.config.name || preview.employee.slug, connection_id: connectionId,
    connection_version: preview.connection.version, action_id: input.actionId, arguments_json: JSON.stringify(input.arguments), input_hash: inputHash,
    status: "pending", expires_at: expiresAt, decision_id: null, decision_account_id: null, decision_version: null, decision_role: null, decided_at: null,
    result_json: null, error_code: null, created_at: now, updated_at: now }, { sql: `${source.sql} AND ${context.sql} AND NOT EXISTS(SELECT 1 FROM workspace_app_approvals WHERE connection_id=? AND status IN ('executing','unknown'))`, values: [...source.values, ...context.values, connectionId] });
  try { requireChanged(await insert.run()); }
  catch (error) {
    const duplicate = await env.AGENT_AUDIT.prepare("SELECT id,input_hash FROM workspace_app_approvals WHERE workspace_id=? AND requester_id=? AND request_id=?")
      .bind(member.workspaceId, member.userId, input.requestId).first<{ id: string; input_hash: string }>();
    if (duplicate?.input_hash === inputHash) return duplicate.id;
    throw error;
  }
  return approvalId;
}
async function decisionCurrent(env: Env, approval: ActionRow) {
  if (!approval.decision_id || !approval.decision_account_id || !approval.decision_version || !approval.decision_role) throw new WorkspaceIntegrationError("workspace_action_not_approved", 403);
  await assertWorkspaceMemberCurrent(env, { workspaceId: approval.workspace_id, userId: approval.decision_id, accountId: approval.decision_account_id, version: approval.decision_version,
    role: approval.decision_role as TeamWorkspaceMembership["role"], joinedAt: 0 }, true);
}
export async function decideWorkspaceAction(env: Env, member: WorkspaceNativeMember, approvalId: string, approved: boolean) {
  await assertWorkspaceMemberCurrent(env, member, true);
  const approval = await row(env, member, approvalId), binding = JSON.parse(approval.binding_json) as ActionBinding;
  await currentBinding(env, binding);
  if (approval.status !== "pending" || Date.now() >= approval.expires_at) throw new WorkspaceIntegrationError("workspace_action_not_pending");
  if (await env.AGENT_AUDIT.prepare("SELECT id FROM workspace_app_approvals WHERE connection_id=? AND id<>? AND status IN ('executing','unknown') LIMIT 1").bind(approval.connection_id, approval.id).first()) {
    throw new WorkspaceIntegrationError("workspace_account_requires_inspection");
  }
  const source = actionGuard(binding), manager = membershipSql(member, true);
  const context = await founderConnectorActionGuard(binding, approvalId);
  requireChanged(await updateGuarded(env, "workspace_app_approvals", { status: approved ? "approved" : "denied", decision_id: member.userId,
    decision_account_id: member.accountId, decision_version: member.version, decision_role: member.role, decided_at: Date.now(), updated_at: Date.now() },
    `id=? AND workspace_id=? AND status='pending' AND expires_at>? AND ${source.sql} AND ${manager.sql} AND ${context.sql} AND NOT EXISTS(SELECT 1 FROM workspace_app_approvals other WHERE other.connection_id=? AND other.id<>? AND other.status IN ('executing','unknown'))`,
    [approvalId, member.workspaceId, Date.now(), ...source.values, ...manager.values, ...context.values, approval.connection_id, approval.id]).run());
  return approvalId;
}
function safeResult(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactSecrets(value).slice(0, 4000);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeResult(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [redactSecrets(key).slice(0, 100), safeResult(item, depth + 1)]));
  return null;
}
export async function executeWorkspaceAction(env: Env, member: WorkspaceNativeMember, approvalId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await assertWorkspaceMemberCurrent(env, member);
  const approval = await row(env, member, approvalId);
  if (approval.requester_id !== member.userId) throw new WorkspaceIntegrationError("workspace_action_requester_required", 403);
  const binding = JSON.parse(approval.binding_json) as ActionBinding;
  if (binding.actorAccountId !== member.accountId) throw new WorkspaceIntegrationError("workspace_native_identity_changed", 403);
  await currentBinding(env, binding);
  await decisionCurrent(env, approval);
  if (await hashToolArgs({ binding, actionId: approval.action_id, arguments: JSON.parse(approval.arguments_json) }) !== approval.input_hash) throw new WorkspaceIntegrationError("workspace_action_digest_mismatch", 403);
  if (["executing", "completed", "failed", "unknown"].includes(approval.status)) return approvalId;
  if (approval.status !== "approved" || Date.now() >= approval.expires_at) throw new WorkspaceIntegrationError("workspace_action_not_approved", 403);
  await verifyAction(env, binding, approval.action_id);
  await assertWorkspaceMemberCurrent(env, member);
  const source = actionGuard(binding), decider = membershipSql({ workspaceId: approval.workspace_id, userId: approval.decision_id!, accountId: approval.decision_account_id!, version: approval.decision_version!, role: approval.decision_role as TeamWorkspaceMembership["role"], joinedAt: 0 }, true);
  const context = await founderConnectorActionGuard(binding, approvalId);
  requireChanged(await updateGuarded(env, "workspace_app_approvals", { status: "executing", updated_at: Date.now() },
    `id=? AND workspace_id=? AND requester_id=? AND status='approved' AND expires_at>? AND ${source.sql} AND ${decider.sql} AND ${context.sql} AND NOT EXISTS(SELECT 1 FROM workspace_app_approvals other WHERE other.connection_id=? AND other.id<>? AND other.status IN ('executing','unknown'))`,
    [approvalId, member.workspaceId, member.userId, Date.now(), ...source.values, ...decider.values, ...context.values, binding.connectionId, approvalId]).run(), "workspace_action_already_claimed");
  let status: "completed" | "failed" | "unknown" = "unknown", result: unknown = null, errorCode: string | null = "workspace_action_outcome_unknown";
  let preflightFailed = false;
  try {
    const output = await getIntegrationProvider(env).executeTool({ userId: member.userId, workspaceId: member.workspaceId, toolkitSlug: binding.providerKey,
      toolSlug: approval.action_id, arguments: JSON.parse(approval.arguments_json) as Record<string, unknown>, approvedConnectionId: binding.providerConnectionId,
      signal, approvedUntil: approval.expires_at, beforeDispatch: async () => {
        try {
          signal?.throwIfAborted();
          if (Date.now() >= approval.expires_at) throw new WorkspaceIntegrationError("workspace_action_expired", 403);
          await assertWorkspaceMemberCurrent(env, member);
          await currentBinding(env, binding);
          await decisionCurrent(env, approval);
          const accounts = await getIntegrationProvider(env).listConnections({ userId: member.userId, workspaceId: member.workspaceId });
          if (!accounts.some((account) => account.id === binding.providerConnectionId && account.authorizationFingerprint === binding.fingerprint && account.executionReady === true)) throw new WorkspaceIntegrationError("workspace_consent_changed", 403);
          // Last awaited operation is one source/decision/requester snapshot.
          // No later account lookup can leave a stale grant authorizing the POST.
          const actor = membershipSql(member);
          if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${source.sql} AND ${decider.sql} AND ${actor.sql} AND ${context.sql}
            AND EXISTS(SELECT 1 FROM workspace_app_approvals WHERE id=? AND workspace_id=? AND status='executing'
              AND input_hash=? AND binding_json=? AND decision_id=? AND decision_account_id=? AND decision_version=? AND decision_role=? AND expires_at=?)`)
            .bind(...source.values, ...decider.values, ...actor.values, ...context.values, approvalId, member.workspaceId, approval.input_hash, approval.binding_json,
              approval.decision_id, approval.decision_account_id, approval.decision_version, approval.decision_role, approval.expires_at).first()) {
            throw new WorkspaceIntegrationError("workspace_action_context_changed", 403);
          }
          signal?.throwIfAborted();
          if (Date.now() >= approval.expires_at) throw new WorkspaceIntegrationError("workspace_action_expired", 403);
        } catch (error) { preflightFailed = true; throw error; }
      } });
    if (output.ok) { status = "completed"; result = safeResult(output.output); errorCode = null; }
    else if (preflightFailed) { status = "failed"; errorCode = "workspace_action_authority_changed"; }
  } finally {
    const encoded = JSON.stringify(result);
    requireChanged(await updateGuarded(env, "workspace_app_approvals", { status, result_json: encoded.length <= 32_768 ? encoded : JSON.stringify({ truncated: true }), error_code: errorCode, updated_at: Date.now() },
      "id=? AND status='executing'", [approvalId]).run(), "workspace_action_receipt_unconfirmed");
  }
  return approvalId;
}
export async function listWorkspaceApprovals(env: Env, member: WorkspaceNativeMember) {
  await ensureWorkspaceIntegrationSchema(env);
  await assertWorkspaceMemberCurrent(env, member);
  const manager = member.role !== "member";
  const rows = await env.AGENT_AUDIT.prepare(`SELECT * FROM workspace_app_approvals WHERE workspace_id=?${manager ? "" : " AND requester_id=?"} ORDER BY created_at DESC LIMIT 50`)
    .bind(member.workspaceId, ...(!manager ? [member.userId] : [])).all<ActionRow>();
  const approvals: WorkspaceIntegrationApproval[] = [];
  const bindings = new Map<string, ActionBinding>();
  for (const approval of rows.results) {
    let current = true, decisionValid = false;
    const binding = JSON.parse(approval.binding_json) as ActionBinding;
    bindings.set(approval.id, binding);
    try { await currentBinding(env, binding); } catch { current = false; }
    if (!manager && !current) continue;
    try { await decisionCurrent(env, approval); decisionValid = true; } catch { /* A stale human decision never authorizes dispatch. */ }
    const expired = Date.now() >= approval.expires_at, abandoned = approval.status === "executing" && Date.now() - approval.updated_at > 5 * 60_000;
    const busy = await env.AGENT_AUDIT.prepare("SELECT id FROM workspace_app_approvals WHERE connection_id=? AND id<>? AND status IN ('executing','unknown') LIMIT 1").bind(approval.connection_id, approval.id).first();
    approvals.push({ id: approval.id, requesterId: approval.requester_id, employeeId: approval.employee_id, employeeVersion: approval.employee_version,
      employeeName: approval.employee_name, connectionId: approval.connection_id, connectionVersion: approval.connection_version, actionId: approval.action_id,
      arguments: current ? JSON.parse(approval.arguments_json) as Record<string, unknown> : {}, inputHash: approval.input_hash,
      status: abandoned ? "unknown" : expired && approval.status === "pending" ? "expired" : approval.status, expiresAt: approval.expires_at,
      canDecide: manager && current && !busy && !expired && approval.status === "pending",
      canExecute: current && decisionValid && !busy && !expired && approval.status === "approved" && approval.requester_id === member.userId,
      result: current && (binding.resultAudience !== "requester-private" || binding.actorAccountId === member.accountId) && approval.result_json ? JSON.parse(approval.result_json) as unknown : null,
      error: current ? abandoned ? "workspace_action_receipt_unconfirmed" : busy ? "workspace_account_requires_inspection" : approval.error_code : "workspace_action_context_changed" });
  }
  // Upstream revocation does not rewrite the local receipt. Observe it before
  // the final local source fence, without exposing another actor's account.
  let accounts: Awaited<ReturnType<ReturnType<typeof getIntegrationProvider>["listConnections"]>> = [];
  if (approvals.some((approval) => approval.error !== "workspace_action_context_changed")) {
    try { accounts = await getIntegrationProvider(env).listConnections({ userId: member.userId, workspaceId: member.workspaceId }); }
    catch { /* No fresh upstream proof means no cached protected content. */ }
  }
  const available = await finalApprovalSourceFilter(env, member, rows.results);
  const filtered: WorkspaceIntegrationApproval[] = [];
  for (const approval of approvals) {
    const binding = bindings.get(approval.id)!;
    const upstream = accounts.some((account) => account.id === binding.providerConnectionId && account.authorizationFingerprint === binding.fingerprint && account.executionReady === true);
    if (available.has(approval.id) && upstream) filtered.push(approval);
    else if (manager) filtered.push({ ...approval, arguments: {}, result: null, canDecide: false, canExecute: false, error: "workspace_action_context_changed" });
  }
  return { ok: true as const, workspaceId: member.workspaceId, approvals: filtered };
}

/** One D1 snapshot checks every returned row after all other asynchronous reads. */
async function finalApprovalSourceFilter(env: Env, member: WorkspaceNativeMember, rows: ActionRow[]): Promise<Set<string>> {
  const actor = membershipSql(member);
  const at = (path: string) => `json_extract(f.value,'$.binding.${path}')`;
  const participant = (prefix: string, user: string, account: string, role: string, version: string, manager = false) =>
    `EXISTS(SELECT 1 FROM team_workspace_memberships ${prefix}m
      JOIN shiba_auth_account_policy ${prefix}p ON ${prefix}p.account_id=${account} AND ${prefix}p.email=${user}
      JOIN "user" ${prefix}u ON ${prefix}u.id=${prefix}p.account_id AND lower(${prefix}u.email)=${user} AND ${prefix}u.emailVerified=1
      WHERE ${prefix}m.tenant_id=? AND ${prefix}m.workspace_id=a.workspace_id AND ${prefix}m.user_id=${user}
        AND ${prefix}m.role=${role} AND ${prefix}m.version=${version} AND ${prefix}m.status='active'${manager ? ` AND ${prefix}m.role IN ('owner','admin')` : ""})`;
  const snapshots = await Promise.all(rows.map(async (row) => {
    const binding = JSON.parse(row.binding_json) as ActionBinding;
    return { id: row.id, binding, bindingJson: row.binding_json, inputHash: row.input_hash,
      founderRecipeSha256: binding.founderContext ? await founderConnectorRecipeHash(binding.founderContext.libraryId) : null };
  }));
  const founderFence = snapshots.some((item) => item.binding.founderContext)
    ? `(json_extract(f.value,'$.binding.founderContext') IS NULL OR ${founderConnectorContextPredicate({
      context: "json_extract(f.value,'$.binding.founderContext')", binding: "json_extract(f.value,'$.binding')",
      approvalId: "a.id", recipeHash: "json_extract(f.value,'$.founderRecipeSha256')",
    })})` : "1=1";
  const result = await env.AGENT_AUDIT.prepare(`SELECT '' AS id,'member' AS kind WHERE ${actor.sql}
    UNION ALL SELECT a.id,'source' AS kind FROM workspace_app_approvals a JOIN json_each(?) f ON a.id=json_extract(f.value,'$.id')
    JOIN workspace_app_connections c ON c.id=${at("connectionId")} AND c.workspace_id=a.workspace_id AND c.state='active'
      AND c.version=${at("connectionVersion")} AND c.generation=${at("generation")} AND c.fingerprint=${at("fingerprint")}
      AND c.provider_connection_id=${at("providerConnectionId")} AND c.provider_key=${at("providerKey")}
      AND c.issuer_id=${at("issuer.userId")} AND c.issuer_account_id=${at("issuer.accountId")} AND c.issuer_version=${at("issuer.version")} AND c.issuer_role=${at("issuer.role")}
    JOIN workspace_app_grants g ON g.id=${at("grantId")} AND g.workspace_id=a.workspace_id AND g.state='active' AND g.version=${at("grantVersion")}
      AND g.connection_id=c.id AND g.connection_version=c.version AND g.fingerprint=c.fingerprint AND g.generation=c.generation
      AND g.actor_id=${at("actorId")} AND g.actor_account_id=${at("actorAccountId")} AND g.actor_version=${at("actorVersion")} AND g.actor_role=${at("actorRole")}
      AND g.manager_id=${at("grantManager.userId")} AND g.manager_account_id=${at("grantManager.accountId")} AND g.manager_version=${at("grantManager.version")} AND g.manager_role=${at("grantManager.role")}
      AND g.permissions_json LIKE '%"execute"%'
    JOIN org_custom_agents e ON e.id=${at("employeeId")} AND e.org_id='team:'||a.workspace_id AND e.version=${at("employeeVersion")}
      AND e.id=g.employee_id AND e.version=g.employee_version AND e.deleted_at IS NULL AND e.archived_at IS NULL
    WHERE a.workspace_id=? AND a.binding_json=json_extract(f.value,'$.bindingJson') AND a.input_hash=json_extract(f.value,'$.inputHash')
      AND ${participant("a", at("actorId"), at("actorAccountId"), at("actorRole"), at("actorVersion"))}
      AND ${participant("i", at("issuer.userId"), at("issuer.accountId"), at("issuer.role"), at("issuer.version"), true)}
      AND ${participant("g", at("grantManager.userId"), at("grantManager.accountId"), at("grantManager.role"), at("grantManager.version"), true)}
      AND ${actor.sql} AND ${founderFence}`)
    .bind(...actor.values, JSON.stringify(snapshots), member.workspaceId, COLLAB_TENANT_ID, COLLAB_TENANT_ID, COLLAB_TENANT_ID, ...actor.values).all<{ id: string; kind: "member" | "source" }>();
  if (!result.results.some((row) => row.kind === "member")) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
  return new Set(result.results.filter((row) => row.kind === "source").map((row) => row.id));
}
