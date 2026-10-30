/** Durable logical-task lineage projected over the existing run registry.
 * A task is the stable conversation + frozen request identity; each attempt
 * owns a fresh approval and run ID. Legacy retained runs become one-attempt
 * tasks on read and remain fully compatible with the /api/runs contract.
 */
import type { DelegatedRun } from "@shiba/shared";

export type TaskAttemptStatus =
  | "submitting" | "pending_approval" | "running" | "completed"
  | "error" | "aborted" | "cancelled" | "unknown" | "rejected" | "expired";

export interface FrozenTaskInput {
  /** Exact allowlisted queue body after profile and skill resolution. */
  body: Record<string, unknown>;
  /** Immutable approval input fingerprint from the existing approval gate. */
  inputHash: string;
  /** Stable owning conversation key used by the existing approval route. */
  threadKey: string;
}

export interface TaskAttempt {
  attempt: number;
  commandId: string;
  approvalId?: string;
  runId?: string;
  status: TaskAttemptStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  frozen: FrozenTaskInput;
}

export interface DurableTask {
  taskId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  attempts: TaskAttempt[];
}

export interface TaskRunView {
  runId: string;
  status: TaskAttemptStatus;
  error?: string;
  updatedAt: number;
}

const TERMINAL = new Set<TaskAttemptStatus>([
  "completed", "error", "aborted", "cancelled", "unknown", "rejected", "expired",
]);

export function canRetryTaskAttempt(attempt: TaskAttempt): boolean {
  // `unknown` means the executor may have performed side effects. Replaying
  // it risks duplicate external writes, so it must be inspected manually.
  return TERMINAL.has(attempt.status) && attempt.status !== "completed" && attempt.status !== "unknown";
}

export function createDurableTask(input: {
  taskId: string;
  ownerId: string;
  title: string;
  commandId: string;
  approvalId?: string;
  frozen: FrozenTaskInput;
  now: number;
}): DurableTask {
  if (!input.taskId || !input.ownerId || !input.commandId || !input.frozen.inputHash || !input.frozen.threadKey) {
    throw new Error("Task identity and frozen approval are required.");
  }
  const attempt: TaskAttempt = {
    attempt: 1,
    commandId: input.commandId,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    status: "pending_approval",
    createdAt: input.now,
    updatedAt: input.now,
    frozen: structuredClone(input.frozen),
  };
  return {
    taskId: input.taskId,
    ownerId: input.ownerId,
    title: input.title.slice(0, 240),
    createdAt: input.now,
    updatedAt: input.now,
    attempts: [attempt],
  };
}

export function appendTaskAttempt(
  task: DurableTask,
  input: { commandId: string; approvalId: string; frozen: FrozenTaskInput; now: number },
): DurableTask {
  const previous = task.attempts.at(-1);
  if (task.attempts.some((attempt) => attempt.commandId === input.commandId)) return task;
  if (!previous || !canRetryTaskAttempt(previous)) throw new Error("Task attempt is not safely retryable.");
  if (input.frozen.inputHash !== previous.frozen.inputHash || input.frozen.threadKey !== previous.frozen.threadKey) {
    throw new Error("Retry changed the approved input identity or conversation.");
  }
  const nextNumber = previous.attempt + 1;
  return {
    ...task,
    updatedAt: input.now,
    attempts: [...task.attempts, {
      attempt: nextNumber,
      commandId: input.commandId,
      approvalId: input.approvalId,
      status: "pending_approval",
      createdAt: input.now,
      updatedAt: input.now,
      frozen: structuredClone(input.frozen),
    }],
  };
}

export function updateTaskAttempt(
  task: DurableTask,
  attemptNo: number,
  update: TaskRunView,
): DurableTask {
  const current = task.attempts.find((attempt) => attempt.attempt === attemptNo);
  if (!current || TERMINAL.has(current.status)) return task;
  return {
    ...task,
    updatedAt: Math.max(task.updatedAt, update.updatedAt),
    attempts: task.attempts.map((attempt) => attempt.attempt !== attemptNo ? attempt : {
      ...attempt,
      runId: update.runId,
      status: update.status,
      updatedAt: update.updatedAt,
      ...(update.error ? { error: update.error.slice(0, 500) } : {}),
    }),
  };
}

/** A cancellation acknowledgement is a fence against a late executor update. */
export function cancelTaskAttempt(task: DurableTask, attemptNo: number, now: number): DurableTask {
  const current = task.attempts.find((attempt) => attempt.attempt === attemptNo);
  if (!current || TERMINAL.has(current.status)) return task;
  return {
    ...task,
    updatedAt: Math.max(task.updatedAt, now),
    attempts: task.attempts.map((attempt) => attempt.attempt !== attemptNo ? attempt : {
      ...attempt,
      status: "cancelled",
      updatedAt: now,
    }),
  };
}

/** A read-only compatibility projection for pre-lineage runs. */
export function legacyTaskForRun(run: DelegatedRun): DurableTask {
  const inputHash = run.approval?.inputHash ?? `legacy:${run.runId}`;
  return {
    taskId: `legacy:${run.runId}`,
    ownerId: run.queuedBy ?? "legacy",
    title: run.task.slice(0, 240),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    attempts: [{
      attempt: 1,
      commandId: `legacy:${run.runId}`,
      approvalId: run.approval?.approvalId,
      runId: run.runId,
      status: run.status as TaskAttemptStatus,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.error ? { error: run.error.slice(0, 500) } : {}),
      frozen: { body: {}, inputHash, threadKey: run.runId },
    }],
  };
}

/** Avoid disclosing whether a task exists to a different authenticated user. */
export function taskVisibleTo(task: DurableTask, ownerId: string): boolean {
  return task.ownerId === ownerId;
}

export function mergeTaskLineage(
  durable: DurableTask[],
  runs: DelegatedRun[],
): DurableTask[] {
  const seenRunIds = new Set(durable.flatMap((task) => task.attempts.map((attempt) => attempt.runId).filter((id): id is string => Boolean(id))));
  const legacy = runs.filter((run) => !seenRunIds.has(run.runId)).map(legacyTaskForRun);
  return [...durable, ...legacy].sort((a, b) => b.updatedAt - a.updatedAt);
}
