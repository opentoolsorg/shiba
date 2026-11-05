// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskHistoryItem } from "./TaskHistory";
import {
  boardColumn,
  deriveKanbanColumn,
  normalizeBoardTask,
  toWireStatus,
  type WorkBoardTask,
  WorkBoardView,
} from "./WorkBoardView";

afterEach(() => {
  cleanup();
});

describe("WorkBoardView", () => {
  it("renders the five columns with counts and dashed empty drop zones", () => {
    render(<WorkBoardView tasks={[]} onOpen={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Work board" })).toBeDefined();
    for (const label of ["Backlog", "Todo", "In progress", "In review", "Done"]) {
      const column = screen.getByRole("region", { name: label });
      expect(within(column).getByRole("heading").textContent).toBe(`${label}0`);
      expect(within(column).getByText("Nothing here")).toBeDefined();
    }
  });

  it("places tasks into columns by status and shows the error line", () => {
    const tasks: WorkBoardTask[] = [
      { id: "t1", title: "Setup database", status: "queued" },
      { id: "t2", title: "Triage later", status: "unknown" },
      { id: "t3", title: "Build chat UI", status: "running" },
      { id: "t4", title: "Deploy to staging", status: "needs-approval" },
      { id: "t5", title: "Ship parser", status: "pr-open" },
      { id: "t6", title: "Fix login bug", status: "completed" },
      { id: "t7", title: "Failed run", status: "error", error: "Connection timed out" },
    ];
    render(<WorkBoardView tasks={tasks} onOpen={vi.fn()} />);
    const text = (id: string) => screen.getByTestId(`board-column-${id}`).textContent ?? "";
    expect(text("backlog")).toContain("Triage later");
    expect(text("todo")).toContain("Setup database");
    expect(text("todo")).toContain("Connection timed out");
    expect(screen.getByRole("region", { name: "Todo" }).querySelector("h3")?.textContent).toBe(
      "Todo2",
    );
    expect(text("in_progress")).toContain("Build chat UI");
    expect(text("in_review")).toContain("Deploy to staging");
    expect(text("in_review")).toContain("Ship parser");
    expect(text("done")).toContain("Fix login bug");
  });

  it("opens a task when its card title is clicked", () => {
    const onOpen = vi.fn();
    render(
      <WorkBoardView
        tasks={[{ id: "run-99", title: "Add auth tokens", status: "running" }]}
        onOpen={onOpen}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add auth tokens" }));
    expect(onOpen).toHaveBeenCalledWith("run-99");
  });

  it("shows assignee avatars and a dashed slot for unassigned tasks", () => {
    const tasks: WorkBoardTask[] = [
      {
        id: "a",
        title: "Agent task",
        status: "queued",
        assigneeKind: "agent",
        assigneeActorId: "agent-ved",
        assigneeName: "Ved",
      },
      {
        id: "h",
        title: "Human task",
        status: "queued",
        assigneeKind: "human",
        assigneeUserId: "u1",
        assigneeName: "Prince",
      },
      { id: "u", title: "Nobody", status: "queued" },
    ];
    render(<WorkBoardView tasks={tasks} onOpen={vi.fn()} />);
    expect(
      within(screen.getByTestId("board-card-a")).getByRole("img", { name: "Ved" }),
    ).toBeDefined();
    expect(
      within(screen.getByTestId("board-card-h")).getByRole("img", { name: "Prince" }),
    ).toBeDefined();
    expect(
      within(screen.getByTestId("board-card-u")).getByRole("img", { name: "Unassigned" }),
    ).toBeDefined();
  });

  it("moves a card to another column on drop", () => {
    const onMove = vi.fn();
    render(
      <WorkBoardView
        tasks={[{ id: "t1", title: "Drag me", status: "queued" }]}
        onOpen={vi.fn()}
        onMove={onMove}
      />,
    );
    const card = screen.getByTestId("board-card-t1");
    expect(card.getAttribute("draggable")).toBe("true");
    const store = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => store.set(k, v),
      getData: (k: string) => store.get(k) ?? "",
    };
    fireEvent.dragStart(card, { dataTransfer });
    const done = screen.getByTestId("board-column-done");
    fireEvent.dragOver(done, { dataTransfer });
    fireEvent.drop(done, { dataTransfer });
    expect(onMove).toHaveBeenCalledWith("t1", "done");
  });

  it("ignores a drop back into the same column", () => {
    const onMove = vi.fn();
    render(
      <WorkBoardView
        tasks={[{ id: "t1", title: "Stay", status: "queued" }]}
        onOpen={vi.fn()}
        onMove={onMove}
      />,
    );
    fireEvent.dragStart(screen.getByTestId("board-card-t1"));
    fireEvent.drop(screen.getByTestId("board-column-todo"));
    expect(onMove).not.toHaveBeenCalled();
  });

  it("offers a keyboard status menu that moves the task", () => {
    const onMove = vi.fn();
    render(
      <WorkBoardView
        tasks={[{ id: "t1", title: "Keyboard task", status: "queued" }]}
        onOpen={vi.fn()}
        onMove={onMove}
      />,
    );
    const menu = screen.getByRole("combobox", {
      name: "Status of Keyboard task",
    }) as HTMLSelectElement;
    expect(menu.value).toBe("todo");
    fireEvent.change(menu, { target: { value: "in_review" } });
    expect(onMove).toHaveBeenCalledWith("t1", "in-review");
  });

  it("reads hyphenated wire statuses and emits them on move", () => {
    const onMove = vi.fn();
    render(
      <WorkBoardView
        tasks={[{ id: "w1", title: "Wire task", status: "in-progress" }]}
        onOpen={vi.fn()}
        onMove={onMove}
      />,
    );
    expect(screen.getByTestId("board-column-in_progress").textContent).toContain("Wire task");
    fireEvent.drop(screen.getByTestId("board-column-in_progress"), {
      dataTransfer: { getData: () => "w1" },
    });
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.drop(screen.getByTestId("board-column-backlog"), {
      dataTransfer: { getData: () => "w1" },
    });
    expect(onMove).toHaveBeenCalledWith("w1", "backlog");
  });

  it("is read-only without onMove", () => {
    render(
      <WorkBoardView
        tasks={[{ id: "t1", title: "Read only", status: "queued" }]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByTestId("board-card-t1").getAttribute("draggable")).toBe("false");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows a Review action only for approval cards", () => {
    const onReview = vi.fn();
    const tasks: WorkBoardTask[] = [
      { id: "pr-1", title: "Ship parser", status: "pr-open" },
      { id: "ap-1", title: "Deploy", status: "needs-approval" },
      { id: "np-1", title: "Pick provider", status: "needs-provider" },
    ];
    render(<WorkBoardView tasks={tasks} onOpen={vi.fn()} onReview={onReview} />);
    expect(screen.getAllByRole("button", { name: /^Review/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review Deploy" }));
    expect(onReview).toHaveBeenCalledWith("ap-1");
  });

  it("supports TaskHistoryItem input", () => {
    const onOpen = vi.fn();
    const historyTasks: TaskHistoryItem[] = [
      {
        taskId: "th-1",
        title: "History approval",
        updatedAt: 1,
        attempts: [{ attempt: 1, status: "pending_approval", updatedAt: 1 }],
      },
      {
        taskId: "th-2",
        title: "History done",
        updatedAt: 2,
        attempts: [{ attempt: 1, status: "completed", updatedAt: 2 }],
      },
    ];
    render(<WorkBoardView tasks={historyTasks} onOpen={onOpen} />);
    expect(screen.getByTestId("board-column-in_review").textContent).toContain("History approval");
    expect(screen.getByTestId("board-column-done").textContent).toContain("History done");
    fireEvent.click(screen.getByRole("button", { name: "History approval" }));
    expect(onOpen).toHaveBeenCalledWith("th-1");
  });
});

describe("toWireStatus", () => {
  it("maps every column id to its hyphenated wire status and back", () => {
    const pairs = [
      ["backlog", "backlog"],
      ["todo", "todo"],
      ["in_progress", "in-progress"],
      ["in_review", "in-review"],
      ["done", "done"],
    ] as const;
    for (const [column, wire] of pairs) {
      expect(toWireStatus(column)).toBe(wire);
      expect(boardColumn(wire)).toBe(column);
      expect(boardColumn(column)).toBe(column);
    }
  });
});

describe("boardColumn", () => {
  it("maps run and planning statuses onto the five columns", () => {
    expect(boardColumn("backlog")).toBe("backlog");
    expect(boardColumn("unknown")).toBe("backlog");
    expect(boardColumn("pending")).toBe("todo");
    expect(boardColumn("queued")).toBe("todo");
    expect(boardColumn("running")).toBe("in_progress");
    expect(boardColumn("live")).toBe("in_progress");
    expect(boardColumn("blocked")).toBe("in_progress");
    for (const s of [
      "needs-approval",
      "pending_approval",
      "waiting-approval",
      "needs-provider",
      "pr-open",
      "in_review",
    ]) {
      expect(boardColumn(s)).toBe("in_review");
    }
    expect(boardColumn("completed")).toBe("done");
    expect(boardColumn("cancelled")).toBe("done");
  });
});

describe("deriveKanbanColumn", () => {
  it("keeps the run-oriented grouping", () => {
    expect(deriveKanbanColumn("pending")).toBe("todo");
    expect(deriveKanbanColumn("running")).toBe("in_progress");
    expect(deriveKanbanColumn("waiting-approval")).toBe("needs_approval");
    expect(deriveKanbanColumn("pr-open")).toBe("pr_open");
    expect(deriveKanbanColumn("completed")).toBe("done");
    for (const status of ["error", "aborted", "cancelled", "unknown", "rejected", "expired"]) {
      expect(deriveKanbanColumn(status)).toBe("attention");
    }
  });
});

describe("normalizeBoardTask", () => {
  it("normalizes a WorkBoardTask with its assignee", () => {
    expect(
      normalizeBoardTask({
        id: "abc",
        title: "",
        status: "running",
        assigneeActorId: "agent-1",
        assigneeName: "Kavi",
        assigneeKind: "agent",
      }),
    ).toEqual({
      id: "abc",
      title: "Untitled task",
      status: "running",
      error: undefined,
      assigneeId: "agent-1",
      assigneeName: "Kavi",
      assigneeKind: "agent",
    });
  });

  it("normalizes a TaskHistoryItem from its latest attempt", () => {
    const item: TaskHistoryItem = {
      taskId: "t-1",
      title: "Task history",
      updatedAt: 2000,
      attempts: [{ attempt: 1, status: "error", updatedAt: 2000, error: "Build failed" }],
    };
    expect(normalizeBoardTask(item)).toEqual({
      id: "t-1",
      title: "Task history",
      status: "error",
      error: "Build failed",
    });
  });
});
