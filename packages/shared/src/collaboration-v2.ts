/** Wire types for multiplayer channels, direct messages, and task threads. */
export const COLLAB_ROOM_KINDS = ["room", "channel", "dm"] as const;
export type CollabRoomKind = (typeof COLLAB_ROOM_KINDS)[number];

export const TASK_THREAD_STATUSES = ["open", "needs_you", "working", "done"] as const;
export type TaskThreadStatus = (typeof TASK_THREAD_STATUSES)[number];

export const TASK_REPLY_ROLES = ["progress", "result", "handoff", "approval"] as const;
export type TaskReplyRole = (typeof TASK_REPLY_ROLES)[number];

export interface CollabV2Room {
  roomId: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  visibility: "private" | "shared";
  kind: CollabRoomKind;
  topic: string | null;
  isPrivate: boolean;
  dmKey: string | null;
  createdByUserId: string;
  createdAt: number;
  unreadCount: number;
  lastMessageSeq: number;
}

export interface TaskThread {
  taskId: string;
  roomId: string;
  rootMessageId: string;
  title: string;
  ownerUserId: string;
  ownerActorId: string;
  status: TaskThreadStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CollabReactionToggle {
  roomId: string;
  messageId: string;
  emoji: string;
  added: boolean;
}

export interface WorkspaceNotification {
  notificationId: string;
  kind: string;
  title: string;
  body: string;
  roomId?: string | null;
  messageId?: string | null;
  readAt?: number | null;
  createdAt: number;
}

export interface WorkspaceNotificationPrefs {
  mentions: boolean;
  threadReplies: boolean;
  agentApprovals: boolean;
}

export type SlackImportJobStatus = "pending" | "running" | "completed" | "cancelled" | "failed";

export interface SlackImportJob {
  jobId: string;
  roomId: string;
  slackTeamId: string;
  slackChannelId: string;
  status: SlackImportJobStatus;
  importedCount: number;
  cursorTs?: string | null;
}
