// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionsSidebar, type SessionItem } from "./SessionsSidebar";
import type { AgentPrincipal } from "../types";

afterEach(() => {
  cleanup();
});

const mockSessions: SessionItem[] = [
  {
    id: "s-1",
    title: "Approve deployment to production",
    repoName: "opentools/backend",
    status: "waiting-approval",
    updatedAt: Date.now() - 1000,
  },
  {
    id: "s-2",
    title: "Refactor database migrations",
    repoName: "opentools/api",
    status: "running",
    updatedAt: Date.now() - 5000,
  },
  {
    id: "s-3",
    title: "Completed setup task",
    repoName: "opentools/docs",
    status: "completed",
    updatedAt: Date.now() - 60000,
  },
];

const mockAgents: AgentPrincipal[] = [
  {
    principal: "claude-code-subagent",
    scopes: ["read", "write"],
    created: Date.now() - 3600000,
    live: true,
  },
];

describe("SessionsSidebar", () => {
  it("renders header row with title and search button", () => {
    const onSearchClick = vi.fn();
    render(
      <SessionsSidebar
        sessions={[]}
        agents={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onNewTask={vi.fn()}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
        onSearchClick={onSearchClick}
      />,
    );

    expect(screen.getByRole("heading", { name: "Work" })).toBeTruthy();
    const searchBtn = screen.getByRole("button", { name: "Search" });
    expect(searchBtn).toBeTruthy();

    fireEvent.click(searchBtn);
    expect(onSearchClick).toHaveBeenCalledTimes(1);
  });

  it("toggles inline search bar and filters sessions", () => {
    render(
      <SessionsSidebar
        sessions={mockSessions}
        agents={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onNewTask={vi.fn()}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
      />,
    );

    const searchBtn = screen.getByRole("button", { name: "Search" });
    fireEvent.click(searchBtn);

    const searchInput = screen.getByRole("searchbox", { name: "Search sessions" });
    expect(searchInput).toBeTruthy();

    fireEvent.change(searchInput, { target: { value: "Refactor" } });
    expect(screen.getAllByText("Refactor database migrations").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Approve deployment to production")).toBeNull();
  });

  it("renders 2-segment Personal | Workspace control and allows switching", () => {
    const onScopeChange = vi.fn();
    render(
      <SessionsSidebar
        sessions={[]}
        agents={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onNewTask={vi.fn()}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
        onScopeChange={onScopeChange}
      />,
    );

    const personalTab = screen.getByRole("tab", { name: "Personal" });
    const workspaceTab = screen.getByRole("tab", { name: "Workspace" });

    expect(personalTab.getAttribute("aria-selected")).toBe("true");
    expect(workspaceTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(workspaceTab);
    expect(onScopeChange).toHaveBeenCalledWith("workspace");
    expect(workspaceTab.getAttribute("aria-selected")).toBe("true");
  });

  it("renders nav list rows and allows selecting active view", () => {
    const onNavChange = vi.fn();
    render(
      <SessionsSidebar
        sessions={[]}
        agents={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onNewTask={vi.fn()}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
        onNavChange={onNavChange}
      />,
    );

    const listNav = screen.getByRole("button", { name: "List" });
    const boardNav = screen.getByRole("button", { name: "Board" });
    expect(screen.getByRole("button", { name: "Timeline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Organization" })).toBeTruthy();

    expect(listNav.getAttribute("aria-current")).toBe("page");
    expect(boardNav.getAttribute("aria-current")).toBeNull();

    fireEvent.click(boardNav);
    expect(onNavChange).toHaveBeenCalledWith("board");
    expect(boardNav.getAttribute("aria-current")).toBe("page");
  });

  it("renders collapsible groups with empty state lines when empty", () => {
    render(
      <SessionsSidebar
        sessions={[]}
        agents={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onNewTask={vi.fn()}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assigned to me" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Everything" })).toBeTruthy();

    expect(screen.getByText("Nothing needs you")).toBeTruthy();
    expect(screen.getByText("Nothing assigned to you")).toBeTruthy();
    expect(screen.getByText("No open tasks")).toBeTruthy();
  });

  it("maps sessions by status into Needs you, Assigned to me, and Everything", () => {
    const onSelect = vi.fn();
    render(
      <SessionsSidebar
        sessions={mockSessions}
        agents={mockAgents}
        selectedId="s-2"
        onSelect={onSelect}
        onNewTask={vi.fn()}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
      />,
    );

    // Waiting approval appears in "Needs you"
    expect(screen.getAllByText("Approve deployment to production").length).toBeGreaterThanOrEqual(1);

    // Running appears in "Assigned to me"
    const runningButtons = screen.getAllByRole("button", { name: /Refactor database migrations/i });
    expect(runningButtons.length).toBeGreaterThanOrEqual(1);

    // Click to select
    expect(runningButtons[0]).toBeDefined();
    fireEvent.click(runningButtons[0]!);
    expect(onSelect).toHaveBeenCalledWith("s-2");

    // MCP agent appears in Agents group
    expect(screen.getByText("claude-code-subagent")).toBeTruthy();
  });

  it("toggles collapsible groups using aria-expanded buttons", () => {
    render(
      <SessionsSidebar
        sessions={[]}
        agents={[]}
        selectedId={null}
        onSelect={vi.fn()}
        onNewTask={vi.fn()}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
      />,
    );

    const needsYouButton = screen.getByRole("button", { name: "Needs you" });
    expect(needsYouButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Nothing needs you")).toBeTruthy();

    fireEvent.click(needsYouButton);
    expect(needsYouButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Nothing needs you")).toBeNull();

    fireEvent.click(needsYouButton);
    expect(needsYouButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Nothing needs you")).toBeTruthy();
  });
});
