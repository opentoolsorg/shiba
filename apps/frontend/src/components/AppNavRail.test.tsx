// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppNavRail, workspaceLabel, type AppNavView } from "./AppNavRail";
import type { SessionItem } from "./SessionsSidebar";

afterEach(() => cleanup());

const sessions: SessionItem[] = [
  {
    id: "run-1",
    title: "Fix flaky checkout",
    repoName: "acme/shop",
    status: "completed",
    updatedAt: Date.now() - 60_000,
  },
  {
    id: "run-2",
    title: "Add audit hash",
    repoName: "acme/api",
    status: "running",
    updatedAt: Date.now() - 5_000,
    live: true,
  },
];

function renderRail(extra?: Partial<Parameters<typeof AppNavRail>[0]>) {
  const onNavigate = vi.fn();
  const onSelectSession = vi.fn();
  render(
    <AppNavRail
      activeView="tasks"
      onNavigate={onNavigate}
      sessions={sessions}
      selectedSessionId="run-1"
      onSelectSession={onSelectSession}
      {...extra}
    />,
  );
  return { onNavigate, onSelectSession };
}

describe("workspaceLabel", () => {
  it("does not invent an operator name when email is missing", () => {
    expect(workspaceLabel(null)).toEqual({ name: "Signed in", detail: "This workspace" });
    expect(workspaceLabel("ada@example.com")).toEqual({ name: "ada", detail: "ada@example.com" });
    expect(workspaceLabel("operator-7")).toEqual({ name: "operator-7", detail: "This workspace" });
  });
});

describe("AppNavRail", () => {
  it("lists threads with status and filters them", () => {
    renderRail();
    expect(screen.getByRole("option", { name: /Fix flaky checkout/ })).toBeTruthy();
    expect(screen.getByText(/Completed · acme\/shop/)).toBeTruthy();
    expect(screen.queryByText(/prince/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Search threads" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter threads" }), {
      target: { value: "audit" },
    });
    expect(screen.queryByText("Fix flaky checkout")).toBeNull();
    expect(screen.getByText("Add audit hash")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter threads" }), {
      target: { value: "nope" },
    });
    expect(screen.getByText(/No threads match/)).toBeTruthy();
  });

  it("moves the selected thread with arrow keys", () => {
    const { onSelectSession } = renderRail();
    const list = screen.getByRole("listbox", { name: "Threads" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(onSelectSession).toHaveBeenCalledWith("run-2");
  });

  it("shows a skeleton while threads are loading and an empty state after", () => {
    const { rerender } = render(
      <AppNavRail activeView="tasks" onNavigate={vi.fn()} sessions={[]} threadsLoading />,
    );
    expect(screen.getByLabelText("Loading threads")).toBeTruthy();
    expect(screen.queryByText(/No threads yet/)).toBeNull();

    rerender(<AppNavRail activeView="tasks" onNavigate={vi.fn()} sessions={[]} threadsLoading={false} />);
    expect(screen.getByText(/No threads yet/)).toBeTruthy();
  });

  it("keeps the desktop rail off the phone layout", () => {
    renderRail();
    const rail = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(rail.className).toContain("hidden");
    expect(rail.className).toContain("lg:flex");
  });

  it("opens custom agents from More", () => {
    const onNavigate = vi.fn<(view: AppNavView) => void>();
    render(<AppNavRail activeView="tasks" onNavigate={onNavigate} sessions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Custom agents" }));
    expect(onNavigate).toHaveBeenCalledWith("custom-agents");
  });
});
