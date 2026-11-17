/** Workspace invalidations and minimal entity patches, filtered by server-owned audiences. */
export interface WorkspaceEventAudience {
  userIds?: string[];
  roomId?: string;
}

export interface WorkspaceEvent {
  id: string;
  workspaceId: string;
  kind: string;
  entityId: string;
  at: number;
  payload?: Record<string, unknown>;
  audience?: WorkspaceEventAudience;
}

export const workspaceEventsPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/events`;

/** Board fields shared by task events; note text, context and activity stay on HTTP. */
export interface WorkspaceTaskPatch {
  id: string;
  workspaceId: string;
  title: string;
  status: "backlog" | "todo" | "in-progress" | "in-review" | "done" | "cancelled";
  priority: "none" | "low" | "medium" | "high" | "urgent";
  ownerId: string | null;
  reviewerId: string | null;
  startDate: string | null;
  endDate: string | null;
  parentId: string | null;
  blocked: boolean;
  archived: boolean;
  updatedAt: number;
  version: number;
}

/** Native human message fields; external-source messages use authorized HTTP reads. */
export interface WorkspaceMessagePatch {
  messageId: string;
  senderUserId: string;
  senderActorId: string;
  senderKind: "human";
  body: string;
  createdAt: number;
  threadRootId: string | null;
}
