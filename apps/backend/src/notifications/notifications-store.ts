import { ensureCollabV2Migrated } from "../collaboration-v2-store.js";
import type { Env } from "../env.js";
import { randomHex } from "../mailbox-store.js";

export class NotificationsStoreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "NotificationsStoreError";
  }
}

export interface WorkspaceNotificationRow {
  notificationId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  roomId: string | null;
  messageId: string | null;
  readAt: number | null;
  createdAt: number;
  metadata: Record<string, unknown>;
}

function rowNotification(row: Record<string, unknown>): WorkspaceNotificationRow {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    notificationId: String(row.notification_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    kind: String(row.kind),
    title: String(row.title),
    body: String(row.body ?? ""),
    roomId: typeof row.room_id === "string" ? row.room_id : null,
    messageId: typeof row.message_id === "string" ? row.message_id : null,
    readAt: row.read_at === null || row.read_at === undefined ? null : Number(row.read_at),
    createdAt: Number(row.created_at),
    metadata,
  };
}

export async function createWorkspaceNotification(
  env: Pick<Env, "AGENT_AUDIT">,
  input: {
    tenantId: string;
    workspaceId: string;
    userId: string;
    kind: string;
    title: string;
    body?: string;
    roomId?: string;
    messageId?: string;
    metadata?: Record<string, unknown>;
    createdAt: number;
    notificationId?: string;
  },
): Promise<WorkspaceNotificationRow> {
  await ensureCollabV2Migrated(env);
  const notificationId = input.notificationId ?? `ntf_${randomHex(12)}`;
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO workspace_notifications (notification_id,tenant_id,workspace_id,user_id,kind,title,body,room_id,message_id,created_at,metadata_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      notificationId,
      input.tenantId,
      input.workspaceId,
      input.userId.trim().toLowerCase(),
      input.kind,
      input.title.slice(0, 240),
      (input.body ?? "").slice(0, 4_000),
      input.roomId ?? null,
      input.messageId ?? null,
      input.createdAt,
      JSON.stringify(input.metadata ?? {}),
    )
    .run();
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT * FROM workspace_notifications WHERE notification_id=?",
  )
    .bind(notificationId)
    .first<Record<string, unknown>>();
  if (!row) throw new NotificationsStoreError("Notification could not be stored.", 503);
  return rowNotification(row);
}

export async function listWorkspaceNotifications(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: { tenantId: string; workspaceId: string; userId: string },
  limit = 100,
): Promise<WorkspaceNotificationRow[]> {
  await ensureCollabV2Migrated(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM workspace_notifications WHERE tenant_id=? AND workspace_id=? AND user_id=?
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId, limit)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(rowNotification);
}

export async function markWorkspaceNotificationRead(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: { tenantId: string; workspaceId: string; userId: string },
  notificationId: string,
  readAt: number,
): Promise<boolean> {
  await ensureCollabV2Migrated(env);
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE workspace_notifications SET read_at=? WHERE notification_id=? AND tenant_id=? AND workspace_id=? AND user_id=? AND read_at IS NULL`,
  )
    .bind(readAt, notificationId, scope.tenantId, scope.workspaceId, scope.userId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export interface WorkspaceNotificationPrefs {
  mentions: boolean;
  threadReplies: boolean;
  agentApprovals: boolean;
}

const DEFAULT_PREFS: WorkspaceNotificationPrefs = {
  mentions: true,
  threadReplies: true,
  agentApprovals: true,
};

export async function getWorkspaceNotificationPrefs(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: { tenantId: string; workspaceId: string; userId: string },
): Promise<WorkspaceNotificationPrefs> {
  await ensureCollabV2Migrated(env);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT prefs_json FROM workspace_notification_prefs WHERE tenant_id=? AND workspace_id=? AND user_id=?",
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId)
    .first<{ prefs_json: string }>();
  if (!row) return { ...DEFAULT_PREFS };
  try {
    const parsed = JSON.parse(row.prefs_json) as Partial<WorkspaceNotificationPrefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function setWorkspaceNotificationPrefs(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: { tenantId: string; workspaceId: string; userId: string },
  prefs: Partial<WorkspaceNotificationPrefs>,
  updatedAt: number,
): Promise<WorkspaceNotificationPrefs> {
  await ensureCollabV2Migrated(env);
  const merged = { ...(await getWorkspaceNotificationPrefs(env, scope)), ...prefs };
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO workspace_notification_prefs (tenant_id,workspace_id,user_id,prefs_json,updated_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(tenant_id,workspace_id,user_id) DO UPDATE SET prefs_json=excluded.prefs_json, updated_at=excluded.updated_at`,
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId, JSON.stringify(merged), updatedAt)
    .run();
  return merged;
}