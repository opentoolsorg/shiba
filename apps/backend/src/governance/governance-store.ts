import {
  type GovernanceAccessLevel,
  type GovernanceResourceKind,
  governanceAccessLevelSchema,
  governanceResourceKindSchema,
  type WorkspaceGroup,
  type WorkspaceSharingPolicy,
} from "@shiba/shared";
import { COLLAB_TENANT_ID } from "../collaboration-store.js";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";
import { getTeamWorkspaceMembership } from "../team-workspaces-store.js";

type StoreEnv = Pick<Env, "AGENT_AUDIT">;

export class GovernanceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "GovernanceError";
  }
}

const changed = (result: D1Result | undefined) => Number(result?.meta?.changes ?? 0) === 1;

export async function hashOpaqueToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newGroupId(): string {
  return `wgrp_${randomHex(12)}`;
}

export function newGrantId(): string {
  return `wgrt_${randomHex(12)}`;
}

export function newGuestId(): string {
  return `wgst_${randomHex(12)}`;
}

export function newShareLinkId(): string {
  return `shlk_${randomHex(12)}`;
}

export function newAuditExportId(): string {
  return `aexp_${randomHex(12)}`;
}

function parseWorkspaceId(value: string): string {
  if (!/^ws_[a-f0-9]{24}$/.test(value)) throw new GovernanceError("Workspace not found.", 404);
  return value;
}

function groupName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 80 ||
    /[\x00-\x1f]/.test(value)
  ) {
    throw new GovernanceError("Group name must contain 1–80 characters.");
  }
  return value.trim();
}

function accessLevel(value: unknown): GovernanceAccessLevel {
  const parsed = governanceAccessLevelSchema.safeParse(value);
  if (!parsed.success) throw new GovernanceError("Invalid access level.");
  return parsed.data;
}

function resourceKind(value: unknown): GovernanceResourceKind {
  const parsed = governanceResourceKindSchema.safeParse(value);
  if (!parsed.success) throw new GovernanceError("Invalid resource kind.");
  return parsed.data;
}

async function requireManager(env: StoreEnv, workspace: string, userId: string): Promise<void> {
  const membership = await getTeamWorkspaceMembership(env, workspace, userId);
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new GovernanceError("Workspace admin required.", 403);
  }
}

export async function listWorkspaceGroups(
  env: StoreEnv,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceGroup[]> {
  workspaceId = parseWorkspaceId(workspaceId);
  const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
  if (!membership) throw new GovernanceError("Workspace not found.", 404);
  const rows = await env
    .AGENT_AUDIT!.prepare(
      `SELECT group_id AS groupId, workspace_id AS workspaceId, name, version, created_at AS createdAt
     FROM workspace_groups WHERE tenant_id=? AND workspace_id=? ORDER BY created_at, group_id`,
    )
    .bind(COLLAB_TENANT_ID, workspaceId)
    .all<WorkspaceGroup>();
  return rows.results;
}

export async function createWorkspaceGroup(
  env: StoreEnv,
  workspaceId: string,
  userId: string,
  input: { name: unknown },
  now = Date.now(),
): Promise<WorkspaceGroup> {
  workspaceId = parseWorkspaceId(workspaceId);
  await requireManager(env, workspaceId, userId);
  const groupId = newGroupId();
  const name = groupName(input.name);
  const result = await env
    .AGENT_AUDIT!.prepare(
      `INSERT INTO workspace_groups(tenant_id,workspace_id,group_id,name,version,created_at) VALUES (?,?,?,?,1,?)`,
    )
    .bind(COLLAB_TENANT_ID, workspaceId, groupId, name, now)
    .run();
  if (!changed(result)) throw new GovernanceError("Group could not be created.", 409);
  return { groupId, workspaceId, name, version: 1, createdAt: now };
}

export async function addWorkspaceGroupMember(
  env: StoreEnv,
  workspaceId: string,
  actorId: string,
  groupId: string,
  targetUserId: string,
  now = Date.now(),
): Promise<void> {
  workspaceId = parseWorkspaceId(workspaceId);
  await requireManager(env, workspaceId, actorId);
  const email = targetUserId.trim().toLowerCase();
  const membership = await getTeamWorkspaceMembership(env, workspaceId, email);
  if (!membership) throw new GovernanceError("Only workspace members can join groups.", 404);
  const group = await env
    .AGENT_AUDIT!.prepare(
      `SELECT group_id FROM workspace_groups WHERE tenant_id=? AND workspace_id=? AND group_id=?`,
    )
    .bind(COLLAB_TENANT_ID, workspaceId, groupId)
    .first();
  if (!group) throw new GovernanceError("Group not found.", 404);
  await env.AGENT_AUDIT!.batch([
    env.AGENT_AUDIT.prepare(
      `INSERT INTO workspace_group_members(tenant_id,workspace_id,group_id,user_id,version,joined_at)
       VALUES (?,?,?,?,1,?) ON CONFLICT(tenant_id,workspace_id,group_id,user_id) DO UPDATE SET
       version=workspace_group_members.version+1, joined_at=excluded.joined_at, removed_at=NULL`,
    ).bind(COLLAB_TENANT_ID, workspaceId, groupId, email, now),
    env.AGENT_AUDIT.prepare(
      `UPDATE workspace_groups SET version=version+1 WHERE tenant_id=? AND workspace_id=? AND group_id=?`,
    ).bind(COLLAB_TENANT_ID, workspaceId, groupId),
  ]);
}

export async function removeWorkspaceGroupMember(
  env: StoreEnv,
  workspaceId: string,
  actorId: string,
  groupId: string,
  targetUserId: string,
  now = Date.now(),
): Promise<void> {
  workspaceId = parseWorkspaceId(workspaceId);
  await requireManager(env, workspaceId, actorId);
  const email = targetUserId.trim().toLowerCase();
  const result = await env.AGENT_AUDIT!.batch([
    env.AGENT_AUDIT.prepare(
      `UPDATE workspace_group_members SET version=version+1, removed_at=? WHERE tenant_id=? AND workspace_id=? AND group_id=? AND user_id=? AND removed_at IS NULL`,
    ).bind(now, COLLAB_TENANT_ID, workspaceId, groupId, email),
    env.AGENT_AUDIT.prepare(
      `UPDATE workspace_groups SET version=version+1 WHERE tenant_id=? AND workspace_id=? AND group_id=?`,
    ).bind(COLLAB_TENANT_ID, workspaceId, groupId),
  ]);
  if (!changed(result[0])) throw new GovernanceError("Group member not found.", 404);
}

export async function upsertResourceGrant(
  env: StoreEnv,
  workspaceId: string,
  actorId: string,
  input: {
    resourceKind: unknown;
    resourceId: unknown;
    principalKind: "user" | "group" | "guest";
    principalId: unknown;
    access: unknown;
  },
  now = Date.now(),
): Promise<{ grantId: string }> {
  workspaceId = parseWorkspaceId(workspaceId);
  await requireManager(env, workspaceId, actorId);
  const kind = resourceKind(input.resourceKind);
  const resourceId =
    typeof input.resourceId === "string" && input.resourceId.length <= 128
      ? input.resourceId
      : (() => {
          throw new GovernanceError("Invalid resource id.");
        })();
  const principalId =
    typeof input.principalId === "string" && input.principalId.length <= 320
      ? input.principalId
      : (() => {
          throw new GovernanceError("Invalid principal id.");
        })();
  const access = accessLevel(input.access);
  const grantId = newGrantId();
  const result = await env
    .AGENT_AUDIT!.prepare(
      `INSERT INTO workspace_resource_grants(tenant_id,workspace_id,grant_id,resource_kind,resource_id,principal_kind,principal_id,access,created_at,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      COLLAB_TENANT_ID,
      workspaceId,
      grantId,
      kind,
      resourceId,
      input.principalKind,
      principalId,
      access,
      now,
      actorId,
    )
    .run();
  if (!changed(result)) throw new GovernanceError("Grant could not be created.", 409);
  return { grantId };
}

export async function revokeResourceGrant(
  env: StoreEnv,
  workspaceId: string,
  actorId: string,
  grantId: string,
  now = Date.now(),
): Promise<void> {
  workspaceId = parseWorkspaceId(workspaceId);
  await requireManager(env, workspaceId, actorId);
  const result = await env
    .AGENT_AUDIT!.prepare(
      `UPDATE workspace_resource_grants SET revoked_at=? WHERE tenant_id=? AND workspace_id=? AND grant_id=? AND revoked_at IS NULL`,
    )
    .bind(now, COLLAB_TENANT_ID, workspaceId, grantId)
    .run();
  if (!changed(result)) throw new GovernanceError("Grant not found.", 404);
}

interface PolicyRow {
  workspaceId: string;
  publicLinksAllowed: number;
  guestInvitesAllowed: number;
  defaultResourceAccess: GovernanceAccessLevel | null;
  version: number;
}

export async function getWorkspaceSharingPolicy(
  env: StoreEnv,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceSharingPolicy> {
  workspaceId = parseWorkspaceId(workspaceId);
  const membership = await getTeamWorkspaceMembership(env, workspaceId, userId);
  if (!membership) throw new GovernanceError("Workspace not found.", 404);
  const row = await env
    .AGENT_AUDIT!.prepare(
      `SELECT workspace_id AS workspaceId, public_links_allowed AS publicLinksAllowed, guest_invites_allowed AS guestInvitesAllowed,
            default_resource_access AS defaultResourceAccess, version
     FROM workspace_sharing_policy WHERE tenant_id=? AND workspace_id=?`,
    )
    .bind(COLLAB_TENANT_ID, workspaceId)
    .first<PolicyRow>();
  if (!row) {
    return {
      workspaceId,
      publicLinksAllowed: true,
      guestInvitesAllowed: true,
      defaultResourceAccess: null,
      version: 0,
    };
  }
  return {
    workspaceId: row.workspaceId,
    publicLinksAllowed: row.publicLinksAllowed === 1,
    guestInvitesAllowed: row.guestInvitesAllowed === 1,
    defaultResourceAccess: row.defaultResourceAccess,
    version: row.version,
  };
}

export async function updateWorkspaceSharingPolicy(
  env: StoreEnv,
  workspaceId: string,
  actorId: string,
  input: {
    publicLinksAllowed?: boolean;
    guestInvitesAllowed?: boolean;
    defaultResourceAccess?: GovernanceAccessLevel | null;
    expectedVersion: unknown;
  },
  now = Date.now(),
): Promise<WorkspaceSharingPolicy> {
  workspaceId = parseWorkspaceId(workspaceId);
  await requireManager(env, workspaceId, actorId);
  const expected = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw new GovernanceError("expectedVersion required.");
  const current = await getWorkspaceSharingPolicy(env, workspaceId, actorId);
  const nextPublic = input.publicLinksAllowed ?? current.publicLinksAllowed;
  const nextGuest = input.guestInvitesAllowed ?? current.guestInvitesAllowed;
  const nextDefault =
    input.defaultResourceAccess !== undefined
      ? input.defaultResourceAccess
      : current.defaultResourceAccess;
  if (expected === 0 && current.version === 0) {
    const result = await env
      .AGENT_AUDIT!.prepare(
        `INSERT INTO workspace_sharing_policy(tenant_id,workspace_id,public_links_allowed,guest_invites_allowed,default_resource_access,version,updated_at)
       VALUES (?,?,?,?,?,1,?)`,
      )
      .bind(COLLAB_TENANT_ID, workspaceId, nextPublic ? 1 : 0, nextGuest ? 1 : 0, nextDefault, now)
      .run();
    if (!changed(result)) throw new GovernanceError("Policy conflict.", 409);
  } else {
    const result = await env
      .AGENT_AUDIT!.prepare(
        `UPDATE workspace_sharing_policy SET public_links_allowed=?, guest_invites_allowed=?, default_resource_access=?, version=version+1, updated_at=?
       WHERE tenant_id=? AND workspace_id=? AND version=?`,
      )
      .bind(
        nextPublic ? 1 : 0,
        nextGuest ? 1 : 0,
        nextDefault,
        now,
        COLLAB_TENANT_ID,
        workspaceId,
        expected,
      )
      .run();
    if (!changed(result)) throw new GovernanceError("Policy not found or version changed.", 409);
  }
  return getWorkspaceSharingPolicy(env, workspaceId, actorId);
}

export async function listActiveGroupIdsForUser(
  env: StoreEnv,
  workspaceId: string,
  userId: string,
): Promise<string[]> {
  const rows = await env
    .AGENT_AUDIT!.prepare(
      `SELECT group_id AS groupId FROM workspace_group_members
     WHERE tenant_id=? AND workspace_id=? AND user_id=? AND removed_at IS NULL`,
    )
    .bind(COLLAB_TENANT_ID, workspaceId, userId)
    .all<{ groupId: string }>();
  return rows.results.map((r) => r.groupId);
}

interface GrantRow {
  access: GovernanceAccessLevel;
}

export async function bestGrantAccess(
  env: StoreEnv,
  workspaceId: string,
  resourceKind: GovernanceResourceKind,
  resourceId: string,
  principals: { kind: "user" | "group" | "guest"; id: string }[],
): Promise<GovernanceAccessLevel | null> {
  if (principals.length === 0) return null;
  const clauses = principals.map(() => "(principal_kind=? AND principal_id=?)").join(" OR ");
  const binds: unknown[] = [COLLAB_TENANT_ID, workspaceId, resourceKind, resourceId];
  for (const principal of principals) {
    binds.push(principal.kind, principal.id);
  }
  const rows = await env
    .AGENT_AUDIT!.prepare(
      `SELECT access FROM workspace_resource_grants
     WHERE tenant_id=? AND workspace_id=? AND resource_kind=? AND resource_id=? AND revoked_at IS NULL AND (${clauses})`,
    )
    .bind(...binds)
    .all<GrantRow>();
  const rank: Record<GovernanceAccessLevel, number> = { view: 1, comment: 2, edit: 3, manage: 4 };
  let best: GovernanceAccessLevel | null = null;
  for (const row of rows.results) {
    if (!best || rank[row.access] > rank[best]) best = row.access;
  }
  return best;
}
