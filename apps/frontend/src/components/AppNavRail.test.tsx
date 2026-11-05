// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
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

describe("AppNavRail non-work views (expanded desktop sidebar & compact rail)", () => {
  it("renders Shiba wordmark and navigates to work on click", () => {
    const { onNavigate } = renderRail();
    const wordmark = screen.getByRole("link", { name: "Shiba Home" });
    expect(wordmark).toBeTruthy();
    expect(within(wordmark).getByRole("img", { name: "Shiba" }).getAttribute("src")).toBe("/assets/mascot/pet-logo.png");
    const profile = screen.getByRole("button", { name: "Workspace profile" });
    expect(within(profile).getByRole("img", { name: "Shiba" }).getAttribute("src")).toBe("/assets/mascot/pet-logo.png");
    expect(screen.getByText("Shiba")).toBeTruthy();
    fireEvent.click(wordmark);
    expect(onNavigate).toHaveBeenCalledWith("work");
  });

  it("shows a static workspace label without a fake scope switch", () => {
    renderRail();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it.each(["rail", "sheet"] as const)("starts a new thread from the %s", (variant) => {
    const onNewTask = vi.fn();
    const onClose = vi.fn();
    renderRail({ variant, onNewTask, onClose });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(onNewTask).toHaveBeenCalledOnce();
    if (variant === "sheet") expect(onClose).toHaveBeenCalledOnce();
  });

  it("falls back to Threads and restores compact setup and sandbox status", () => {
    const onOpenSetup = vi.fn();
    const { onNavigate } = renderRail({ setupDone: 2, setupTotal: 6, activeSandboxCount: 3, onOpenSetup });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
    fireEvent.click(screen.getByRole("button", { name: "Setup 2/6" }));
    expect(onOpenSetup).toHaveBeenCalledOnce();
    expect(screen.getByText("3 active sandboxes")).toBeTruthy();
  });

  it("navigates to Work view when clicking Work", () => {
    const { onNavigate } = renderRail();
    const workBtn = screen.getByRole("button", { name: "Work" });
    fireEvent.click(workBtn);
    expect(onNavigate).toHaveBeenCalledWith("work");
  });

  it("renders approval groups without fabricated assignment data", () => {
    renderRail();
    expect(screen.getByText("Needs approval")).toBeTruthy();
    expect(screen.getByText("Nothing waiting")).toBeTruthy();
    expect(screen.queryByText("Assigned to me")).toBeNull();
    expect(screen.queryByText("Nothing assigned to you")).toBeNull();
  });

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

  it.each(["rail", "sheet"] as const)("puts navigation, agents, approvals and full-height threads in one scrolling region for %s", (variant) => {
    const { onSelectSession } = renderRail({ variant, onNewAgentThread: vi.fn() });
    const content = screen.getByRole("region", { name: "Sidebar navigation" });
    expect(content.className).toContain("min-h-0");
    expect(content.className).toContain("flex-1");
    expect(content.className).toContain("overflow-y-auto");
    expect(within(content).getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(within(content).getByRole("region", { name: "Agents" })).toBeTruthy();
    expect(within(content).getByRole("button", { name: "Needs approval" })).toBeTruthy();
    const threads = within(content).getByRole("listbox", { name: "Threads" });
    expect(threads.className).not.toContain("overflow-y-auto");
    expect(threads.className).not.toContain("flex-1");
    expect(threads.parentElement?.className).not.toContain("overflow-hidden");
    expect(threads.parentElement?.className).not.toContain("flex-1");
    fireEvent.click(within(threads).getByRole("option", { name: /Fix flaky checkout/ }));
    expect(onSelectSession).toHaveBeenCalledWith("run-1");
    const profile = screen.getByRole("button", { name: "Workspace profile" });
    expect(content.contains(profile)).toBe(false);
    expect(profile.parentElement?.parentElement?.className).toContain("shrink-0");
  });

  it("keeps the desktop rail off the phone layout", () => {
    renderRail();
    const rail = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(rail.className).toContain("hidden");
    expect(rail.className).toContain("lg:flex");
  });

  it("shows only the full sidebar when desktop navigation is expanded", () => {
    renderRail({ onToggleCollapse: vi.fn() });
    expect(screen.getByRole("region", { name: "Sidebar navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Shiba Home" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "App Icon Rail" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat & Threads" })).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse sidebar" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("shows only the accessible compact rail when collapsed, with a way to reopen on every view", () => {
    const onToggleCollapse = vi.fn();
    const { onNavigate } = renderRail({ activeView: "tasks", collapsed: true, onToggleCollapse });
    const aside = screen.getByRole("complementary", { name: "Primary Left Rail" });
    const compact = screen.getByRole("navigation", { name: "App Icon Rail" });
    expect(aside.getAttribute("aria-hidden")).toBeNull();
    expect(screen.queryByRole("region", { name: "Sidebar navigation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Shiba Home" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    const expand = within(compact).getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(expand.getAttribute("aria-controls")).toBe(aside.id);
    expect(expand.className).toContain("size-11");
    fireEvent.click(within(compact).getByRole("button", { name: "Tasks" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks");
    fireEvent.click(expand);
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });

  it("alternates navigation modes without duplicate controls and transfers keyboard focus to the current toggle", () => {
    function Navigation() {
      const [collapsed, setCollapsed] = useState(false);
      return <AppNavRail activeView="tasks" onNavigate={vi.fn()} collapsed={collapsed} onToggleCollapse={() => setCollapsed((value) => !value)} />;
    }
    render(<Navigation />);
    for (let cycle = 0; cycle < 3; cycle++) {
      const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
      collapse.focus();
      fireEvent.click(collapse);
      const expand = screen.getByRole("button", { name: "Expand sidebar" });
      expect(document.activeElement).toBe(expand);
      expect(screen.queryByRole("region", { name: "Sidebar navigation" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
      fireEvent.click(expand);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(screen.queryByRole("navigation", { name: "App Icon Rail" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
    }
  });

  it("keeps the mobile sheet fully expanded regardless of the desktop collapse preference", () => {
    const onClose = vi.fn();
    const onToggleCollapse = vi.fn();
    renderRail({ variant: "sheet", collapsed: true, onClose, onToggleCollapse });
    const aside = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(aside.getAttribute("aria-hidden")).toBeNull();
    expect(aside.className).not.toContain("lg:flex");
    expect(screen.getByRole("region", { name: "Sidebar navigation" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "App Icon Rail" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });

  it("retains sidebar focus for an external shortcut toggle without stealing focus from the main view", () => {
    const props = { activeView: "tasks" as const, onNavigate: vi.fn(), onToggleCollapse: vi.fn() };
    const { rerender } = render(<><AppNavRail {...props} collapsed={false} /><input aria-label="Main task" /></>);
    screen.getByRole("button", { name: "New thread" }).focus();
    rerender(<><AppNavRail {...props} collapsed /><input aria-label="Main task" /></>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand sidebar" }));
    const task = screen.getByRole("textbox", { name: "Main task" });
    task.focus();
    rerender(<><AppNavRail {...props} collapsed={false} /><input aria-label="Main task" /></>);
    expect(document.activeElement).toBe(task);
  });

  it("opens custom agents from its dedicated navigation, not More", () => {
    const onNavigate = vi.fn<(view: AppNavView) => void>();
    render(<AppNavRail activeView="custom-agents" onNavigate={onNavigate} sessions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(onNavigate).toHaveBeenCalledWith("custom-agents");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Agents" })).toBeNull();
  });

  it.each(["rail", "sheet"] as const)("exposes integrations, skills and MCP outside More in the %s", (variant) => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<AppNavRail activeView="agents" onNavigate={onNavigate} variant={variant} onClose={onClose} />);
    for (const [label, id] of [["Integrations", "integrations"], ["Skills", "skills"], ["MCP", "agents"]] as const) {
      const button = screen.getByRole("button", { name: label });
      fireEvent.click(button);
      expect(onNavigate).toHaveBeenLastCalledWith(id);
      rerender(<AppNavRail activeView={id} onNavigate={onNavigate} variant={variant} onClose={onClose} />);
      expect(screen.getByRole("button", { name: label }).getAttribute("aria-current")).toBe("page");
      expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    }
    if (variant === "sheet") expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "MCP" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Providers" })).toBeTruthy();
  });

  it("labels the account remote-page link truthfully", () => {
    const onNavigate = vi.fn();
    render(<AppNavRail activeView="tasks" onNavigate={onNavigate} sessions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace profile" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remote access" }));
    expect(onNavigate).toHaveBeenCalledWith("remote");
    expect(screen.queryByText("Open desktop app")).toBeNull();
  });

  it("makes Tool policy reachable from More and labels its active view", () => {
    const { onNavigate } = renderRail({ activeView: "employee-tools" });
    const more = screen.getByRole("button", { name: "Tool policy" });
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "Tool policy" }));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("employee-tools");
  });
});

describe("AppNavRail Desktop Overlay 52px Icon Rail (activeView === 'work')", () => {
  it("renders ~52px transparent desktop icon rail on work view with round logo mark top", () => {
    const { onNavigate } = renderRail({ activeView: "work" });
    const aside = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(aside.className).toContain("w-[52px]");
    expect(aside.className).toContain("bg-transparent");
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("lg:flex");

    const logo = screen.getByRole("link", { name: "Shiba Home" });
    expect(logo).toBeTruthy();
    expect(within(logo).getByRole("img", { name: "Shiba" }).getAttribute("src")).toBe("/assets/mascot/pet-logo.png");
    fireEvent.click(logo);
    expect(onNavigate).toHaveBeenCalledWith("work");
  });

  it("stacks primary buttons: Work, Agents, Chat, and More with active pill on Work", () => {
    const { onNavigate } = renderRail({ activeView: "work" });
    const workBtn = screen.getByRole("button", { name: "Work" });
    const agentsBtn = screen.getByRole("button", { name: "Agents" });
    const chatBtn = screen.getByRole("button", { name: "Chat" });
    const moreBtn = screen.getByRole("button", { name: "More" });

    expect(workBtn.getAttribute("aria-current")).toBe("page");
    expect(workBtn.className).toContain("bg-[#e4e4e7]");
    expect(agentsBtn.getAttribute("aria-current")).toBeNull();
    expect(chatBtn.getAttribute("aria-current")).toBeNull();

    fireEvent.click(agentsBtn);
    expect(onNavigate).toHaveBeenCalledWith("custom-agents");

    fireEvent.click(chatBtn);
    expect(onNavigate).toHaveBeenCalledWith("threads");

    fireEvent.click(workBtn);
    expect(onNavigate).toHaveBeenCalledWith("work");

    expect(moreBtn).toBeTruthy();
  });

  it("opens More popover on work rail listing remaining nav items and includes workspace switcher", () => {
    const onNavigate = vi.fn();
    render(
      <AppNavRail
        activeView="work"
        onNavigate={onNavigate}
        workspaceSwitcher={<div data-testid="test-ws-switcher">Switcher</div>}
      />,
    );

    const moreBtn = screen.getByRole("button", { name: "More" });
    fireEvent.click(moreBtn);

    expect(screen.getByTestId("test-ws-switcher")).toBeTruthy();
    const tasksMenuItem = screen.getByRole("menuitem", { name: "Tasks" });
    expect(tasksMenuItem).toBeTruthy();
    fireEvent.click(tasksMenuItem);
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("renders bottom utilities and workspace profile popover on work view", () => {
    const onToggleTheme = vi.fn();
    const onOpenShortcuts = vi.fn();
    const onNavigate = vi.fn();
    const onToggleCollapse = vi.fn();

    render(
      <AppNavRail
        activeView="work"
        onNavigate={onNavigate}
        theme="light"
        onToggleTheme={onToggleTheme}
        onOpenShortcuts={onOpenShortcuts}
        onToggleCollapse={onToggleCollapse}
        collapsed={false}
      />,
    );

    const collapseBtn = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapseBtn).toBeTruthy();
    fireEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalledOnce();

    const themeBtn = screen.getByRole("button", { name: "Switch to dark theme" });
    fireEvent.click(themeBtn);
    expect(onToggleTheme).toHaveBeenCalledOnce();

    const helpBtn = screen.getByRole("button", { name: "Help & shortcuts" });
    fireEvent.click(helpBtn);
    expect(onOpenShortcuts).toHaveBeenCalledOnce();

    const settingsBtn = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(settingsBtn);
    expect(onNavigate).toHaveBeenCalledWith("settings");

    const profileBtn = screen.getByRole("button", { name: "Workspace profile" });
    fireEvent.click(profileBtn);
    const remoteItem = screen.getByRole("menuitem", { name: "Remote access" });
    fireEvent.click(remoteItem);
    expect(onNavigate).toHaveBeenCalledWith("remote");
  });
});
