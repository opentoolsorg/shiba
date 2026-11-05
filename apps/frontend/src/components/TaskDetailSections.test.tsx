// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TeamWorkItem } from "../team-work-items";
import { parseCondition, parseContextItem, TaskDetailSections } from "./TaskDetailSections";

afterEach(() => {
  cleanup();
});

const task = (patch: Partial<TeamWorkItem> = {}): TeamWorkItem => ({
  id: "t1",
  workspaceId: "w1",
  roomId: "r1",
  roomTitle: "Room",
  title: "Ship onboarding",
  assigneeKind: "human",
  status: "queued",
  updatedAt: 0,
  ...patch,
});

describe("TaskDetailSections", () => {
  it("renders section headings, objective hint and placeholder", () => {
    render(<TaskDetailSections task={task()} onChange={vi.fn()} />);
    for (const name of ["Objective", "Waiting on", "Context", "Done when"])
      expect(screen.getByRole("region", { name })).toBeTruthy();
    expect(screen.getByText("The outcome, not the steps")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("Describe what a good result looks like. Markdown works."),
    ).toBeTruthy();
  });

  it("commits the objective on blur only when it changed", () => {
    const onChange = vi.fn();
    render(<TaskDetailSections task={task()} onChange={onChange} />);
    const box = screen.getByRole("textbox", { name: "Objective" });
    fireEvent.focus(box);
    fireEvent.blur(box);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "Users finish setup in **2 minutes**" } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith({ objective: "Users finish setup in **2 minutes**" });
  });

  it("renders the objective as safe markdown without injecting raw HTML", () => {
    const objective =
      "# Goal\nShip **fast** with `pnpm`\n- one\n- two\n[docs](https://example.com) [bad](javascript:alert(1))\n<img src=x onerror=alert(1)>";
    const { container } = render(
      <TaskDetailSections task={task({ objective })} onChange={vi.fn()} />,
    );
    expect(screen.queryByRole("textbox", { name: "Objective" })).toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("fast");
    expect(container.querySelector("code")?.textContent).toBe("pnpm");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe(
      "https://example.com",
    );
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("switches the objective preview to an editor and reverts on Escape", () => {
    const onChange = vi.fn();
    render(<TaskDetailSections task={task({ objective: "Old" })} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit objective" }));
    const box = screen.getByRole("textbox", { name: "Objective" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Old");
    fireEvent.change(box, { target: { value: "New" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit objective" })).toBeTruthy();
  });

  it("adds and removes a blocking task", () => {
    const onChange = vi.fn();
    const others = [
      task(),
      task({ id: "t2", title: "Write copy" }),
      task({ id: "t3", title: "Old thing", archived: true }),
    ];
    const { rerender } = render(
      <TaskDetailSections task={task()} onChange={onChange} tasks={others} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Wait on a task" }));
    const picker = screen.getByRole("combobox", { name: "Task to wait on" });
    expect(within(picker).queryByText("Old thing")).toBeNull();
    expect(within(picker).queryByText("Ship onboarding")).toBeNull();
    fireEvent.change(picker, { target: { value: "t2" } });
    expect(onChange).toHaveBeenCalledWith({ waitingOn: ["t2"] });

    rerender(
      <TaskDetailSections task={task({ waitingOn: ["t2"] })} onChange={onChange} tasks={others} />,
    );
    expect(screen.getByText("Write copy")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop waiting on Write copy" }));
    expect(onChange).toHaveBeenLastCalledWith({ waitingOn: [] });
  });

  it("shows a real empty state when there is nothing to wait on", () => {
    render(<TaskDetailSections task={task()} onChange={vi.fn()} tasks={[task()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Wait on a task" }));
    expect(screen.getByText("No other open tasks to wait on.")).toBeTruthy();
  });

  it("adds typed context items and rejects unsafe links", () => {
    const onChange = vi.fn();
    render(
      <TaskDetailSections task={task({ context: ["note:Keep it short"] })} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add file, note, chat or link" }));
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    const input = screen.getByRole("textbox", { name: "Link context" });
    fireEvent.change(input, { target: { value: "javascript:alert(1)" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(screen.getByRole("alert").textContent).toContain("http");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "https://example.com/spec" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onChange).toHaveBeenCalledWith({
      context: ["note:Keep it short", "link:https://example.com/spec"],
    });
  });

  it("renders context with icons and removes an item", () => {
    const onChange = vi.fn();
    render(
      <TaskDetailSections
        task={task({ context: ["file:brief.md", "link:https://example.com"] })}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText("File")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://example.com" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove file brief.md" }));
    expect(onChange).toHaveBeenCalledWith({ context: ["link:https://example.com"] });
  });

  it("adds, toggles and removes done-when conditions", () => {
    const onChange = vi.fn();
    const { rerender } = render(<TaskDetailSections task={task()} onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "Add a condition" });
    fireEvent.change(input, { target: { value: "  Tests pass " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ doneWhen: ["[ ] Tests pass"] });
    expect((input as HTMLInputElement).value).toBe("");

    rerender(
      <TaskDetailSections
        task={task({ doneWhen: ["[ ] Tests pass", "[x] Docs updated"] })}
        onChange={onChange}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Tests pass" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: "Docs updated" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith({ doneWhen: ["[x] Tests pass", "[x] Docs updated"] });
    fireEvent.click(screen.getByRole("button", { name: "Remove condition Docs updated" }));
    expect(onChange).toHaveBeenLastCalledWith({ doneWhen: ["[ ] Tests pass"] });
  });
});

describe("stored string encodings", () => {
  it("parses context kinds with a link/note fallback for unprefixed values", () => {
    expect(parseContextItem("chat:Kickoff")).toEqual({ kind: "chat", value: "Kickoff" });
    expect(parseContextItem("https://a.dev")).toEqual({ kind: "link", value: "https://a.dev" });
    expect(parseContextItem("plain")).toEqual({ kind: "note", value: "plain" });
  });

  it("parses conditions with an unchecked fallback", () => {
    expect(parseCondition("[X] Done")).toEqual({ done: true, text: "Done" });
    expect(parseCondition("Legacy")).toEqual({ done: false, text: "Legacy" });
  });
});
