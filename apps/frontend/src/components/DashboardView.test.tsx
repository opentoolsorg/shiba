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
  it("renders the 48px header with breadcrumb and connection label", () => {
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
        pendingApprovals={[{ approvalId: "app-1", messageId: "m1", toolCallId: "tc1", tool: "deploy", input: {} }]}
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
