// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkTimelineView, type WorkTimelineTask } from "./WorkTimelineView";

afterEach(() => {
  cleanup();
});

describe("WorkTimelineView", () => {
  it("renders muted empty state when tasks list is empty", () => {
    const onOpen = vi.fn();
    render(<WorkTimelineView tasks={[]} onOpen={onOpen} />);

    expect(screen.getByText("No tasks yet")).toBeTruthy();
    expect(screen.getByText("Add a task above. It lands in Todo.")).toBeTruthy();
  });

  it("renders custom empty state text when provided", () => {
    const onOpen = vi.fn();
    render(
      <WorkTimelineView
        tasks={[]}
        onOpen={onOpen}
        emptyTitle="Nothing here"
        emptyDescription="No timeline activity found."
      />,
    );

    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByText("No timeline activity found.")).toBeTruthy();
  });

  it("renders tasks grouped by day and ordered newest first", () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    const mockTasks: WorkTimelineTask[] = [
      {
        id: "task-old",
        title: "Deploy to staging",
        status: "completed",
        updatedAt: twoDaysAgo,
      },
      {
        id: "task-1",
        title: "Review PR #42",
        status: "running",
        updatedAt: oneHourAgo,
      },
      {
        id: "task-2",
        title: "Write unit tests",
        status: "pending",
        updatedAt: now,
      },
    ];

    const onOpen = vi.fn();
    render(<WorkTimelineView tasks={mockTasks} onOpen={onOpen} />);

    // Verify day headers
    expect(screen.getByText("Today")).toBeTruthy();

    // Verify task titles are rendered
    expect(screen.getByText("Write unit tests")).toBeTruthy();
    expect(screen.getByText("Review PR #42")).toBeTruthy();
    expect(screen.getByText("Deploy to staging")).toBeTruthy();

    // Verify statuses
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();

    // Verify ordering: newest first within Today
    const buttons = screen.getAllByRole("button");
    expect(buttons[0]?.textContent).toContain("Write unit tests");
    expect(buttons[1]?.textContent).toContain("Review PR #42");
    expect(buttons[2]?.textContent).toContain("Deploy to staging");
  });

  it("calls onOpen with task id when a row is clicked", () => {
    const now = Date.now();
    const mockTasks: WorkTimelineTask[] = [
      {
        id: "task-123",
        title: "Investigate latency spike",
        status: "running",
        updatedAt: now,
      },
    ];

    const onOpen = vi.fn();
    render(<WorkTimelineView tasks={mockTasks} onOpen={onOpen} />);

    const row = screen.getByRole("button", { name: /Investigate latency spike/i });
    fireEvent.click(row);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("task-123");
  });

  it("handles fallback to createdAt if updatedAt is 0 or missing", () => {
    const createdTime = Date.now();
    const mockTasks: WorkTimelineTask[] = [
      {
        id: "fallback-task",
        title: "Task with createdAt only",
        status: "ready",
        updatedAt: 0,
        createdAt: createdTime,
      },
    ];

    const onOpen = vi.fn();
    render(<WorkTimelineView tasks={mockTasks} onOpen={onOpen} />);

    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Task with createdAt only")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("renders repoName if provided", () => {
    const now = Date.now();
    const mockTasks: WorkTimelineTask[] = [
      {
        id: "repo-task",
        title: "Run migration",
        status: "completed",
        updatedAt: now,
        repoName: "org/repo-api",
      },
    ];

    const onOpen = vi.fn();
    render(<WorkTimelineView tasks={mockTasks} onOpen={onOpen} />);

    expect(screen.getByText("org/repo-api")).toBeTruthy();
  });
});
