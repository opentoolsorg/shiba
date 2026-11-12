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
      variant="sheet"
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

describe("AppNavRail mobile sheet (full navigation with thread list)", () => {
  it("renders Shiba wordmark and navigates to work on click", () => {
    const { onNavigate } = renderRail();
    const wordmark = screen.getByRole("link", { name: "Shiba Home" });
    expect(wordmark).toBeTruthy();
    expect(within(wordmark).getByRole("img", { name: "Shiba" })).toBeTruthy();
    const profile = screen.getByRole("button", { name: "Workspace profile" });
    expect(within(profile).getByRole("img", { name: "Shiba" })).toBeTruthy();
    expect(screen.getByText("Shiba")).toBeTruthy();
    fireEvent.click(wordmark);
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("shows a static workspace label without a fake scope switch", () => {
    renderRail();
    expect(screen.getByText("Workspace")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it.each([
    ["Extensions", "integrations"],
    ["Mailbox", "inbox"],
    ["Memory", "memory"],
    ["Automations", "automations"],
    ["Insights", "dashboard"],
  ] as const)("shows %s as a direct sidebar destination", (label, id) => {
    const { onNavigate } = renderRail();
    const sidebar = screen.getByRole("region", { name: "Sidebar navigation" });
    fireEvent.click(within(sidebar).getByRole("button", { name: label }));
    expect(onNavigate).toHaveBeenCalledWith(id);
  });

  it.each(["sheet"] as const)("starts a new thread from the %s", (variant) => {
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
    expect(onNavigate).toHaveBeenCalledWith("tasks");
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
      <AppNavRail activeView="tasks" variant="sheet" onNavigate={vi.fn()} sessions={[]} threadsLoading />,
    );
    expect(screen.getByLabelText("Loading threads")).toBeTruthy();
    expect(screen.queryByText(/No threads yet/)).toBeNull();

    rerender(<AppNavRail activeView="tasks" variant="sheet" onNavigate={vi.fn()} sessions={[]} threadsLoading={false} />);
    expect(screen.getByText(/No threads yet/)).toBeTruthy();
  });

  it.each(["sheet"] as const)("puts navigation, agents, approvals and full-height threads in one scrolling region for %s", (variant) => {
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

  it("opens custom agents from its dedicated navigation, not More", () => {
    const onNavigate = vi.fn<(view: AppNavView) => void>();
    render(<AppNavRail activeView="custom-agents" onNavigate={onNavigate} sessions={[]} variant="rail" />);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(onNavigate).toHaveBeenCalledWith("custom-agents");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Agents" })).toBeNull();
  });

  it("exposes Extensions, skills and MCP in the sheet", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(<AppNavRail activeView="agents" onNavigate={onNavigate} variant="sheet" onClose={onClose} />);
    for (const [label, id] of [["Extensions", "integrations"], ["Skills", "skills"], ["MCP", "agents"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onNavigate).toHaveBeenLastCalledWith(id);
      rerender(<AppNavRail activeView={id} onNavigate={onNavigate} variant="sheet" onClose={onClose} />);
      expect(screen.getByRole("button", { name: label }).getAttribute("aria-current")).toBe("page");
    }
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("labels the account remote-page link truthfully", () => {
    const onNavigate = vi.fn();
    render(<AppNavRail activeView="tasks" onNavigate={onNavigate} sessions={[]} variant="rail" />);
    fireEvent.click(screen.getByRole("button", { name: "Workspace profile" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remote access" }));
    expect(onNavigate).toHaveBeenCalledWith("remote");
    expect(screen.queryByText("Open desktop app")).toBeNull();
  });
});

describe("AppNavRail desktop labeled navigation (every view)", () => {
  it("renders a 72px transparent desktop rail on work view with round logo mark top", () => {
    const { onNavigate } = renderRail({ activeView: "work", variant: "rail" });
    const aside = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(aside.className).toContain("w-[72px]");
    expect(aside.className).toContain("bg-transparent");
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("lg:flex");

    const logo = screen.getByRole("link", { name: "Shiba Home" });
    expect(logo).toBeTruthy();
    expect(within(logo).getByRole("img", { name: "Shiba" })).toBeTruthy();
    fireEvent.click(logo);
    expect(onNavigate).toHaveBeenCalledWith("tasks");
  });

  it("stacks primary buttons: Work, Agents, Chats, and More with active pill on Work", () => {
    const { onNavigate } = renderRail({ activeView: "work", variant: "rail" });
    const workBtn = screen.getByRole("button", { name: "Work" });
    const agentsBtn = screen.getByRole("button", { name: "Agents" });
    const chatBtn = screen.getByRole("button", { name: "Chats" });
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
    expect(onNavigate).toHaveBeenCalledWith("tasks");

    expect(moreBtn).toBeTruthy();
  });

  it.each([
    ["Extensions", "integrations"],
    ["Mailbox", "inbox"],
    ["Memory", "memory"],
    ["Automations", "automations"],
    ["Insights", "dashboard"],
  ] as const)("More menu routes %s to %s", (label, id) => {
    const onNavigate = vi.fn();
    render(<AppNavRail activeView="work" onNavigate={onNavigate} variant="rail" />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(onNavigate).toHaveBeenCalledWith(id);
  });

  it.each([
    ["custom-agents", "Agents"],
    ["employee-tools", "Agents"],
    ["swarm", "Agents"],
    ["tasks", "Work"],
    ["threads", "Chats"],
    ["collaboration", "Chats"],
    ["memory", "More"],
    ["analytics", "Insights"],
    ["settings", "Settings"],
  ] as const)("marks the %s view under the %s rail item on every view", (view, item) => {
    render(<AppNavRail activeView={view} onNavigate={vi.fn()} variant="rail" />);
    expect(screen.getByRole("button", { name: item }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Work" }).getAttribute("aria-current")).toBe(item === "Work" ? "page" : null);
  });

  it("offers a labeled Insights destination with a real pending approval count", () => {
    const onNavigate = vi.fn();
    render(<AppNavRail activeView="approvals" onNavigate={onNavigate} variant="rail" pendingApprovalCount={3} />);
    const insights = screen.getByRole("button", { name: "Insights" });
    expect(within(insights).getByText("Insights")).toBeTruthy();
    expect(within(insights).getByLabelText("3 pending approvals")).toBeTruthy();
    expect(insights.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(insights);
    expect(onNavigate).toHaveBeenCalledWith("dashboard");
  });

  it("lists workspaces in the account menu with a check on the current one", () => {
    const onNavigate = vi.fn();
    const onSelectWorkspace = vi.fn();
    const workspaces = [{ workspaceId: "ws_1", name: "Design team", version: 1, createdAt: 1, membership: { workspaceId: "ws_1", userId: "a@b.co", role: "owner", version: 1, joinedAt: 1 } }];
    render(
      <AppNavRail activeView="threads" onNavigate={onNavigate} variant="rail" accountEmail="a@b.co" workspaces={workspaces as never} selectedWorkspaceId="ws_1" onSelectWorkspace={onSelectWorkspace} onSignOut={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /workspace/i }));
    expect(screen.getByRole("menuitemradio", { name: "Design team" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Personal workspace" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("menuitem", { name: "Create workspace" }));
    expect(onNavigate).toHaveBeenCalledWith("team");
    fireEvent.click(screen.getByRole("button", { name: /workspace/i }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Personal workspace" }));
    expect(onSelectWorkspace).toHaveBeenCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: /workspace/i }));
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();
  });

  it("keeps the desktop rail off the phone layout and keeps sidebar toggle focus across collapse", () => {
    function Navigation() {
      const [collapsed, setCollapsed] = useState(false);
      return <AppNavRail activeView="tasks" variant="rail" onNavigate={vi.fn()} collapsed={collapsed} onToggleCollapse={() => setCollapsed((value) => !value)} />;
    }
    render(<Navigation />);
    const rail = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(rail.className).toContain("hidden");
    expect(rail.className).toContain("lg:flex");
    for (let cycle = 0; cycle < 2; cycle++) {
      const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
      collapse.focus();
      fireEvent.click(collapse);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand sidebar" }));
      fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    }
  });

  it("retains sidebar focus for an external shortcut toggle without stealing focus from the main view", () => {
    const props = { activeView: "tasks" as const, onNavigate: vi.fn(), onToggleCollapse: vi.fn(), variant: "rail" as const };
    const { rerender } = render(<><AppNavRail {...props} collapsed={false} /><input aria-label="Main task" /></>);
    screen.getByRole("button", { name: "Collapse sidebar" }).focus();
    rerender(<><AppNavRail {...props} collapsed /><input aria-label="Main task" /></>);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand sidebar" }));
    const task = screen.getByRole("textbox", { name: "Main task" });
    task.focus();
    rerender(<><AppNavRail {...props} collapsed={false} /><input aria-label="Main task" /></>);
    expect(document.activeElement).toBe(task);
  });

  it("points the sidebar toggle at the rail when no panel exists and omits aria-controls for a collapsed panel", () => {
    const props = { activeView: "work" as const, onNavigate: vi.fn(), onToggleCollapse: vi.fn(), variant: "rail" as const };
    const { rerender } = render(<AppNavRail {...props} />);
    const aside = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(screen.getByRole("button", { name: "Collapse sidebar" }).getAttribute("aria-controls")).toBe(aside.id);
    rerender(<AppNavRail {...props} sidebarPanelId="work-panel" collapsed />);
    expect(screen.getByRole("button", { name: "Expand sidebar" }).getAttribute("aria-controls")).toBeNull();
    rerender(<AppNavRail {...props} sidebarPanelId="work-panel" />);
    expect(screen.getByRole("button", { name: "Collapse sidebar" }).getAttribute("aria-controls")).toBe("work-panel");
  });

  it("keeps Tool policy and MCP out of the rail More menu, reachable from the Agents rail item", () => {
    const onNavigate = vi.fn();
    render(<AppNavRail activeView="employee-tools" onNavigate={onNavigate} variant="rail" />);
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Tool policy" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "MCP" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(onNavigate).toHaveBeenCalledWith("custom-agents");
  });

  it("closes the More and account menus on Escape and returns focus to the trigger", () => {
    render(<AppNavRail activeView="work" onNavigate={vi.fn()} variant="rail" />);
    const more = screen.getByRole("button", { name: "More" });
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: "Additional views" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Additional views" })).toBeNull();
    expect(document.activeElement).toBe(more);
    const profile = screen.getByRole("button", { name: "Workspace profile" });
    fireEvent.click(profile);
    expect(screen.getByRole("menu", { name: "Account actions" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Account actions" })).toBeNull();
    expect(document.activeElement).toBe(profile);
  });

  it("has no nested navigation landmarks in the compact rail", () => {
    render(<AppNavRail activeView="work" onNavigate={vi.fn()} variant="rail" />);
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  it("renders bottom utilities and workspace profile popover on work view", () => {
    const onToggleTheme = vi.fn();
    const onOpenShortcuts = vi.fn();
    const onNavigate = vi.fn();
    const onToggleCollapse = vi.fn();

    render(
      <AppNavRail
        activeView="work"
        variant="rail"
        onNavigate={onNavigate}
        sidebarPanelId="work-panel"
        theme="light"
        onToggleTheme={onToggleTheme}
        onOpenShortcuts={onOpenShortcuts}
        onToggleCollapse={onToggleCollapse}
        collapsed={false}
      />,
    );

    const collapseBtn = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapseBtn).toBeTruthy();
    expect(collapseBtn.getAttribute("aria-controls")).toBe("work-panel");
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
