// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AppNavRail, workspaceLabel, navStatusDotClass } from "./AppNavRail";
import { APP_AREAS, APP_NAV_ITEMS, navigationLabel, areaForView } from "../app-navigation";
import { AppShell } from "../layouts/AppShell";
import { ContextPanel } from "./ui/ContextPanel";
import { WorkLeftPanel } from "./WorkLeftPanel";

afterEach(cleanup);

it("does not invent an operator identity", () => {
  expect(workspaceLabel(null)).toEqual({ name: "Signed in", detail: "This workspace" });
  expect(workspaceLabel("ada@example.com")).toEqual({ name: "ada", detail: "ada@example.com" });
  expect(workspaceLabel("operator-7")).toEqual({ name: "operator-7", detail: "This workspace" });
});
it("keeps stored unknown and cancelled thread statuses distinct", () => {
  expect(navStatusDotClass("unknown")).toContain("attention");
  expect(navStatusDotClass("cancelled")).toContain("destructive");
  expect(navStatusDotClass("completed")).toContain("success");
});

describe("five-area desktop shell", () => {
  it.each(APP_NAV_ITEMS)("marks the area for $id and exposes its actual destinations", ({ id }) => {
    const onNavigate = vi.fn();
    render(
      <AppShell activeView={id} onNavigate={onNavigate} pendingApprovalCount={3}>
        <AppNavRail activeView={id} onNavigate={onNavigate} />
        <ContextPanel title="Surface controls">
          <button type="button">Existing control</button>
        </ContextPanel>
      </AppShell>,
    );
    const rail = screen.getByRole("navigation", { name: "Workspace areas" });
    expect(within(rail).getAllByRole("button")).toHaveLength(5);
    const area = areaForView(id);
    expect(
      within(rail).getByRole("button", { name: area.label }).getAttribute("aria-current"),
    ).toBe("page");
    const destinations = screen.getByRole("navigation", { name: `${area.label} destinations` });
    expect(
      within(destinations)
        .getByRole("button", { name: navigationLabel(id) })
        .getAttribute("aria-current"),
    ).toBe("page");
    for (const view of area.views) {
      fireEvent.click(within(destinations).getByRole("button", { name: navigationLabel(view) }));
      expect(onNavigate).toHaveBeenLastCalledWith(view);
    }
    expect(screen.getByRole("button", { name: "Existing control" })).toBeTruthy();
  });
  it("keeps the Work sidebar controls and adds area destinations", () => {
    render(
      <AppShell activeView="work" onNavigate={vi.fn()} pendingApprovalCount={0}>
        <WorkLeftPanel
          scope="personal"
          onScopeChange={vi.fn()}
          view="list"
          onViewChange={vi.fn()}
          needsYou={[]}
          assignedToMe={[]}
          everything={[]}
          onOpenTask={vi.fn()}
        />
      </AppShell>,
    );
    expect(screen.getByRole("navigation", { name: "Work destinations" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Work pages" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs you" })).toBeTruthy();
  });
  it("navigates each primary area and reports real pending approvals", () => {
    const onNavigate = vi.fn();
    render(<AppNavRail activeView="approvals" onNavigate={onNavigate} pendingApprovalCount={3} />);
    expect(screen.getByLabelText("3 pending approvals").textContent).toBe("3");
    for (const area of APP_AREAS) {
      fireEvent.click(screen.getByRole("button", { name: area.label }));
      expect(onNavigate).toHaveBeenLastCalledWith(area.defaultView);
    }
  });
  it("preserves collapse focus across shortcuts without stealing main-stage focus", () => {
    function Navigation() {
      const [collapsed, setCollapsed] = useState(false);
      return (
        <>
          <AppNavRail
            activeView="work"
            onNavigate={vi.fn()}
            sidebarPanelId="work-panel"
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed(!collapsed)}
          />
          <input aria-label="Task draft" />
        </>
      );
    }
    render(<Navigation />);
    const rail = screen.getByRole("complementary", { name: "Primary Left Rail" });
    expect(rail.className).toContain("hidden");
    expect(rail.className).toContain("lg:flex");
    const collapse = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(collapse.getAttribute("aria-controls")).toBe("work-panel");
    collapse.focus();
    fireEvent.click(collapse);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-controls")).toBeNull();
    expect(document.activeElement).toBe(expand);
    fireEvent.click(expand);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse sidebar" }));
  });
  it("preserves account actions, theme, setup and Escape focus", () => {
    const onNavigate = vi.fn(),
      onToggleTheme = vi.fn(),
      onOpenSetup = vi.fn(),
      onSignOut = vi.fn();
    render(
      <AppNavRail
        activeView="tasks"
        onNavigate={onNavigate}
        theme="light"
        onToggleTheme={onToggleTheme}
        setupDone={2}
        onOpenSetup={onOpenSetup}
        onSignOut={onSignOut}
        connectionLabel="Live connection lost"
        connectionTone="error"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(onToggleTheme).toHaveBeenCalledOnce();
    const profile = screen.getByRole("button", { name: "Workspace profile" });
    fireEvent.click(profile);
    expect(screen.getByText("Live connection lost")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(profile);
    fireEvent.click(profile);
    fireEvent.click(screen.getByRole("menuitem", { name: "Setup 2/6" }));
    expect(onOpenSetup).toHaveBeenCalledOnce();
    fireEvent.click(profile);
    fireEvent.click(screen.getByRole("menuitem", { name: /Remote access/ }));
    expect(onNavigate).toHaveBeenCalledWith("remote");
    fireEvent.click(profile);
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledOnce();
  });
});

describe("mobile navigation", () => {
  it("makes every current view directly reachable and closes after selection", () => {
    const onNavigate = vi.fn(),
      onClose = vi.fn();
    render(
      <AppNavRail activeView="tasks" onNavigate={onNavigate} variant="sheet" onClose={onClose} />,
    );
    const areas = screen.getByRole("navigation", { name: "Workspace areas" });
    for (const item of APP_NAV_ITEMS) {
      fireEvent.click(within(areas).getByRole("button", { name: navigationLabel(item.id) }));
      expect(onNavigate).toHaveBeenLastCalledWith(item.id);
    }
    expect(onClose).toHaveBeenCalledTimes(APP_NAV_ITEMS.length);
  });
  it("filters real sessions and opens a selected thread", () => {
    const onSelectSession = vi.fn(),
      onClose = vi.fn();
    render(
      <AppNavRail
        activeView="threads"
        onNavigate={vi.fn()}
        variant="sheet"
        onClose={onClose}
        onSelectSession={onSelectSession}
        sessions={[
          {
            id: "run-1",
            title: "Fix checkout",
            repoName: "acme/shop",
            status: "completed",
            updatedAt: 1,
          },
          {
            id: "run-2",
            title: "Add audit",
            repoName: "acme/api",
            status: "running",
            updatedAt: 2,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search threads" }), {
      target: { value: "acme/api" },
    });
    expect(screen.queryByRole("option", { name: /Fix checkout/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Add audit/ }));
    expect(onSelectSession).toHaveBeenCalledWith("run-2");
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("traps drawer focus and lets the account menu consume Escape first", () => {
    const onClose = vi.fn();
    render(
      <AppNavRail activeView="tasks" onNavigate={vi.fn()} variant="sheet" onClose={onClose} />,
    );
    const drawer = screen.getByRole("dialog", { name: "Workspace navigation" });
    const first = within(drawer).getByRole("link", { name: "Shiba Home" });
    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    const profile = within(drawer).getByRole("button", { name: "Workspace profile" });
    expect(document.activeElement).toBe(profile);
    fireEvent.click(profile);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(profile.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
