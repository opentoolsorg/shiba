// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTaskHistoryRetryable, TaskHistory } from "./TaskHistory";

describe("TaskHistory", () => {
  afterEach(() => cleanup());

  it("shows retry lineage and calls the task-level action", () => {
    const onRetry = vi.fn();
    render(
      <TaskHistory
        tasks={[
          {
            taskId: "task-a",
            title: "Fix parser",
            updatedAt: 20,
            attempts: [
              { attempt: 1, runId: "run-old", status: "error", updatedAt: 10, error: "worker stopped" },
              { attempt: 2, approvalId: "approval-new", runId: "run-new", status: "error", updatedAt: 20, error: "retry failed" },
            ],
          },
        ]}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("2 attempts · latest error")).toBeTruthy();
    expect(screen.getByLabelText("Attempts").textContent).toContain("run-old");
    expect(screen.getByLabelText("Attempts").textContent).toContain("run-new");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith("task-a");
  });

  it("keeps unknown outcomes from exposing retry and calls cancellation for active work", () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    expect(isTaskHistoryRetryable({ attempt: 1, status: "unknown", updatedAt: 1 })).toBe(false);
    expect(isTaskHistoryRetryable({ attempt: 1, status: "error", updatedAt: 1, retryable: false })).toBe(false);
    render(
      <TaskHistory
        tasks={[
          {
            taskId: "task-b",
            title: "Uncertain task",
            updatedAt: 1,
            attempts: [{ attempt: 1, runId: "run-b", status: "unknown", updatedAt: 1 }],
          },
          {
            taskId: "task-c",
            title: "Running task",
            updatedAt: 2,
            attempts: [{ attempt: 1, runId: "run-c", status: "running", updatedAt: 2 }],
          },
        ]}
        onRetry={onRetry}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("Outcome uncertain; inspect before retrying.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledWith("task-c", 1);
  });

  it("renders the centered empty state when there are no tasks", () => {
    render(<TaskHistory tasks={[]} />);
    expect(screen.getByText("No task attempts yet.")).toBeTruthy();
    expect(screen.queryByText(/Add a task above/)).toBeNull();
  });

  it("renders loading state", () => {
    render(<TaskHistory tasks={[]} loading={true} />);
    expect(screen.getByText("Loading tasks…")).toBeTruthy();
  });

  it("renders error alert when error message is provided", () => {
    render(<TaskHistory tasks={[]} error="Failed to fetch tasks" />);
    expect(screen.getByRole("alert").textContent).toContain("Failed to fetch tasks");
  });

  it("renders compact task row with status icon, title, muted meta and open action", () => {
    const onSelectRun = vi.fn();
    render(
      <TaskHistory
        tasks={[
          {
            taskId: "task-1",
            title: "Deploy worker",
            updatedAt: 100,
            attempts: [{ attempt: 1, runId: "run-42", status: "completed", updatedAt: 100 }],
          },
        ]}
        onSelectRun={onSelectRun}
      />,
    );

    expect(screen.getByText("Deploy worker")).toBeTruthy();
    expect(screen.getByText("1 attempt · latest completed")).toBeTruthy();
    expect(screen.getByLabelText("Completed")).toBeTruthy();

    const openButton = screen.getByRole("button", { name: "Open" });
    fireEvent.click(openButton);
    expect(onSelectRun).toHaveBeenCalledWith("run-42");

    const row = screen.getByTestId("task-history-task-1");
    expect(row.className).toContain("rounded-lg");
  });

  it("gives row actions a 44px target below the lg breakpoint", () => {
    render(
      <TaskHistory
        tasks={[{ taskId: "task-1", title: "Deploy worker", updatedAt: 100, attempts: [{ attempt: 1, runId: "run-42", status: "completed", updatedAt: 100 }] }]}
        onSelectRun={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Open" }).className).toContain("max-lg:min-h-11");
  });
});
