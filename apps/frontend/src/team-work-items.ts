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
  status:
    | "backlog"
    | "todo"
    | "in-progress"
    | "in-review"
    | "done"
    | "queued"
    | "needs-approval"
    | "running"
    | "completed"
    | "blocked"
    | "cancelled"
    | "unknown";
  updatedAt: number;
  runId?: string;
  approvalRequired?: boolean;
  /** Current-viewer permission projected by the server; this UI never decides approvals. */
  viewerCanApprove?: boolean;
  /** False when the authorized source or result is no longer available. */
  resultAvailable?: boolean;
  priority?: TeamWorkPriority;
  ownerId?: string;
  reviewerId?: string;
  startDate?: string;
  endDate?: string;
  parentId?: string;
  blocked?: boolean;
  objective?: string;
  waitingOn?: string[];
  context?: string[];
  doneWhen?: string[];
  activity?: TeamWorkActivity[];
  archived?: boolean;
}

export type TeamWorkPriority = "none" | "low" | "medium" | "high" | "urgent";

export interface TeamWorkActivity {
  id: string;
  at: number;
  actorId?: string;
  kind: "comment" | "change" | "created";
  text: string;
}

export type TeamWorkFilter = "all" | "assigned" | "needs-you";

export function isTeamWorkAssignedToViewer(task: TeamWorkItem, currentActorId?: string): boolean {
  return Boolean(
    currentActorId && task.assigneeKind === "human" && task.assigneeActorId === currentActorId,
  );
}

export function teamWorkNeedsViewer(task: TeamWorkItem): boolean {
  return (
    task.status === "needs-approval" &&
    task.approvalRequired === true &&
    task.viewerCanApprove === true
  );
}

/** Reject stale workspace rows before rendering, including during navigation fetches. */
export function selectTeamWorkItems(
  items: readonly TeamWorkItem[],
  workspaceId: string,
  filter: TeamWorkFilter,
  currentActorId?: string,
): TeamWorkItem[] {
  return items
    .filter(
      (task) =>
        task.workspaceId === workspaceId &&
        (filter === "assigned"
          ? isTeamWorkAssignedToViewer(task, currentActorId)
          : filter === "needs-you"
            ? teamWorkNeedsViewer(task)
            : true),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}
