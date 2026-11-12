// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { WorkLeftPanel, type WorkLeftPanelProps } from "./WorkLeftPanel";

afterEach(() => cleanup());

const setup = (overrides: Partial<WorkLeftPanelProps> = {}) => {
  const props: WorkLeftPanelProps = {
    scope: "workspace",
    onScopeChange: vi.fn(),
    view: "list",
    onViewChange: vi.fn(),
    needsYou: [],
    assignedToMe: [],
    everything: [],
    onOpenTask: vi.fn(),
    ...overrides,
  };
  render(<WorkLeftPanel {...props} />);
  return props;
};

describe("WorkLeftPanel", () => {
  it("keeps workspace switching global and lets the panel change views", () => {
    const props = setup();
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Personal" })).toBeNull();
    expect(props.onScopeChange).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation", { name: "Work pages" });
    expect(within(nav).getByRole("button", { name: "List" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(nav).getByRole("button", { name: "Organization" }));
    expect(props.onViewChange).toHaveBeenCalledWith("organization");
  });

  it("shows real empty copy for each section", () => {
    setup();
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByText("Nothing assigned to you")).toBeTruthy();
    expect(screen.getByText("No open tasks")).toBeTruthy();
  });

  it("lists open tasks, highlights the selected row and opens a task", () => {
    const props = setup({
      everything: [
        { id: "a", title: "Write launch brief", status: "queued" },
        { id: "b", title: "Ship pricing page", status: "running" },
      ],
      selectedId: "b",
    });
    const everything = screen.getByRole("region", { name: "Everything" });
    expect(within(everything).getByRole("button", { name: "Ship pricing page" }).getAttribute("aria-current")).toBe("true");
    expect(within(everything).getByRole("button", { name: "Write launch brief" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(within(everything).getByRole("button", { name: "Write launch brief" }));
    expect(props.onOpenTask).toHaveBeenCalledWith("a");
  });

  it("collapses and expands a section", () => {
    setup({ needsYou: [{ id: "r", title: "Approve deploy", status: "needs-approval" }] });
    const toggle = screen.getByRole("button", { name: "Needs you" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Approve deploy" })).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Approve deploy" })).toBeTruthy();
  });

  it("offers search only when a handler is given", () => {
    const onSearch = vi.fn();
    setup({ onSearch });
    fireEvent.click(screen.getByRole("button", { name: "Search tasks" }));
    expect(onSearch).toHaveBeenCalledOnce();
  });
});
