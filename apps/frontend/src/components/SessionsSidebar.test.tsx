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
    const searchBtn = screen.getByRole("button", { name: "Search sessions" });
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

    const searchBtn = screen.getByRole("button", { name: "Search sessions" });
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

    const personalTab = screen.getByRole("button", { name: "Personal" });
    const workspaceTab = screen.getByRole("button", { name: "Workspace" });

    expect(personalTab.getAttribute("aria-pressed")).toBe("true");
    expect(workspaceTab.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(workspaceTab);
    expect(onScopeChange).toHaveBeenCalledWith("workspace");
    expect(workspaceTab.getAttribute("aria-pressed")).toBe("true");
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

    expect(screen.getByRole("button", { name: "Waiting on you" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Running" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recent" })).toBeTruthy();

    expect(screen.getByText("Nothing waiting on you")).toBeTruthy();
    expect(screen.getByText("Nothing running")).toBeTruthy();
    expect(screen.getByText("No recent tasks")).toBeTruthy();
  });

  it("maps sessions by status into Waiting on you, Running, and Recent", () => {
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

    // Waiting approval appears in "Waiting on you"
    expect(screen.getAllByText("Approve deployment to production").length).toBeGreaterThanOrEqual(1);

    // Running appears in "Running"
    const runningButtons = screen.getAllByRole("button", { name: /Refactor database migrations/i });
    expect(runningButtons.length).toBeGreaterThanOrEqual(1);

    // Click to select
    expect(runningButtons[0]).toBeDefined();
    fireEvent.click(runningButtons[0]!);
    expect(onSelect).toHaveBeenCalledWith("s-2");

    // MCP agent appears in Agents group
    expect(screen.getByText("claude-code-subagent")).toBeTruthy();
  });

  it("groups needs-provider as waiting, keeps idle ready chats in recent, and never lists the default session", () => {
    const sessions: SessionItem[] = [
      { id: "default", title: "Default Session", repoName: "", status: "running", updatedAt: 1 },
      { id: "p-1", title: "Needs a key", repoName: "", status: "needs-provider", updatedAt: 2 },
      { id: "r-1", title: "Ready thread", repoName: "", status: "ready", updatedAt: 3 },
      { id: "c-1", title: "Old thread", repoName: "", status: "completed", updatedAt: 4 },
    ];
    render(
      <SessionsSidebar sessions={sessions} agents={[]} selectedId={null} onSelect={vi.fn()} onNewTask={vi.fn()} connectionLabel="Connected" connectionTone="ok" setupDone={null} setupTotal={6} onOpenSetup={vi.fn()} />,
    );
    const within = (name: string) => screen.getByRole("region", { name });
    expect(within("Waiting on you").textContent).toContain("Needs a key");
    expect(within("Running").textContent).not.toContain("Ready thread");
    expect(within("Recent").textContent).toContain("Ready thread");
    expect(within("Recent").textContent).toContain("Old thread");
    expect(screen.queryByText("Default Session")).toBeNull();
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

    const needsYouButton = screen.getByRole("button", { name: "Waiting on you" });
    expect(needsYouButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Nothing waiting on you")).toBeTruthy();

    fireEvent.click(needsYouButton);
    expect(needsYouButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Nothing waiting on you")).toBeNull();

    fireEvent.click(needsYouButton);
    expect(needsYouButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Nothing waiting on you")).toBeTruthy();
  });

  it("lists registered agents in the sessions drawer variant", () => {
    render(
      <SessionsSidebar variant="sessions" sessions={mockSessions} agents={mockAgents} selectedId={null} onSelect={vi.fn()} onNewTask={vi.fn()} connectionLabel="Connected" connectionTone="ok" setupDone={null} setupTotal={6} onOpenSetup={vi.fn()} />,
    );
    expect(screen.getByText("claude-code-subagent")).toBeTruthy();
  });

  it("renders sessions drawer variant with Sessions title, working New thread button, and full list without Work nav/scope", () => {
    const onNewTask = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionsSidebar
        variant="sessions"
        sessions={mockSessions}
        agents={[]}
        selectedId={null}
        onSelect={onSelect}
        onNewTask={onNewTask}
        connectionLabel="Connected"
        connectionTone="ok"
        setupDone={null}
        setupTotal={6}
        onOpenSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Sessions" })).toBeTruthy();

    const newThreadBtn = screen.getByRole("button", { name: "New thread" });
    expect(newThreadBtn).toBeTruthy();
    fireEvent.click(newThreadBtn);
    expect(onNewTask).toHaveBeenCalledTimes(1);

    const drawerSearch = screen.getByRole("searchbox", { name: "Search sessions" });
    expect(document.activeElement).not.toBe(drawerSearch);

    expect(screen.queryByRole("button", { name: "Personal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "List" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Waiting on you" })).toBeNull();

    expect(screen.getByText("Approve deployment to production")).toBeTruthy();
    expect(screen.getByText("Refactor database migrations")).toBeTruthy();
    expect(screen.getByText("Completed setup task")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Refactor database migrations/i }));
    expect(onSelect).toHaveBeenCalledWith("s-2");
  });
});
