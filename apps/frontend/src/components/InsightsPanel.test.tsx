// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InsightsPanel } from "./InsightsPanel";

afterEach(cleanup);

describe("InsightsPanel", () => {
  it("renders all five navigation items and switches scopes", () => {
    const onScopeChange = vi.fn();
    const onSelect = vi.fn();

    render(
      <InsightsPanel
        scope="personal"
        onScopeChange={onScopeChange}
        active="dashboard"
        onSelect={onSelect}
        pendingApprovalsCount={3}
      />,
    );

    expect(screen.getByRole("heading", { name: "Insights" })).toBeTruthy();

    // Check scope switch
    const workspaceTab = screen.getByRole("tab", { name: "Workspace" });
    fireEvent.click(workspaceTab);
    expect(onScopeChange).toHaveBeenCalledWith("workspace");

    // Check nav items
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Activity" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pull requests" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Approvals/ })).toBeTruthy();

    // Active item has aria-current="page"
    expect(screen.getByRole("button", { name: "Dashboard" }).getAttribute("aria-current")).toBe("page");

    // Badge is present for pending approvals
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("3 pending approvals");

    // Selecting an item calls onSelect
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(onSelect).toHaveBeenCalledWith("analytics");

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(onSelect).toHaveBeenCalledWith("activity");

    fireEvent.click(screen.getByRole("button", { name: "Pull requests" }));
    expect(onSelect).toHaveBeenCalledWith("diff");

    fireEvent.click(screen.getByRole("button", { name: /Approvals/ }));
    expect(onSelect).toHaveBeenCalledWith("approvals");
  });

  it("hides the pending badge when count is zero", () => {
    render(
      <InsightsPanel
        scope="workspace"
        onScopeChange={vi.fn()}
        active="analytics"
        onSelect={vi.fn()}
        pendingApprovalsCount={0}
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Usage" }).getAttribute("aria-current")).toBe("page");
  });
});
