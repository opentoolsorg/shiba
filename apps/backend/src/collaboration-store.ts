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
export const COLLAB_SLACK_SOURCE_LIMIT = 1_000;
export const COLLAB_SLACK_LINK_LIMIT_PER_ROOM = 10;
export const COLLAB_SLACK_MESSAGES_PER_THREAD = 200;

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
  sourceRunId?: string | null;
  sourceHandoffId?: string | null;
  sourceArtifactRefs?: CollaborationSourceArtifactRef[];
  sourceSlackEventId?: string | null;
  sourceSlackTeamId?: string | null;
  sourceSlackChannelId?: string | null;
  sourceSlackThreadTs?: string | null;
  sourceSlackUserId?: string | null;
  createdAt: number;
}

export interface CollaborationSourceArtifactRef {
  index: number;
  path: string;
  artifactId?: string;
  version?: number;
  sha256?: string;
}

export interface CollaborationSlackSourceRow {
  teamId: string;
  channelId: string;
  threadTs: string;
  lastSeenAt: number;
  lastUserId: string;
  mappedRoomId?: string;
}

export interface CollaborationSlackLinkRow {
  linkId: string;
  roomId: string;
  ownerUserId: string;
  teamId: string;
  channelId: string;
  threadTs: string;
  status: "active" | "revoked";
  createdAt: number;
  revokedAt: number | null;
}

export interface CollaborationSlackDeliveryIntentRow {
  intentId: string;
  roomId: string;
  linkId: string;
  messageId: string;
  createdByUserId: string;
  channelId: string;
  teamId: string;
  threadTs: string;
  content: string;
  contentHash: string;
  status: "pending" | "blocked";
  deliveryStatus: "awaiting_approval" | "approved" | "sending" | "sent" | "blocked" | "failed" | "unknown";
  createdAt: number;
  approvedByUserId: string | null;
  approvedAt: number | null;
  receiptTs: string | null;
  outcomeDetail: string | null;
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
  approvalId?: string | null;
  runId?: string | null;
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
    source_run_id TEXT,
    source_handoff_id TEXT,
    source_artifact_refs_json TEXT,
    source_slack_event_id TEXT,
    source_slack_team_id TEXT,
    source_slack_channel_id TEXT,
    source_slack_thread_ts TEXT,
    source_slack_user_id TEXT,
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
    approval_id TEXT,
    run_id TEXT,
    FOREIGN KEY (tenant_id, workspace_id, room_id, sender_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, room_id, recipient_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, parent_handoff_id)
      REFERENCES collaboration_handoffs(tenant_id, workspace_id, handoff_id),
    PRIMARY KEY (tenant_id, workspace_id, handoff_id)
  )`,
  `CREATE INDEX IF NOT EXISTS collaboration_handoffs_parent ON collaboration_handoffs(tenant_id, workspace_id, room_id, parent_handoff_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS collaboration_slack_observations (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    last_event_id TEXT NOT NULL,
    last_user_id TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, team_id, channel_id, thread_ts)
  )`,
  `CREATE TABLE IF NOT EXISTS collaboration_slack_room_links (
    link_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','revoked')),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (tenant_id, workspace_id, link_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS collaboration_slack_one_active_link ON collaboration_slack_room_links(tenant_id,workspace_id,team_id,channel_id,thread_ts) WHERE status='active'`,
  `CREATE INDEX IF NOT EXISTS collaboration_slack_links_room ON collaboration_slack_room_links(tenant_id,workspace_id,room_id,status,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS collaboration_slack_delivery_intents (
    intent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    team_id TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('pending','blocked')),
    delivery_status TEXT NOT NULL DEFAULT 'awaiting_approval',
    created_at INTEGER NOT NULL,
    approved_by_user_id TEXT,
    approved_at INTEGER,
    receipt_ts TEXT,
    outcome_detail TEXT,
    PRIMARY KEY (tenant_id, workspace_id, intent_id),
    UNIQUE (tenant_id, workspace_id, message_id, link_id)
  )`,
  `CREATE INDEX IF NOT EXISTS collaboration_slack_intents_room ON collaboration_slack_delivery_intents(tenant_id,workspace_id,room_id,created_at DESC)`,
];

const initialized = new WeakSet<D1Database>();

export async function ensureCollaborationSchema(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  if (!env.AGENT_AUDIT)
    throw new CollaborationStoreError("Collaboration storage is unavailable.", 503);
  if (initialized.has(env.AGENT_AUDIT)) return;
  for (const sql of SCHEMA) await env.AGENT_AUDIT.prepare(sql).run();
  for (const column of ["approval_id TEXT", "run_id TEXT"]) {
    try {
      await env.AGENT_AUDIT.prepare(
        `ALTER TABLE collaboration_handoffs ADD COLUMN ${column}`,
      ).run();
    } catch (error) {
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
  }
  for (const column of [
    "content TEXT NOT NULL DEFAULT ''",
    "content_hash TEXT NOT NULL DEFAULT ''",
    "team_id TEXT NOT NULL DEFAULT ''",
    "delivery_status TEXT NOT NULL DEFAULT 'awaiting_approval'",
    "approved_by_user_id TEXT",
    "approved_at INTEGER",
    "receipt_ts TEXT",
    "outcome_detail TEXT",
  ]) {
    try {
      await env.AGENT_AUDIT.prepare(
        `ALTER TABLE collaboration_slack_delivery_intents ADD COLUMN ${column}`,
      ).run();
    } catch (error) {
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
  }
  for (const column of [
    "source_run_id TEXT",
    "source_handoff_id TEXT",
    "source_artifact_refs_json TEXT",
    "source_slack_event_id TEXT",
    "source_slack_team_id TEXT",
    "source_slack_channel_id TEXT",
    "source_slack_thread_ts TEXT",
    "source_slack_user_id TEXT",
  ]) {
    try {
      await env.AGENT_AUDIT.prepare(
        `ALTER TABLE collaboration_messages ADD COLUMN ${column}`,
      ).run();
    } catch (error) {
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error)))
        throw error;
    }
  }
  await env.AGENT_AUDIT.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS collaboration_messages_source_run ON collaboration_messages(tenant_id,workspace_id,source_run_id) WHERE source_run_id IS NOT NULL",
  ).run();
  await env.AGENT_AUDIT.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS collaboration_messages_slack_event ON collaboration_messages(tenant_id,workspace_id,source_slack_team_id,source_slack_event_id) WHERE source_slack_event_id IS NOT NULL",
  ).run();
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
  let sourceArtifactRefs: CollaborationSourceArtifactRef[] | undefined;
  if (typeof row.source_artifact_refs_json === "string") {
    try {
      const parsed: unknown = JSON.parse(row.source_artifact_refs_json);
      if (Array.isArray(parsed)) {
        sourceArtifactRefs = parsed.filter(
          (item): item is CollaborationSourceArtifactRef =>
            typeof item === "object" && item !== null &&
            Number.isSafeInteger((item as CollaborationSourceArtifactRef).index) &&
            typeof (item as CollaborationSourceArtifactRef).path === "string",
        );
      }
    } catch {
      /* Stored source references are optional; malformed metadata is hidden. */
    }
  }
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
    ...(typeof row.source_run_id === "string" ? { sourceRunId: row.source_run_id } : {}),
    ...(typeof row.source_handoff_id === "string" ? { sourceHandoffId: row.source_handoff_id } : {}),
    ...(sourceArtifactRefs ? { sourceArtifactRefs } : {}),
    ...(typeof row.source_slack_event_id === "string"
      ? {
          sourceSlackEventId: row.source_slack_event_id,
          sourceSlackTeamId: String(row.source_slack_team_id ?? ""),
          sourceSlackChannelId: String(row.source_slack_channel_id ?? ""),
          sourceSlackThreadTs: String(row.source_slack_thread_ts ?? ""),
          sourceSlackUserId: String(row.source_slack_user_id ?? ""),
        }
      : {}),
    createdAt: Number(row.created_at),
  };
}

function rowSlackLink(row: Record<string, unknown>): CollaborationSlackLinkRow {
  return {
    linkId: String(row.link_id),
    roomId: String(row.room_id),
    ownerUserId: String(row.owner_user_id),
    teamId: String(row.team_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    status: row.status as "active" | "revoked",
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  };
}

function rowSlackSource(row: Record<string, unknown>): CollaborationSlackSourceRow {
  return {
    teamId: String(row.team_id),
    channelId: String(row.channel_id),
    threadTs: String(row.thread_ts),
    lastSeenAt: Number(row.last_seen_at),
    lastUserId: String(row.last_user_id),
    ...(typeof row.mapped_room_id === "string" ? { mappedRoomId: row.mapped_room_id } : {}),
  };
}

function rowSlackIntent(row: Record<string, unknown>): CollaborationSlackDeliveryIntentRow {
  return {
    intentId: String(row.intent_id),
    roomId: String(row.room_id),
    linkId: String(row.link_id),
    messageId: String(row.message_id),
    createdByUserId: String(row.created_by_user_id),
    channelId: String(row.channel_id),
    teamId: String(row.team_id ?? ""),
    threadTs: String(row.thread_ts),
    content: String(row.content ?? ""),
    contentHash: String(row.content_hash ?? ""),
    status: row.status as "pending" | "blocked",
    deliveryStatus: row.delivery_status as CollaborationSlackDeliveryIntentRow["deliveryStatus"],
    createdAt: Number(row.created_at),
    approvedByUserId: typeof row.approved_by_user_id === "string" ? row.approved_by_user_id : null,
    approvedAt: row.approved_at == null ? null : Number(row.approved_at),
    receiptTs: typeof row.receipt_ts === "string" ? row.receipt_ts : null,
    outcomeDetail: typeof row.outcome_detail === "string" ? row.outcome_detail : null,
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
    ...(typeof row.approval_id === "string" ? { approvalId: row.approval_id } : {}),
    ...(typeof row.run_id === "string" ? { runId: row.run_id } : {}),
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
    profileVersion?: number;
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
      input.kind === "agent" ? (input.profileVersion ?? 1) : null,
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

/** Atomically attach the normal approval-gated run pointer to a room handoff. */
export async function linkCollaborationHandoffRun(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  handoffId: string,
  approvalId: string,
  runId: string,
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_handoffs SET approval_id=?,run_id=?
     WHERE tenant_id=? AND workspace_id=? AND handoff_id=? AND sender_user_id=?
       AND status='active' AND (approval_id IS NULL OR approval_id=?) AND (run_id IS NULL OR run_id=?)`,
  )
    .bind(
      approvalId,
      runId,
      scope.tenantId,
      scope.workspaceId,
      handoffId,
      scope.userId,
      approvalId,
      runId,
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

/** Persist a deterministic employee reply only for its active, linked, pinned run. */
export async function createCollaborationAgentReply(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: {
    messageId: string;
    roomId: string;
    handoffId: string;
    runId: string;
    agentUserId: string;
    agentActorId: string;
    profileVersion: number;
    body: string;
    sourceArtifactRefs: CollaborationSourceArtifactRef[];
    createdAt: number;
  },
): Promise<CollaborationMessageRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_messages (message_id,tenant_id,workspace_id,room_id,sender_user_id,sender_actor_id,sender_kind,body,profile_version,source_run_id,source_handoff_id,source_artifact_refs_json,created_at)
     SELECT ?,?,?,?,?,?,'agent',?,?,?,?,?,?
     WHERE EXISTS (
       SELECT 1 FROM collaboration_handoffs h
       JOIN collaboration_handoffs root ON root.tenant_id=h.tenant_id AND root.workspace_id=h.workspace_id AND root.handoff_id=h.root_handoff_id
       JOIN collaboration_memberships agent ON agent.tenant_id=h.tenant_id AND agent.workspace_id=h.workspace_id AND agent.room_id=h.room_id AND agent.user_id=h.recipient_user_id AND agent.actor_id=h.recipient_actor_id AND agent.actor_kind='agent' AND agent.profile_version=h.profile_version AND agent.status='active'
       JOIN collaboration_memberships reader ON reader.tenant_id=h.tenant_id AND reader.workspace_id=h.workspace_id AND reader.room_id=h.room_id AND reader.user_id=? AND reader.status='active'
       WHERE h.tenant_id=? AND h.workspace_id=? AND h.room_id=? AND h.handoff_id=? AND h.run_id=? AND h.recipient_actor_id=? AND h.profile_version=? AND h.status='active' AND root.status='active'
     ) ON CONFLICT DO NOTHING RETURNING *`,
  )
    .bind(
      input.messageId,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      input.agentUserId,
      input.agentActorId,
      input.body,
      input.profileVersion,
      input.runId,
      input.handoffId,
      JSON.stringify(input.sourceArtifactRefs),
      input.createdAt,
      scope.userId,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      input.handoffId,
      input.runId,
      input.agentActorId,
      input.profileVersion,
    )
    .first<Record<string, unknown>>();
  if (row) return rowMessage(row);
  const existing = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_messages WHERE tenant_id=? AND workspace_id=? AND room_id=? AND source_run_id=? AND EXISTS (SELECT 1 FROM collaboration_memberships reader WHERE reader.tenant_id=? AND reader.workspace_id=? AND reader.room_id=? AND reader.user_id=? AND reader.status='active')`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      input.runId,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      scope.userId,
    )
    .first<Record<string, unknown>>();
  return existing ? rowMessage(existing) : null;
}

/** Record only the signed event's identifiers, never unlinked Slack message text. */
export async function observeCollaborationSlackThread(
  env: Pick<Env, "AGENT_AUDIT">,
  input: {
    teamId: string;
    channelId: string;
    threadTs: string;
    eventId: string;
    userId: string;
    seenAt: number;
  },
): Promise<void> {
  await ensureCollaborationSchema(env);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_slack_observations (tenant_id,workspace_id,team_id,channel_id,thread_ts,last_event_id,last_user_id,last_seen_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,workspace_id,team_id,channel_id,thread_ts) DO UPDATE SET
       last_event_id=excluded.last_event_id,last_user_id=excluded.last_user_id,last_seen_at=excluded.last_seen_at`,
  )
    .bind(
      COLLAB_TENANT_ID,
      COLLAB_WORKSPACE_ID,
      input.teamId,
      input.channelId,
      input.threadTs,
      input.eventId,
      input.userId,
      input.seenAt,
    )
    .run();
  await env.AGENT_AUDIT.prepare(
    `DELETE FROM collaboration_slack_observations AS o
     WHERE o.tenant_id=? AND o.workspace_id=?
       AND NOT EXISTS (SELECT 1 FROM collaboration_slack_room_links l WHERE l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.team_id=o.team_id AND l.channel_id=o.channel_id AND l.thread_ts=o.thread_ts AND l.status='active')
       AND (o.last_seen_at<? OR (o.team_id,o.channel_id,o.thread_ts) NOT IN (
         SELECT recent.team_id,recent.channel_id,recent.thread_ts FROM collaboration_slack_observations recent
         WHERE recent.tenant_id=o.tenant_id AND recent.workspace_id=o.workspace_id
           AND NOT EXISTS (SELECT 1 FROM collaboration_slack_room_links l WHERE l.tenant_id=recent.tenant_id AND l.workspace_id=recent.workspace_id AND l.team_id=recent.team_id AND l.channel_id=recent.channel_id AND l.thread_ts=recent.thread_ts AND l.status='active')
         ORDER BY recent.last_seen_at DESC LIMIT ?
       ))`,
  )
    .bind(COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, input.seenAt - 30 * 24 * 60 * 60 * 1000, COLLAB_SLACK_SOURCE_LIMIT)
    .run();
}

/** Owner-visible signed Slack sources; IDs alone are stored until an owner maps a thread. */
export async function listCollaborationSlackSources(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollaborationSlackSourceRow[]> {
  await ensureCollaborationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT o.*,l.room_id AS mapped_room_id
     FROM collaboration_slack_observations o
     LEFT JOIN collaboration_slack_room_links l ON l.tenant_id=o.tenant_id AND l.workspace_id=o.workspace_id AND l.team_id=o.team_id AND l.channel_id=o.channel_id AND l.thread_ts=o.thread_ts AND l.status='active'
     WHERE o.tenant_id=? AND o.workspace_id=?
       AND (l.room_id=? OR l.room_id IS NULL)
       AND EXISTS (SELECT 1 FROM collaboration_memberships owner WHERE owner.tenant_id=? AND owner.workspace_id=? AND owner.room_id=? AND owner.user_id=? AND owner.role='owner' AND owner.status='active')
     ORDER BY o.last_seen_at DESC LIMIT 100`,
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
  return (rows.results ?? []).map(rowSlackSource);
}

export async function listCollaborationSlackLinks(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollaborationSlackLinkRow[]> {
  await ensureCollaborationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_slack_room_links l WHERE tenant_id=? AND workspace_id=? AND room_id=?
       AND EXISTS (SELECT 1 FROM collaboration_memberships reader WHERE reader.tenant_id=l.tenant_id AND reader.workspace_id=l.workspace_id AND reader.room_id=l.room_id AND reader.user_id=? AND reader.status='active')
     ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, scope.userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowSlackLink);
}

export async function createCollaborationSlackLink(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: {
    linkId: string;
    roomId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    createdAt: number;
  },
): Promise<CollaborationSlackLinkRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_slack_room_links (link_id,tenant_id,workspace_id,room_id,owner_user_id,team_id,channel_id,thread_ts,status,created_at,revoked_at)
     SELECT ?,?,?,?,?,?,?,?,'active',?,NULL
     WHERE EXISTS (SELECT 1 FROM collaboration_memberships owner WHERE owner.tenant_id=? AND owner.workspace_id=? AND owner.room_id=? AND owner.user_id=? AND owner.role='owner' AND owner.status='active')
       AND EXISTS (SELECT 1 FROM collaboration_slack_observations o WHERE o.tenant_id=? AND o.workspace_id=? AND o.team_id=? AND o.channel_id=? AND o.thread_ts=?)
       AND (SELECT COUNT(*) FROM collaboration_slack_room_links active WHERE active.tenant_id=? AND active.workspace_id=? AND active.room_id=? AND active.status='active')<?
     ON CONFLICT DO NOTHING RETURNING *`,
  )
    .bind(
      input.linkId,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      scope.userId,
      input.teamId,
      input.channelId,
      input.threadTs,
      input.createdAt,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      scope.userId,
      scope.tenantId,
      scope.workspaceId,
      input.teamId,
      input.channelId,
      input.threadTs,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      COLLAB_SLACK_LINK_LIMIT_PER_ROOM,
    )
    .first<Record<string, unknown>>();
  if (row) return rowSlackLink(row);
  const existing = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_slack_room_links WHERE tenant_id=? AND workspace_id=? AND room_id=? AND team_id=? AND channel_id=? AND thread_ts=? AND status='active' AND owner_user_id=?`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      input.teamId,
      input.channelId,
      input.threadTs,
      scope.userId,
    )
    .first<Record<string, unknown>>();
  return existing ? rowSlackLink(existing) : null;
}

export async function revokeCollaborationSlackLink(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  linkId: string,
  revokedAt: number,
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const results = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(
      `UPDATE collaboration_slack_room_links SET status='revoked',revoked_at=?
       WHERE tenant_id=? AND workspace_id=? AND room_id=? AND link_id=? AND status='active'
         AND EXISTS (SELECT 1 FROM collaboration_memberships owner WHERE owner.tenant_id=? AND owner.workspace_id=? AND owner.room_id=? AND owner.user_id=? AND owner.role='owner' AND owner.status='active')`,
    ).bind(
      revokedAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      linkId,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
    ),
    env.AGENT_AUDIT.prepare(
      `UPDATE collaboration_memberships SET status='removed',removed_at=?
       WHERE tenant_id=? AND workspace_id=? AND room_id=? AND substr(actor_id,1,?)=? AND actor_id LIKE 'slack:%' AND status='active'
         AND EXISTS (SELECT 1 FROM collaboration_slack_room_links l JOIN collaboration_memberships owner ON owner.tenant_id=l.tenant_id AND owner.workspace_id=l.workspace_id AND owner.room_id=l.room_id WHERE l.tenant_id=? AND l.workspace_id=? AND l.room_id=? AND l.link_id=? AND l.status='revoked' AND l.revoked_at=? AND owner.user_id=? AND owner.role='owner' AND owner.status='active')`,
    ).bind(
      revokedAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      `slack:${linkId}:`.length,
      `slack:${linkId}:`,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      linkId,
      revokedAt,
      scope.userId,
    ),
    env.AGENT_AUDIT.prepare(
      `UPDATE collaboration_slack_delivery_intents SET status='blocked',delivery_status='blocked' WHERE tenant_id=? AND workspace_id=? AND room_id=? AND link_id=? AND status='pending'`,
    ).bind(scope.tenantId, scope.workspaceId, roomId, linkId),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1;
}

/** Signed Slack event ingestion is limited to an active exact-thread room link. */
export async function ingestCollaborationSlackMessage(
  env: Pick<Env, "AGENT_AUDIT">,
  input: {
    eventId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    text: string;
    createdAt: number;
  },
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const link = await env.AGENT_AUDIT.prepare(
    `SELECT link_id,room_id FROM collaboration_slack_room_links WHERE tenant_id=? AND workspace_id=? AND team_id=? AND channel_id=? AND thread_ts=? AND status='active' LIMIT 1`,
  )
    .bind(COLLAB_TENANT_ID, COLLAB_WORKSPACE_ID, input.teamId, input.channelId, input.threadTs)
    .first<{ link_id: string; room_id: string }>();
  if (!link) return false;
  const actorId = `slack:${link.link_id}:${input.userId}`;
  const userId = `slack:${input.teamId}:${input.userId}`;
  const safeBody = input.text.slice(0, 5_000);
  if (!safeBody.trim()) return false;
  const results = await env.AGENT_AUDIT.batch([
    env.AGENT_AUDIT.prepare(
      `INSERT OR IGNORE INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at,removed_at)
       SELECT ?,?,?,?,?,?,'human','member','active','["message.send"]',NULL,?,NULL
       WHERE EXISTS (SELECT 1 FROM collaboration_slack_room_links l WHERE l.tenant_id=? AND l.workspace_id=? AND l.room_id=? AND l.link_id=? AND l.team_id=? AND l.channel_id=? AND l.thread_ts=? AND l.status='active')`,
    ).bind(
      COLLAB_TENANT_ID,
      COLLAB_WORKSPACE_ID,
      link.room_id,
      userId,
      `Slack user ${input.userId}`,
      actorId,
      input.createdAt,
      COLLAB_TENANT_ID,
      COLLAB_WORKSPACE_ID,
      link.room_id,
      link.link_id,
      input.teamId,
      input.channelId,
      input.threadTs,
    ),
    env.AGENT_AUDIT.prepare(
      `INSERT OR IGNORE INTO collaboration_messages (message_id,tenant_id,workspace_id,room_id,sender_user_id,sender_actor_id,sender_kind,body,profile_version,source_slack_event_id,source_slack_team_id,source_slack_channel_id,source_slack_thread_ts,source_slack_user_id,created_at)
       SELECT ?,?,?,?,?,?,'human',?,NULL,?,?,?,?,?,?
       WHERE EXISTS (SELECT 1 FROM collaboration_slack_room_links l WHERE l.tenant_id=? AND l.workspace_id=? AND l.room_id=? AND l.link_id=? AND l.team_id=? AND l.channel_id=? AND l.thread_ts=? AND l.status='active')
         AND EXISTS (SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.actor_id=? AND m.status='active')
         AND (SELECT COUNT(*) FROM collaboration_messages existing WHERE existing.tenant_id=? AND existing.workspace_id=? AND existing.room_id=? AND existing.source_slack_channel_id=? AND existing.source_slack_thread_ts=?)<?`,
    ).bind(
      `slack_evt_${input.teamId}_${input.eventId}`,
      COLLAB_TENANT_ID,
      COLLAB_WORKSPACE_ID,
      link.room_id,
      userId,
      actorId,
      safeBody,
      input.eventId,
      input.teamId,
      input.channelId,
      input.threadTs,
      input.userId,
      input.createdAt,
      COLLAB_TENANT_ID,
      COLLAB_WORKSPACE_ID,
      link.room_id,
      link.link_id,
      input.teamId,
      input.channelId,
      input.threadTs,
      COLLAB_TENANT_ID,
      COLLAB_WORKSPACE_ID,
      link.room_id,
      actorId,
      COLLAB_TENANT_ID,
      COLLAB_WORKSPACE_ID,
      link.room_id,
      input.channelId,
      input.threadTs,
      COLLAB_SLACK_MESSAGES_PER_THREAD,
    ),
  ]);
  return Number(results[1]?.meta?.changes ?? 0) === 1;
}

export async function listCollaborationSlackDeliveryIntents(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollaborationSlackDeliveryIntentRow[]> {
  await ensureCollaborationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_slack_delivery_intents i WHERE tenant_id=? AND workspace_id=? AND room_id=?
       AND EXISTS (SELECT 1 FROM collaboration_memberships reader WHERE reader.tenant_id=i.tenant_id AND reader.workspace_id=i.workspace_id AND reader.room_id=i.room_id AND reader.user_id=? AND reader.status='active')
     ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, scope.userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowSlackIntent);
}

export async function createCollaborationSlackDeliveryIntent(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: {
    intentId: string;
    roomId: string;
    linkId: string;
    messageId: string;
    channelId: string;
    threadTs: string;
    contentHash: string;
    createdAt: number;
  },
): Promise<CollaborationSlackDeliveryIntentRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_slack_delivery_intents (intent_id,tenant_id,workspace_id,room_id,link_id,message_id,created_by_user_id,channel_id,thread_ts,team_id,content,content_hash,status,created_at)
     SELECT ?,?,?,?,?,?,?,?, ?,l.team_id,m.body,?,'pending',?
       FROM collaboration_messages m
       JOIN collaboration_slack_room_links l ON l.tenant_id=m.tenant_id AND l.workspace_id=m.workspace_id AND l.room_id=m.room_id AND l.link_id=?
       JOIN collaboration_memberships reader ON reader.tenant_id=l.tenant_id AND reader.workspace_id=l.workspace_id AND reader.room_id=l.room_id
       WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.message_id=?
         AND l.channel_id=? AND l.thread_ts=? AND l.status='active'
         AND reader.user_id=? AND reader.status='active' AND m.sender_user_id=? AND m.sender_kind='human' AND m.source_slack_event_id IS NULL AND m.source_run_id IS NULL
     ON CONFLICT DO NOTHING RETURNING *`,
  )
    .bind(
      input.intentId,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      input.linkId,
      input.messageId,
      scope.userId,
      input.channelId,
      input.threadTs,
      input.contentHash,
      input.createdAt,
      input.linkId,
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      input.messageId,
      input.channelId,
      input.threadTs,
      scope.userId,
      scope.userId,
    )
    .first<Record<string, unknown>>();
  if (row) return rowSlackIntent(row);
  const existing = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_slack_delivery_intents WHERE tenant_id=? AND workspace_id=? AND room_id=? AND link_id=? AND message_id=? AND created_by_user_id=?`,
  )
    .bind(scope.tenantId, scope.workspaceId, input.roomId, input.linkId, input.messageId, scope.userId)
    .first<Record<string, unknown>>();
  return existing ? rowSlackIntent(existing) : null;
}

export async function approveCollaborationSlackDeliveryIntent(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  intentId: string,
  approvedAt: number,
): Promise<CollaborationSlackDeliveryIntentRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_slack_delivery_intents SET delivery_status='approved',approved_by_user_id=?,approved_at=?
       WHERE tenant_id=? AND workspace_id=? AND room_id=? AND intent_id=? AND status='pending' AND delivery_status='awaiting_approval'
         AND EXISTS (SELECT 1 FROM collaboration_slack_room_links l WHERE l.tenant_id=? AND l.workspace_id=? AND l.room_id=? AND l.link_id=collaboration_slack_delivery_intents.link_id AND l.status='active' AND l.team_id=collaboration_slack_delivery_intents.team_id AND l.channel_id=collaboration_slack_delivery_intents.channel_id AND l.thread_ts=collaboration_slack_delivery_intents.thread_ts)
       RETURNING *`,
  )
    .bind(scope.userId, approvedAt, scope.tenantId, scope.workspaceId, roomId, intentId,
      scope.tenantId, scope.workspaceId, roomId)
    .first<Record<string, unknown>>();
  if (row) return rowSlackIntent(row);
  const existing = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_slack_delivery_intents WHERE tenant_id=? AND workspace_id=? AND room_id=? AND intent_id=?`,
  ).bind(scope.tenantId, scope.workspaceId, roomId, intentId).first<Record<string, unknown>>();
  return existing ? rowSlackIntent(existing) : null;
}

/** Atomically claim an approved intent only while its exact link and content still exist. */
export async function claimCollaborationSlackDeliveryIntent(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  intentId: string,
): Promise<CollaborationSlackDeliveryIntentRow | null> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_slack_delivery_intents SET delivery_status='sending'
       WHERE tenant_id=? AND workspace_id=? AND room_id=? AND intent_id=? AND status='pending' AND delivery_status='approved'
         AND EXISTS (SELECT 1 FROM collaboration_slack_room_links l WHERE l.tenant_id=? AND l.workspace_id=? AND l.room_id=? AND l.link_id=collaboration_slack_delivery_intents.link_id AND l.team_id=collaboration_slack_delivery_intents.team_id AND l.channel_id=collaboration_slack_delivery_intents.channel_id AND l.thread_ts=collaboration_slack_delivery_intents.thread_ts AND l.status='active')
         AND EXISTS (SELECT 1 FROM collaboration_messages m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.message_id=collaboration_slack_delivery_intents.message_id AND m.sender_user_id=collaboration_slack_delivery_intents.created_by_user_id AND m.sender_kind='human' AND m.source_slack_event_id IS NULL AND m.source_run_id IS NULL AND m.body=collaboration_slack_delivery_intents.content)
       RETURNING *`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, intentId,
      scope.tenantId, scope.workspaceId, roomId,
      scope.tenantId, scope.workspaceId, roomId)
    .first<Record<string, unknown>>();
  if (row) return rowSlackIntent(row);
  return null;
}

export async function isCollaborationSlackDeliverySendable(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  intentId: string,
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT 1 FROM collaboration_slack_delivery_intents i
       JOIN collaboration_slack_room_links l ON l.tenant_id=i.tenant_id AND l.workspace_id=i.workspace_id AND l.room_id=i.room_id AND l.link_id=i.link_id
       JOIN collaboration_messages m ON m.tenant_id=i.tenant_id AND m.workspace_id=i.workspace_id AND m.room_id=i.room_id AND m.message_id=i.message_id
       WHERE i.tenant_id=? AND i.workspace_id=? AND i.room_id=? AND i.intent_id=? AND i.delivery_status='sending' AND i.status='pending'
         AND l.status='active' AND l.team_id=i.team_id AND l.channel_id=i.channel_id AND l.thread_ts=i.thread_ts
         AND m.sender_user_id=i.created_by_user_id AND m.sender_kind='human' AND m.source_slack_event_id IS NULL AND m.source_run_id IS NULL AND m.body=i.content`,
  ).bind(scope.tenantId, scope.workspaceId, roomId, intentId).first();
  return Boolean(row);
}

export async function finishCollaborationSlackDeliveryIntent(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: { intentId: string; roomId: string; status: "sent" | "failed" | "unknown" | "blocked"; receiptTs?: string; detail?: string },
): Promise<boolean> {
  await ensureCollaborationSchema(env);
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_slack_delivery_intents SET delivery_status=?,receipt_ts=?,outcome_detail=?
       WHERE tenant_id=? AND workspace_id=? AND room_id=? AND intent_id=? AND delivery_status='sending'`,
  ).bind(input.status, input.receiptTs ?? null, input.detail?.slice(0, 500) ?? null,
    scope.tenantId, scope.workspaceId, input.roomId, input.intentId).run();
  return Number(result.meta?.changes ?? 0) === 1;
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
