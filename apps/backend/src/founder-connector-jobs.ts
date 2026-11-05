/** A cron occurrence is inert until its native requester explicitly prepares and executes an approved call. */
import {
  founderConnectorPrepareInputSchema, founderConnectorContractSchema, getFounderSkillLibraryEntry, INTEGRATION_CATALOG,
  redactSecrets,
  type FounderConnectorContract, type FounderConnectorPlan, type FounderConnectorState, type FounderConnectorOccurrence,
} from "@shiba/shared";
import type { Env } from "./env.js";
import type { WorkspaceNativeMember } from "./workspace-native-authority.js";
import { membershipSql, assertWorkspaceMemberCurrent, listWorkspaceConnections, WorkspaceIntegrationError } from "./workspace-integrations-store.js";
import { listCustomAgents } from "./custom-agents-store.js";
import { getSkill } from "./skills-store.js";
import { getSkillInstall } from "./skill-library-store.js";
import { nextFounderReviewDue } from "./founder-review-schedules.js";
import { hashToolArgs } from "./mcp-gateway.js";
import {
  workspaceActionSourceGuard, previewWorkspaceAction, requestWorkspaceAction, decideWorkspaceAction, executeWorkspaceAction,
  listWorkspaceApprovals, type WorkspaceActionBinding,
} from "./workspace-integration-actions.js";
import { founderConnectorActionGuard, founderConnectorContextPredicate, founderConnectorRecipeHash, FOUNDER_SQL_NOW, type FounderConnectorActionContext } from "./founder-connector-context.js";
function requireReviewableArguments(value: unknown, depth = 0): void {
  if (depth > 8) throw new WorkspaceIntegrationError("founder_arguments_unreviewable", 400);
  if (typeof value === "string" && redactSecrets(value) !== value) throw new WorkspaceIntegrationError("founder_credentials_not_allowed", 400);
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/^(password|secret|access_?token|refresh_?token|api_?key|authorization|cookie|private_?key|client_?secret)$/i.test(key)) throw new WorkspaceIntegrationError("founder_credentials_not_allowed", 400);
    requireReviewableArguments(item, depth + 1);
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS founder_connector_jobs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
    library_id TEXT NOT NULL, member_version INTEGER NOT NULL, member_role TEXT NOT NULL,
    version INTEGER NOT NULL, digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('draft','enabled','paused','revoked','blocked')),
    contract_json TEXT NOT NULL,source_json TEXT NOT NULL,binding_json TEXT NOT NULL,recipe_sha256 TEXT NOT NULL,
    expires_at INTEGER NOT NULL,review_expires_at INTEGER NOT NULL,next_due_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,blocked_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    UNIQUE(workspace_id,owner_account_id,library_id))`,
  `CREATE INDEX IF NOT EXISTS founder_connector_jobs_tick ON founder_connector_jobs(state,checked_at)`,
  `CREATE TABLE IF NOT EXISTS founder_connector_occurrences (
    id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,plan_version INTEGER NOT NULL,digest TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,request_id TEXT NOT NULL UNIQUE,approval_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('open','cancelled','expired')),UNIQUE(plan_id,plan_version,scheduled_at))`,
  `CREATE INDEX IF NOT EXISTS founder_connector_occurrences_plan ON founder_connector_occurrences(plan_id,state)`,
];
interface JobRow {
  id: string; workspace_id: string; owner_id: string; owner_account_id: string; library_id: string; member_version: number; member_role: WorkspaceNativeMember["role"];
  version: number; digest: string; state: FounderConnectorPlan["state"]; contract_json: string; source_json: string; binding_json: string;
  recipe_sha256: string; expires_at: number; review_expires_at: number; next_due_at: number; blocked_reason: string | null;
}
interface OccurrenceRow { id: string; plan_id: string; plan_version: number; digest: string; scheduled_at: number; expires_at: number; created_at: number; request_id: string; approval_id: string | null; state: "open" | "cancelled" | "expired" }
const initialized = new WeakSet<D1Database>();
export async function ensureFounderConnectorSchema(env: Env) {
  if (!env.AGENT_AUDIT) throw new WorkspaceIntegrationError("founder_connector_storage_unavailable", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
function contract(row: JobRow): FounderConnectorContract { return JSON.parse(row.contract_json) as FounderConnectorContract; }
function binding(row: JobRow): WorkspaceActionBinding { return JSON.parse(row.binding_json) as WorkspaceActionBinding; }
function manager(row: JobRow): WorkspaceNativeMember { return { workspaceId: row.workspace_id, userId: row.owner_id, accountId: row.owner_account_id, role: row.member_role, version: row.member_version, joinedAt: 0 }; }
function sourceGuard(row: JobRow) {
  const action = workspaceActionSourceGuard(binding(row));
  return { sql: `${action.sql} AND EXISTS (SELECT 1 FROM skills s JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.version
      JOIN skill_installs i ON i.org_id=s.org_id AND i.installed_by=s.owner_id AND i.skill_id=s.id
      WHERE s.id=? AND s.org_id=? AND s.owner_id=? AND s.status='active' AND s.version=? AND s.active_version=s.version
      AND s.reviewed_version=s.version AND s.reviewed_instructions=v.instructions AND v.instructions=json_extract(?,'$.skillInstructions')
      AND v.source_url IS json_extract(?,'$.skillSource') AND i.library_slug=?)
    AND EXISTS (SELECT 1 FROM org_custom_agents WHERE id=? AND org_id=? AND version=? AND config_json=json_extract(?,'$.employeeConfig') AND deleted_at IS NULL AND archived_at IS NULL)`,
    values: [...action.values, contract(row).skillId, `team:${row.workspace_id}`, row.owner_id, contract(row).skillVersion, row.source_json, row.source_json, row.library_id,
      contract(row).employeeId, `team:${row.workspace_id}`, contract(row).employeeVersion, row.source_json] };
}
async function ownRow(env: Env, member: WorkspaceNativeMember, libraryId: string): Promise<JobRow | null> {
  await ensureFounderConnectorSchema(env);
  const actor = membershipSql(member, true);
  return env.AGENT_AUDIT.prepare(`SELECT * FROM founder_connector_jobs WHERE workspace_id=? AND owner_id=? AND owner_account_id=? AND library_id=? AND ${actor.sql}`)
    .bind(member.workspaceId, member.userId, member.accountId, libraryId, ...actor.values).first<JobRow>();
}
export function founderConnectionAllowed(libraryId: string, providerKey: string): boolean {
  const entry = getFounderSkillLibraryEntry(libraryId);
  return Boolean(entry && entry.integrationCatalogIds.some((id) => {
    const catalog = INTEGRATION_CATALOG.find((candidate) => candidate.id === id);
    return (catalog?.openConnectorServiceIds ?? [id]).includes(providerKey);
  }));
}
function scope(member: WorkspaceNativeMember, libraryId: string) { return { ok: true as const, workspaceId: member.workspaceId, libraryId, actorId: member.userId }; }
export async function founderConnectorOptions(env: Env, member: WorkspaceNativeMember, libraryId: string) {
  await assertWorkspaceMemberCurrent(env, member, true);
  const install = await getSkillInstall(env, `team:${member.workspaceId}`, member.userId, libraryId);
  const skill = install ? await getSkill(env, `team:${member.workspaceId}`, member.userId, install.skillId) : null;
  const employees = await listCustomAgents(env, `team:${member.workspaceId}`);
  const connections = await listWorkspaceConnections(env, member);
  const actor = membershipSql(member, true);
  if (!await env.AGENT_AUDIT.prepare(`SELECT 1 AS current WHERE ${actor.sql}`).bind(...actor.values).first()) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
  return { ...scope(member, libraryId), canConfigure: true, employees: employees.slice(0, 100).map((item) => ({ id: item.id, version: item.version, name: item.config.name })),
    skill: skill?.status === "active" && skill.version === skill.activeVersion && skill.version === skill.reviewedVersion ? { id: skill.id, version: skill.version, name: skill.content.name } : null,
    connections: connections.connections.filter((item) => founderConnectionAllowed(libraryId, item.providerKey)).slice(0, 100) };
}
export async function configureFounderConnector(env: Env, member: WorkspaceNativeMember, libraryId: string, body: unknown) {
  await assertWorkspaceMemberCurrent(env, member, true);
  const input = founderConnectorPrepareInputSchema.parse(body), now = Date.now();
  if (input.expiresAt <= now || input.expiresAt > now + 90 * 86_400_000 || new TextEncoder().encode(JSON.stringify(input.arguments)).length > 16_000) throw new WorkspaceIntegrationError("founder_connector_scope_invalid", 400);
  requireReviewableArguments(input.arguments);
  const preview = await previewWorkspaceAction(env, member, input.connectionId, input, { resultAudience: "requester-private" });
  if (preview.connection.version !== input.connectionVersion || !founderConnectionAllowed(libraryId, preview.binding.providerKey)) throw new WorkspaceIntegrationError("founder_connector_connection_changed", 409);
  const installed = await getSkillInstall(env, `team:${member.workspaceId}`, member.userId, libraryId);
  const skill = await getSkill(env, `team:${member.workspaceId}`, member.userId, input.skillId);
  if (!skill || installed?.skillId !== skill.id || skill.status !== "active" || skill.version !== input.skillVersion || skill.activeVersion !== skill.version || skill.reviewedVersion !== skill.version || skill.reviewedInstructions !== skill.content.instructions) throw new WorkspaceIntegrationError("reviewed_active_founder_skill_required", 409);
  const [hour, minute] = input.localTime.split(":").map(Number);
  const recipeSha = await founderConnectorRecipeHash(libraryId);
  if (!recipeSha) throw new WorkspaceIntegrationError("founder_recipe_unavailable", 404);
  const publicContract = founderConnectorContractSchema.parse({ format: "shiba.founder-connector.v1", libraryId, workspaceId: member.workspaceId,
    ownerId: member.userId, ownerAccountId: member.accountId, employeeId: input.employeeId, employeeVersion: input.employeeVersion, employeeName: preview.employee.config.name,
    skillId: skill.id, skillVersion: skill.version, skillName: skill.content.name, connectionId: input.connectionId, connectionVersion: input.connectionVersion,
    providerKey: preview.binding.providerKey, identityLabel: preview.connection.identity_label, actionId: input.actionId, actionName: preview.action.name,
    inputSchema: preview.action.inputSchema ?? {}, arguments: input.arguments, actionSchemaHash: preview.binding.actionSchemaHash, bindingDigest: await hashToolArgs(preview.binding), recipeSha256: recipeSha,
    cadence: input.cadence, localTime: input.localTime, ...(input.weekday !== undefined ? { weekday: input.weekday } : {}), timezone: input.timezone,
    cron: `${minute} ${hour} * * ${input.cadence === "weekly" ? input.weekday : "*"}`, expiresAt: input.expiresAt, destination: "private-dashboard", model: null,
    employeeConfig: JSON.stringify(preview.employee.config), skillInstructions: skill.content.instructions });
  if (new TextEncoder().encode(JSON.stringify(publicContract)).length > 200_000) throw new WorkspaceIntegrationError("founder_connector_contract_unreviewable", 413);
  const source = JSON.stringify({ employeeConfig: JSON.stringify(preview.employee.config), skillInstructions: skill.content.instructions, skillSource: skill.content.sourceUrl ?? null });
  const prior = await ownRow(env, member, libraryId);
  if ((prior?.version ?? 0) !== input.expectedVersion) throw new WorkspaceIntegrationError("founder_connector_version_conflict", 409);
  const id = prior?.id ?? `fcj_${crypto.randomUUID().replaceAll("-", "")}`, version = (prior?.version ?? 0) + 1;
  const digest = await hashToolArgs({ id, version, contract: publicContract, source, member });
  const nextDue = nextFounderReviewDue(publicContract, Date.now());
  const row: JobRow = { id, workspace_id: member.workspaceId, owner_id: member.userId, owner_account_id: member.accountId, library_id: libraryId,
    member_version: member.version, member_role: member.role, version, digest, state: "draft", contract_json: JSON.stringify(publicContract), source_json: source,
    binding_json: JSON.stringify(preview.binding), recipe_sha256: recipeSha, expires_at: input.expiresAt, review_expires_at: Date.now() + 900_000, next_due_at: nextDue, blocked_reason: null };
  const guard = sourceGuard(row), actor = membershipSql(member, true);
  const values = [version, digest, row.contract_json, source, row.binding_json, recipeSha, row.expires_at, row.review_expires_at, nextDue, Date.now(), Date.now()];
  const statement = prior ? env.AGENT_AUDIT.prepare(`UPDATE founder_connector_jobs SET version=?,digest=?,contract_json=?,source_json=?,binding_json=?,recipe_sha256=?,expires_at=?,review_expires_at=?,next_due_at=?,checked_at=?,updated_at=?,state='draft',blocked_reason=NULL,member_version=?,member_role=? WHERE id=? AND version=? AND ${guard.sql} AND ${actor.sql}`)
    .bind(...values, member.version, member.role, id, prior.version, ...guard.values, ...actor.values)
    : env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO founder_connector_jobs(version,digest,contract_json,source_json,binding_json,recipe_sha256,expires_at,review_expires_at,next_due_at,checked_at,updated_at,id,workspace_id,owner_id,owner_account_id,library_id,member_version,member_role,state,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',? WHERE ${guard.sql} AND ${actor.sql} AND (SELECT COUNT(*) FROM founder_connector_jobs)<1000`)
      .bind(...values, id, member.workspaceId, member.userId, member.accountId, libraryId, member.version, member.role, Date.now(), ...guard.values, ...actor.values);
  const results = await env.AGENT_AUDIT.batch([statement, env.AGENT_AUDIT.prepare("UPDATE founder_connector_occurrences SET state='cancelled' WHERE plan_id=? AND state='open' AND changes()=1").bind(id)]);
  if (results[0]?.meta.changes !== 1) throw new WorkspaceIntegrationError("founder_connector_sources_changed", 409);
}

export async function transitionFounderConnector(env: Env, member: WorkspaceNativeMember, libraryId: string, action: "enable" | "pause" | "resume" | "revoke", input: { expectedVersion: number; digest: string; reviewed: true }) {
  const row = await ownRow(env, member, libraryId);
  if (!row || row.version !== input.expectedVersion || row.digest !== input.digest || input.reviewed !== true) throw new WorkspaceIntegrationError("founder_connector_version_conflict", 409);
  if (action === "enable" && row.state !== "draft" || action === "pause" && row.state !== "enabled" || action === "resume" && row.state !== "paused" || row.state === "revoked") throw new WorkspaceIntegrationError("founder_connector_state_changed", 409);
  const state = action === "enable" || action === "resume" ? "enabled" : action === "pause" ? "paused" : "revoked";
  const recipe = await founderConnectorRecipeHash(libraryId), actor = membershipSql(member, true), source = action === "revoke" ? actor : sourceGuard(row);
  if (action !== "revoke" && recipe !== row.recipe_sha256) throw new WorkspaceIntegrationError("founder_recipe_changed", 409);
  const nextDue = state === "enabled" ? nextFounderReviewDue(contract(row), Date.now()) : row.next_due_at;
  const results = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`UPDATE founder_connector_jobs SET version=version+1,state=?,next_due_at=?,updated_at=? WHERE id=? AND version=? AND digest=? AND ${source.sql} AND ${actor.sql}
      AND (?<>'enabled' OR expires_at>${FOUNDER_SQL_NOW}) AND (?<>'enable' OR review_expires_at>${FOUNDER_SQL_NOW})
      AND (?<>'enabled' OR NOT EXISTS(SELECT 1 FROM workspace_app_approvals WHERE connection_id=? AND status IN ('unknown','executing')))`)
      .bind(state, nextDue, Date.now(), row.id, row.version, row.digest, ...source.values, ...actor.values, state, action, state, contract(row).connectionId),
    env.AGENT_AUDIT.prepare("UPDATE founder_connector_occurrences SET state='cancelled' WHERE plan_id=? AND state='open' AND changes()=1").bind(row.id),
  ]);
  if (results[0]?.meta.changes !== 1) throw new WorkspaceIntegrationError("founder_connector_sources_or_expiry_changed", 409);
}

function occurrenceContext(row: JobRow, occurrence: OccurrenceRow): FounderConnectorActionContext {
  return { kind: "founder-connector-occurrence.v1", libraryId: row.library_id, planId: row.id, planVersion: row.version, planDigest: row.digest,
    occurrenceId: occurrence.id, occurrenceDigest: occurrence.digest, requestId: occurrence.request_id, expiresAt: occurrence.expires_at };
}
async function occurrenceApproval(row: JobRow, occurrence: OccurrenceRow) {
  const plan = contract(row), bound: WorkspaceActionBinding = { ...binding(row), founderContext: occurrenceContext(row, occurrence) };
  return { bound, encoded: JSON.stringify(bound), inputHash: await hashToolArgs({ binding: bound, actionId: plan.actionId, arguments: plan.arguments }) };
}
async function currentOccurrence(env: Env, member: WorkspaceNativeMember, libraryId: string, id: string, expected: { expectedVersion: number; digest: string; occurrenceDigest: string }) {
  const row = await ownRow(env, member, libraryId);
  if (!row || row.state !== "enabled" || row.version !== expected.expectedVersion || row.digest !== expected.digest) throw new WorkspaceIntegrationError("founder_connector_version_conflict", 409);
  const occurrence = await env.AGENT_AUDIT.prepare("SELECT * FROM founder_connector_occurrences WHERE id=? AND plan_id=? AND plan_version=? AND digest=? AND state='open'")
    .bind(id, row.id, row.version, expected.occurrenceDigest).first<OccurrenceRow>();
  if (!occurrence || occurrence.expires_at <= Date.now()) throw new WorkspaceIntegrationError("founder_occurrence_expired_or_changed", 409);
  if (row.recipe_sha256 !== await founderConnectorRecipeHash(libraryId)) throw new WorkspaceIntegrationError("founder_recipe_changed", 409);
  return { row, occurrence };
}
export async function prepareFounderConnectorOccurrence(env: Env, member: WorkspaceNativeMember, libraryId: string, id: string, expected: { expectedVersion: number; digest: string; occurrenceDigest: string }) {
  const { row, occurrence } = await currentOccurrence(env, member, libraryId, id, expected), plan = contract(row);
  const approvalId = await requestWorkspaceAction(env, member, plan.connectionId, { employeeId: plan.employeeId, employeeVersion: plan.employeeVersion,
    actionId: plan.actionId, arguments: plan.arguments, requestId: occurrence.request_id }, { expectedBindingDigest: plan.bindingDigest,
    founderContext: occurrenceContext(row, occurrence), resultAudience: "requester-private", expiresAt: occurrence.expires_at });
  // The stable request ID recovers a committed approval if this acknowledgement is lost.
  const exact = await occurrenceApproval(row, occurrence), context = await founderConnectorActionGuard(exact.bound, approvalId), actor = membershipSql(member, true);
  const updated = await env.AGENT_AUDIT.prepare(`UPDATE founder_connector_occurrences SET approval_id=? WHERE id=? AND state='open' AND (approval_id IS NULL OR approval_id=?) AND ${context.sql} AND ${actor.sql}
    AND EXISTS(SELECT 1 FROM workspace_app_approvals WHERE id=? AND request_id=? AND input_hash=? AND binding_json=?)`)
    .bind(approvalId, occurrence.id, approvalId, ...context.values, ...actor.values, approvalId, occurrence.request_id, exact.inputHash, exact.encoded).run();
  if (updated.meta.changes !== 1) throw new WorkspaceIntegrationError("founder_action_receipt_unconfirmed", 409);
}
export async function decideFounderConnectorOccurrence(env: Env, member: WorkspaceNativeMember, libraryId: string, id: string, expected: { expectedVersion: number; digest: string; occurrenceDigest: string; approvalId: string; inputHash: string; approved: boolean }) {
  const { row, occurrence } = await currentOccurrence(env, member, libraryId, id, expected);
  if (occurrence.approval_id !== expected.approvalId) throw new WorkspaceIntegrationError("founder_action_receipt_changed", 409);
  await exactApproval(env, member, row, occurrence, expected);
  await decideWorkspaceAction(env, member, expected.approvalId, expected.approved);
}
export async function executeFounderConnectorOccurrence(env: Env, member: WorkspaceNativeMember, libraryId: string, id: string, expected: { expectedVersion: number; digest: string; occurrenceDigest: string; approvalId: string; inputHash: string }, signal?: AbortSignal) {
  const { row, occurrence } = await currentOccurrence(env, member, libraryId, id, expected);
  if (occurrence.approval_id !== expected.approvalId) throw new WorkspaceIntegrationError("founder_action_receipt_changed", 409);
  await exactApproval(env, member, row, occurrence, expected);
  await executeWorkspaceAction(env, member, expected.approvalId, signal);
}
async function exactApproval(env: Env, member: WorkspaceNativeMember, row: JobRow, occurrence: OccurrenceRow, expected: { approvalId: string; inputHash: string }) {
  const exact = await occurrenceApproval(row, occurrence);
  if (expected.inputHash !== exact.inputHash) throw new WorkspaceIntegrationError("founder_action_receipt_changed", 409);
  const approval = await env.AGENT_AUDIT.prepare(`SELECT id FROM workspace_app_approvals WHERE id=? AND workspace_id=? AND request_id=? AND input_hash=? AND requester_id=? AND binding_json=?`)
    .bind(expected.approvalId, member.workspaceId, occurrence.request_id, expected.inputHash, member.userId, exact.encoded).first();
  if (!approval) throw new WorkspaceIntegrationError("founder_action_receipt_changed", 409);
}

export async function readFounderConnectorState(env: Env, member: WorkspaceNativeMember, libraryId: string): Promise<FounderConnectorState> {
  const row = await ownRow(env, member, libraryId), base = { ...scope(member, libraryId), libraryId: libraryId as FounderConnectorState["libraryId"], canConfigure: true, plan: null, occurrences: [] };
  if (!row) { await assertWorkspaceMemberCurrent(env, member, true); return base; }
  const plan = contract(row), approvals = await listWorkspaceApprovals(env, member);
  const records = await env.AGENT_AUDIT.prepare("SELECT * FROM founder_connector_occurrences WHERE plan_id=? AND plan_version=? ORDER BY created_at DESC,id DESC LIMIT 50").bind(row.id, row.version).all<OccurrenceRow>();
  // Reconcile only the complete hash-bound handoff. A generic request UUID collision is not an occurrence approval.
  const collisions = new Set<string>();
  for (const item of records.results) if (!item.approval_id && item.state === "open") {
    const exact = await occurrenceApproval(row, item), actor = membershipSql(member, true);
    const candidate = await env.AGENT_AUDIT.prepare("SELECT id,input_hash,binding_json FROM workspace_app_approvals WHERE workspace_id=? AND requester_id=? AND request_id=?")
      .bind(member.workspaceId, member.userId, item.request_id).first<{ id: string; input_hash: string; binding_json: string }>();
    if (!candidate) continue;
    if (candidate.input_hash !== exact.inputHash || candidate.binding_json !== exact.encoded) { collisions.add(item.id); continue; }
    const context = await founderConnectorActionGuard(exact.bound, candidate.id);
    const updated = await env.AGENT_AUDIT.prepare(`UPDATE founder_connector_occurrences SET approval_id=? WHERE id=? AND approval_id IS NULL AND state='open' AND ${context.sql} AND ${actor.sql}`)
      .bind(candidate.id, item.id, ...context.values, ...actor.values).run();
    if (updated.meta.changes === 1) item.approval_id = candidate.id;
  }
  const source = sourceGuard(row), actor = membershipSql(member, true), recipe = await founderConnectorRecipeHash(libraryId);
  const snapshots = await Promise.all(records.results.map(async (item) => {
    const exact = await occurrenceApproval(row, item), approval = approvals.approvals.find((candidate) => candidate.id === item.approval_id) ?? null;
    return { id: item.id, context: exact.bound.founderContext, binding: exact.bound, bindingJson: exact.encoded, inputHash: exact.inputHash, recipeSha256: recipe,
      approvalId: approval?.id ?? null, status: approval?.status ?? null, expiresAt: approval?.expiresAt ?? null,
      argumentsJson: JSON.stringify(approval?.arguments ?? {}), resultJson: JSON.stringify(approval?.result ?? null) };
  }));
  // One final snapshot covers the plan AND each cached approval's occurrence.
  // A revoked/expired/cancelled occurrence may not carry previously read args or results.
  const occurrenceFence = founderConnectorContextPredicate({ context: "json_extract(f.value,'$.context')", binding: "json_extract(f.value,'$.binding')",
    approvalId: "COALESCE(json_extract(f.value,'$.approvalId'),'')", recipeHash: "json_extract(f.value,'$.recipeSha256')" });
  const current = await env.AGENT_AUDIT.prepare(`SELECT j.*,(SELECT json_group_array(json_extract(f.value,'$.id')) FROM json_each(?) f
      LEFT JOIN workspace_app_approvals a ON a.id=json_extract(f.value,'$.approvalId')
      WHERE ${occurrenceFence} AND (json_extract(f.value,'$.approvalId') IS NULL OR (
        a.binding_json=json_extract(f.value,'$.bindingJson') AND a.input_hash=json_extract(f.value,'$.inputHash')
        AND a.arguments_json=json_extract(f.value,'$.argumentsJson') AND COALESCE(a.result_json,'null')=json_extract(f.value,'$.resultJson')
        AND a.expires_at=json_extract(f.value,'$.expiresAt')
        AND CASE WHEN a.status='executing' AND a.updated_at<${FOUNDER_SQL_NOW}-300000 THEN 'unknown'
          WHEN a.status='pending' AND a.expires_at<=${FOUNDER_SQL_NOW} THEN 'expired' ELSE a.status END=json_extract(f.value,'$.status')
      ))) AS available_occurrences_json FROM founder_connector_jobs j WHERE j.id=? AND j.version=? AND j.recipe_sha256=? AND ${source.sql} AND ${actor.sql}`)
    .bind(JSON.stringify(snapshots), row.id, row.version, recipe, ...source.values, ...actor.values).first<JobRow & { available_occurrences_json: string }>();
  if (!current) {
    const fresh = await ownRow(env, member, libraryId);
    if (!fresh) throw new WorkspaceIntegrationError("workspace_authority_changed", 403);
    return { ...base, unavailableReason: "founder_connector_sources_changed", stalePlan: { id: fresh.id, version: fresh.version, digest: fresh.digest, state: fresh.state, canRevoke: fresh.state !== "revoked" } };
  }
  const available = new Set(JSON.parse(current.available_occurrences_json) as string[]);
  const now = Date.now(), enabled = current.state === "enabled" && current.expires_at > now;
  const occurrences: FounderConnectorOccurrence[] = (records.results ?? []).map((item) => {
    const observed = available.has(item.id);
    const cached = observed ? approvals.approvals.find((candidate) => candidate.id === item.approval_id) ?? null : null;
    const approval = cached ? { ...cached, canDecide: cached.canDecide && now < cached.expiresAt, canExecute: cached.canExecute && now < cached.expiresAt } : null;
    const expired = item.expires_at <= now;
    const status = item.state === "cancelled" ? "cancelled" : item.state === "expired" || expired ? "expired" : collisions.has(item.id) ? "unknown" : approval ? approval.status === "pending" ? "awaiting-approval" : approval.status : item.approval_id ? "unknown" : "pending";
    return { id: item.id, planId: item.plan_id, planVersion: item.plan_version, digest: item.digest, scheduledAt: item.scheduled_at, createdAt: item.created_at,
      expiresAt: item.expires_at, requestId: item.request_id, status, approval,
      canPrepare: enabled && observed && !expired && item.state === "open" && !item.approval_id && !collisions.has(item.id),
      canDecide: enabled && !expired && Boolean(approval?.canDecide), canExecute: enabled && !expired && Boolean(approval?.canExecute) };
  });
  return { ...base, plan: { id: current.id, version: current.version, digest: current.digest, state: current.state, contract: plan, reviewExpiresAt: current.review_expires_at,
    nextDueAt: current.next_due_at, ...(current.blocked_reason ? { blockedReason: current.blocked_reason } : {}),
    canEnable: current.state === "draft" && current.review_expires_at > now && current.expires_at > now, canPause: current.state === "enabled", canResume: current.state === "paused" && current.expires_at > now, canRevoke: current.state !== "revoked" }, occurrences };
}

/** D1-only tick. It never calls a provider, creates an action approval or executes as a human. */
export async function tickFounderConnectorJobs(env: Env, fixtureNow?: number): Promise<{ created: number; blocked: number }> {
  if (!env.AGENT_AUDIT) return { created: 0, blocked: 0 };
  await ensureFounderConnectorSchema(env);
  const rows = await env.AGENT_AUDIT.prepare("SELECT * FROM founder_connector_jobs WHERE state='enabled' ORDER BY checked_at,id LIMIT 100").all<JobRow>();
  let created = 0, blocked = 0;
  for (const row of rows.results) {
    const now = fixtureNow ?? Date.now(), source = sourceGuard(row), recipe = await founderConnectorRecipeHash(row.library_id);
    const due = row.next_due_at <= now, expires = Math.min(row.expires_at, row.next_due_at + 86_400_000), next = due ? nextFounderReviewDue(contract(row), now) : row.next_due_at;
    const requestId = crypto.randomUUID(), id = `${row.id}:${row.version}:${row.next_due_at}`;
    const digest = await hashToolArgs({ planId: row.id, planVersion: row.version, planDigest: row.digest, scheduledAt: row.next_due_at, expiresAt: expires, requestId });
    const clock = fixtureNow === undefined ? { sql: FOUNDER_SQL_NOW, values: [] as unknown[] } : { sql: "?", values: [fixtureNow] as unknown[] };
    const results = await env.AGENT_AUDIT.batch([
      env.AGENT_AUDIT.prepare(`UPDATE founder_connector_jobs SET state='blocked',version=version+1,blocked_reason='founder_sources_or_unresolved_action_changed',checked_at=? WHERE id=? AND version=? AND state='enabled'
        AND (recipe_sha256<>? OR expires_at<=${clock.sql} OR NOT (${source.sql}) OR EXISTS(SELECT 1 FROM workspace_app_approvals WHERE connection_id=? AND (status='unknown' OR (status='executing' AND updated_at<=${clock.sql}-300000))))`)
        .bind(now, row.id, row.version, recipe, ...clock.values, ...source.values, contract(row).connectionId, ...clock.values),
      env.AGENT_AUDIT.prepare("UPDATE founder_connector_occurrences SET state='cancelled' WHERE plan_id=? AND state='open' AND EXISTS(SELECT 1 FROM founder_connector_jobs WHERE id=? AND state='blocked')").bind(row.id, row.id),
      env.AGENT_AUDIT.prepare(`UPDATE founder_connector_occurrences SET state='expired' WHERE plan_id=? AND state='open' AND expires_at<=${clock.sql}`).bind(row.id, ...clock.values),
      env.AGENT_AUDIT.prepare(`INSERT OR IGNORE INTO founder_connector_occurrences(id,plan_id,plan_version,digest,scheduled_at,expires_at,created_at,request_id,state)
        SELECT ?,id,version,?,next_due_at,?,?,?,'open' FROM founder_connector_jobs WHERE id=? AND version=? AND state='enabled' AND next_due_at<=? AND ?>${clock.sql} AND ${source.sql}
        AND NOT EXISTS(SELECT 1 FROM workspace_app_approvals WHERE connection_id=? AND status IN ('unknown','executing'))
        AND NOT EXISTS(SELECT 1 FROM founder_connector_occurrences o LEFT JOIN workspace_app_approvals a ON a.id=o.approval_id WHERE o.plan_id=? AND o.state='open' AND o.expires_at>${clock.sql}
          AND (o.approval_id IS NULL OR a.status IN ('unknown','executing','approved') OR (a.status='pending' AND a.expires_at>${clock.sql})))`)
        .bind(id, digest, expires, now, requestId, row.id, row.version, now, expires, ...clock.values, ...source.values, contract(row).connectionId, row.id, ...clock.values, ...clock.values),
      env.AGENT_AUDIT.prepare("UPDATE founder_connector_jobs SET next_due_at=?,checked_at=? WHERE id=? AND version=? AND state='enabled'").bind(next, now, row.id, row.version),
      env.AGENT_AUDIT.prepare("DELETE FROM founder_connector_occurrences WHERE plan_id=? AND state<>'open' AND id NOT IN(SELECT id FROM founder_connector_occurrences WHERE plan_id=? ORDER BY created_at DESC,id DESC LIMIT 50)").bind(row.id, row.id),
    ]);
    if (results[0]?.meta.changes === 1) blocked++;
    if (results[3]?.meta.changes === 1) created++;
  }
  return { created, blocked };
}
