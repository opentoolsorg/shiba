// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkHeader } from "./WorkHeader";

afterEach(() => {
  cleanup();
});

describe("WorkHeader", () => {
  it("renders breadcrumb crumbs and count label correctly", () => {
    const onToggleSidebar = vi.fn();
    const onSearch = vi.fn();
    const onNewTask = vi.fn();

    render(
      <WorkHeader
        crumbs={["Personal", "Work", "List"]}
        countLabel="0 open"
        sidebarCollapsed={false}
        onToggleSidebar={onToggleSidebar}
        onSearch={onSearch}
        onNewTask={onNewTask}
      />,
    );

    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.getByText("Work")).toBeTruthy();
    const lastCrumb = screen.getByText("List");
    expect(lastCrumb).toBeTruthy();
    expect(lastCrumb.getAttribute("aria-current")).toBe("page");

    expect(screen.getByText("0 open")).toBeTruthy();
  });

  it("handles sidebar toggle click and updates label based on sidebarCollapsed", () => {
    const onToggleSidebar = vi.fn();

    const { rerender } = render(
      <WorkHeader
        crumbs={["Personal", "Work", "List"]}
        sidebarCollapsed={false}
        onToggleSidebar={onToggleSidebar}
        onSearch={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );

    const collapseButton = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapseButton).toBeTruthy();
    expect(collapseButton.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(collapseButton);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    rerender(
      <WorkHeader
        crumbs={["Personal", "Work", "List"]}
        sidebarCollapsed={true}
        onToggleSidebar={onToggleSidebar}
        onSearch={vi.fn()}
        onNewTask={vi.fn()}
      />,
    );

    const expandButton = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expandButton).toBeTruthy();
    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("handles search and new task clicks", () => {
    const onSearch = vi.fn();
    const onNewTask = vi.fn();

    render(
      <WorkHeader
        crumbs={["Work"]}
        sidebarCollapsed={false}
        onToggleSidebar={vi.fn()}
        onSearch={onSearch}
        onNewTask={onNewTask}
      />,
    );

    const searchButton = screen.getByRole("button", { name: "Filter tasks" });
    expect(searchButton.getAttribute("aria-controls")).toBe("work-search");
    expect(searchButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(searchButton);
    expect(onSearch).toHaveBeenCalledTimes(1);

    const newTaskButton = screen.getByRole("button", { name: "New task" });
    fireEvent.click(newTaskButton);
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it("renders segmented view control when activeView and onViewChange are provided", () => {
    const onViewChange = vi.fn();
    render(
      <WorkHeader
        crumbs={["Personal", "Work", "List"]}
        sidebarCollapsed={true}
        onToggleSidebar={vi.fn()}
        onSearch={vi.fn()}
        onNewTask={vi.fn()}
        activeView="list"
        onViewChange={onViewChange}
      />,
    );

    const viewsFieldset = screen.getByRole("group", { name: "Work views" });
    expect(viewsFieldset).toBeTruthy();

    const listBtn = screen.getByRole("button", { name: "List" });
    const boardBtn = screen.getByRole("button", { name: "Board" });
    expect(listBtn.getAttribute("aria-pressed")).toBe("true");
    expect(boardBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(boardBtn);
    expect(onViewChange).toHaveBeenCalledWith("board");
  });
});
