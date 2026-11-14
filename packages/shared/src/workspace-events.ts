/** Browser-facing shape of the WorkspaceEvents Durable Object frames. */
export interface WorkspaceEventMessage {
  type: string;
  resourceId: string;
  version: number;
  at: number;
}

export const workspaceEventsPath = (workspaceId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/events`;