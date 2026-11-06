// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChatHeader } from "./AgentChatHeader";

afterEach(cleanup);

const agent = { id: "coding-coworker", name: "Agni" };
const participants = [{ id: "me", name: "You" }, { id: "coding-coworker", name: "Agni" }];

describe("AgentChatHeader", () => {
  it("renders the Workspace > Agents > agent breadcrumb with the current page marked", () => {
    const onOpenAgents = vi.fn();
    render(<AgentChatHeader agent={agent} participants={participants} panelOpen={false} onTogglePanel={vi.fn()} onOpenAgents={onOpenAgents} />);
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    expect(crumbs.getByText("Workspace")).toBeTruthy();
    fireEvent.click(crumbs.getByRole("button", { name: "Agents" }));
    expect(onOpenAgents).toHaveBeenCalledOnce();
    expect(crumbs.getByText("Agni").closest("li")?.getAttribute("aria-current")).toBe("page");
  });

  it("shows the participant count and lists participants on demand", () => {
    render(<AgentChatHeader agent={agent} participants={participants} panelOpen={false} onTogglePanel={vi.fn()} />);
    const chip = screen.getByRole("button", { name: "2 participants" });
    expect(chip.textContent).toContain("2");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "Participants" });
    expect(within(dialog).getByText("You")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Participants" })).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("toggles the right panel and reports its state", () => {
    const onTogglePanel = vi.fn();
    const { rerender } = render(<AgentChatHeader agent={agent} participants={participants} panelOpen={false} onTogglePanel={onTogglePanel} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details panel" }));
    expect(onTogglePanel).toHaveBeenCalledOnce();
    rerender(<AgentChatHeader agent={agent} participants={participants} panelOpen onTogglePanel={onTogglePanel} />);
    expect(screen.getByRole("button", { name: "Hide details panel" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("runs an action from the more menu and hides the menu when there are no actions", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<AgentChatHeader agent={agent} participants={participants} panelOpen={false} onTogglePanel={vi.fn()} actions={[{ label: "Clear conversation", onSelect }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear conversation" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<AgentChatHeader agent={agent} participants={participants} panelOpen={false} onTogglePanel={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Conversation actions" })).toBeNull();
  });
});
