import { describe, expect, it } from "vitest";
import {
  appendTaskAttempt,
  artifactLineageForRun,
  canRetryTaskAttempt,
  cancelTaskAttempt,
  createDurableTask,
  legacyTaskForRun,
  mergeTaskLineage,
  taskVisibleTo,
  taskHistoryDto,
  updateTaskAttempt,
} from "../src/task-attempts.js";

const frozen = { body: { task: "ship it", repoUrl: "https://github.com/o/r" }, inputHash: "frozen-hash", threadKey: "web:user:abc" };
const task = () => createDurableTask({ taskId: "task-1", ownerId: "user-1", title: "ship it", commandId: "task-1:1", approvalId: "approval-1", frozen, now: 1 });

describe("durable task attempts", () => {
  it("keeps retry lineage, conversation, and approved input immutable", () => {
    const failed = updateTaskAttempt(task(), 1, { runId: "run-1", status: "error", error: "temporary failure", updatedAt: 5 });
    const retried = appendTaskAttempt(failed, { commandId: "task-1:2", approvalId: "approval-2", frozen, now: 6 });
    expect(retried.attempts.map(({ runId, approvalId, attempt }) => ({ runId, approvalId, attempt }))).toEqual([
      { runId: "run-1", approvalId: "approval-1", attempt: 1 },
      { runId: undefined, approvalId: "approval-2", attempt: 2 },
    ]);
    expect(retried.attempts[1]?.frozen).toEqual(retried.attempts[0]?.frozen);
    expect(retried.attempts[1]?.frozen).not.toBe(retried.attempts[0]?.frozen);
  });

  it("deduplicates a retry command and rejects changed identity", () => {
    const failed = updateTaskAttempt(task(), 1, { runId: "run-1", status: "error", updatedAt: 2 });
    const once = appendTaskAttempt(failed, { commandId: "task-1:2", approvalId: "approval-2", frozen, now: 3 });
    expect(appendTaskAttempt(once, { commandId: "task-1:2", approvalId: "approval-2b", frozen, now: 4 })).toBe(once);
    expect(() => appendTaskAttempt(failed, { commandId: "task-1:2", approvalId: "approval-2", frozen: { ...frozen, inputHash: "changed" }, now: 3 })).toThrow(/identity/);
    expect(() => appendTaskAttempt(failed, { commandId: "task-1:2", approvalId: "approval-2", frozen: { ...frozen, threadKey: "other" }, now: 3 })).toThrow(/conversation/);
  });

  it("does not automatically retry indeterminate work or successful attempts", () => {
    const current = task().attempts[0];
    if (!current) throw new Error("Expected initial attempt.");
    expect(canRetryTaskAttempt({ ...current, status: "unknown" })).toBe(false);
    expect(canRetryTaskAttempt({ ...current, status: "completed" })).toBe(false);
    expect(canRetryTaskAttempt({ ...current, status: "cancelled" })).toBe(true);
  });

  it("fences cancellation against late completion updates", () => {
    const cancelled = cancelTaskAttempt(task(), 1, 10);
    expect(cancelled.attempts[0]?.status).toBe("cancelled");
    const late = updateTaskAttempt(cancelled, 1, { runId: "run-late", status: "completed", updatedAt: 20 });
    expect(late).toBe(cancelled);
  });

  it("reloads serialized data and projects legacy runs without renaming run IDs", () => {
    const saved = JSON.parse(JSON.stringify(task()));
    const reloaded = appendTaskAttempt(updateTaskAttempt(saved, 1, { runId: "run-1", status: "error", updatedAt: 5 }), {
      commandId: "task-1:2", approvalId: "approval-2", frozen, now: 6,
    });
    expect(reloaded.attempts).toHaveLength(2);
    const run = { runId: "legacy-run", task: "old", status: "completed", createdAt: 1, updatedAt: 2 } as never;
    const legacy = legacyTaskForRun(run);
    expect(legacy.taskId).toBe("legacy:legacy-run");
    expect(mergeTaskLineage([reloaded], [run])).toHaveLength(2);
    expect(mergeTaskLineage([reloaded], [{ ...(run as object), runId: "run-1" } as never])).toHaveLength(1);
    expect(taskVisibleTo(reloaded, "user-1")).toBe(true);
    expect(taskVisibleTo(reloaded, "user-2")).toBe(false);
  });

  it("retains root artifact lineage and exposes the revision source after serialization", () => {
    const revisionOf = { taskId: "task-1", runId: "run-1", artifactId: "artifact_abc", artifactVersion: 2, path: "report.md" };
    const revision = createDurableTask({
      taskId: "task-revision", artifactLineageId: "task-1", revisionOf,
      ownerId: "user-1", title: "Revise report", commandId: "artifact-revision:cmd-1234",
      approvalId: "approval-new", frozen: { ...frozen, body: { ...frozen.body, task: "Revise report" } }, now: 10,
    });
    const serialized = JSON.parse(JSON.stringify(revision));
    expect(serialized.artifactLineageId).toBe("task-1");
    expect(taskHistoryDto(serialized).revisionOf).toEqual(revisionOf);
    expect(artifactLineageForRun([serialized], { runId: "run-new", approval: { approvalId: "approval-new" } } as never)).toBe("task-1");
    // Pre-delta task rows have no explicit root field; taskId is the migration default.
    expect(artifactLineageForRun([{ ...serialized, taskId: "task-old", artifactLineageId: undefined }], { runId: "run-new", approval: { approvalId: "approval-new" } } as never)).toBe("task-old");
  });
});
