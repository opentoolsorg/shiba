// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamWorkItem } from "../team-work-items";
import { WorkListView, workListGroup } from "./WorkListView";

afterEach(() => {
  cleanup();
});

function task(
  id: string,
  title: string,
  status: TeamWorkItem["status"],
  extra: Partial<TeamWorkItem> = {},
): TeamWorkItem {
  return {
    id,
    workspaceId: "w1",
    roomId: "r1",
    roomTitle: "Room",
    title,
    assigneeKind: "human",
    status,
    updatedAt: 1,
    ...extra,
  };
}

const tasks = [
  task("a", "Write spec", "queued"),
  task("b", "Ship build", "running", {
    assigneeKind: "agent",
    assigneeActorId: "coding-coworker",
    assigneeName: "Coder",
  }),
  task("c", "Review PR", "needs-approval", { assigneeActorId: "u1", assigneeName: "Priya" }),
  task("d", "Old thing", "completed"),
  task("e", "Archived", "queued", { archived: true }),
];

function renderList(props: Partial<Parameters<typeof WorkListView>[0]> = {}) {
  const onOpen = vi.fn();
  const onToggleDone = vi.fn();
  render(<WorkListView tasks={tasks} onOpen={onOpen} onToggleDone={onToggleDone} {...props} />);
  return { onOpen, onToggleDone };
}

describe("workListGroup", () => {
  it("maps server statuses onto the five planning groups", () => {
    expect(workListGroup("queued")).toBe("todo");
    expect(workListGroup("running")).toBe("in_progress");
    expect(workListGroup("needs-approval")).toBe("in_review");
    expect(workListGroup("completed")).toBe("done");
    expect(workListGroup("unknown")).toBe("backlog");
  });
});

describe("WorkListView", () => {
  it("shows the real empty state when there are no tasks", () => {
    renderList({ tasks: [] });
    expect(screen.getByText("No tasks yet")).toBeTruthy();
    expect(screen.getByText("Add a task above. It lands in Todo.")).toBeTruthy();
  });

  it("treats a list of only archived tasks as empty", () => {
    renderList({ tasks: [task("x", "Gone", "queued", { archived: true })] });
    expect(screen.getByText("No tasks yet")).toBeTruthy();
  });

  it("groups tasks by status with counts, in planning order, hiding empty groups and archived tasks", () => {
    renderList();
    const headers = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent);
    expect(headers).toEqual(["Todo1", "In progress1", "In review1", "Done1"]);
    expect(within(screen.getByRole("list", { name: "Todo" })).getByText("Write spec")).toBeTruthy();
    expect(screen.queryByText("Archived")).toBeNull();
  });

  it("collapses and expands a group", () => {
    renderList();
    const header = screen.getByRole("button", { name: /^Todo/ });
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Write spec")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByText("Write spec")).toBeTruthy();
  });

  it("opens a task on row click and toggles done from the status circle without opening", () => {
    const { onOpen, onToggleDone } = renderList();
    fireEvent.click(screen.getByText("Write spec"));
    expect(onOpen).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Mark Write spec done" }));
    expect(onToggleDone).toHaveBeenCalledWith("a");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Mark Old thing not done" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("highlights the selected row", () => {
    renderList({ selectedId: "b" });
    const row = screen.getByText("Ship build").closest("button");
    expect(row?.getAttribute("aria-current")).toBe("true");
    expect(row?.closest("li")?.className).toContain("bg-zinc-100");
  });

  it("renders assignee avatars and a dashed slot when unassigned", () => {
    renderList();
    expect(screen.getByRole("img", { name: "Coder" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Priya" }).getAttribute("src")).toMatch(
      /^\/assets\/agents\//,
    );
    expect(screen.getAllByRole("img", { name: "Unassigned" })).toHaveLength(2);
  });

  it("moves focus between rows with arrow keys", () => {
    renderList();
    const first = screen.getByText("Write spec").closest("button") as HTMLButtonElement;
    const second = screen.getByText("Ship build").closest("button") as HTMLButtonElement;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
  });
});
