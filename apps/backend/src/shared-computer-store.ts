import { SHARED_COMPUTER_LIMITS as LIMIT, SHARED_COMPUTER_POLICY, type SharedComputerContract, type SharedComputerPrepare, type SharedComputerSession } from "@shiba/shared";
import type { Env } from "./env.js";
import { COLLAB_TENANT_ID, ensureCollaborationSchema, getCollaborationRoom, getCollaborationMembership, humanActorId, type CollaborationMembershipRow } from "./collaboration-store.js";
import { getTeamWorkspaceMembership } from "./team-workspaces-store.js";
import { membershipSql, insertGuarded, updateGuarded } from "./workspace-integrations-store.js";
import { resolveWorkspaceNativeGrantTarget, type WorkspaceNativeMember } from "./workspace-native-authority.js";
import { hashToolArgs } from "./mcp-gateway.js";
import { SHARED_COMPUTER_SCHEMA } from "./shared-computer-schema.js";
import type { ComputerSession } from "./computer-session.js";

export interface SharedComputerEnv extends Env {
  SHIBA_SHARED_COMPUTER?: string;
  SHIBA_SHARED_COMPUTER_IMAGE?: string;
  ComputerSession?: DurableObjectNamespace<ComputerSession>;
}
export class SharedComputerError extends Error { constructor(readonly code: string, readonly status = 409) { super(code); } }
export const COMPUTER_DB_NOW = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
interface Participant { member: WorkspaceNativeMember; room: CollaborationMembershipRow }
export interface ComputerBinding {
  workspaceId: string; roomId: string; roomCreatedAt: number; roomOwner: string; visibility: string;
  owner: WorkspaceNativeMember; funder: WorkspaceNativeMember; participants: Participant[];
}
export interface ComputerRow {
  id: string; workspace_id: string; room_id: string; owner_account_id: string; request_id: string; request_hash: string;
  version: number; digest: string; binding_json: string; contract_json: string; state: SharedComputerSession["state"];
  consumed: number; lease_owner: string | null; lease_account_id: string | null; lease_version: number; lease_expires_at: number;
  sequence: number; input_count: number; frame_count: number; frame_bytes: number; last_input_at: number; last_frame_at: number;
  created_at: number; updated_at: number;
}
export function computerPolicy(env: SharedComputerEnv) {
  const enabled = env.SHIBA_SHARED_COMPUTER === "1";
  const image = env.SHIBA_SHARED_COMPUTER_IMAGE;
  const validImage = typeof image === "string" && /^[a-z0-9][a-z0-9./:_-]{1,300}@sha256:[a-f0-9]{64}$/.test(image);
  const signing = typeof env.INTERNAL_SIGNING_KEY === "string" && env.INTERNAL_SIGNING_KEY.length >= 32;
  return { enabled, available: enabled && validImage && Boolean(env.ComputerSession) && signing, image: validImage ? image! : null,
    reason: !enabled ? "shared_computer_disabled" : !validImage ? "shared_computer_image_unavailable" : !env.ComputerSession ? "shared_computer_runtime_unavailable" : !signing ? "shared_computer_signing_unavailable" : null };
}
export function requireComputerPolicy(env: SharedComputerEnv, expectedImage?: string) {
  const policy = computerPolicy(env);
  if (!policy.available || (expectedImage !== undefined && expectedImage !== policy.image)) throw new SharedComputerError(policy.reason ?? "shared_computer_image_changed", 503);
  return policy;
}
const initialized = new WeakSet<D1Database>();
export async function ensureSharedComputerSchema(env: SharedComputerEnv) {
  if (!env.AGENT_AUDIT) throw new SharedComputerError("shared_computer_storage_unavailable", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  await ensureCollaborationSchema(env);
  for (const sql of SHARED_COMPUTER_SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
export function computerContract(row: ComputerRow): SharedComputerContract { return JSON.parse(row.contract_json); }
export function computerBinding(row: ComputerRow): ComputerBinding { return JSON.parse(row.binding_json); }
function changed(result: D1Result) { if (result.meta.changes !== 1) throw new SharedComputerError("shared_computer_authority_or_version_changed"); }

/** Only persisted, digest-checked bindings enter this expression. All identities are UUID-bound. */
export function computerSourceSql(alias = "s") {
  const at = (path: string) => `json_extract(${alias}.binding_json,'$.${path}')`;
  const native = (v: string, bootstrap = false) => `EXISTS(SELECT 1 FROM team_workspace_memberships m
    JOIN shiba_auth_account_policy p ON p.account_id=json_extract(${v},'$.accountId') AND p.email=m.user_id
    JOIN "user" u ON u.id=p.account_id AND lower(u.email)=p.email AND u.emailVerified=1
    WHERE m.tenant_id='${COLLAB_TENANT_ID}' AND m.workspace_id=${alias}.workspace_id AND m.user_id=json_extract(${v},'$.userId')
      AND m.role=json_extract(${v},'$.role') AND m.version=json_extract(${v},'$.version') AND m.status='active'
      ${bootstrap ? "AND p.kind='bootstrap' AND m.role IN ('owner','admin')" : ""})`;
  return `${native(`json_extract(${alias}.binding_json,'$.owner')`)} AND ${native(`json_extract(${alias}.binding_json,'$.funder')`, true)}
    AND EXISTS(SELECT 1 FROM collaboration_rooms r WHERE r.tenant_id='${COLLAB_TENANT_ID}' AND r.workspace_id=${alias}.workspace_id AND r.room_id=${alias}.room_id
      AND r.created_at=${at("roomCreatedAt")} AND r.created_by_user_id=${at("roomOwner")} AND r.visibility=${at("visibility")})
    AND NOT EXISTS(SELECT 1 FROM collaboration_slack_room_links l WHERE l.tenant_id='${COLLAB_TENANT_ID}' AND l.workspace_id=${alias}.workspace_id AND l.room_id=${alias}.room_id AND l.status='active')
    AND NOT EXISTS(SELECT 1 FROM json_each(${alias}.binding_json,'$.participants') v WHERE NOT (${native("json_extract(v.value,'$.member')")})
      OR NOT EXISTS(SELECT 1 FROM collaboration_memberships c WHERE c.tenant_id='${COLLAB_TENANT_ID}' AND c.workspace_id=${alias}.workspace_id AND c.room_id=${alias}.room_id
        AND c.actor_id=json_extract(v.value,'$.room.actorId') AND c.user_id=json_extract(v.value,'$.member.userId') AND c.actor_kind='human' AND c.status='active'
        AND c.role=json_extract(v.value,'$.room.role') AND c.created_at=json_extract(v.value,'$.room.createdAt')
        AND c.capabilities_json=json_extract(v.value,'$.room.capabilitiesJson')
        AND EXISTS(SELECT 1 FROM json_each(c.capabilities_json) WHERE value='room.read')))`;
}
function persistedBinding(binding: ComputerBinding) {
  return { ...binding, participants: binding.participants.map((value) => ({ ...value, room: { ...value.room, capabilitiesJson: JSON.stringify(value.room.capabilities) } })) };
}
async function participant(env: SharedComputerEnv, workspaceId: string, roomId: string, userId: string, expectedVersion?: number): Promise<Participant> {
  const member = await getTeamWorkspaceMembership(env, workspaceId, userId);
  if (!member || (expectedVersion !== undefined && member.version !== expectedVersion)) throw new SharedComputerError("shared_computer_member_changed", 403);
  const native = await resolveWorkspaceNativeGrantTarget(env, member);
  const room = await getCollaborationMembership(env, { tenantId: COLLAB_TENANT_ID, workspaceId, userId }, roomId, humanActorId(userId));
  if (!native || !room || room.actorKind !== "human" || !room.capabilities.includes("room.read")) throw new SharedComputerError("shared_computer_native_room_member_required", 403);
  return { member: native, room };
}
export async function prepareSharedComputer(env: SharedComputerEnv, owner: WorkspaceNativeMember, input: SharedComputerPrepare) {
  const policy = requireComputerPolicy(env); await ensureSharedComputerSchema(env);
  const now = Date.now();
  if (input.expiresAt <= now || input.expiresAt > now + LIMIT.ttlMs || !input.viewers.some((x) => x.userId === owner.userId)) throw new SharedComputerError("shared_computer_scope_invalid", 400);
  const room = await getCollaborationRoom(env, { tenantId: COLLAB_TENANT_ID, workspaceId: owner.workspaceId, userId: owner.userId }, input.roomId);
  if (!room || room.createdByUserId !== owner.userId || room.visibility !== "shared") throw new SharedComputerError("shared_computer_room_owner_required", 403);
  const selections = [...input.viewers];
  if (!selections.some((v) => v.userId === input.fundingMember.userId)) selections.push(input.fundingMember);
  const participants = await Promise.all(selections.map((v) => participant(env, owner.workspaceId, input.roomId, v.userId, v.version)));
  const own = participants.find((v) => v.member.userId === owner.userId)!;
  if (own.member.accountId !== owner.accountId || own.member.version !== owner.version) throw new SharedComputerError("shared_computer_owner_changed", 403);
  const funder = participants.find((v) => v.member.userId === input.fundingMember.userId)!.member;
  if (funder.version !== input.fundingMember.version) throw new SharedComputerError("shared_computer_funder_changed", 403);
  const binding = persistedBinding({ workspaceId: owner.workspaceId, roomId: input.roomId, roomCreatedAt: room.createdAt, roomOwner: room.createdByUserId, visibility: room.visibility, owner, funder, participants });
  const contract: SharedComputerContract = { policy: SHARED_COMPUTER_POLICY, purpose: "offline-human-desktop", image: policy.image!, roomId: input.roomId,
    ownerId: owner.userId, funderId: funder.userId, viewers: input.viewers.map((v) => v.userId).sort(), controllers: [...input.controllers].sort(), expiresAt: input.expiresAt,
    maxSessions: 1, instance: "standard-1", width: 1024, height: 768, resources: { vcpu: 0.5, memoryMiB: 4096, diskMB: 8000 }, limits: LIMIT, internet: false, credentials: null, sources: [],
    estimatedContainerOverageUsd: Math.ceil((input.expiresAt - now) * 0.00002056) / 1000,
    estimateNotice: "Resource estimate only; excludes account base charges, Workers, DO, storage and billing-unit rounding." };
  const requestHash = await hashToolArgs(input), digest = await hashToolArgs({ binding, contract });
  const previous = await env.AGENT_AUDIT.prepare("SELECT * FROM shared_computer_sessions WHERE workspace_id=? AND owner_account_id=? AND request_id=?").bind(owner.workspaceId, owner.accountId, input.requestId).first<ComputerRow>();
  if (previous) { if (previous.request_hash !== requestHash) throw new SharedComputerError("shared_computer_request_conflict"); return previous.id; }
  const id = `scs_${crypto.randomUUID().replaceAll("-", "")}`, actor = membershipSql(owner);
  const data = { id, workspace_id: owner.workspaceId, room_id: input.roomId, owner_account_id: owner.accountId, request_id: input.requestId, request_hash: requestHash,
    version: 1, digest, binding_json: JSON.stringify(binding), contract_json: JSON.stringify(contract), state: "draft", created_at: now, updated_at: now };
  // The same universal source predicate is evaluated on the proposed immutable row.
  changed(await insertGuarded(env, "shared_computer_sessions", data, { sql: `${actor.sql} AND (SELECT COUNT(*) FROM shared_computer_sessions WHERE workspace_id=? AND json_extract(contract_json,'$.expiresAt')>${COMPUTER_DB_NOW} AND state<>'stopped')<20 AND EXISTS(SELECT 1 FROM (SELECT ? AS workspace_id,? AS room_id,? AS binding_json) s WHERE ${computerSourceSql()})`,
    values: [...actor.values, owner.workspaceId, owner.workspaceId, input.roomId, data.binding_json] }).run());
  return id;
}
export async function readComputerRow(env: SharedComputerEnv, workspaceId: string, id: string) {
  await ensureSharedComputerSchema(env);
  const row = await env.AGENT_AUDIT.prepare("SELECT * FROM shared_computer_sessions WHERE id=? AND workspace_id=?").bind(id, workspaceId).first<ComputerRow>();
  if (!row) throw new SharedComputerError("shared_computer_not_found", 404);
  if (await hashToolArgs({ binding: computerBinding(row), contract: computerContract(row) }) !== row.digest) throw new SharedComputerError("shared_computer_digest_changed", 403);
  return row;
}
export async function assertComputerCurrent(env: SharedComputerEnv, row: ComputerRow, actor?: WorkspaceNativeMember, running = false) {
  requireComputerPolicy(env, computerContract(row).image);
  const member = actor ? membershipSql(actor) : null;
  const found = await env.AGENT_AUDIT.prepare(`SELECT 1 AS current FROM shared_computer_sessions s WHERE s.id=? AND s.version=? AND s.digest=? AND s.binding_json=? AND s.contract_json=?
    AND json_extract(s.contract_json,'$.expiresAt')>${COMPUTER_DB_NOW} AND s.state ${running ? "='running'" : "IN ('draft','funded','starting','running')"}
    AND ${computerSourceSql()} ${member ? `AND ${member.sql}` : ""}`)
    .bind(row.id, row.version, row.digest, row.binding_json, row.contract_json, ...(member?.values ?? [])).first();
  if (!found) throw new SharedComputerError("shared_computer_source_changed", 403);
}
export async function fundSharedComputer(env: SharedComputerEnv, member: WorkspaceNativeMember, row: ComputerRow, digest: string) {
  const binding = computerBinding(row);
  if (member.accountId !== binding.funder.accountId || member.userId !== binding.funder.userId || digest !== row.digest || row.state !== "draft") throw new SharedComputerError("shared_computer_funder_required", 403);
  await assertComputerCurrent(env, row, member);
  const actor = membershipSql(member, true);
  changed(await updateGuarded(env, "shared_computer_sessions", { state: "funded", version: row.version + 1, updated_at: Date.now() },
    `id=? AND version=? AND state='draft' AND digest=? AND json_extract(contract_json,'$.expiresAt')>${COMPUTER_DB_NOW} AND ${actor.sql} AND EXISTS(SELECT 1 FROM shared_computer_sessions s WHERE s.id=shared_computer_sessions.id AND ${computerSourceSql()})`,
    [row.id, row.version, digest, ...actor.values]).run());
}
export async function claimComputerStart(env: SharedComputerEnv, member: WorkspaceNativeMember, row: ComputerRow, digest: string) {
  if (computerBinding(row).owner.accountId !== member.accountId || row.digest !== digest || row.state !== "funded") throw new SharedComputerError("shared_computer_owner_review_required", 403);
  await assertComputerCurrent(env, row, member); const actor = membershipSql(member);
  try { changed(await updateGuarded(env, "shared_computer_sessions", { state: "starting", consumed: 1, version: row.version + 1, updated_at: Date.now() },
    `id=? AND version=? AND digest=? AND state='funded' AND consumed=0 AND json_extract(contract_json,'$.expiresAt')>${COMPUTER_DB_NOW} AND ${actor.sql}
      AND NOT EXISTS(SELECT 1 FROM shared_computer_sessions busy WHERE busy.id<>shared_computer_sessions.id AND busy.consumed=1 AND busy.state<>'stopped')
      AND EXISTS(SELECT 1 FROM shared_computer_sessions s WHERE s.id=shared_computer_sessions.id AND ${computerSourceSql()})`, [row.id, row.version, digest, ...actor.values]).run()); }
  catch (error) { if (error instanceof SharedComputerError) throw error; throw new SharedComputerError("shared_computer_capacity_or_claim_conflict"); }
  return readComputerRow(env, member.workspaceId, row.id);
}
export async function claimComputerLease(env: SharedComputerEnv, actor: WorkspaceNativeMember, row: ComputerRow, digest: string, leaseMs: number) {
  if (row.digest !== digest || !computerContract(row).controllers.includes(actor.userId) || !Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > LIMIT.leaseMs) throw new SharedComputerError("shared_computer_controller_scope_required", 403);
  await assertComputerCurrent(env, row, actor, true); const member = membershipSql(actor), now = Date.now();
  changed(await updateGuarded(env, "shared_computer_sessions", { lease_owner: actor.userId, lease_account_id: actor.accountId, lease_version: row.lease_version + 1, lease_expires_at: Math.min(now + leaseMs, computerContract(row).expiresAt), version: row.version + 1, updated_at: now },
    `id=? AND version=? AND state='running' AND lease_expires_at<=${COMPUTER_DB_NOW} AND json_extract(contract_json,'$.expiresAt')>${COMPUTER_DB_NOW} AND ${member.sql}
      AND EXISTS(SELECT 1 FROM shared_computer_sessions s WHERE s.id=shared_computer_sessions.id AND ${computerSourceSql()})`, [row.id, row.version, ...member.values]).run());
}
export async function computerDto(env: SharedComputerEnv, actor: WorkspaceNativeMember, row: ComputerRow): Promise<SharedComputerSession> {
  const contract = computerContract(row), binding = computerBinding(row), policy = computerPolicy(env);
  let current = false; try { await assertComputerCurrent(env, row, actor); current = true; } catch { /* stale snapshots confer no capabilities */ }
  const selected = binding.participants.some((p) => p.member.accountId === actor.accountId && p.member.userId === actor.userId);
  if (!selected) throw new SharedComputerError("shared_computer_not_found", 404);
  const owner = binding.owner.accountId === actor.accountId, funder = binding.funder.accountId === actor.accountId;
  return { id: row.id, roomId: row.room_id, version: row.version, digest: row.digest, state: row.state, contract, consumed: row.consumed === 1,
    lease: current && row.lease_owner && row.lease_expires_at > Date.now() ? { ownerId: row.lease_owner, version: row.lease_version, expiresAt: row.lease_expires_at } : null,
    nextSequence: row.sequence + 1, inputCount: row.input_count, frameCount: row.frame_count,
    canFund: current && funder && row.state === "draft", canStart: current && owner && row.state === "funded",
    canControl: current && row.state === "running" && contract.controllers.includes(actor.userId),
    canView: current && row.state === "running" && contract.viewers.includes(actor.userId),
    canStop: (owner || funder) && row.state !== "stopped", unavailableReason: !current ? policy.reason ?? "shared_computer_source_or_lifecycle_changed" : null };
}
