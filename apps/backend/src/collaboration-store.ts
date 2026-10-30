import {
  COLLABORATION_CAPABILITIES,
  type CollaborationActorKind,
  type CollaborationCapability,
  type CollaborationRole,
  type CollaborationVisibility,
} from "@shiba/shared";
import type { Env } from "./env.js";

export const COLLAB_TENANT_ID = "self-hosted";
export const COLLAB_WORKSPACE_ID = "default";
export const COLLAB_MESSAGE_LIMIT = 200;

const ALL_HUMAN_CAPABILITIES = COLLABORATION_CAPABILITIES;
const AGENT_CAPABILITIES: readonly CollaborationCapability[] = [
  "room.read",
  "message.send",
  "handoff.create",
  "task.cancel",
];

export interface CollaborationScope {
  tenantId: string;
  workspaceId: string;
  userId: string;
}

export interface CollaborationRoomRow {
  roomId: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  visibility: CollaborationVisibility;
  createdByUserId: string;
  createdAt: number;
  memberCount?: number;
}

export interface CollaborationMembershipRow {
  roomId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  displayName: string;
  actorId: string;
  actorKind: CollaborationActorKind;
  role: CollaborationRole;
  status: "active" | "removed";
  capabilities: CollaborationCapability[];
  profileVersion: number | null;
  createdAt: number;
  removedAt: number | null;
}

export interface CollaborationMessageRow {
  messageId: string;
  tenantId: string;
  workspaceId: string;
  roomId: string;
  senderUserId: string;
  senderActorId: string;
  senderKind: CollaborationActorKind;
  body: string;
  profileVersion: number | null;
  createdAt: number;
}

export interface CollaborationHandoffRow {
  handoffId: string;
  tenantId: string;
  workspaceId: string;
  roomId: string;
  taskId: string;
  senderUserId: string;
  senderActorId: string;
  recipientUserId: string;
  recipientActorId: string;
  parentHandoffId: string | null;
  rootHandoffId: string;
  depth: number;
  ancestorHandoffIds: string[];
  remainingBudget: number;
  grantedCapabilities: CollaborationCapability[];
  profileVersion: number | null;
  status: "active" | "cancelled";
  createdAt: number;
  cancelledAt: number | null;
}

export class CollaborationStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CollaborationStoreError";
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS collaboration_rooms (
    room_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','shared')),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS collaboration_rooms_scope ON collaboration_rooms(tenant_id, workspace_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS collaboration_memberships (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
    role TEXT NOT NULL CHECK (role IN ('owner','member','agent')),
    status TEXT NOT NULL CHECK (status IN ('active','removed')),
    capabilities_json TEXT NOT NULL,
    profile_version INTEGER,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (tenant_id, workspace_id, room_id, actor_id)
  )`,
  `CREATE INDEX IF NOT EXISTS collaboration_memberships_user ON collaboration_memberships(tenant_id, workspace_id, user_id, status, room_id)`,
  `CREATE TABLE IF NOT EXISTS collaboration_messages (
    message_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    sender_user_id TEXT NOT NULL,
    sender_actor_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human','agent')),
    body TEXT NOT NULL,
    profile_version INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id, workspace_id, room_id, sender_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    PRIMARY KEY (tenant_id, workspace_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS collaboration_messages_room ON collaboration_messages(tenant_id, workspace_id, room_id, created_at, message_id)`,
  `CREATE TABLE IF NOT EXISTS collaboration_handoff_budgets (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    root_handoff_id TEXT NOT NULL,
    remaining INTEGER NOT NULL CHECK (remaining >= 0),
    last_spend_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, room_id, task_id, root_handoff_id),
    FOREIGN KEY (room_id) REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_handoffs (
    handoff_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_actor_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    recipient_actor_id TEXT NOT NULL,
    parent_handoff_id TEXT,
    root_handoff_id TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 4),
    ancestor_handoff_ids_json TEXT NOT NULL,
    remaining_budget INTEGER NOT NULL CHECK (remaining_budget BETWEEN 0 AND 32),
    granted_capabilities_json TEXT NOT NULL,
    profile_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active','cancelled')),
    created_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    FOREIGN KEY (tenant_id, workspace_id, room_id, sender_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, room_id, recipient_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, parent_handoff_id)
      REFERENCES collaboration_handoffs(tenant_id, workspace_id, handoff_id),
    PRIMARY KEY (tenant_id, workspace_id, handoff_id)
  )`,
  `CREATE INDEX IF NOT EXISTS collaboration_handoffs_parent ON collaboration_handoffs(tenant_id, workspace_id, room_id, parent_handoff_id, created_at)`,
];

const initialized = new WeakSet<D1Database>();

export async function ensureCollaborationSchema(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  if (!env.AGENT_AUDIT)
    throw new CollaborationStoreError("Collaboration storage is unavailable.", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  initialized.add(env.AGENT_AUDIT);
}

function rowRoom(row: Record<string, unknown>): CollaborationRoomRow {
  return {
    roomId: String(row.room_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    visibility: row.visibility as CollaborationVisibility,
    createdByUserId: String(row.created_by_user_id),
    createdAt: Number(row.created_at),
    ...(row.member_count !== undefined ? { memberCount: Number(row.member_count) } : {}),
  };
}

function rowMembership(row: Record<string, unknown>): CollaborationMembershipRow {
  let capabilities: CollaborationCapability[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.capabilities_json));
    if (Array.isArray(parsed))
      capabilities = parsed.filter((item): item is CollaborationCapability =>
        (COLLABORATION_CAPABILITIES as readonly unknown[]).includes(item),
      );
  } catch {
    /* Invalid stored grants fail closed. */
  }
  return {
    roomId: String(row.room_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    displayName: String(row.display_name),
    actorId: String(row.actor_id),
    actorKind: row.actor_kind as CollaborationActorKind,
    role: row.role as CollaborationRole,
    status: row.status as "active" | "removed",
    capabilities,
    profileVersion: row.profile_version === null ? null : Number(row.profile_version),
    createdAt: Number(row.created_at),
    removedAt: row.removed_at === null ? null : Number(row.removed_at),
  };
}

function rowMessage(row: Record<string, unknown>): CollaborationMessageRow {
  return {
    messageId: String(row.message_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    roomId: String(row.room_id),
    senderUserId: String(row.sender_user_id),
    senderActorId: String(row.sender_actor_id),
    senderKind: row.sender_kind as CollaborationActorKind,
    body: String(row.body),
    profileVersion: row.profile_version === null ? null : Number(row.profile_version),
    createdAt: Number(row.created_at),
  };
}

function rowHandoff(row: Record<string, unknown>): CollaborationHandoffRow {
  let ancestors: string[] = [];
  let grants: CollaborationCapability[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.ancestor_handoff_ids_json));
    if (Array.isArray(parsed)) ancestors = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* fail closed */
  }
  try {
    const parsed: unknown = JSON.parse(String(row.granted_capabilities_json));
    if (Array.isArray(parsed))
      grants = parsed.filter((x): x is CollaborationCapability =>
        (COLLABORATION_CAPABILITIES as readonly unknown[]).includes(x),
      );
  } catch {
    /* fail closed */
  }
  return {
    handoffId: String(row.handoff_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    roomId: String(row.room_id),
    taskId: String(row.task_id),
    senderUserId: String(row.sender_user_id),
    senderActorId: String(row.sender_actor_id),
    recipientUserId: String(row.recipient_user_id),
    recipientActorId: String(row.recipient_actor_id),
    parentHandoffId: row.parent_handoff_id === null ? null : String(row.parent_handoff_id),
    rootHandoffId: String(row.root_handoff_id),
    depth: Number(row.depth),
    ancestorHandoffIds: ancestors,
    remainingBudget: Number(row.remaining_budget),
    grantedCapabilities: grants,
    profileVersion: row.profile_version === null ? null : Number(row.profile_version),
    status: row.status as "active" | "cancelled",
    createdAt: Number(row.created_at),
    cancelledAt: row.cancelled_at === null ? null : Number(row.cancelled_at),
  };
}

export async function createCollaborationRoom(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: { roomId: string; title: string; visibility: CollaborationVisibility; createdAt: number },
): Promise<CollaborationRoomRow> {
  await ensureCollaborationSchema(env);
  const db = env.AGENT_AUDIT;
  await db.batch([
    db
      .prepare(
        `INSERT INTO collaboration_rooms (room_id,tenant_id,workspace_id,title,visibility,created_by_user_id,created_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(
        input.roomId,
        scope.tenantId,
        scope.workspaceId,
        input.title,
        input.visibility,
        scope.userId,
        input.createdAt,
      ),
    db
      .prepare(
        `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at) VALUES (?,?,?,?,?,?,'human','owner','active',?,NULL,?)`,
      )
      .bind(
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        scope.userId,
        scope.userId,
        humanActorId(scope.userId),
        JSON.stringify(ALL_HUMAN_CAPABILITIES),
        input.createdAt,
      ),
  ]);
  return {
    roomId: input.roomId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    title: input.title,
    visibility: input.visibility,
    createdByUserId: scope.userId,
    createdAt: input.createdAt,
    memberCount: 1,
  };
}

export function humanActorId(userId: string): string {
  return `human:${userId}`;
}

export async function listCollaborationRooms(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
): Promise<CollaborationRoomRow[]> {
  await ensureCollaborationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT DISTINCT r.*, (SELECT COUNT(*) FROM collaboration_memberships m WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.room_id AND m.status='active') AS member_count FROM collaboration_rooms r JOIN collaboration_memberships mine ON mine.tenant_id=r.tenant_id AND mine.workspace_id=r.workspace_id AND mine.room_id=r.room_id WHERE r.tenant_id=? AND r.workspace_id=? AND mine.user_id=? AND mine.status='active' ORDER BY r.created_at DESC LIMIT 100`,
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowRoom);
}

export async function getCollaborationRoom(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollaborationRoomRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT r.* FROM collaboration_rooms r WHERE r.tenant_id=? AND r.workspace_id=? AND r.room_id=? AND EXISTS (SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.room_id AND m.user_id=? AND m.status='active')`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, scope.userId)
    .first<Record<string, unknown>>();
  return row ? rowRoom(row) : null;
}

export async function getCollaborationMembership(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  actorId: string,
): Promise<CollaborationMembershipRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_memberships WHERE tenant_id=? AND workspace_id=? AND room_id=? AND actor_id=? AND user_id=? AND status='active'`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, actorId, scope.userId)
    .first<Record<string, unknown>>();
  return row ? rowMembership(row) : null;
}

export async function getActiveCollaborationMembership(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: Omit<CollaborationScope, "userId">,
  roomId: string,
  actorId: string,
): Promise<CollaborationMembershipRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_memberships WHERE tenant_id=? AND workspace_id=? AND room_id=? AND actor_id=? AND status='active'`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, actorId)
    .first<Record<string, unknown>>();
  return row ? rowMembership(row) : null;
}

export async function listCollaborationMemberships(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollaborationMembershipRow[]> {
  await ensureCollaborationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_memberships WHERE tenant_id=? AND workspace_id=? AND room_id=? AND status='active' AND EXISTS (SELECT 1 FROM collaboration_memberships reader WHERE reader.tenant_id=? AND reader.workspace_id=? AND reader.room_id=? AND reader.user_id=? AND reader.status='active') ORDER BY role,created_at`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
    )
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowMembership);
}

export async function listCollaborationMessages(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollaborationMessageRow[]> {
  await ensureCollaborationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_messages WHERE tenant_id=? AND workspace_id=? AND room_id=? AND EXISTS (SELECT 1 FROM collaboration_memberships reader WHERE reader.tenant_id=? AND reader.workspace_id=? AND reader.room_id=? AND reader.user_id=? AND reader.status='active') ORDER BY created_at DESC,message_id DESC LIMIT ?`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
      COLLAB_MESSAGE_LIMIT,
    )
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowMessage).reverse();
}

export async function listCollaborationHandoffs(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollaborationHandoffRow[]> {
  await ensureCollaborationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_handoffs WHERE tenant_id=? AND workspace_id=? AND room_id=? AND EXISTS (SELECT 1 FROM collaboration_memberships reader WHERE reader.tenant_id=? AND reader.workspace_id=? AND reader.room_id=? AND reader.user_id=? AND reader.status='active') ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
    )
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowHandoff);
}

export async function addCollaborationMember(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  input: {
    userId: string;
    displayName: string;
    actorId: string;
    kind: CollaborationActorKind;
    createdAt: number;
  },
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const caps = input.kind === "human" ? ALL_HUMAN_CAPABILITIES : AGENT_CAPABILITIES;
  const role = input.kind === "human" ? "member" : "agent";
  const result = await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at) SELECT ?,?,?,?,?,?,?,?,'active',?,?,? WHERE EXISTS (SELECT 1 FROM collaboration_memberships owner WHERE owner.tenant_id=? AND owner.workspace_id=? AND owner.room_id=? AND owner.user_id=? AND owner.role='owner' AND owner.status='active') AND EXISTS (SELECT 1 FROM collaboration_rooms r WHERE r.tenant_id=? AND r.workspace_id=? AND r.room_id=?) ON CONFLICT(tenant_id,workspace_id,room_id,actor_id) DO UPDATE SET user_id=excluded.user_id, display_name=excluded.display_name, actor_kind=excluded.actor_kind, role=excluded.role, status='active', capabilities_json=excluded.capabilities_json, profile_version=excluded.profile_version, removed_at=NULL WHERE collaboration_memberships.status='removed'`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      input.userId,
      input.displayName,
      input.actorId,
      input.kind,
      role,
      JSON.stringify(caps),
      input.kind === "agent" ? 1 : null,
      input.createdAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
      scope.tenantId,
      scope.workspaceId,
      roomId,
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function removeCollaborationMember(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  actorId: string,
  removedAt: number,
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_memberships SET status='removed',removed_at=? WHERE tenant_id=? AND workspace_id=? AND room_id=? AND actor_id=? AND role<>'owner' AND status='active' AND EXISTS (SELECT 1 FROM collaboration_memberships owner WHERE owner.tenant_id=? AND owner.workspace_id=? AND owner.room_id=? AND owner.user_id=? AND owner.role='owner' AND owner.status='active')`,
  )
    .bind(
      removedAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      actorId,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function createCollaborationMessage(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: CollaborationMessageRow,
): Promise<CollaborationMessageRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_messages (message_id,tenant_id,workspace_id,room_id,sender_user_id,sender_actor_id,sender_kind,body,profile_version,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.user_id=? AND m.actor_id=? AND m.actor_kind=? AND m.status='active' AND EXISTS (SELECT 1 FROM collaboration_rooms r WHERE r.tenant_id=m.tenant_id AND r.workspace_id=m.workspace_id AND r.room_id=m.room_id)) RETURNING *`,
  )
    .bind(
      input.messageId,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      scope.userId,
      input.senderActorId,
      input.senderKind,
      input.body,
      input.profileVersion,
      input.createdAt,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      scope.userId,
      input.senderActorId,
      input.senderKind,
    )
    .first<Record<string, unknown>>();
  return row ? rowMessage(row) : null;
}

export async function getCollaborationHandoff(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  handoffId: string,
): Promise<CollaborationHandoffRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_handoffs WHERE tenant_id=? AND workspace_id=? AND handoff_id=?`,
  )
    .bind(scope.tenantId, scope.workspaceId, handoffId)
    .first<Record<string, unknown>>();
  return row ? rowHandoff(row) : null;
}

export async function createRootCollaborationHandoff(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: CollaborationHandoffRow,
): Promise<CollaborationHandoffRow | null> {
  await ensureCollaborationSchema(env);
  const db = env.AGENT_AUDIT;
  await db.batch([
    db
      .prepare(
        `INSERT INTO collaboration_handoffs (handoff_id,tenant_id,workspace_id,room_id,task_id,sender_user_id,sender_actor_id,recipient_user_id,recipient_actor_id,parent_handoff_id,root_handoff_id,depth,ancestor_handoff_ids_json,remaining_budget,granted_capabilities_json,profile_version,status,created_at) SELECT ?,?,?,?,?,?,?,?,?,NULL,?,0,'[]',?,?,?,'active',? WHERE EXISTS (SELECT 1 FROM collaboration_memberships s WHERE s.tenant_id=? AND s.workspace_id=? AND s.room_id=? AND s.user_id=? AND s.actor_id=? AND s.status='active' AND EXISTS (SELECT 1 FROM collaboration_memberships r WHERE r.tenant_id=s.tenant_id AND r.workspace_id=s.workspace_id AND r.room_id=s.room_id AND r.actor_id=? AND r.status='active'))`,
      )
      .bind(
        input.handoffId,
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        input.taskId,
        scope.userId,
        input.senderActorId,
        input.recipientUserId,
        input.recipientActorId,
        input.rootHandoffId,
        input.remainingBudget,
        JSON.stringify(input.grantedCapabilities),
        input.profileVersion,
        input.createdAt,
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        scope.userId,
        input.senderActorId,
        input.recipientActorId,
      ),
    db
      .prepare(
        `INSERT INTO collaboration_handoff_budgets (tenant_id,workspace_id,room_id,task_id,root_handoff_id,remaining,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM collaboration_handoffs h WHERE h.tenant_id=? AND h.workspace_id=? AND h.handoff_id=? AND h.status='active')`,
      )
      .bind(
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        input.taskId,
        input.rootHandoffId,
        input.remainingBudget,
        input.createdAt,
        scope.tenantId,
        scope.workspaceId,
        input.handoffId,
      ),
  ]);
  return getCollaborationHandoff(env, scope, input.handoffId);
}

export async function createChildCollaborationHandoff(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: CollaborationHandoffRow,
): Promise<CollaborationHandoffRow | null> {
  await ensureCollaborationSchema(env);
  const db = env.AGENT_AUDIT;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE collaboration_handoff_budgets SET remaining=remaining-1,last_spend_id=? WHERE tenant_id=? AND workspace_id=? AND room_id=? AND task_id=? AND root_handoff_id=? AND remaining>0 AND EXISTS (SELECT 1 FROM collaboration_handoffs parent JOIN collaboration_memberships sender ON sender.tenant_id=parent.tenant_id AND sender.workspace_id=parent.workspace_id AND sender.room_id=parent.room_id AND sender.actor_id=parent.recipient_actor_id AND sender.user_id=? AND sender.status='active' JOIN collaboration_memberships recipient ON recipient.tenant_id=parent.tenant_id AND recipient.workspace_id=parent.workspace_id AND recipient.room_id=parent.room_id AND recipient.actor_id=? AND recipient.user_id=? AND recipient.status='active' WHERE parent.tenant_id=? AND parent.workspace_id=? AND parent.handoff_id=? AND parent.status='active' AND parent.room_id=? AND parent.task_id=?)`,
      )
      .bind(
        input.handoffId,
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        input.taskId,
        input.rootHandoffId,
        scope.userId,
        input.recipientActorId,
        input.recipientUserId,
        scope.tenantId,
        scope.workspaceId,
        input.parentHandoffId,
        input.roomId,
        input.taskId,
      ),
    db
      .prepare(
        `INSERT INTO collaboration_handoffs (handoff_id,tenant_id,workspace_id,room_id,task_id,sender_user_id,sender_actor_id,recipient_user_id,recipient_actor_id,parent_handoff_id,root_handoff_id,depth,ancestor_handoff_ids_json,remaining_budget,granted_capabilities_json,profile_version,status,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT remaining FROM collaboration_handoff_budgets WHERE tenant_id=? AND workspace_id=? AND room_id=? AND task_id=? AND root_handoff_id=?),?,?,'active',? WHERE EXISTS (SELECT 1 FROM collaboration_handoff_budgets b WHERE b.tenant_id=? AND b.workspace_id=? AND b.room_id=? AND b.task_id=? AND b.root_handoff_id=? AND b.last_spend_id=?) AND EXISTS (SELECT 1 FROM collaboration_handoffs parent JOIN collaboration_memberships sender ON sender.tenant_id=parent.tenant_id AND sender.workspace_id=parent.workspace_id AND sender.room_id=parent.room_id AND sender.actor_id=parent.recipient_actor_id AND sender.user_id=? AND sender.status='active' JOIN collaboration_memberships recipient ON recipient.tenant_id=parent.tenant_id AND recipient.workspace_id=parent.workspace_id AND recipient.room_id=parent.room_id AND recipient.actor_id=? AND recipient.user_id=? AND recipient.status='active' WHERE parent.tenant_id=? AND parent.workspace_id=? AND parent.handoff_id=? AND parent.status='active' AND parent.room_id=? AND parent.task_id=?)`,
      )
      .bind(
        input.handoffId,
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        input.taskId,
        scope.userId,
        input.senderActorId,
        input.recipientUserId,
        input.recipientActorId,
        input.parentHandoffId,
        input.rootHandoffId,
        input.depth,
        JSON.stringify(input.ancestorHandoffIds),
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        input.taskId,
        input.rootHandoffId,
        JSON.stringify(input.grantedCapabilities),
        input.profileVersion,
        input.createdAt,
        scope.tenantId,
        scope.workspaceId,
        input.roomId,
        input.taskId,
        input.rootHandoffId,
        input.handoffId,
        scope.userId,
        input.recipientActorId,
        input.recipientUserId,
        scope.tenantId,
        scope.workspaceId,
        input.parentHandoffId,
        input.roomId,
        input.taskId,
      ),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1 || Number(results[1]?.meta?.changes ?? 0) !== 1)
    return null;
  return getCollaborationHandoff(env, scope, input.handoffId);
}

export async function cancelCollaborationHandoff(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  handoffId: string,
  cancelledAt: number,
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const result = await env.AGENT_AUDIT.prepare(`WITH target_root AS (
      SELECT root.tenant_id,root.workspace_id,root.room_id,root.root_handoff_id,root.sender_user_id,root.recipient_user_id
      FROM collaboration_handoffs target
      JOIN collaboration_handoffs root ON root.tenant_id=target.tenant_id AND root.workspace_id=target.workspace_id
        AND root.handoff_id=target.root_handoff_id AND root.parent_handoff_id IS NULL
      WHERE target.tenant_id=? AND target.workspace_id=? AND target.handoff_id=?
    )
    UPDATE collaboration_handoffs SET status='cancelled',cancelled_at=?
    WHERE tenant_id=? AND workspace_id=?
      AND root_handoff_id=(SELECT root_handoff_id FROM target_root)
      AND status='active'
      AND EXISTS (
        SELECT 1 FROM target_root root
        JOIN collaboration_memberships member ON member.tenant_id=root.tenant_id
          AND member.workspace_id=root.workspace_id AND member.room_id=root.room_id
          AND member.user_id=? AND member.status='active'
        WHERE root.sender_user_id=member.user_id OR root.recipient_user_id=member.user_id
      )`)
    .bind(
      scope.tenantId,
      scope.workspaceId,
      handoffId,
      cancelledAt,
      scope.tenantId,
      scope.workspaceId,
      scope.userId,
    )
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}
