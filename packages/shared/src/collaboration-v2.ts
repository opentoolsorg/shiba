/** Wire types for WS05 multiplayer chat (channels, DMs, reactions, notifications). */
export const COLLAB_ROOM_KINDS = ["room", "channel", "dm"] as const;
export type CollabRoomKind = (typeof COLLAB_ROOM_KINDS)[number];

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
  slackImportChannelId: string | null;
  createdByUserId: string;
  createdAt: number;
  unreadCount: number;
  lastMessageSeq: number;
}

export interface CollabReactionToggle {
  roomId: string;
  messageId: string;
  emoji: string;
  added: boolean;
}

export interface CollabReadCursor {
  roomId: string;
  threadRootMessageId?: string;
  lastReadSeq: number;
  updatedAt: number;
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