// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamWorkItem } from "../team-work-items";
import { TaskDetailPanel, taskStatusOption } from "./TaskDetailPanel";

vi.mock("./TaskDetailSections", () => ({
  TaskDetailSections: ({ task }: { task: TeamWorkItem }) => (
    <section aria-label="Sections">{task.id}</section>
  ),
}));
vi.mock("./TaskActivity", () => ({
  TaskActivity: ({ onComment }: { onComment(text: string): void }) => (
    <button type="button" onClick={() => onComment("hello")}>
      Comment
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const task = (overrides: Partial<TeamWorkItem> = {}): TeamWorkItem => ({
  id: "t1",
  workspaceId: "ws",
  roomId: "",
  roomTitle: "",
  title: "Ship onboarding",
  assigneeKind: "human",
  status: "queued",
  updatedAt: 1,
  ...overrides,
});
const agents = [
  { id: "coding-coworker", name: "Agni" },
  { id: "pr-reviewer", name: "Ved" },
];

function setup(props: Partial<Parameters<typeof TaskDetailPanel>[0]> = {}) {
  const handlers = { onChange: vi.fn(), onArchive: vi.fn(), onClose: vi.fn(), onComment: vi.fn() };
  const view = render(<TaskDetailPanel task={task()} agents={agents} {...handlers} {...props} />);
  return { ...handlers, ...view };
}

describe("TaskDetailPanel", () => {
  it("renders the header, title, and default property values", () => {
    setup();
    expect(screen.getByRole("complementary", { name: "Task details" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Task" })).toBeDefined();
    expect((screen.getByLabelText("Task title") as HTMLTextAreaElement).value).toBe(
      "Ship onboarding",
    );
    expect(
      (screen.getByLabelText("Status") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe("Todo");
    expect(
      (screen.getByLabelText("Owner") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe("Assign a person or agent");
    expect(
      (screen.getByLabelText("Reviewer") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe("None");
    expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("medium");
    expect(
      (screen.getByLabelText("Inside") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe("Not inside another task");
    expect(screen.getByRole("switch", { name: "Blocked" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByRole("region", { name: "Sections" }).textContent).toBe("t1");
  });

  it("lists all five statuses and maps run-derived statuses to the nearest option", () => {
    setup();
    const options = Array.from((screen.getByLabelText("Status") as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );
    expect(options).toEqual(["Backlog", "Todo", "In progress", "In review", "Done"]);
    expect(taskStatusOption("needs-approval")).toBe("in-review");
    expect(taskStatusOption("queued")).toBe("todo");
    expect(taskStatusOption("running")).toBe("in-progress");
    expect(taskStatusOption("completed")).toBe("done");
    expect(taskStatusOption("blocked")).toBe("todo");
    expect(taskStatusOption("in-review")).toBe("in-review");
  });

  it("emits patches for status, owner, reviewer, priority, dates, parent, and blocked", () => {
    const parent = task({ id: "p1", title: "Launch" });
    const { onChange } = setup({ tasks: [task(), parent] });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "in-progress" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "coding-coworker" } });
    fireEvent.change(screen.getByLabelText("Reviewer"), { target: { value: "pr-reviewer" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "urgent" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-05" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-11-09" } });
    fireEvent.change(screen.getByLabelText("Inside"), { target: { value: "p1" } });
    fireEvent.click(screen.getByRole("switch", { name: "Blocked" }));
    expect(onChange.mock.calls.map(([patch]) => patch)).toEqual([
      { status: "in-progress" },
      { ownerId: "coding-coworker" },
      { reviewerId: "pr-reviewer" },
      { priority: "urgent" },
      { startDate: "2026-11-05" },
      { endDate: "2026-11-09" },
      { parentId: "p1" },
      { blocked: true },
    ]);
  });

  it("excludes the task itself from parent options and shows the owner avatar", () => {
    setup({
      task: task({ ownerId: "coding-coworker" }),
      tasks: [task(), task({ id: "p1", title: "Launch" })],
    });
    const parents = Array.from((screen.getByLabelText("Inside") as HTMLSelectElement).options).map(
      (o) => o.textContent,
    );
    expect(parents).toEqual(["Not inside another task", "Launch"]);
    expect((screen.getByLabelText("Owner") as HTMLSelectElement).value).toBe("coding-coworker");
    expect(document.querySelector('.shiba-agent-mascot[data-shape="pointed"][data-eyes="happy"]')).not.toBeNull();
  });

  it("debounces title edits into a single patch and flushes on blur", () => {
    vi.useFakeTimers();
    const { onChange } = setup();
    const title = screen.getByLabelText("Task title");
    fireEvent.change(title, { target: { value: "Ship" } });
    fireEvent.change(title, { target: { value: "Ship it" } });
    expect(onChange).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ title: "Ship it" });

    fireEvent.change(title, { target: { value: "Ship it now" } });
    fireEvent.blur(title);
    expect(onChange).toHaveBeenLastCalledWith({ title: "Ship it now" });
    act(() => vi.advanceTimersByTime(400));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("never saves a blank title and restores the current one", () => {
    const { onChange } = setup();
    const title = screen.getByLabelText("Task title") as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "   " } });
    fireEvent.blur(title);
    expect(onChange).not.toHaveBeenCalled();
    expect(title.value).toBe("Ship onboarding");
  });

  it("saves a pending title edit to the original task when switching tasks", () => {
    const first = vi.fn();
    const second = vi.fn();
    const handlers = { onArchive: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(
      <TaskDetailPanel task={task()} agents={agents} onChange={first} {...handlers} />,
    );
    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Renamed" } });
    rerender(
      <TaskDetailPanel
        task={task({ id: "t2", title: "Other" })}
        agents={agents}
        onChange={second}
        {...handlers}
      />,
    );
    expect(first).toHaveBeenCalledWith({ title: "Renamed" });
    expect(second).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Task title") as HTMLTextAreaElement).value).toBe("Other");
  });

  it("archives, closes, closes on Escape, and forwards comments", () => {
    const { onArchive, onClose, onComment } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Archive task" }));
    expect(onArchive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close task" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect(onComment).toHaveBeenCalledWith("hello");
  });
});
