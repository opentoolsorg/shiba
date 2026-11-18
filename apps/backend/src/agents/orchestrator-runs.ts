import { RunStore } from "../runs.js";
import type { RunCommand, RunDecision } from "@shiba/shared";
import {
  createDurableTask,
  frozenTaskInputFromApproval,
  type DurableTask,
} from "../task-attempts.js";
import type { PendingApproval } from "../pending-approvals.js";
import type { OrchestratorState } from "./orchestrator.js";

export class OrchestratorRuns {
  constructor(
    private readonly read: () => OrchestratorState,
    private readonly write: (state: OrchestratorState) => void,
    private readonly tap: (command: RunCommand, decision: RunDecision) => void,
    private readonly ownerId: () => string,
  ) {}

  get store(): RunStore {
    return new RunStore(
      () => this.read()?.runs ?? [],
      (runs) => this.write({ ...this.read(), runs }),
      this.tap,
    );
  }

  taskForApproval(approval: PendingApproval): DurableTask {
    return createDurableTask({
      taskId: `task_${approval.approvalId}`,
      ownerId: this.ownerId() ?? "default",
      ...(approval.queuedBy ? { queuedBy: approval.queuedBy } : {}),
      title: approval.task,
      commandId: `approval:${approval.approvalId}`,
      approvalId: approval.approvalId,
      frozen: frozenTaskInputFromApproval(approval),
      now: approval.createdAt,
    });
  }

  task(taskId: string): DurableTask | undefined {
    return (this.read()?.tasks ?? []).find((candidate) => candidate.taskId === taskId);
  }

  storeTask(task: DurableTask): void {
    const state = this.read();
    const current = state?.tasks ?? [];
    this.write({
      ...state,
      tasks: current.some((candidate) => candidate.taskId === task.taskId)
        ? current.map((candidate) => (candidate.taskId === task.taskId ? task : candidate))
        : [...current, task].slice(-300),
    });
  }
}
