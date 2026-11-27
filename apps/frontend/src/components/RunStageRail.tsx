import type { JSX } from "react";
import { statusLabel } from "../ui-helpers";

export type StageState = "done" | "current" | "upcoming" | "blocked";
export interface RunStage {
  label: string;
  state: StageState;
  note: string;
}
/** Recorded approval outcome; `undefined` means no approval is recorded and none is assumed. */
export type StageApproval = "approved" | "rejected" | "waiting";

const DOT: Record<StageState, string> = {
  done: "bg-[var(--success)]",
  current: "bg-[var(--warning)]",
  upcoming: "bg-[var(--muted-foreground-3)]",
  blocked: "bg-[var(--destructive)]",
};

/** Maps recorded approval and run status to the Task brief → Review → Execution → Results rail. */
export function runStages({ approval, runStatus, queued = false }: { approval?: StageApproval; runStatus?: string; queued?: boolean }): RunStage[] {
  const approvalStage: Omit<RunStage, "label"> =
    approval === "approved" ? { state: "done", note: "Approved" }
    : approval === "rejected" ? { state: "blocked", note: "Rejected" }
    : approval === "waiting" ? { state: "current", note: "Waiting for you" }
    : { state: "upcoming", note: "Not recorded" };
  const execution: Omit<RunStage, "label"> = runStatus
    ? runStatus === "completed" ? { state: "done", note: "Completed" }
      : runStatus === "running" || runStatus === "pending" ? { state: "current", note: statusLabel(runStatus) }
      : { state: "blocked", note: statusLabel(runStatus) }
    : queued ? { state: "current", note: "Queued" }
    : { state: "upcoming", note: approval === "rejected" ? "Will not run" : "Not started" };
  return [
    { label: "Task brief", state: "done", note: "Recorded" },
    { label: "Review", ...approvalStage },
    { label: "Execution", ...execution },
    runStatus === "completed" ? { label: "Results", state: "done", note: "Ready to review" } : { label: "Results", state: "upcoming", note: "After execution" },
  ];
}

/** Read-only stage rail; every state is also spelled out as text. */
export function RunStageRail({ stages, className = "" }: { stages: readonly RunStage[]; className?: string }): JSX.Element {
  return (
    <ol aria-label="Request progress" className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ${className}`.trim()}>
      {stages.map((stage, index) => (
        <li key={stage.label} aria-current={stage.state === "current" ? "step" : undefined} className="flex items-center gap-1.5">
          {index ? <span aria-hidden="true" className="text-[var(--muted-foreground-3)]">→</span> : null}
          <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[stage.state]}`} />
          <span className="font-medium">{stage.label}</span>
          <span className="text-[var(--muted-foreground-2)]">{stage.note}</span>
        </li>
      ))}
    </ol>
  );
}
