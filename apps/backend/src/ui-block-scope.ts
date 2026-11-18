const TASK_SEPARATOR = ":ui-task:";

export function uiBlockRunId(threadId: string, taskId: string): string {
  return `${threadId}${TASK_SEPARATOR}${encodeURIComponent(taskId)}`;
}

export function uiBlockThreadId(runId: string): string {
  const separator = runId.lastIndexOf(TASK_SEPARATOR);
  return separator < 0 ? runId : runId.slice(0, separator);
}
