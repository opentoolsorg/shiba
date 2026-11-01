import { onboardingRunFields } from "@shiba/shared";
/** Durable logical-task lineage projected over the existing run registry.
 * A task is the stable conversation + frozen request identity; each attempt
 * owns a fresh approval and run ID. Legacy retained runs become one-attempt
 * tasks on read and remain fully compatible with the /api/runs contract.
 */
import { runInputHash, type DelegatedRun, type PendingApproval, type RunInputFields } from "@shiba/shared";

export type TaskAttemptStatus =
  | "submitting" | "pending_approval" | "pending" | "running" | "completed"
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

export interface ArtifactRevisionSource {
  taskId: string;
  runId: string;
  artifactId: string;
  artifactVersion: number;
  reviewRevision?: number;
  path: string;
}

export interface DurableTask {
  taskId: string;
  /** Root task identity retained across explicit artifact revision tasks. */
  artifactLineageId?: string;
  revisionOf?: ArtifactRevisionSource;
  ownerId: string;
  queuedBy?: string;
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
  return !attempt.commandId.startsWith("legacy:") && typeof attempt.frozen.body.repoUrl === "string" &&
    TERMINAL.has(attempt.status) && attempt.status !== "completed" && attempt.status !== "unknown";
}

export function createDurableTask(input: {
  taskId: string;
  artifactLineageId?: string;
  revisionOf?: ArtifactRevisionSource;
  ownerId: string;
  queuedBy?: string;
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
    artifactLineageId: input.artifactLineageId ?? input.taskId,
    ...(input.revisionOf ? { revisionOf: structuredClone(input.revisionOf) } : {}),
    ownerId: input.ownerId,
    ...(input.queuedBy ? { queuedBy: input.queuedBy } : {}),
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
export function legacyTaskForRun(run: DelegatedRun, ownerId = "legacy"): DurableTask {
  const inputHash = run.approval?.inputHash ?? `legacy:${run.runId}`;
  return {
    taskId: `legacy:${run.runId}`,
    ownerId,
    ...(run.queuedBy ? { queuedBy: run.queuedBy } : {}),
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

export function taskVisibleToPrincipal(task: DurableTask, principal: string | null): boolean {
  return principal === null || task.queuedBy === principal;
}

/** Freeze the same post-default input hash that the run approval gate checks. */
export function frozenTaskInputFromApproval(approval: PendingApproval): FrozenTaskInput {
  const input: RunInputFields = {
    ...onboardingRunFields(approval),
    repoUrl: approval.repoUrl,
    ...(approval.executionTarget !== undefined ? { executionTarget: approval.executionTarget } : {}),
    task: approval.task,
    baseBranch: approval.baseBranch ?? "main",
    publishPullRequest: approval.publishPullRequest ?? false,
    ...(approval.reviewAfterPublish !== undefined ? { reviewAfterPublish: approval.reviewAfterPublish } : {}),
    ...(approval.route !== undefined ? { route: approval.route } : {}),
    ...(approval.authAccount !== undefined ? { authAccount: approval.authAccount } : {}),
    ...(approval.runtime !== undefined ? { runtime: approval.runtime } : {}),
    ...(approval.targetMachineId !== undefined ? { targetMachineId: approval.targetMachineId } : {}),
    ...(approval.testCommand !== undefined ? { testCommand: approval.testCommand } : {}),
    ...(approval.expectedDeliverables !== undefined ? { expectedDeliverables: approval.expectedDeliverables } : {}),
    ...(approval.forkedFrom !== undefined ? { forkedFrom: approval.forkedFrom } : {}),
    ...(approval.parentRunId !== undefined ? { parentRunId: approval.parentRunId } : {}),
    ...(approval.subagentPath !== undefined ? { subagentPath: approval.subagentPath } : {}),
    ...(approval.subagentSandbox !== undefined ? { subagentSandbox: approval.subagentSandbox } : {}),
    ...(approval.captainId !== undefined ? { captainId: approval.captainId } : {}),
    ...(approval.denId !== undefined ? { denId: approval.denId } : {}),
    ...(approval.sandboxProvider !== undefined ? { sandboxProvider: approval.sandboxProvider } : {}),
    ...(approval.customAgentId !== undefined ? { customAgentId: approval.customAgentId } : {}),
    ...(approval.envNames !== undefined ? { envNames: approval.envNames } : {}),
    ...(approval.envDigest !== undefined ? { envDigest: approval.envDigest } : {}),
    ...(approval.runSetup === true ? { runSetup: true } : {}),
    ...(approval.customAgentVersion !== undefined ? { customAgentVersion: approval.customAgentVersion } : {}),
    ...(approval.employeeToolPolicyVersion !== undefined
      ? { employeeToolPolicyVersion: approval.employeeToolPolicyVersion }
      : {}),
    ...(approval.collaborationHandoffId !== undefined
      ? { collaborationHandoffId: approval.collaborationHandoffId }
      : {}),
    ...(approval.skillPins !== undefined ? { skillPins: approval.skillPins } : {}),
    ...(approval.role !== undefined ? { role: approval.role } : {}),
    ...(approval.subagentBudget !== undefined ? { subagentBudget: approval.subagentBudget } : {}),
  };
  return {
    body: structuredClone(approval) as unknown as Record<string, unknown>,
    inputHash: runInputHash(input),
    threadKey: approval.threadKey,
  };
}

/** Public DTO deliberately strips the sealed run environment and frozen body. */
export function taskHistoryDto(task: DurableTask): Omit<DurableTask, "attempts" | "ownerId" | "queuedBy"> & {
  attempts: (Omit<TaskAttempt, "frozen" | "commandId"> & { retryable: boolean })[];
} {
  return {
    taskId: task.taskId,
    title: task.title,
    ...(task.revisionOf ? { revisionOf: structuredClone(task.revisionOf) } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    attempts: task.attempts.map(({ frozen, commandId, ...attempt }) => ({
      ...attempt,
      retryable: canRetryTaskAttempt({ ...attempt, frozen, commandId }),
    })),
  };
}

export function mergeTaskLineage(
  durable: DurableTask[],
  runs: DelegatedRun[],
  ownerId = "legacy",
): DurableTask[] {
  const seenRunIds = new Set(durable.flatMap((task) => task.attempts.map((attempt) => attempt.runId).filter((id): id is string => Boolean(id))));
  const seenApprovalIds = new Set(durable.flatMap((task) => task.attempts.map((attempt) => attempt.approvalId).filter((id): id is string => Boolean(id))));
  const legacy = runs
    .filter((run) => !seenRunIds.has(run.runId) && !(run.approval?.approvalId && seenApprovalIds.has(run.approval.approvalId)))
    .map((run) => legacyTaskForRun(run, ownerId));
  return [...durable, ...legacy].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Resolve the stable task family for a run without requiring polling first. */
export function artifactLineageForRun(tasks: readonly DurableTask[], run: DelegatedRun): string | undefined {
  const approvalId = run.approval?.approvalId;
  const task = tasks.find((candidate) => candidate.attempts.some((attempt) =>
    attempt.runId === run.runId || (approvalId !== undefined && attempt.approvalId === approvalId),
  ));
  return task ? (task.artifactLineageId ?? task.taskId) : undefined;
}
