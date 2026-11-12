// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "./DashboardView";
import type { RetainedRun } from "../types";

afterEach(cleanup);

const mockRun: RetainedRun = {
  runId: "run-12345678",
  sandboxId: "sb-123",
  generation: 1,
  task: "Optimize database queries",
  repoUrl: "https://github.com/shiba/core",
  baseBranch: "main",
  status: "completed",
  createdAt: 1000,
  updatedAt: 60000,
  publishPullRequest: true,
};

describe("DashboardView", () => {
  it("renders overview heading, breadcrumb, connection state and a new task action", () => {
    const onNewTask = vi.fn();
    render(
      <DashboardView
        runs={[]}
        pendingApprovals={[]}
        storedApprovals={[]}
        agents={[]}
        connectionLabel="Connected"
        connectionTone="ok"
        runsError={null}
        onNavigate={vi.fn()}
        onNewTask={onNewTask}
        onInspectRun={vi.fn()}
        scope="workspace"
      />,
    );

    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.getByText("Insights")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();

    // New task button
    const newTaskBtn = screen.getByRole("button", { name: "New task" });
    fireEvent.click(newTaskBtn);
    expect(onNewTask).toHaveBeenCalledOnce();
  });

  it("renders stat cards with computed metrics and navigates", () => {
    const onNavigate = vi.fn();
    render(
      <DashboardView
        runs={[mockRun]}
        pendingApprovals={[
          { approvalId: "app-1", messageId: "m1", toolCallId: "tc1", tool: "deploy", input: {} },
        ]}
        storedApprovals={[]}
        agents={[{ principal: "agent-1", scopes: ["read"], live: true, created: 1000 }]}
        connectionLabel="Connected"
        connectionTone="ok"
        runsError={null}
        onNavigate={onNavigate}
        onNewTask={vi.fn()}
        onInspectRun={vi.fn()}
      />,
    );

    expect(screen.getByText("Total runs")).toBeTruthy();
    expect(screen.getByText("1 requested a PR")).toBeTruthy();
    expect(screen.getByText("Pending approvals")).toBeTruthy();
    expect(screen.getByText("100%")).toBeTruthy();

    fireEvent.click(screen.getByText("Total runs").closest("button")!);
    expect(onNavigate).toHaveBeenCalledWith("analytics");
  });

  it("shows launch blocked banner and runs error when present", () => {
    render(
      <DashboardView
        runs={[]}
        pendingApprovals={[]}
        storedApprovals={[]}
        agents={[]}
        connectionLabel="Error"
        connectionTone="error"
        launchBlocked={true}
        runsError="Failed to fetch runs"
        onNavigate={vi.fn()}
        onNewTask={vi.fn()}
        onInspectRun={vi.fn()}
      />,
    );

    expect(screen.getByTestId("launch-blocked-banner")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Failed to fetch runs");
    expect(screen.getByRole("button", { name: /Total runs/ }).textContent).toContain("—");
    expect(screen.queryByRole("heading", { name: "No runs yet" })).toBeNull();
  });

  it("inspects recent run on click", () => {
    const onInspectRun = vi.fn();
    render(
      <DashboardView
        runs={[mockRun]}
        pendingApprovals={[]}
        storedApprovals={[]}
        agents={[]}
        connectionLabel="Connected"
        connectionTone="ok"
        runsError={null}
        onNavigate={vi.fn()}
        onNewTask={vi.fn()}
        onInspectRun={onInspectRun}
      />,
    );

    fireEvent.click(screen.getByText("Optimize database queries").closest("button")!);
    expect(onInspectRun).toHaveBeenCalledWith("run-12345678");
  });
});

describe("Dashboard overview hierarchy", () => {
  const props = {
    runs: [],
    pendingApprovals: [],
    storedApprovals: [],
    agents: [],
    connectionLabel: "Connected",
    connectionTone: "ok" as const,
    runsError: null,
    onNavigate: vi.fn(),
    onNewTask: vi.fn(),
    onInspectRun: vi.fn(),
  };

  it("puts the approval review ahead of setup without approving anything from the overview", () => {
    const onNavigate = vi.fn();
    render(
      <DashboardView
        {...props}
        onNavigate={onNavigate}
        launchBlocked
        pendingApprovals={[
          { approvalId: "a", messageId: "m", toolCallId: "tc", tool: "deploy", input: {} },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: "Your review comes first" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review approvals" }));
    expect(onNavigate).toHaveBeenCalledWith("approvals");
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
  });

  it("directs a blocked empty workspace to setup and never fabricates a success rate", () => {
    const onNavigate = vi.fn();
    render(<DashboardView {...props} launchBlocked onNavigate={onNavigate} />);
    expect(screen.getByRole("heading", { name: "Connect a provider to get started" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Success rate/ }).textContent).toContain("—");
    expect(screen.queryByText("100%")).toBeNull();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open providers" })[0] as HTMLButtonElement,
    );
    expect(onNavigate).toHaveBeenCalledWith("providers");
  });

  it("keeps workspace shortcuts connected to their owning routes", () => {
    const onNavigate = vi.fn();
    render(<DashboardView {...props} onNavigate={onNavigate} />);
    for (const [label, route] of [
      ["Connect your tools", "integrations"],
      ["Add useful context", "memory"],
      ["Meet your agents", "custom-agents"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      expect(onNavigate).toHaveBeenLastCalledWith(route);
    }
  });

  it("sorts recent activity by the latest update and limits it to six runs", () => {
    const onInspectRun = vi.fn();
    const runs = Array.from({ length: 8 }, (_, index) => ({
      ...mockRun,
      runId: `run-${index}`,
      task: `Task ${index}`,
      updatedAt: 1000 + index,
    }));
    render(<DashboardView {...props} runs={runs} onInspectRun={onInspectRun} />);
    expect(screen.queryByText("Task 0")).toBeNull();
    expect(screen.queryByText("Task 1")).toBeNull();
    expect(screen.getByText("6 shown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Task 7/ }));
    expect(onInspectRun).toHaveBeenCalledWith("run-7");
  });
});
