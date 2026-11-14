/** Invalidation frames on the WorkspaceEvents Durable Object. Payloads are ids and counts only. */
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