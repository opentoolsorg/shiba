import {
  isTeamWorkspaceId, isTeamWorkspaceRole, TEAM_WORKSPACE_INVITATION_TTL_MS,
  type CreatedTeamWorkspaceInvitation, type TeamWorkspaceDetail, type TeamWorkspaceInvitation,
  type TeamWorkspaceMembership, type TeamWorkspaceRole, type TeamWorkspaceSummary,
} from "@shiba/shared";
import { COLLAB_TENANT_ID, ensureCollaborationSchema } from "./collaboration-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;
interface MemberRow { workspace_id: string; user_id: string; role: TeamWorkspaceRole; version: number; joined_at: number }
interface WorkspaceRow { workspace_id: string; name: string; version: number; created_at: number }
interface InvitationRow {
  invitation_id: string; workspace_id: string; email: string; role: TeamWorkspaceRole;
  issuer_user_id: string; issuer_version: number; created_at: number; expires_at: number;
  status: "pending" | "accepted" | "revoked"; issuer_current_version?: number; issuer_role?: TeamWorkspaceRole; issuer_status?: string;
}
export class TeamWorkspaceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = "TeamWorkspaceError"; }
}
const initialized = new WeakSet<D1Database>();
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS team_workspaces (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>0), created_at INTEGER NOT NULL,
    PRIMARY KEY(tenant_id,workspace_id))`,
  `CREATE TABLE IF NOT EXISTS team_workspace_memberships (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
    status TEXT NOT NULL CHECK(status IN ('active','removed')), version INTEGER NOT NULL CHECK(version>0),
    joined_at INTEGER NOT NULL, removed_at INTEGER, mutation_id TEXT,
    PRIMARY KEY(tenant_id,workspace_id,user_id),
    FOREIGN KEY(tenant_id,workspace_id) REFERENCES team_workspaces(tenant_id,workspace_id))`,
  `CREATE INDEX IF NOT EXISTS team_workspace_memberships_user ON team_workspace_memberships(tenant_id,user_id,status)`,
  `CREATE TABLE IF NOT EXISTS team_workspace_invitations (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, invitation_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
    issuer_user_id TEXT NOT NULL, issuer_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_by_user_id TEXT, accepted_at INTEGER, revoked_at INTEGER,
    PRIMARY KEY(tenant_id,workspace_id,invitation_id),
    FOREIGN KEY(tenant_id,workspace_id) REFERENCES team_workspaces(tenant_id,workspace_id))`,
];
export async function ensureTeamWorkspacesSchema(env: StoreEnv): Promise<void> {
  if (!env.AGENT_AUDIT) throw new TeamWorkspaceError("Workspace storage is unavailable.", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}
export function normalizeTeamWorkspaceEmail(value: unknown): string {
  if (typeof value !== "string") throw new TeamWorkspaceError("A valid email is required.");
  const email = value.trim().toLowerCase();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Rejects control bytes in untrusted identity or portable text input.
  if (email.length > 254 || !/^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email)) throw new TeamWorkspaceError("A valid email is required.");
  return email;
}
function human(value: string): string {
  // Current verified dashboard identities are emails. Never accept service IDs or guessed aliases.
  return normalizeTeamWorkspaceEmail(value);
}
function id(value: string): string {
  if (!isTeamWorkspaceId(value)) throw new TeamWorkspaceError("Workspace not found.", 404);
  return value;
}
function name(value: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Rejects control bytes in untrusted identity or portable text input.
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100 || /[\x00-\x1f]/.test(value)) throw new TeamWorkspaceError("Workspace name must contain 1–100 characters.");
  return value.trim();
}
function role(value: unknown): TeamWorkspaceRole {
  if (!isTeamWorkspaceRole(value)) throw new TeamWorkspaceError("Invalid workspace role.");
  return value;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TeamWorkspaceError("A current expectedVersion is required.");
  return Number(value);
}
const memberDto = (row: MemberRow): TeamWorkspaceMembership => ({ workspaceId: row.workspace_id, userId: row.user_id, role: row.role, version: row.version, joinedAt: row.joined_at });
function invitationDto(row: InvitationRow, now: number): TeamWorkspaceInvitation {
  const validIssuer = row.issuer_status === "active" && row.issuer_version === row.issuer_current_version && (row.issuer_role === "owner" || (row.issuer_role === "admin" && row.role === "member"));
  return { invitationId: row.invitation_id, workspaceId: row.workspace_id, email: row.email, role: row.role, issuerUserId: row.issuer_user_id, createdAt: row.created_at, expiresAt: row.expires_at,
    status: row.status !== "pending" ? row.status : row.expires_at <= now ? "expired" : !validIssuer ? "invalidated" : "pending" };
}
async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
const changed = (result: D1Result | undefined) => Number(result?.meta?.changes ?? 0) === 1;

export async function getTeamWorkspaceMembership(env: StoreEnv, workspaceId: string, userId: string): Promise<TeamWorkspaceMembership | null> {
  if (!isTeamWorkspaceId(workspaceId)) return null;
  await ensureTeamWorkspacesSchema(env);
  const row = await env.AGENT_AUDIT.prepare(`SELECT workspace_id,user_id,role,version,joined_at FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=? AND user_id=? AND status='active'`).bind(COLLAB_TENANT_ID, workspaceId, human(userId)).first<MemberRow>();
  return row ? memberDto(row) : null;
}
export async function isTeamWorkspaceMember(env: StoreEnv, workspaceId: string, userId: string): Promise<boolean> {
  return (await getTeamWorkspaceMembership(env, workspaceId, userId)) !== null;
}
export async function listTeamWorkspaces(env: StoreEnv, userId: string): Promise<TeamWorkspaceSummary[]> {
  await ensureTeamWorkspacesSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(`SELECT w.*,m.user_id,m.role,m.version AS member_version,m.joined_at FROM team_workspaces w JOIN team_workspace_memberships m ON m.tenant_id=w.tenant_id AND m.workspace_id=w.workspace_id WHERE w.tenant_id=? AND m.user_id=? AND m.status='active' ORDER BY w.created_at,w.workspace_id LIMIT 50`).bind(COLLAB_TENANT_ID, human(userId)).all<WorkspaceRow & MemberRow & { member_version: number }>();
  return rows.results.map((r) => ({ workspaceId: r.workspace_id, name: r.name, version: r.version, createdAt: r.created_at, membership: memberDto({ ...r, version: r.member_version }) }));
}
export async function createTeamWorkspace(env: StoreEnv, userId: string, input: { name: unknown }, now = Date.now()): Promise<TeamWorkspaceDetail> {
  await ensureTeamWorkspacesSchema(env);
  const user = human(userId), workspaceId = `ws_${randomHex(12)}`, workspaceName = name(input.name);
  const results = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`INSERT INTO team_workspaces(tenant_id,workspace_id,name,version,created_at) SELECT ?,?,?,1,? WHERE (SELECT COUNT(*) FROM team_workspace_memberships WHERE tenant_id=? AND user_id=? AND status='active')<50`).bind(COLLAB_TENANT_ID, workspaceId, workspaceName, now, COLLAB_TENANT_ID, user),
    env.AGENT_AUDIT.prepare(`INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) SELECT ?,?,?,'owner','active',1,? WHERE changes()=1`).bind(COLLAB_TENANT_ID, workspaceId, user, now),
  ]);
  if (!changed(results[1])) throw new TeamWorkspaceError("Workspace membership limit reached.", 409);
  return (await getTeamWorkspace(env, workspaceId, user, now))!;
}
export async function getTeamWorkspace(env: StoreEnv, workspaceId: string, userId: string, now = Date.now()): Promise<TeamWorkspaceDetail | null> {
  await ensureTeamWorkspacesSchema(env);
  const workspace = id(workspaceId), user = human(userId);
  const membership = await getTeamWorkspaceMembership(env, workspace, user);
  if (!membership) return null;
  const access = `EXISTS(SELECT 1 FROM team_workspace_memberships reader WHERE reader.tenant_id=? AND reader.workspace_id=? AND reader.user_id=? AND reader.status='active')`;
  const row = await env.AGENT_AUDIT.prepare(`SELECT * FROM team_workspaces WHERE tenant_id=? AND workspace_id=? AND ${access}`).bind(COLLAB_TENANT_ID, workspace, COLLAB_TENANT_ID, workspace, user).first<WorkspaceRow>();
  if (!row) return null;
  const members = await env.AGENT_AUDIT.prepare(`SELECT workspace_id,user_id,role,version,joined_at FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=? AND status='active' AND ${access} ORDER BY joined_at,user_id LIMIT 100`).bind(COLLAB_TENANT_ID, workspace, COLLAB_TENANT_ID, workspace, user).all<MemberRow>();
  const detail: TeamWorkspaceDetail = { workspaceId: workspace, name: row.name, version: row.version, createdAt: row.created_at, membership, members: members.results.map(memberDto) };
  if (membership.role !== "member") {
    const invites = await env.AGENT_AUDIT.prepare(`SELECT i.*,issuer.version AS issuer_current_version,issuer.role AS issuer_role,issuer.status AS issuer_status FROM team_workspace_invitations i LEFT JOIN team_workspace_memberships issuer ON issuer.tenant_id=i.tenant_id AND issuer.workspace_id=i.workspace_id AND issuer.user_id=i.issuer_user_id WHERE i.tenant_id=? AND i.workspace_id=? AND EXISTS(SELECT 1 FROM team_workspace_memberships manager WHERE manager.tenant_id=i.tenant_id AND manager.workspace_id=i.workspace_id AND manager.user_id=? AND manager.status='active' AND manager.role IN ('owner','admin')) ORDER BY i.created_at DESC LIMIT 100`).bind(COLLAB_TENANT_ID, workspace, user).all<InvitationRow>();
    detail.invitations = invites.results.map((r) => invitationDto(r, now));
  }
  return detail;
}
export async function renameTeamWorkspace(env: StoreEnv, workspaceId: string, userId: string, input: { name: unknown; expectedVersion: unknown }): Promise<void> {
  await ensureTeamWorkspacesSchema(env);
  const result = await env.AGENT_AUDIT.prepare(`UPDATE team_workspaces SET name=?,version=version+1 WHERE tenant_id=? AND workspace_id=? AND version=? AND EXISTS(SELECT 1 FROM team_workspace_memberships m WHERE m.tenant_id=team_workspaces.tenant_id AND m.workspace_id=team_workspaces.workspace_id AND m.user_id=? AND m.status='active' AND m.role IN ('owner','admin'))`).bind(name(input.name), COLLAB_TENANT_ID, id(workspaceId), version(input.expectedVersion), human(userId)).run();
  if (!changed(result)) throw new TeamWorkspaceError("Workspace not found or its version changed.", 409);
}

/** Role and revocation guard is re-evaluated inside the write, including the last-owner count. */
export async function changeTeamWorkspaceMember(env: StoreEnv, workspaceId: string, userId: string, targetUserId: string, input: { role?: unknown; remove?: boolean; expectedVersion: unknown }, now = Date.now()): Promise<void> {
  await ensureTeamWorkspacesSchema(env);
  await ensureCollaborationSchema(env);
  const workspace = id(workspaceId), user = human(userId), target = human(targetUserId), remove = input.remove === true;
  const newRole = remove ? "member" : role(input.role), expected = version(input.expectedVersion), mutationId = randomHex(16);
  const result = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`UPDATE team_workspace_memberships AS target SET role=CASE WHEN ?=1 THEN role ELSE ? END,status=CASE WHEN ?=1 THEN 'removed' ELSE 'active' END,version=version+1,removed_at=CASE WHEN ?=1 THEN ? ELSE NULL END,mutation_id=? WHERE tenant_id=? AND workspace_id=? AND user_id=? AND status='active' AND version=?
      AND (role<>'owner' OR (?=0 AND ?='owner') OR (SELECT COUNT(*) FROM team_workspace_memberships owners WHERE owners.tenant_id=target.tenant_id AND owners.workspace_id=target.workspace_id AND owners.role='owner' AND owners.status='active')>1)
      AND EXISTS(SELECT 1 FROM team_workspace_memberships manager WHERE manager.tenant_id=target.tenant_id AND manager.workspace_id=target.workspace_id AND manager.user_id=? AND manager.status='active' AND (manager.role='owner' OR (manager.role='admin' AND target.role='member' AND ?='member') OR (?=1 AND manager.user_id=target.user_id)))`).bind(remove ? 1 : 0, newRole, remove ? 1 : 0, remove ? 1 : 0, now, mutationId, COLLAB_TENANT_ID, workspace, target, expected, remove ? 1 : 0, newRole, user, newRole, remove ? 1 : 0),
    env.AGENT_AUDIT.prepare(`UPDATE collaboration_memberships SET status='removed',removed_at=? WHERE tenant_id=? AND workspace_id=? AND user_id=? AND status='active' AND EXISTS(SELECT 1 FROM team_workspace_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.user_id=? AND m.status='removed' AND m.mutation_id=?)`).bind(now, COLLAB_TENANT_ID, workspace, target, COLLAB_TENANT_ID, workspace, target, mutationId),
    env.AGENT_AUDIT.prepare(`UPDATE collaboration_handoffs SET status='cancelled',cancelled_at=? WHERE tenant_id=? AND workspace_id=? AND status='active' AND root_handoff_id IN (SELECT affected.root_handoff_id FROM collaboration_handoffs affected WHERE affected.tenant_id=? AND affected.workspace_id=? AND (affected.sender_user_id=? OR affected.recipient_user_id=?)) AND EXISTS(SELECT 1 FROM team_workspace_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.user_id=? AND m.status='removed' AND m.mutation_id=?)`).bind(now, COLLAB_TENANT_ID, workspace, COLLAB_TENANT_ID, workspace, target, target, COLLAB_TENANT_ID, workspace, target, mutationId),
    env.AGENT_AUDIT.prepare(`UPDATE collaboration_slack_delivery_intents SET status='blocked',delivery_status='blocked',outcome_detail='A workspace member was removed.' WHERE tenant_id=? AND workspace_id=? AND status='pending' AND delivery_status IN ('awaiting_approval','approved') AND (created_by_user_id=? OR approved_by_user_id=?) AND EXISTS(SELECT 1 FROM team_workspace_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.user_id=? AND m.status='removed' AND m.mutation_id=?)`).bind(COLLAB_TENANT_ID, workspace, target, target, COLLAB_TENANT_ID, workspace, target, mutationId),
  ]);
  if (!changed(result[0])) throw new TeamWorkspaceError("Member change denied, stale, or would remove the last owner.", 409);
}

export async function createTeamWorkspaceInvitation(env: StoreEnv, workspaceId: string, userId: string, input: { email: unknown; role: unknown }, now = Date.now()): Promise<CreatedTeamWorkspaceInvitation> {
  await ensureTeamWorkspacesSchema(env);
  const workspace = id(workspaceId), user = human(userId), email = normalizeTeamWorkspaceEmail(input.email), invitedRole = role(input.role);
  const token = randomHex(32), tokenHash = await hashToken(token), invitationId = `wsi_${randomHex(12)}`;
  const result = await env.AGENT_AUDIT.prepare(`INSERT INTO team_workspace_invitations(tenant_id,workspace_id,invitation_id,token_hash,email,role,issuer_user_id,issuer_version,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,issuer.version,'pending',?,? FROM team_workspace_memberships issuer WHERE issuer.tenant_id=? AND issuer.workspace_id=? AND issuer.user_id=? AND issuer.status='active' AND (issuer.role='owner' OR (issuer.role='admin' AND ?='member')) AND (SELECT COUNT(*) FROM team_workspace_invitations WHERE tenant_id=? AND workspace_id=?)<100 AND (SELECT COUNT(*) FROM team_workspace_memberships WHERE tenant_id=? AND workspace_id=?)<100`).bind(COLLAB_TENANT_ID, workspace, invitationId, tokenHash, email, invitedRole, user, now, now + TEAM_WORKSPACE_INVITATION_TTL_MS, COLLAB_TENANT_ID, workspace, user, invitedRole, COLLAB_TENANT_ID, workspace, COLLAB_TENANT_ID, workspace).run();
  if (!changed(result)) throw new TeamWorkspaceError("Invitation denied or workspace capacity reached.", 409);
  return { token, invitation: { invitationId, workspaceId: workspace, email, role: invitedRole, issuerUserId: user, createdAt: now, expiresAt: now + TEAM_WORKSPACE_INVITATION_TTL_MS, status: "pending" } };
}
export async function revokeTeamWorkspaceInvitation(env: StoreEnv, workspaceId: string, userId: string, invitationId: string, now = Date.now()): Promise<void> {
  await ensureTeamWorkspacesSchema(env);
  const result = await env.AGENT_AUDIT.prepare(`UPDATE team_workspace_invitations AS invitation SET status='revoked',revoked_at=? WHERE tenant_id=? AND workspace_id=? AND invitation_id=? AND status='pending' AND EXISTS(SELECT 1 FROM team_workspace_memberships manager WHERE manager.tenant_id=invitation.tenant_id AND manager.workspace_id=invitation.workspace_id AND manager.user_id=? AND manager.status='active' AND (manager.role='owner' OR (manager.role='admin' AND invitation.role='member')))` ).bind(now, COLLAB_TENANT_ID, id(workspaceId), invitationId, human(userId)).run();
  if (!changed(result)) throw new TeamWorkspaceError("Invitation unavailable or revocation denied.", 409);
}
export async function acceptTeamWorkspaceInvitation(env: StoreEnv, userId: string, token: unknown, now = Date.now()): Promise<TeamWorkspaceSummary> {
  await ensureTeamWorkspacesSchema(env);
  const user = human(userId);
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new TeamWorkspaceError("Invitation unavailable.", 404);
  const tokenHash = await hashToken(token);
  // One D1 transaction: consumption only follows a successful conditional membership grant.
  const result = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(`INSERT INTO team_workspace_memberships(tenant_id,workspace_id,user_id,role,status,version,joined_at) SELECT invitation.tenant_id,invitation.workspace_id,?,invitation.role,'active',1,? FROM team_workspace_invitations invitation JOIN team_workspace_memberships issuer ON issuer.tenant_id=invitation.tenant_id AND issuer.workspace_id=invitation.workspace_id AND issuer.user_id=invitation.issuer_user_id WHERE invitation.tenant_id=? AND invitation.token_hash=? AND invitation.email=? AND invitation.status='pending' AND invitation.expires_at>? AND issuer.status='active' AND issuer.version=invitation.issuer_version AND (issuer.role='owner' OR (issuer.role='admin' AND invitation.role='member')) AND (SELECT COUNT(*) FROM team_workspace_memberships WHERE tenant_id=? AND user_id=? AND status='active')<50 AND ((SELECT COUNT(*) FROM team_workspace_memberships m WHERE m.tenant_id=invitation.tenant_id AND m.workspace_id=invitation.workspace_id)<100 OR EXISTS(SELECT 1 FROM team_workspace_memberships m WHERE m.tenant_id=invitation.tenant_id AND m.workspace_id=invitation.workspace_id AND m.user_id=?)) ON CONFLICT(tenant_id,workspace_id,user_id) DO UPDATE SET role=excluded.role,status='active',version=team_workspace_memberships.version+1,joined_at=excluded.joined_at,removed_at=NULL,mutation_id=NULL WHERE team_workspace_memberships.status='removed'`).bind(user, now, COLLAB_TENANT_ID, tokenHash, user, now, COLLAB_TENANT_ID, user, user),
    env.AGENT_AUDIT.prepare(`UPDATE team_workspace_invitations SET status='accepted',accepted_by_user_id=?,accepted_at=? WHERE tenant_id=? AND token_hash=? AND email=? AND status='pending' AND changes()=1`).bind(user, now, COLLAB_TENANT_ID, tokenHash, user),
  ]);
  if (!changed(result[0]) || !changed(result[1])) throw new TeamWorkspaceError("Invitation unavailable.", 404);
  const row = await env.AGENT_AUDIT.prepare(`SELECT workspace_id FROM team_workspace_invitations WHERE tenant_id=? AND token_hash=? AND status='accepted' AND accepted_by_user_id=?`).bind(COLLAB_TENANT_ID, tokenHash, user).first<{ workspace_id: string }>();
  const detail = row && await getTeamWorkspace(env, row.workspace_id, user, now);
  if (!detail) throw new TeamWorkspaceError("Workspace access was revoked.", 403);
  return { workspaceId: detail.workspaceId, name: detail.name, version: detail.version, createdAt: detail.createdAt, membership: detail.membership };
}

/** Read-only eligibility for native enrollment. Does not consume or grant an invitation. */
export async function validatePendingTeamInvitation(env: StoreEnv, token: string, email: string, now = Date.now()): Promise<{ invitationId: string; workspaceId: string; issuerUserId: string } | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  await ensureTeamWorkspacesSchema(env);
  const row = await env.AGENT_AUDIT.prepare(`SELECT invitation.invitation_id,invitation.workspace_id,invitation.issuer_user_id
    FROM team_workspace_invitations invitation JOIN team_workspace_memberships issuer
    ON issuer.tenant_id=invitation.tenant_id AND issuer.workspace_id=invitation.workspace_id AND issuer.user_id=invitation.issuer_user_id
    WHERE invitation.tenant_id=? AND invitation.token_hash=? AND invitation.email=? AND invitation.status='pending'
    AND invitation.expires_at>? AND issuer.status='active' AND issuer.version=invitation.issuer_version
    AND (issuer.role='owner' OR (issuer.role='admin' AND invitation.role='member'))`)
    .bind(COLLAB_TENANT_ID, await hashToken(token), normalizeTeamWorkspaceEmail(email), now)
    .first<{ invitation_id: string; workspace_id: string; issuer_user_id: string }>();
  return row ? { invitationId: row.invitation_id, workspaceId: row.workspace_id, issuerUserId: row.issuer_user_id } : null;
}

/** Recheck the pinned enrollment before sending or consuming email verification. */
export async function isPendingTeamEnrollmentCurrent(env: StoreEnv, input: { invitationId: string; workspaceId: string; email: string }, now = Date.now()): Promise<boolean> {
  await ensureTeamWorkspacesSchema(env);
  const row = await env.AGENT_AUDIT.prepare(`SELECT invitation.invitation_id
    FROM team_workspace_invitations invitation JOIN team_workspace_memberships issuer
    ON issuer.tenant_id=invitation.tenant_id AND issuer.workspace_id=invitation.workspace_id AND issuer.user_id=invitation.issuer_user_id
    WHERE invitation.tenant_id=? AND invitation.workspace_id=? AND invitation.invitation_id=? AND invitation.email=?
    AND invitation.status='pending' AND invitation.expires_at>? AND issuer.status='active' AND issuer.version=invitation.issuer_version
    AND (issuer.role='owner' OR (issuer.role='admin' AND invitation.role='member'))`)
    .bind(COLLAB_TENANT_ID, id(input.workspaceId), input.invitationId, normalizeTeamWorkspaceEmail(input.email), now)
    .first<{ invitation_id: string }>();
  return row !== null;
}
