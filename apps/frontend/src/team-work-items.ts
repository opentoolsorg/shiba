/** A membership-authorized projection of shared handoffs, never personal history. */
export interface TeamWorkItem {
  id: string;
  workspaceId: string;
  roomId: string;
  roomTitle: string;
  title: string;
  assigneeUserId?: string;
  assigneeActorId?: string;
  assigneeKind: "human" | "agent";
  assigneeName?: string;
  status: "queued" | "needs-approval" | "running" | "completed" | "blocked" | "cancelled" | "unknown";
  updatedAt: number;
  runId?: string;
  approvalRequired?: boolean;
  /** Current-viewer permission projected by the server; this UI never decides approvals. */
  viewerCanApprove?: boolean;
  /** False when the authorized source or result is no longer available. */
  resultAvailable?: boolean;
}

export type TeamWorkFilter = "all" | "assigned" | "needs-you";

export function isTeamWorkAssignedToViewer(task: TeamWorkItem, currentActorId?: string): boolean {
  return Boolean(currentActorId && task.assigneeKind === "human" && task.assigneeActorId === currentActorId);
}

export function teamWorkNeedsViewer(task: TeamWorkItem): boolean {
  return task.status === "needs-approval" && task.approvalRequired === true && task.viewerCanApprove === true;
}

/** Reject stale workspace rows before rendering, including during navigation fetches. */
export function selectTeamWorkItems(items: readonly TeamWorkItem[], workspaceId: string, filter: TeamWorkFilter, currentActorId?: string): TeamWorkItem[] {
  return items.filter((task) => task.workspaceId === workspaceId && (
    filter === "assigned" ? isTeamWorkAssignedToViewer(task, currentActorId) : filter === "needs-you" ? teamWorkNeedsViewer(task) : true
  )).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
