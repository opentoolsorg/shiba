import type { JSX, ReactNode } from "react";
import type { VMRun } from "../types";
import { extractCompletedDiff, statusLabel } from "../ui-helpers";
import { DiffViewer } from "./DiffViewer";

export type WorkStepState = "done" | "current" | "todo" | "failed";

export interface WorkStep {
  id: "queued" | "approval" | "running" | "result";
  label: string;
  state: WorkStepState;
}

const STAND_IN_MARKER = /verify-shiba stand-in/;

/** Derives the visible plan for one run from its persisted status; never from client guesses. */
export class RunWorkPlan {
  constructor(private readonly run: Pick<VMRun, "status" | "summary" | "error" | "executionTarget" | "repoUrl">) {}

  steps(): WorkStep[] {
    const status = this.run.status;
    const failed = status === "error" || status === "aborted" || status === "cancelled" || status === "unknown";
    const started = status !== "pending";
    return [
      { id: "queued", label: "Task queued", state: "done" },
      { id: "approval", label: "Human approval", state: started ? "done" : "current" },
      { id: "running", label: "Working in the sandbox", state: status === "running" ? "current" : started ? (failed ? "failed" : "done") : "todo" },
      {
        id: "result",
        label: failed ? `Stopped: ${statusLabel(status)}` : "Results ready for review",
        state: status === "completed" ? "done" : failed ? "failed" : "todo",
      },
    ];
  }

  get synthetic(): boolean {
    return STAND_IN_MARKER.test(this.run.summary ?? "");
  }

  get targetLabel(): string {
    const target = this.run.executionTarget;
    if (target?.kind === "artifact-workspace") {
      return `Artifact workspace${target.workspaceName ? ` “${target.workspaceName}”` : ""} · no repository`;
    }
    return target?.kind === "repository" ? target.repoUrl : this.run.repoUrl || "Repository";
  }
}

const STEP_MARK: Record<WorkStepState, string> = { done: "✓", current: "●", todo: "○", failed: "✗" };

/** One place per run: plan, live activity, files, deliverables, and review. */
export function BotRunWorkspace({
  run,
  botName,
  children,
}: {
  run: VMRun | undefined;
  botName?: string;
  /** Live activity, deliverables, PR and review panels for this run. */
  children: ReactNode;
}): JSX.Element | null {
  if (!run) return null;
  const plan = new RunWorkPlan(run);
  const diff = extractCompletedDiff(run);
  return (
    <section
      aria-label="Run work"
      data-testid="bot-run-workspace"
      data-run-status={run.status}
      className="flex flex-col gap-3 border border-[var(--border-1)] rounded-[10px] bg-[var(--card)] p-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--fg)]">{botName ? `${botName} · work` : "Work"}</h2>
        {plan.synthetic ? (
          <span data-testid="run-synthetic-badge" className="text-xs border border-[var(--border-1)] px-2 py-0.5 rounded-[var(--radius-button)] text-[var(--muted-foreground-2)]">
            Synthetic execution — no model or container ran
          </span>
        ) : null}
      </header>
      <p className="text-xs text-[var(--muted-foreground-2)] break-all" data-testid="run-work-target">{plan.targetLabel}</p>
      <ol aria-label="Plan" className="flex flex-col gap-1 text-xs">
        {plan.steps().map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            data-state={step.state}
            aria-current={step.state === "current" ? "step" : undefined}
            className={step.state === "failed" ? "text-[var(--destructive)]" : step.state === "todo" ? "text-[var(--muted-foreground-3)]" : "text-[var(--fg)]"}
          >
            <span aria-hidden="true" className="inline-block w-4">{STEP_MARK[step.state]}</span>
            {step.label}
          </li>
        ))}
      </ol>
      {children}
      {diff ? (
        <section aria-label="Files changed" data-testid="run-files-changed" className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-[var(--fg)]">Files changed</h3>
          <DiffViewer diff={diff} runId={run.runId} />
        </section>
      ) : null}
    </section>
  );
}
