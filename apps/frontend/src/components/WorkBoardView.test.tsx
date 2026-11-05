// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveKanbanColumn,
  normalizeBoardTask,
  WorkBoardView,
  type WorkBoardTask,
} from "./WorkBoardView";
import type { TaskHistoryItem } from "./TaskHistory";

afterEach(() => {
  cleanup();
});

describe("WorkBoardView", () => {
  it("renders all 4 kanban columns with empty states when no tasks are provided", () => {
    const onOpen = vi.fn();
    render(<WorkBoardView tasks={[]} onOpen={onOpen} />);

    expect(screen.getByRole("region", { name: "Work board" })).toBeDefined();

    // Check headers and empty column text
    expect(screen.getByText("Todo")).toBeDefined();
    expect(screen.getByText("In progress")).toBeDefined();
    expect(screen.getByText("Needs approval")).toBeDefined();
    expect(screen.getByText("Done")).toBeDefined();

    expect(screen.getByText("No tasks in Todo")).toBeDefined();
    expect(screen.getByText("Nothing in progress")).toBeDefined();
    expect(screen.getByText("Nothing needs approval")).toBeDefined();
    expect(screen.getByText("No completed tasks")).toBeDefined();
  });

  it("categorizes tasks into correct kanban columns and displays counts", () => {
    const onOpen = vi.fn();
    const tasks: WorkBoardTask[] = [
      { id: "task-1", title: "Setup database", status: "pending" },
      { id: "task-2", title: "Migrate schema", status: "submitting" },
      { id: "task-3", title: "Build chat UI", status: "running" },
      { id: "task-4", title: "Deploy to staging", status: "pending_approval" },
      { id: "task-5", title: "Fix login bug", status: "completed" },
      { id: "task-6", title: "Failed run", status: "error", error: "Connection timed out" },
    ];

    render(<WorkBoardView tasks={tasks} onOpen={onOpen} />);

    // Column counts:
    // Todo: 2 (task-1, task-2)
    // In progress: 1 (task-3)
    // Needs approval: 1 (task-4)
    // Done: 2 (task-5, task-6)
    const todoCol = screen.getByTestId("kanban-column-todo");
    expect(todoCol.textContent).toContain("2");
    expect(todoCol.textContent).toContain("Setup database");
    expect(todoCol.textContent).toContain("Migrate schema");

    const inProgressCol = screen.getByTestId("kanban-column-in_progress");
    expect(inProgressCol.textContent).toContain("1");
    expect(inProgressCol.textContent).toContain("Build chat UI");

    const needsApprovalCol = screen.getByTestId("kanban-column-needs_approval");
    expect(needsApprovalCol.textContent).toContain("1");
    expect(needsApprovalCol.textContent).toContain("Deploy to staging");

    const doneCol = screen.getByTestId("kanban-column-done");
    expect(doneCol.textContent).toContain("2");
    expect(doneCol.textContent).toContain("Fix login bug");
    expect(doneCol.textContent).toContain("Failed run");
    expect(doneCol.textContent).toContain("Connection timed out");
  });

  it("calls onOpen with the task id when a card is clicked", () => {
    const onOpen = vi.fn();
    const tasks: WorkBoardTask[] = [
      { id: "run-99", title: "Add auth tokens", status: "running" },
    ];

    render(<WorkBoardView tasks={tasks} onOpen={onOpen} />);

    const card = screen.getByTestId("board-card-run-99");
    fireEvent.click(card);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("run-99");
  });

  it("calls onOpen when pressing Enter or Space on a task card", () => {
    const onOpen = vi.fn();
    const tasks: WorkBoardTask[] = [
      { id: "run-100", title: "Keyboard navigation test", status: "pending" },
    ];

    render(<WorkBoardView tasks={tasks} onOpen={onOpen} />);

    const card = screen.getByTestId("board-card-run-100");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("run-100");

    fireEvent.keyDown(card, { key: " " });
    expect(onOpen).toHaveBeenCalledWith("run-100");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("supports TaskHistoryItem format seamlessly", () => {
    const onOpen = vi.fn();
    const historyTasks: TaskHistoryItem[] = [
      {
        taskId: "th-1",
        title: "History task approval",
        updatedAt: Date.now() - 60000,
        attempts: [
          {
            attempt: 1,
            status: "pending_approval",
            updatedAt: Date.now() - 60000,
          },
        ],
      },
      {
        taskId: "th-2",
        title: "History task done",
        updatedAt: Date.now() - 120000,
        attempts: [
          {
            attempt: 1,
            status: "completed",
            updatedAt: Date.now() - 120000,
          },
        ],
      },
    ];

    render(<WorkBoardView tasks={historyTasks} onOpen={onOpen} />);

    expect(screen.getByTestId("board-card-th-1")).toBeDefined();
    expect(screen.getByTestId("board-card-th-2")).toBeDefined();

    const needsApprovalCol = screen.getByTestId("kanban-column-needs_approval");
    expect(needsApprovalCol.textContent).toContain("History task approval");

    const doneCol = screen.getByTestId("kanban-column-done");
    expect(doneCol.textContent).toContain("History task done");

    fireEvent.click(screen.getByTestId("board-card-th-1"));
    expect(onOpen).toHaveBeenCalledWith("th-1");
  });
});

describe("deriveKanbanColumn", () => {
  it("maps statuses to expected columns", () => {
    expect(deriveKanbanColumn("pending")).toBe("todo");
    expect(deriveKanbanColumn("submitting")).toBe("todo");
    expect(deriveKanbanColumn("ready")).toBe("todo");

    expect(deriveKanbanColumn("running")).toBe("in_progress");
    expect(deriveKanbanColumn("live")).toBe("in_progress");

    expect(deriveKanbanColumn("pending_approval")).toBe("needs_approval");
    expect(deriveKanbanColumn("waiting-approval")).toBe("needs_approval");
    expect(deriveKanbanColumn("needs-provider")).toBe("needs_approval");

    expect(deriveKanbanColumn("completed")).toBe("done");
    expect(deriveKanbanColumn("error")).toBe("done");
    expect(deriveKanbanColumn("aborted")).toBe("done");
    expect(deriveKanbanColumn("cancelled")).toBe("done");
    expect(deriveKanbanColumn("unknown")).toBe("done");
  });
});

describe("normalizeBoardTask", () => {
  it("normalizes a WorkBoardTask correctly", () => {
    const task: WorkBoardTask = {
      id: "abc",
      title: "My task",
      status: "running",
      repoName: "org/repo",
      updatedAt: 1000,
    };
    const normalized = normalizeBoardTask(task);
    expect(normalized).toEqual({
      id: "abc",
      title: "My task",
      status: "running",
      updatedAt: 1000,
      repoName: "org/repo",
      error: undefined,
    });
  });

  it("normalizes a TaskHistoryItem correctly", () => {
    const historyItem: TaskHistoryItem = {
      taskId: "t-1",
      title: "Task history",
      updatedAt: 2000,
      attempts: [
        {
          attempt: 1,
          status: "error",
          updatedAt: 2000,
          error: "Build failed",
        },
      ],
    };
    const normalized = normalizeBoardTask(historyItem);
    expect(normalized).toEqual({
      id: "t-1",
      title: "Task history",
      status: "error",
      updatedAt: 2000,
      repoName: undefined,
      error: "Build failed",
    });
  });
});
